#!/usr/bin/env node
/**
 * verify-effective.mjs — 「声明 vs 运行时实际」对账器。
 *
 * 解决的问题：YAML 里写了什么，不等于 DSH 真的按它跑了。本脚本读**会话记录**
 * （$DSH_HOME/sessions/…/session.v4.jsonl.zstd，Node 24 的 zlib 能直接解 zstd），
 * 把运行时的真值抓出来，和你的声明逐项对账，告诉你哪一项**在实际工作中没生效**。
 *
 * 证据来源（都是 DSH 自己写的，不是我们猜的）：
 *   - `request/context`：每次请求实际用的 provider / model / contextWindow（声明生效后的值）
 *   - `assistant/message.usage`：inputTokens / outputTokens / cacheReadTokens
 *   - `assistant/attempt` 的 finish.reason.failure：网关错误原文（429 / 上下文超限 / 图像不支持…）
 *   - `llm/retry`：重试策略与失败类别
 *
 * 用法：
 *   node scripts/verify-effective.mjs --patch ~/.dsh/profiles/web/cordis.patch.yml
 *   node scripts/verify-effective.mjs --patch … --sessions ~/.dsh/sessions --last 10
 *   node scripts/verify-effective.mjs --patch … --json
 *   node scripts/verify-effective.mjs --patch … --log ./verify.log.jsonl
 *
 * 退出码：0 = 没有发现「声明与实际矛盾」；1 = 有矛盾（会列出哪一项、证据）；2 = 用法/环境错误
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { computeBudget, compactionConfigFromPatch } from "../lib/compaction.mjs";
import { logAttempt, appendRecord, DEFAULT_LOG } from "../lib/runlog.mjs";
import { usageText } from "../lib/usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let EXTRA_NODE_MODULES = null;   // --node-modules DIR（v0.3.9：旧版文档化了却从没用过）
function loadYaml() {
  const tries = [
    "yaml",
    EXTRA_NODE_MODULES ? `${EXTRA_NODE_MODULES}/yaml` : null,
    "/opt/dsh/node_modules/yaml",
    process.env.DSH_NODE_MODULES ? `${process.env.DSH_NODE_MODULES}/yaml` : null,
  ].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch { /* 试下一个 */ }
  }
  throw new Error(`找不到 yaml 解析器（试过 ${tries.join(" / ")}）：在仓库里 npm i yaml，或设置 DSH_NODE_MODULES`);
}

