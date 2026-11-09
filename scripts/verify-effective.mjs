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

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadYaml() {
  const tries = [
    "yaml",
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
  for (const s of found.slice(0, limit)) {
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
  const curOf = (sid) => current.get(sid) ?? { provider: "?", model: "?" };
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "request/context") {
      const c = { provider: d.provider ?? "?", model: d.model ?? "?" };
      current.set(e.session, c);
      const f = get(c.provider, c.model);
      if (Number.isFinite(d.contextWindow)) f.contextWindows.add(d.contextWindow);
      f.sessions.add(e.session);
    } else if (e.type === "request/header") {
      const c = d.header?.config ?? {};
      if (c.provider || c.model) {
        const cfg = { provider: c.provider ?? "?", model: c.model ?? "?" };
        current.set(e.session, cfg);
        get(cfg.provider, cfg.model).sessions.add(e.session);
      }
    } else if (e.type === "assistant/message") {
      const cfg = curOf(e.session);
      const f = get(cfg.provider, cfg.model);
      f.requests += 1;
      f.sessions.add(e.session);
      const u = d.usage ?? {};
      if (Number.isFinite(u.inputTokens)) f.maxInputTokens = Math.max(f.maxInputTokens, u.inputTokens);
      const content = d.message?.content ?? [];
      if (Array.isArray(content)) {
        if (content.some((c) => c?.type === "image")) f.imageMessages += 1;
        if (content.some((c) => c?.type === "reasoning")) f.reasoningMessages += 1;
      }
    } else if (e.type === "user/message") {
      const content = d.message?.content ?? [];
      if (Array.isArray(content) && content.some((c) => c?.type === "image")) {
        const cfg = curOf(e.session);
        get(cfg.provider, cfg.model).imageMessages += 1;
      }
    } else if (e.type === "assistant/attempt") {
      const cfg = curOf(e.session);
      const stream = Array.isArray(d.stream) ? d.stream : [];
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
  for (const [routeName, route] of Object.entries(providers ?? {})) {
    const models = Array.isArray(route?.models) ? route.models : [];
    for (const m of models) {
      const id = m?.id;
      if (!id) continue;
      const fact = facts.get(`${routeName}\u0000${id}`) ?? null;
      const declaredCtx = Number.isFinite(m.contextWindow)
        ? m.contextWindow
        : (Number.isFinite(route.defaultContextWindow) ? route.defaultContextWindow : 1000000);
      const declaredMax = Number.isFinite(m.maxTokens)
        ? m.maxTokens
        : (Number.isFinite(route.defaultMaxTokens) ? route.defaultMaxTokens : 128000);
      const declaredImage = Array.isArray(m.input) ? m.input.includes("image") : Array.isArray(route.defaultInput) ? route.defaultInput.includes("image") : false;
      const budget = computeBudget({ contextWindow: declaredCtx, reservedCompletionTokens: declaredMax, headroomTokens: compaction.headroomTokens, thresholdRatio: compaction.thresholdRatio, retainRatio: compaction.retainRatio, retainTokens: compaction.retainTokens });

      const row = {
        route: routeName, model: id,
        declaredCtx, declaredMax, declaredImage,
        runtimeCtx: fact ? [...fact.contextWindows] : [],
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

      for (const cw of row.runtimeCtx) {
        if (cw !== declaredCtx) {
          row.issues.push(`运行时 contextWindow=${cw}，声明是 ${declaredCtx} —— 「声明没生效」或被别的层覆盖`);
        }
      }
      if (row.maxInputTokens >= budget.thresholdTokens && budget.ok) {
        row.issues.push(`最大输入 ${row.maxInputTokens} ≥ 压缩阈值 ${budget.thresholdTokens}：说明声明的大窗口/大 maxTokens 没有让压缩按预期触发`);
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
      row.warnings = [];
      for (const { c, n, sample } of byClass.values()) {
        const line = `[${c.id}] ${c.hint}（${n} 次）：${sample.slice(0, 160)}`;
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
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return;
  }
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
  const phases = [
    { name: "会话记录", ok: loaded.sessions.length > 0, detail: loaded.sessions.length ? `${loaded.sessions.length} 个会话、${loaded.events.length} 条事件${loaded.skipped.length ? `（跳过 ${loaded.skipped.length} 个：${loaded.skipped[0].reason}）` : ""}` : `在 ${o.sessions} 下没找到 session.v4.jsonl.zstd` },
    { name: "声明对账", ok: problems.length === 0, detail: problems.length ? `${problems.length} 个模型出现「声明与实际」矛盾` : "没有矛盾" },
  ];
  logAttempt(log ?? DEFAULT_LOG, { cmd: "verify-effective", patch: o.patch, status: problems.length ? "fail" : "ok", phases });

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
    console.log(problems.length ? `\n结论：${problems.length} 项「声明与实际不一致」——见上。` : "\n结论：没有发现「声明与实际不一致」（未观测到的项标「未使用」，不代表没问题）。");
  }
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();