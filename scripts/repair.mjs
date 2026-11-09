#!/usr/bin/env node
/**
 * repair.mjs — 按「探针实测结果」自动修正已经写错的声明（在原文上改字段，不整份重写）。
 *
 * 解决什么问题：probe-capabilities 只告诉你「实测是多少」，不会替你改 YAML；
 * 而手改容易忘、改一半、改错档位。本脚本做闭环：
 *
 *   探针结果 + 现有 patch → 逐字段算「应该是什么」→ 三方校验（Config/语义/压缩预算）
 *   → 备份 + 原子写 → 写后再校验一遍 → 失败自动回滚 → 全程记 JSONL 日志
 *
 * 修正规则（和 lib/snippet.mjs 共用 thinkingDecl，避免两套规则漂移）：
 *   - contextWindow：用探针实测值；没测到就**不猜**，保持原值并在日志里说明
 *   - maxTokens：pickSafeMaxTokens（≤min(网关实测上限, ctx×0.2) 且过压缩预算），算不出来就**不改**并报错
 *   - input：探针证明能看图才加 image；证明不能看就把 image 去掉
 *   - compat.thinkingFormat / supportsReasoningEffort / reasoningEfforts：按 thinkingDecl
 *
 * 用法：
 *   node scripts/repair.mjs --patch ~/.dsh/profiles/web/cordis.patch.yml \
 *     --probe /tmp/probe.json                 # 先看 diff（默认 dry-run，不写盘）
 *   node scripts/repair.mjs --patch … --probe … --apply --log ./repair.log.jsonl
 *
 * 退出码：0 = 无需修正 或 已成功修正；1 = 有无法修正的项 / 写后校验失败已回滚；2 = 用法/环境错误
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pickSafeMaxTokens, compactionConfigFromPatch } from "../lib/compaction.mjs";
import { thinkingDecl } from "../lib/snippet.mjs";
import { verifyLoadPath } from "../lib/load-path.mjs";
import { resolveWriteTarget, backupFile, atomicWriteFile, rollbackFrom, contentFingerprint, assertUnchanged } from "../lib/fs-safe.mjs";
import { locateProviders, removeRouteBlock, renderRouteYaml, detectEol, normalizeEol, applyEol, findRouteBlock } from "../lib/yaml-edit.mjs";
import { logAttempt, logChange, attemptKey, DEFAULT_LOG } from "../lib/runlog.mjs";
import { usageText } from "../lib/usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadYaml() {
  const tries = ["yaml", "/opt/dsh/node_modules/yaml", process.env.DSH_NODE_MODULES ? `${process.env.DSH_NODE_MODULES}/yaml` : null].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch { /* next */ } }
  throw new Error(`找不到 yaml 解析器（试过 ${tries.join(" / ")}）`);
}

function parseArgs(argv) {
  const o = {
    patch: process.env.DSH_HOME_PROFILE_PATCH ?? null, probe: null,
    routes: [], apply: false, log: DEFAULT_LOG, pluginRoot: "/opt/dsh/node_modules", json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--patch") o.patch = argv[++i];
    else if (a === "--probe") o.probe = argv[++i];
    else if (a === "--route") o.routes.push(argv[++i]);
    else if (a === "--plugin-root" || a === "--plugin") o.pluginRoot = argv[++i];
    else if (a === "--log") o.log = argv[++i];
    else if (a === "--no-log") o.log = null;
    else if (a === "--apply") o.apply = true;
    else if (a === "--dry-run") o.apply = false;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else o.patch ??= a;
  }
  return o;
}