function parseArgs(argv) {
  const out = {
    patch: process.env.DSH_HOME_PROFILE_PATCH ?? null,
    sessions: process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : join(process.env.HOME ?? "/root", ".dsh", "sessions"),
    last: 8, json: false, log: null, verbose: false, nodeModules: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--patch") out.patch = argv[++i];
    else if (a === "--node-modules") out.nodeModules = argv[++i];
    else if (a === "--sessions") out.sessions = argv[++i];
    else if (a === "--last") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--last 需要正整数，收到 ${JSON.stringify(argv[i])}`);
      out.last = n;
    } else if (a === "--json") out.json = true;
    else if (a === "--log") out.log = argv[++i];
    else if (a === "--no-log") out.log = null;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else out.patch ??= a;
  }
  return out;
}

/** 读出最近 N 个会话的原始事件；解不开的会话跳过并记一笔原因。
 *
 * 目录布局（本机实测）：$DSH_HOME/sessions/<工作目录 slug>/session-<uuid>/session.v4.jsonl.zstd
 * 也兼容少一层的旧布局，所以这里按「文件名」递归找（深度 ≤ 3）。*/
export function loadSessions(dir, limit) {
  const out = { events: [], sessions: [], skipped: [] };
  if (!existsSync(dir)) return out;
  const found = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let names;
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = join(d, n.name);
      if (n.isDirectory()) { walk(p, depth + 1); continue; }
      if (n.name === "session.v4.jsonl.zstd") {
        try { found.push({ id: p.split("/").slice(-2, -1)[0] ?? p, file: p, mtime: statSync(p).mtimeMs }); } catch { /* 忽略 */ }
      }
    }
  };
  walk(dir, 1);
  found.sort((a, b) => b.mtime - a.mtime);
  // v0.3.9（P2-1）：取最近 limit 个会话后按**时间升序**处理，这样
  // latestContextWindow 由最新会话写入；旧版降序处理，最后被最老会话覆盖。
  const picked = found.slice(0, limit).reverse();
  for (const s of picked) {
    try {
      const text = zstdDecompressSync(readFileSync(s.file)).toString("utf8");
      const events = text.split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      out.sessions.push({ id: s.id, file: s.file, events: events.length });
      for (const e of events) out.events.push({ session: s.id, ...e });
    } catch (e) {
      out.skipped.push({ id: s.id, reason: String(e?.message ?? e) });
    }
  }
  return out;
}

/** 把事件压成「每个 provider/model 的运行时事实」。 */
export function collectFacts(events) {
  const facts = new Map();
  const get = (provider, model) => {
    const k = `${provider}\u0000${model}`;
    if (!facts.has(k)) {
      facts.set(k, {
        provider, model,
        contextWindows: new Set(),
        latestContextWindow: null,
        maxInputTokens: 0,
        requests: 0,
        imageMessages: 0,
        reasoningMessages: 0,
        failures: [],
        retries: 0,
        sessions: new Set(),
      });
    }
    return facts.get(k);
  };
  // assistant/message 本身不带 provider/model：按事件顺序用最近一次 request/* 的配置归属
  // （同一会话里换模型是可能的，所以每会话各自跟踪，不要跨会话泄漏）。
  const current = new Map();
  // v0.3.9（P2-2）：会话开头的 user/message（图）出现在 request/context 之前，
  // 旧版按「最近一次 request」归属会记到 "?"；先挂起，等下一次 request 归属。
  const pendingImages = new Map();
  const flushImages = (sid, provider, model) => {
    const n = pendingImages.get(sid) ?? 0;
    if (n) { get(provider, model).imageMessages += n; pendingImages.delete(sid); }
  };
  const curOf = (sid) => current.get(sid) ?? { provider: "?", model: "?" };
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "request/context") {
      const c = { provider: d.provider ?? "?", model: d.model ?? "?" };
      // v0.4.0（外部评审 1c）：挂起的图只在「紧接着的下一次请求」里归属。模型/端点变了
      // （包括上图被本地 UNSUPPORTED_CONTENT 拦下、用户换模型重发的情况）就作废，
      // 否则会把 A 模型的图算到 B 模型头上。
      const prev = current.get(e.session);
      if (prev && (prev.provider !== c.provider || prev.model !== c.model)) pendingImages.delete(e.session);
      current.set(e.session, c);
      const f = get(c.provider, c.model);
      if (Number.isFinite(d.contextWindow)) { f.contextWindows.add(d.contextWindow); f.latestContextWindow = d.contextWindow; }
      f.sessions.add(e.session);
      flushImages(e.session, c.provider, c.model);
    } else if (e.type === "request/header") {
      const c = d.header?.config ?? {};
      if (c.provider || c.model) {
        const cfg = { provider: c.provider ?? "?", model: c.model ?? "?" };
        const prev = current.get(e.session);
        if (prev && (prev.provider !== cfg.provider || prev.model !== cfg.model)) pendingImages.delete(e.session);
        current.set(e.session, cfg);
        get(cfg.provider, cfg.model).sessions.add(e.session);
        flushImages(e.session, cfg.provider, cfg.model);
      }
    } else if (e.type === "assistant/message") {
      const cfg = curOf(e.session);
      // 图如果是跟在这一轮的 request 之后才落盘的，也归属给这一轮
      flushImages(e.session, cfg.provider, cfg.model);
      const f = get(cfg.provider, cfg.model);
      f.requests += 1;
      f.sessions.add(e.session);
      const u = d.usage ?? {};
      if (Number.isFinite(u.inputTokens)) f.maxInputTokens = Math.max(f.maxInputTokens, u.inputTokens);
      const content = (d.content ?? d.message?.content) ?? [];
      if (Array.isArray(content) && content.some((c) => c?.type === "reasoning")) f.reasoningMessages += 1;
      // 注意：assistant/message 里的 image 是**输出**图（模型生成/回传），不是「我们发了图」，
      // v0.3.9（P2-2）：旧版把它计入 imageMessages，会把纯文本路由误报成发过图。
    } else if (e.type === "user/message") {
      const content = (d.content ?? d.message?.content) ?? [];
      if (Array.isArray(content) && content.some((c) => c?.type === "image")) {
        // v0.4.0（外部评审 1c）：一律先挂起，由**紧接着的** request/context（或同一轮
        // 的 assistant/message）归属。旧版「当前有配置就直接记」会把「发图后本地被
        // UNSUPPORTED_CONTENT 拦下、用户换模型重发」的图算到上一个模型头上。
        pendingImages.set(e.session, (pendingImages.get(e.session) ?? 0) + 1);
      }
    } else if (e.type === "assistant/attempt") {
      const cfg = curOf(e.session);
      const stream = Array.isArray(d.stream) ? d.stream : [];
      // 这一轮如果失败（含 pi-ai 在本地就抛 UNSUPPORTED_CONTENT，压根没落 request 事件），
      // 挂起的图就必须丢弃：它没被任何模型真正收到过。
      const anyError = stream.some((it) => it?.chunk?.reason?.kind === "error") || d.error || d.failure;
      if (anyError) pendingImages.delete(e.session);
      for (const item of stream) {
        const reason = item?.chunk?.reason;
        if (reason?.kind === "error" && reason.failure?.message) {
          get(cfg.provider, cfg.model).failures.push(String(reason.failure.message).slice(0, 500));
        }
      }
    } else if (e.type === "llm/retry") {
      const cfg = { provider: d.provider ?? curOf(e.session).provider, model: d.model ?? curOf(e.session).model };
      get(cfg.provider, cfg.model).retries += 1;
    }
  }
  // 会话末尾还挂着的图：没有再发生模型切换，就归给最后那次请求的模型。
  // （若中途切过模型，切换点已经 delete 过了，这里不会串到别的模型。）
  for (const [sid, n] of pendingImages) {
    if (!n) continue;
    const cfg = curOf(sid);
    if (cfg.provider && cfg.model) flushImages(sid, cfg.provider, cfg.model);
  }
  return facts;
}

const FAILURE_CLASSES = [
  { id: "context-overflow", re: /context[_ ](length|window)|maximum context|too many tokens|input is too long/i, hint: "实际窗口比声明的 contextWindow 小（或 maxTokens 吃了太多预算）" },
  { id: "image-unsupported", re: /does not support image|image input|unsupported.*image|vision/i, hint: "端点不收图：要么 input 不该声明 image，要么网关把它丢了" },
  { id: "thinking-rejected", re: /thinking|reasoning_effort|enable_thinking/i, hint: "思考字段被端点拒绝：compat.thinkingFormat / 档位声明与实际不符" },
  { id: "auth", re: /invalid.*api.?key|unauthorized|401/i, hint: "Key 不对：apiKeyEnv 指向的环境变量没值或已失效" },
  { id: "rate", re: /429|too many requests|rate limit/i, hint: "被限流（不一定是声明错，但会掩盖真实能力）" },
];

function classifyFailure(msg) {
  for (const c of FAILURE_CLASSES) if (c.re.test(msg)) return c;
  return null;
}

/** 对账：返回 {rows, problems, notes}。 */
export function reconcile({ facts, providers, compaction }) {
  const rows = [];
  const problems = [];
  // v0.4.1：会话里用过、但当前补丁里**已经没有**的 provider/model 不能静默忽略
  // （改路由名、删模型、被别的层覆盖都会落到这里）。
  const declaredKeys = new Set();
  for (const [routeName, route] of Object.entries(providers ?? {})) {
    const models = Array.isArray(route?.models) ? route.models : [];
    for (const m of models) {
      const id = m?.id;
      if (!id) continue;
      declaredKeys.add(`${routeName}\u0000${id}`);
      const fact = facts.get(`${routeName}\u0000${id}`) ?? null;
      const declaredCtx = Number.isFinite(m.contextWindow)
        ? m.contextWindow
        : (Number.isFinite(route.defaultContextWindow) ? route.defaultContextWindow : 1000000);
      const declaredMax = Number.isFinite(m.maxTokens)
        ? m.maxTokens
        : (Number.isFinite(route.defaultMaxTokens) ? route.defaultMaxTokens : 128000);
      const declaredImage = Array.isArray(m.input) ? m.input.includes("image") : Array.isArray(route.defaultInput) ? route.defaultInput.includes("image") : false;
      const budget = computeBudget({ contextWindow: declaredCtx, reservedCompletionTokens: declaredMax, headroomTokens: compaction.headroomTokens, thresholdRatio: compaction.thresholdRatio, retainRatio: compaction.retainRatio, retainTokens: compaction.retainTokens, configMaxTokens: compaction.maxTokens });

      const row = {
        route: routeName, model: id,
        declaredCtx, declaredMax, declaredImage,
        runtimeCtx: fact ? [...fact.contextWindows] : [],
        latestRuntimeCtx: fact?.latestContextWindow ?? null,
        requests: fact?.requests ?? 0,
        maxInputTokens: fact?.maxInputTokens ?? 0,
        imageUsed: (fact?.imageMessages ?? 0) > 0,
        imageMessages: fact?.imageMessages ?? 0,
        reasoningSeen: (fact?.reasoningMessages ?? 0) > 0,
        retries: fact?.retries ?? 0,
        failures: fact?.failures ?? [],
        verdict: "未使用",
        issues: [], warnings: [],
      };

      if (!fact || (row.requests === 0 && row.runtimeCtx.length === 0)) {
        row.verdict = "未使用（没有运行时证据）";
        rows.push(row);
        continue;
      }

      // v0.3.8（P2-7）：只拿**最近一次**请求的运行时 ctx 判矛盾；更早会话里的旧值
      // 多半是「声明后来才改的」，判 error 会长期假红，降级成 warning 并说明。
      // v0.4.0（外部评审 1a）：`request/context.contextWindow` 是 **DSH 本地记录**当时
      // 内存里的声明值，不是网关回报的物理窗口。所以这个比较只能证明「运行时加载的
      // 不是现在这份声明」（HMR 没生效 / 中途改过 / 多层覆盖），不能证明网关窗口大小。
      const latestCtx = row.latestRuntimeCtx;
      if (Number.isFinite(latestCtx) && latestCtx !== declaredCtx) {
        row.issues.push(`运行时记录的 contextWindow=${latestCtx}，当前声明是 ${declaredCtx} —— 这是 DSH 本地声明值（不是网关回报），说明该会话跑的是旧声明：HMR 未生效或被别的层覆盖。重启/重载后应一致`);
      }
      for (const cw of row.runtimeCtx) {
        if (cw === declaredCtx) continue;
        if (Number.isFinite(latestCtx) && cw === latestCtx) continue; // 已在上面算 error
        row.warnings.push(`历史会话里出现过 contextWindow=${cw}（声明 ${declaredCtx}）—— 若声明是之后才改的，这是旧记录，可忽略`);
      }
      // v0.4.0（外部评审 1b）：单轮输入合法地越过阈值是常态（长粘贴/大工具输出会在
      // **这一轮**就超过阈值，压缩在下一轮才发生）。旧版直接判「矛盾 exit 1」会误报。
      // 真正的矛盾只有两种：单轮输入已经超过 messageBudget（B = ctx - maxTokens，必然 400），
      // 或者出现了 context-overflow 而当时的输入远小于声明窗口（见下面的失败分类）。
      if (Number.isFinite(budget.messageBudgetTokens) && row.maxInputTokens >= budget.messageBudgetTokens) {
        row.issues.push(`最大单轮输入 ${row.maxInputTokens} ≥ 可用消息预算 ${budget.messageBudgetTokens}（= ctx - maxTokens）—— 这种请求本该被拒，若真的成功了，说明实际窗口比声明的更大`);
      } else if (budget.ok && row.maxInputTokens >= budget.thresholdTokens) {
        row.warnings.push(`本轮输入 ${row.maxInputTokens} 已达到压缩阈值 ${budget.thresholdTokens}（属正常：压缩在下一轮触发；若之后几轮输入仍不下降，才是压缩没生效）`);
      }
      if (row.imageUsed && !declaredImage) {
        row.issues.push(`会话里真的发过图（${row.imageMessages} 条含 image），但声明 input 不含 image`);
      }
      // 失败按「类别」归并：同类只报一次（带次数 + 一条原文），否则 429 会把整页刷满。
      const byClass = new Map();
      for (const msg of row.failures) {
        const c = classifyFailure(msg);
        if (!c) continue;
        if (!byClass.has(c.id)) byClass.set(c.id, { c, n: 0, sample: msg });
        byClass.get(c.id).n += 1;
      }
      // v0.3.9（第二轮审计）：旧版这里 `row.warnings = []` 把上面刚收集的
      // 「历史 ctx 提示」整段清空，只剩限流类提示 —— 是真的丢信息。
      for (const { c, n, sample } of byClass.values()) {
        let line = `[${c.id}] ${c.hint}（${n} 次）：${sample.slice(0, 160)}`;
        // v0.4.0：这才是「网关窗口比声明小」的铁证 —— 真的超限了，而当时最大单轮输入
        // 还没到声明的 contextWindow。
        if (c.id === "context-overflow" && row.maxInputTokens > 0 && row.maxInputTokens < declaredCtx) {
          line += `；最大单轮输入只有 ${row.maxInputTokens} 却报超限 → 实际窗口 < 声明的 ${declaredCtx}（这是唯一能证伪大窗口的运行时证据）`;
        }
        // 只有「声明与实际矛盾」类才算 error；限流/鉴权是环境噪音，单列 warning。
        if (c.id === "context-overflow" || c.id === "image-unsupported" || c.id === "thinking-rejected") row.issues.push(line);
        else row.warnings.push(line);
      }

      if (row.issues.length) { row.verdict = "矛盾"; problems.push(row); }
      else if (row.maxInputTokens === 0 && row.runtimeCtx.length === 0) row.verdict = "证据不足";
      else row.verdict = "一致（已观测）";
      rows.push(row);
    }
  }
  for (const [key, fact] of facts) {
    if (declaredKeys.has(key)) continue;
    if (!(fact.requests > 0 || fact.imageMessages > 0)) continue;
    const [provider, model] = key.split("\u0000");
    rows.push({
      route: provider, model,
      declaredCtx: null, declaredMax: null, declaredImage: null,
      runtimeCtx: [...fact.contextWindows],
      latestRuntimeCtx: fact.latestContextWindow ?? null,
      requests: fact.requests,
      maxInputTokens: fact.maxInputTokens,
      imageUsed: fact.imageMessages > 0,
      imageMessages: fact.imageMessages,
      reasoningSeen: fact.reasoningMessages > 0,
      retries: fact.retries,
      failures: fact.failures,
      verdict: "配置里已没有这个模型",
      orphan: true,
      issues: [],
      warnings: [
        `会话里用过 ${fact.requests} 轮（provider=${provider}, model=${model}），但当前补丁里没有任何路由声明它 —— 可能是改过路由名/模型名、删了条目，或被别的层覆盖`,
      ],
    });
  }
  return { rows, problems };
}

function fmt(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`用法错误：${String(e.message)}`); process.exit(2); }
  if (o.help) {
    console.log(usageText("verify-effective.mjs"));
    return;
  }
  if (o.nodeModules) EXTRA_NODE_MODULES = o.nodeModules;
  if (!o.patch) { console.error("缺少 --patch（或设置 DSH_HOME_PROFILE_PATCH）"); process.exit(2); }
  if (!existsSync(o.patch)) { console.error(`读不到补丁：${o.patch}`); process.exit(2); }

  let doc;
  try {
    const YAML = loadYaml();
    doc = YAML.parse(readFileSync(o.patch, "utf8"));
    if (!Array.isArray(doc)) throw new Error("补丁顶层不是数组（应为 `- id: …` 列表）");
  } catch (e) {
    console.error(`补丁解析失败（未改动任何文件）：${String(e?.message ?? e)}`);
    process.exit(2);
  }
  const entry = doc.find((x) => x && typeof x === "object" && x.id === "llm-pi-ai");
  const providers = entry?.config?.providers;
  if (!providers || typeof providers !== "object") { console.error("补丁里没有 llm-pi-ai 条目 / 没有 providers:"); process.exit(2); }

  const compactionConfig = compactionConfigFromPatch(doc);
  // v0.3.9（审计 v0.3.8 P0-1）：配置本身在 DSH 加载期就会被拒时，先报出来（exit 1）。
  const configFailures = compactionConfig.validation && !compactionConfig.validation.ok ? compactionConfig.validation.failures : [];
  const compaction = {
    headroomTokens: compactionConfig.headroomTokens ?? 65536,
    thresholdRatio: compactionConfig.thresholdRatio ?? 0.8,
    retainRatio: compactionConfig.retainRatio ?? 0.16,
    retainTokens: compactionConfig.retainTokens,
    duplicates: compactionConfig.duplicates ?? [],
  };

  const loaded = loadSessions(o.sessions, o.last);
  const facts = collectFacts(loaded.events);
  const { rows, problems } = reconcile({ facts, providers, compaction });

  const log = o.log ?? null;
  const sessionsUsable = loaded.sessions.length > 0 && loaded.events.length > 0;
  const phases = [
    { name: "会话记录", ok: sessionsUsable, detail: sessionsUsable ? `${loaded.sessions.length} 个会话、${loaded.events.length} 条事件${loaded.skipped.length ? `（跳过 ${loaded.skipped.length} 个：${loaded.skipped[0].reason}）` : ""}` : `在 ${o.sessions} 下没有可用会话（找到 ${loaded.skipped.length} 个但读不出：${loaded.skipped.map((x) => x.reason).slice(0, 3).join("；") || "无文件"}）` },
    { name: "声明对账", ok: problems.length === 0, detail: problems.length ? `${problems.length} 个模型出现「声明与实际」矛盾` : (sessionsUsable ? "没有矛盾" : "没有可用会话，无法对账") },
    { name: "compaction 配置", ok: configFailures.length === 0, detail: configFailures.length ? configFailures.join("；") : "加载期校验通过" },
  ];
  // P2-1：o.log === null 表示 --no-log，旧版 `log ?? DEFAULT_LOG` 又把它兜回默认文件。
  if (configFailures.length) { console.error("compaction 配置在 DSH 加载期就会被拒："); for (const f of configFailures) console.error(`  ✗ ${f}`); }
  logAttempt(log, { cmd: "verify-effective", patch: o.patch, status: problems.length || configFailures.length ? "fail" : (sessionsUsable ? "ok" : "fail"), phases });

  if (o.json) {
    console.log(JSON.stringify({ sessions: loaded.sessions, skipped: loaded.skipped, rows, problems, compaction }, null, 2));
  } else {
    console.log(`声明 vs 会话记录（${loaded.sessions.length} 个会话 · ${loaded.events.length} 条事件）`);
    for (const r of rows) {
      const mark = r.verdict === "矛盾" ? "✗" : r.verdict.startsWith("未使用") ? "·" : "✓";
      console.log(`${mark} ${r.route} / ${r.model} —— ${r.verdict}`);
      console.log(`    声明 ctx=${fmt(r.declaredCtx)} max=${fmt(r.declaredMax)} image=${r.declaredImage ? "yes" : "no"} ｜ 实际 ctx=${r.runtimeCtx.map(fmt).join(",") || "—"} 最大输入=${fmt(r.maxInputTokens)} 请求=${r.requests}${r.imageUsed ? " 发过图" : ""}${r.reasoningSeen ? " 有 reasoning" : ""}`);
      for (const i of r.issues) console.log(`    ✗ ${i}`);
      for (const i of r.warnings ?? []) console.log(`    · ${i}`);
    }
    if (!rows.length) console.log("（补丁里没有带 models 的路由）");
    if (!sessionsUsable) {
      console.log(`\n✗ 没有任何可用的会话记录，无法判断「声明是否生效」。`);
      console.log(`  查过：${o.sessions}`);
      for (const s2 of loaded.skipped.slice(0, 5)) console.log(`  读不出：${s2.id} —— ${s2.reason}`);
      console.log(`  （这不是「没问题」：本脚本判绿的前提是至少读到一份真实会话。）`);
    } else {
      console.log(problems.length ? `\n结论：${problems.length} 项「声明与实际不一致」——见上。` : "\n结论：没有发现「声明与实际不一致」（未观测到的项标「未使用」，不代表没问题）。");
    }
  }
  // P1-1：读不到任何会话 = 环境错误，exit 2（旧版 0，假绿）
  process.exit(!sessionsUsable ? 2 : (problems.length || configFailures.length ? 1 : 0));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();