/** --plugin-root 可以是安装目录（含 node_modules）或包目录本身；统一解析到包目录。 */
function locatePluginRoot(r) {
  const cands = [
    r,
    resolve(r, "@deepseek-ai", "dsh-llm-pi-ai"),
    resolve(r, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai"),
  ];
  for (const c of cands) if (existsSync(resolve(c, "lib", "index.js"))) return c;
  return null;
}

const normBase = (u) => String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
// v0.3.8（P2-6）：旧版只比 host，同主机不同 scheme/path 会被当成同一端点，
// 可能把 A 端点的探针结果写到 B 端点路由。这里要求 scheme+host+path 全等
// （host 相同、路径不同但 baseURL 只差末尾斜杠的情况由 normBase 兜住）。
const fullOf = (u) => {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}`.toLowerCase(); }
  catch { return ""; }
};
const sameEndpoint = (a, b) => Boolean(a && b) && (normBase(a) === normBase(b) || (fullOf(a) !== "" && fullOf(a) === fullOf(b)));

/** verifyLoadPath 返回 {schema, semantic, routes, budget}（没有顶层 ok）——这里统一成一个结论。 */
function flattenVerify(res) {
  const failures = [];
  if (!res) return { ok: false, failures: ["校验没有返回结果"] };
  if (!res.schema?.ok) failures.push(`Config 层：${res.schema?.error ?? "失败"}`);
  if (!res.semantic?.ok) failures.push(`语义层：${res.semantic?.error ?? "失败"}`);
  for (const [name, r] of Object.entries(res.routes ?? {})) {
    if (r?.error) failures.push(`路由 ${name}：${r.error}`);
  }
  for (const f of res.budget?.failures ?? []) failures.push(`压缩预算：${f}`);
  return { ok: failures.length === 0, failures };
}

const fmt = (v) => (v === undefined ? "（不写）" : JSON.stringify(v));

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`用法错误：${String(e.message)}`); process.exit(2); }
  if (o.help) { console.log(usageText("repair.mjs")); return; }
  if (!o.patch) { console.error("缺少 --patch（或设置 DSH_HOME_PROFILE_PATCH）"); process.exit(2); }
  if (!o.probe) { console.error("缺少 --probe：请先用 probe-capabilities.mjs --json 生成探测结果"); process.exit(2); }
  if (!existsSync(o.patch)) { console.error(`读不到补丁：${o.patch}`); process.exit(2); }
  const pluginRoot = locatePluginRoot(o.pluginRoot);
  if (!pluginRoot) { console.error(`找不到 dsh-llm-pi-ai 包（试过 ${o.pluginRoot} 及其子目录）；用 --plugin-root 指向安装目录`); process.exit(2); }
  if (!existsSync(o.probe)) { console.error(`读不到探测结果：${o.probe}`); process.exit(2); }

  let probe;
  try { probe = JSON.parse(readFileSync(o.probe, "utf8")); } catch (e) { console.error(`探测结果不是合法 JSON：${String(e?.message ?? e)}`); process.exit(2); }
  const summary = probe?.summary ?? {};
  const probeBase = probe?.base;
  const probeModel = probe?.model;
  if (!probeBase || !probeModel) { console.error("探测结果缺 base/model（不要手写，用 probe-capabilities --json）"); process.exit(2); }

  let rawText;
  try { rawText = readFileSync(o.patch, "utf8"); } catch (e) { console.error(`读不到补丁：${String(e?.message ?? e)}`); process.exit(2); }
  const eol = detectEol(rawText);
  if (rawText.charCodeAt(0) === 0xfeff) { rawText = rawText.slice(1); console.error("提示：文件开头有 BOM，已按无 BOM 处理。"); }
  const text = normalizeEol(rawText);

  const YAML = loadYaml();
  let doc;
  try { doc = YAML.parse(text); } catch (e) { console.error(`补丁解析失败（未改动任何文件）：${String(e?.message ?? e)}`); process.exit(2); }
  if (!Array.isArray(doc)) { console.error("补丁顶层不是数组（应为 `- id: …` 列表）"); process.exit(2); }
  const entry = doc.find((x) => x && typeof x === "object" && (x.id === "llm-pi-ai"));
  const providers = entry?.config?.providers;
  if (!providers || typeof providers !== "object") { console.error("补丁里没有 llm-pi-ai / providers:"); process.exit(2); }

  const compaction = compactionConfigFromPatch(doc);
  const headroomTokens = compaction.headroomTokens ?? 65536;
  const policies = Object.fromEntries((compaction.modelPolicies ?? []).map((p) => [String(p?.model ?? ""), p]));

  // ── 1. 找目标（默认按 baseURL 同主机 + model id 匹配；--route 可强制） ──
  const targets = [];
  for (const [routeName, route] of Object.entries(providers)) {
    if (!route || typeof route !== "object") continue;
    if (o.routes.length && !o.routes.includes(routeName)) continue;
    const endpointOk = sameEndpoint(route.baseURL, probeBase);
    if (!endpointOk && !o.routes.length) continue;
    const models = Array.isArray(route.models) ? route.models : [];
    models.forEach((m, idx) => {
      if (!m || typeof m !== "object") return;
      if (!o.routes.length && m.id !== probeModel) return;
      targets.push({ routeName, route, model: m, idx });
    });
  }
  if (!targets.length) {
    const msg = `没有匹配到目标：探针是 ${probeBase} / ${probeModel}。检查 --patch 里的 baseURL，或用 --route 指定。`;
    console.error(msg);
    const rec = logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "fail", phases: [{ name: "匹配目标", ok: false, detail: msg }] });
    if (o.json) console.log(JSON.stringify({ ok: false, reason: msg, record: rec }, null, 2));
    process.exit(1);
  }

  // ── 2. 逐字段算目标值 ──
  const changes = [];
  const blockers = [];
  for (const t of targets) {
    const m = t.model;
    const policy = policies[m.id] ?? {};
    const localHeadroom = Number.isFinite(policy.headroomTokens) ? policy.headroomTokens : headroomTokens;
    const measuredCtx = Number.isFinite(summary.contextWindow) && summary.contextWindow > 0 ? summary.contextWindow : null;
    const ctx = measuredCtx ?? (Number.isFinite(m.contextWindow) ? m.contextWindow : (Number.isFinite(t.route.defaultContextWindow) ? t.route.defaultContextWindow : null));
    if (!Number.isFinite(ctx)) {
      blockers.push(`${t.routeName}/${m.id}：探针没测到窗口（加 --window），且现有声明也没有 contextWindow —— 不知道填多少，不猜`);
      continue;
    }
    if (!measuredCtx) console.error(`提示：${t.routeName}/${m.id} 没测到窗口，沿用现有 ${ctx}；建议以后加 --window 实测。`);

    // v0.3.8（P1-5）：只有真测到网关上限（gateMaxTokens / 旧版 outputCap）才允许
    // 按 min(gate, ctx×0.2) 反推；没测到就「只能降不能升」，绝不拿「没测到」当「没上限」。
    const measuredGate = Number.isFinite(summary.gateMaxTokens) ? summary.gateMaxTokens
      : (Number.isFinite(summary.outputCap) ? summary.outputCap : null);
    const pick = pickSafeMaxTokens({ contextWindow: ctx, gateMax: measuredGate, headroomTokens: localHeadroom });
    if (measuredGate === null && pick.maxTokens !== null) {
      const cur = Number.isFinite(m.maxTokens) ? m.maxTokens : pick.maxTokens;
      if (pick.maxTokens > cur) {
        // 没有上限证据：保持现状（只能降），并在提示里说明为什么没照「ctx×0.2」调大
        pick.maxTokens = cur;
        pick.reason = `没测到网关输出上限（probe 里没有 gateMaxTokens），不向上调整 maxTokens，保持 ${cur}`;
      }
    }
    if (pick.maxTokens === null) {
      blockers.push(`${t.routeName}/${m.id}：窗口 ${ctx} 下没有任何 maxTokens 能过压缩预算（${pick.reason}）——需要调小 headroomTokens 或换更大窗口的模型`);
      continue;
    }

    const want = {
      contextWindow: ctx,
      maxTokens: pick.maxTokens,
      input: (() => {
        const cur = Array.isArray(m.input) ? m.input.slice() : (Array.isArray(t.route.defaultInput) ? t.route.defaultInput.slice() : ["text"]);
        const hasImage = cur.includes("image");
        if (summary.vision === true && !hasImage) return [...cur, "image"];
        if (summary.vision === false && hasImage) return cur.filter((x) => x !== "image");
        return cur;
      })(),
    };
    const switchableKnownEmpty = Array.isArray(summary.thinkingSwitchable) && summary.thinkingSwitchable.length === 0;
    const decl = switchableKnownEmpty ? { compat: null, efforts: false, notes: ["探针明确「开不了思考」（thinkingSwitchable=[]）：不写 compat/reasoningEfforts"] } : thinkingDecl({
      format: summary.switchFormat ?? null,
      defaultOn: summary.thinkingDefaultOn === true,
      canDisable: summary.thinkingCanDisable === true,
      canEnable: summary.thinkingCanEnable === true,
      supportsEffort: summary.thinkingSupportsEffort === true,
      levels: summary.thinkingCanEnable && summary.thinkingCanDisable ? ["low", "high"] : ["high"],
    });

    const diffs = [];
    if (m.contextWindow !== want.contextWindow) diffs.push({ field: "contextWindow", from: m.contextWindow, to: want.contextWindow });
    if (m.maxTokens !== want.maxTokens) diffs.push({ field: "maxTokens", from: m.maxTokens, to: want.maxTokens });
    if (JSON.stringify(m.input ?? null) !== JSON.stringify(want.input)) diffs.push({ field: "input", from: m.input, to: want.input });
    const oldEfforts = m.reasoningEfforts === undefined ? undefined : m.reasoningEfforts;
    if (JSON.stringify(oldEfforts ?? null) !== JSON.stringify(decl.efforts === false ? false : decl.efforts)) {
      diffs.push({ field: "reasoningEfforts", from: oldEfforts, to: decl.efforts });
    }
    if (decl.compat) {
      const oldCompat = m.compat && typeof m.compat === "object" ? m.compat : undefined;
      if (JSON.stringify(oldCompat?.thinkingFormat) !== JSON.stringify(decl.compat.thinkingFormat)) {
        diffs.push({ field: "compat.thinkingFormat", from: oldCompat?.thinkingFormat, to: decl.compat.thinkingFormat });
      }
      if (Boolean(oldCompat?.supportsReasoningEffort) !== Boolean(decl.compat.supportsReasoningEffort)) {
        diffs.push({ field: "compat.supportsReasoningEffort", from: oldCompat?.supportsReasoningEffort, to: decl.compat.supportsReasoningEffort ?? null });
      }
    } else if (m.compat && typeof m.compat === "object" && ("thinkingFormat" in m.compat || "supportsReasoningEffort" in m.compat)) {
      diffs.push({ field: "compat（删除无证据的项）", from: { thinkingFormat: m.compat.thinkingFormat, supportsReasoningEffort: m.compat.supportsReasoningEffort }, to: "（删除）" });
    }

    if (!diffs.length) { changes.push({ ...t, diffs: [] }); continue; }
    changes.push({ ...t, diffs, want, decl });
  }

  const pending = changes.filter((c) => c.diffs.length);
  const key = attemptKey({ cmd: "repair", patch: o.patch });

  // ── 3. dry-run 输出 ──
  if (!o.apply) {
    for (const c of changes) {
      const tag = c.diffs.length ? "✎" : "✓";
      console.log(`${tag} ${c.routeName} / ${c.model.id}`);
      for (const d of c.diffs) console.log(`    ${d.field}: ${fmt(d.from)} → ${fmt(d.to)}`);
      if (!c.diffs.length) console.log("    无需修正（与探针一致）");
    }
    for (const b of blockers) console.log(`✗ ${b}`);
    console.log(`\n（dry-run：没有改动文件。加 --apply 才写盘；写前会再做三方校验并备份）`);
    logAttempt(o.log, {
      cmd: "repair", patch: o.patch, status: blockers.length ? "fail" : "ok",
      phases: [
        { name: "计算修正", ok: changes.length > 0, detail: `${pending.length} 个模型需要改` },
        { name: "可修正性", ok: blockers.length === 0, detail: blockers.join("；") },
      ],
    });
    process.exit(blockers.length ? 1 : 0);
  }

  if (blockers.length) {
    console.error("有无法自动修正的项，未改动任何文件：");
    for (const b of blockers) console.error(`  ✗ ${b}`);
    logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "fail", phases: [{ name: "可修正性", ok: false, detail: blockers.join("；") }] });
    process.exit(1);
  }
  if (!pending.length) {
    console.log("✓ 所有匹配的模型声明都与探针一致，不需要修正。");
    logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "ok", phases: [{ name: "计算修正", ok: true, detail: "无需修改" }] });
    process.exit(0);
  }

  // ── 4. 写盘前先验：按修正后的对象跑三方校验（不落盘） ──
  for (const c of pending) {
    const m = c.model;
    m.contextWindow = c.want.contextWindow;
    m.maxTokens = c.want.maxTokens;
    m.input = c.want.input;
    m.reasoningEfforts = c.decl.efforts === false ? false : c.decl.efforts;
    if (c.decl.compat) m.compat = { ...(m.compat && typeof m.compat === "object" ? m.compat : {}), ...c.decl.compat };
    else if (m.compat && typeof m.compat === "object") { delete m.compat.thinkingFormat; delete m.compat.supportsReasoningEffort; if (!Object.keys(m.compat).length) delete m.compat; }
  }
  // 修正 P2-2：只校验这次真正改动的路由。整份校验会让「无关路由本来就不合理」
  // 把目标路由也卡死（安全但用户无法修任何东西）。
  const touched = {};
  for (const c of pending) touched[c.routeName] = providers[c.routeName];
  let pre;
  try {
    pre = flattenVerify(await verifyLoadPath(pluginRoot, touched, "strict", { compaction }));
  } catch (e) {
    console.error(`写前校验跑不起来（未改动文件）：${String(e?.message ?? e)}`);
    logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "fail", phases: [{ name: "写前校验", ok: false, detail: String(e?.message ?? e) }] });
    process.exit(1);
  }
  if (!pre.ok) {
    console.error("修正后的声明仍然过不了校验，未改动文件：");
    for (const f of pre.failures.slice(0, 10)) console.error(`  ✗ ${f}`);
    logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "fail", phases: [{ name: "写前校验", ok: false, detail: pre.failures.join("；") }] });
    process.exit(1);
  }

  // ── 5. 改文本：整块重渲染被修正的路由（会重排版式，注释会丢） ──
  const { lines, childIndent } = locateProviders(text.split("\n"));
  let next = text;
  const rendered = new Map();
  for (const c of pending) {
    const block = renderRouteYaml(c.routeName, c.route, childIndent, YAML);
    rendered.set(c.routeName, block);
  }
  // 从后往前替换，避免索引错位：先按原始文本定位每个路由块的起止
  // v0.3.8（P0-1）：用 findRouteBlock —— 兄弟路由同缩进，旧扫描会把它们吞掉。
  const curLines = next.split("\n");
  const spots = [];
  for (const routeName of rendered.keys()) {
    const r = findRouteBlock(curLines, routeName, childIndent);
    if (!r) { console.error(`找不到路由 ${routeName} 的键行（缩进或引号可能不同），未改动文件`); process.exit(1); }
    spots.push({ i: r.start, j: r.end, block: rendered.get(routeName) });
  }
  spots.sort((a, b) => b.i - a.i);
  for (const s of spots) {
    next = [...curLines.slice(0, s.i), ...s.block.split("\n"), ...curLines.slice(s.j)].join("\n");
  }
  const outText = applyEol(next, eol);

  // ── 6. 备份 + 原子写 ──
  // v0.3.8（P1-4）：读入 → 计算 → 写盘之间有秒级窗口，别人在这期间改了文件，
  // 旧版会整份覆盖（丢更新）还报成功。写前核对内容指纹，变了就中止。
  const { target } = resolveWriteTarget(o.patch);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  let bak = null;
  try {
    assertUnchanged(target, contentFingerprint(rawText));
    bak = backupFile(target, stamp);
    atomicWriteFile(target, outText, {
      check: (content) => {
        const d = YAML.parse(content);
        if (!Array.isArray(d)) throw new Error("写出来的不是数组");
        const e = d.find((x) => x && x.id === "llm-pi-ai");
        if (!e?.config?.providers) throw new Error("写出来的文件里没有 providers:");
      },
    });
  } catch (e) {
    console.error(`写入失败：${String(e?.message ?? e)}${bak ? `（备份在 ${bak}，文件未被破坏）` : ""}`);
    logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "fail", phases: [{ name: "写盘", ok: false, detail: String(e?.message ?? e) }] });
    process.exit(1);
  }

  // ── 7. 写后再验一遍：失败就回滚 ──
  let post = null;
  try {
    const d2 = YAML.parse(readFileSync(target, "utf8"));
    const p2 = d2.find((x) => x && x.id === "llm-pi-ai")?.config?.providers;
    post = flattenVerify(await verifyLoadPath(pluginRoot, p2, "strict", { compaction: compactionConfigFromPatch(d2) }));
  } catch (e) {
    post = { ok: false, failures: [String(e?.message ?? e)] };
  }
  if (!post.ok) {
    console.error("写后校验失败，已回滚：");
    for (const f of post.failures.slice(0, 8)) console.error(`  ✗ ${f}`);
    try { rollbackFrom(bak, target); } catch (e) { console.error(`回滚也失败了：${String(e?.message ?? e)}；备份仍在 ${bak}`); }
    logAttempt(o.log, { cmd: "repair", patch: o.patch, status: "fail", phases: [{ name: "写后校验", ok: false, detail: post.failures.join("；") }] });
    process.exit(1);
  }

  // ── 8. 日志：每个字段改动 + 本次结论（含上一轮失败原因） ──
  for (const c of pending) {
    for (const d of c.diffs) {
      logChange(o.log, { key, field: `${c.routeName}/${c.model.id}.${d.field}`, from: d.from, to: d.to, reason: `探针：ctx=${summary.contextWindow ?? "未测"}, gateMax=${summary.gateMaxTokens}, vision=${summary.vision}, format=${summary.switchFormat}` });
    }
  }
  const rec = logAttempt(o.log, {
    cmd: "repair", patch: o.patch, status: "ok",
    phases: [
      { name: "计算修正", ok: true, detail: `${pending.length} 个模型` },
      { name: "写前校验", ok: true },
      { name: "写盘", ok: true },
      { name: "写后校验", ok: true },
    ],
  });
  console.log(`✓ 已修正 ${pending.length} 个模型，写后三方校验通过。`);
  console.log(`  备份：${bak}`);
  if (o.log) console.log(`  日志：${o.log}${rec?.prevFailure ? `\n  上次失败：${rec.prevFailure}` : ""}`);
  if (o.json) console.log(JSON.stringify({ ok: true, changed: pending.map((c) => ({ route: c.routeName, model: c.model.id, diffs: c.diffs })), backup: bak, record: rec }, null, 2));
}

main().catch((e) => { console.error(`未捕获错误：${String(e?.stack ?? e)}`); process.exit(1); });