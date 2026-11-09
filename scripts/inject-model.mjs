#!/usr/bin/env node
/**
 * inject-model.mjs — 把一条"已探测"的模型声明安全地写进你的 cordis.patch.yml。
 *
 * 设计目标：**坏的一条不能弄坏其它条**。
 *   - 写之前先在隔离的临时目录里跑一遍 strict 校验（dry-run），不过就不写；
 *   - 写入时保留原文件注释与格式，只做最小文本插入；
 *   - 自动备份成 <file>.bak-<时间戳>；
 *   - dsh-hmr 热重载会当场校验，失败会保留旧配置——所以这一步只是"少走一次弯路"。
 *
 * 用法：
 *   # 1) 先探测（不花钱的小请求）
 *   node scripts/probe-capabilities.mjs --base ... --model ... --key-env K --json > /tmp/probe.json
 *   # 2) 生成条目并注入
 *   node scripts/inject-model.mjs --patch ~/.dsh/profiles/web/cordis.patch.yml \
 *        --route custom-myroute --probe /tmp/probe.json --plugin-root /opt/dsh/node_modules
 *   # 只看不写
 *   node scripts/inject-model.mjs ... --dry-run
 *
 * 退出码：0 写入成功（或者 dry-run 校验通过）；1 校验失败/拒绝写入；2 用法错误
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { locateProviders, removeRouteBlock, renderRouteYaml } from "../lib/yaml-edit.mjs";
import { pickSafeMaxTokens } from "../lib/compaction.mjs";
import { computeBudget, compactionConfigFromPatch, policyForRoute } from "../lib/compaction.mjs";
import { resolveWriteTarget, atomicWriteFile, backupFile, rollbackFrom } from "../lib/fs-safe.mjs";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const o = { dryRun: false, pluginRoot: null, headroom: 65536, force: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === "--patch") o.patch = next();
  else if (a === "--route") o.route = next();
  else if (a === "--probe") o.probe = next();
  else if (a === "--plugin-root" || a === "--plugin") o.pluginRoot = next();
  else if (a === "--api-key-env") o.apiKeyEnv = next();
  else if (a === "--display-name") o.displayName = next();
  else if (a === "--dry-run") o.dryRun = true;
  else if (a === "--force") o.force = true;
  else if (a === "--assume-ctx" || a === "--assume-contextWindow") o.assumeCtx = next();
  else if (a === "--max") o.maxOverride = next();
  else if (a === "--api") o.api = next();
  else if (a === "-h" || a === "--help") { console.log("用法见 scripts/inject-model.mjs 顶部注释"); process.exit(0); }
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}
if (!o.patch || !o.route || !o.probe) { console.error("必须给 --patch / --route / --probe"); process.exit(2); }
function numArg(name, v) {
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) { console.error(`--${name} 需要正整数，收到 "${v}"`); process.exit(2); }
  return n;
}
o.headroom = numArg("headroom", String(o.headroom)) ?? 65536;
o.maxOverride = numArg("max", o.maxOverride);
o.assumeCtx = numArg("assume-ctx", o.assumeCtx);

function loadYaml() {
  for (const t of ["yaml", "/opt/dsh/node_modules/yaml", o.pluginRoot ? `${dirname(dirname(o.pluginRoot))}/yaml` : null].filter(Boolean)) {
    try { return require(t); } catch {}
  }
  throw new Error("找不到 yaml 解析器（加 --plugin-root 或在 DSH 安装目录下运行）");
}

let probe;
try { probe = JSON.parse(readFileSync(o.probe, "utf8")); }
catch (e) { console.error(`读不了探测结果 ${o.probe}：${String(e?.message ?? e)}（文件不存在 / 不是 JSON）`); process.exit(2); }
if (!probe || typeof probe !== "object" || Array.isArray(probe)) { console.error("探测结果必须是 JSON 对象（probe-capabilities --json 的输出）"); process.exit(2); }
if (typeof probe.base !== "string" || probe.base.trim() === "") {
  console.error("探测结果里没有 base（baseURL）。请不要手写 probe.json，用 probe-capabilities.mjs --json 生成。");
  process.exit(2);
}
if (typeof probe.model !== "string" || probe.model.trim() === "") {
  console.error("探测结果里没有 model。");
  process.exit(2);
}
const s = probe.summary ?? {};
const modelId = probe.model;

// V6：不再"往大里凑"。审计指出旧版 Math.max(ctx,1e6) / Math.min(max,65536) 与
// method.md 的「填实测值、宁小勿大」直接冲突，还会给非通义网关硬塞 thinkingFormat: qwen。
// 现在：一律用探测到的值；没探测到就拒绝，要求显式 --assume-*（并在报告里标成【未验】）。
function need(name, value, assume) {
  if (value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  if (assume !== undefined && Number.isFinite(Number(assume)) && Number(assume) > 0) {
    console.error(`警告：${name} 未探测到，使用 --assume-${name}=${assume}（这是假设值，不是实测值）`);
    return Number(assume);
  }
  console.error(`拒绝写入：探测结果里没有 ${name}。`);
  console.error(`  真实窗口只能用 probe-capabilities.mjs 的大输入探测得到；量不到就显式给 --assume-${name} <值>。`);
  console.error(`  （不要用 1000000 兜底 —— 那是"猜的"，会让压缩阈值算错。）`);
  process.exit(1);
}
o.assumeCtx ??= undefined;
const ctx = need("contextWindow", s.contextWindow, o.assumeCtx);
const probeMax = s.outputCap;
if (probeMax === null || probeMax === undefined) console.error("警告：输出上限未探测到，退回 --max（默认 65536，保守值）");
// v0.3.1：maxTokens 不再写死 min(probeMax,65536)，改为按 ctx×0.2 与压缩预算反推，
// 否则 ctx=131072 + max=65536 会 pressure=0，写进去必然被 compaction-basic 拒。
const pick = pickSafeMaxTokens({
  contextWindow: ctx,
  gateMax: Number(probeMax) || Number(o.maxOverride) || null,
  headroomTokens: o.headroom,
});
const maxTokens = pick.maxTokens ?? Number(o.maxOverride) ?? 0;
if (pick.maxTokens === null) {
  console.error(`这个窗口（ctx=${ctx}）下没有安全的 maxTokens：${pick.reason}；请调小 --headroom 或换更大窗口的模型。`);
  process.exit(1);
}
const input = ["text", ...(s.vision ? ["image"] : [])];
const switchable = Array.isArray(s.thinkingSwitchable) && s.thinkingSwitchable.length > 0;

// thinkingFormat：只认探测给出的 switchFormat；没有证据就**不写**这个字段（宁可少写）。
const fmt = switchable ? (s.switchFormat ?? null) : null;
if (!fmt) console.error("提示：探测没证明这个端点能开/关思考，不写 compat（宁可少写，避免静默退化）。");
// 只有真探测到「思考可开关」才写 compat；否则整块不写，别塞一个没证据的 supportsReasoningEffort。
const effortProven = switchable && (s.thinkingSwitchable ?? []).some((v) => String(v).startsWith("reasoning_effort"));
const compat = fmt
  ? { thinkingFormat: fmt, ...(effortProven ? { supportsReasoningEffort: true } : {}) }
  : null;

// 压缩联动自检：三个数字（ctx / maxTokens / headroom）必须过 dsh-compaction-basic 的硬约束。
// 公式来自 lib/compaction.mjs（唯一副本）；具体 headroom 在读到目标 patch 里的
// compaction-basic 配置后才能确定（可能被 headroomTokens / modelPolicies 覆盖）。
function budgetCheck(compactionCfg) {
  const policy = policyForRoute(
    compactionCfg ?? { headroomTokens: o.headroom, thresholdRatio: 0.8, retainRatio: 0.16, retainTokens: null, modelPolicies: [] },
    o.route,
    modelId,
  );
  return computeBudget({
    contextWindow: ctx,
    reservedCompletionTokens: maxTokens,
    headroomTokens: o.headroom ?? policy.headroomTokens,
    thresholdRatio: policy.thresholdRatio,
    retainRatio: policy.retainRatio,
    retainTokens: policy.retainTokens,
  });
}

// api：探测脚本只会说 OpenAI 兼容协议（它自己就是按 /chat/completions 打的），
// 绝不能拿 summary.accent（那是 thinkingFormat 的口味，如 "qwen"）当 api 写进 YAML。
const apiKind = o.api ?? "openai-completions";
const profile = {
  displayName: o.displayName ?? o.route,
  api: apiKind,
  baseURL: probe.base,
  apiKeyEnv: o.apiKeyEnv ?? "YOUR_KEY_ENV",
  defaultInput: ["text"],
  defaultMaxTokens: maxTokens,
  models: [{
    id: modelId,
    name: modelId,
    contextWindow: ctx,
    maxTokens,
    input,
    ...(compat ? { compat } : {}),
    // v0.3.1：档位只在实测证明「开关能变」时才写；off 档只在实测关得掉时写；
    // 多档只在 reasoning_effort 真的生效时写（否则 UI 上是两个等价档）。
    ...(switchable
      ? {
          reasoningEfforts: {
            ...(s.thinkingCanDisable === false ? {} : { off: null }),
            ...(effortProven ? { low: "low", high: "high" } : { high: "high" }),
          },
        }
      : { reasoningEfforts: false }),
  }],
};

const YAML = loadYaml();
let text;
try { text = readFileSync(o.patch, "utf8"); }
catch (e) { console.error(`读不到 ${o.patch}：${String(e?.message ?? e)}`); process.exit(2); }

// 缩进从目标文件探测（4 空格缩进的文件也支持）
let lines = text.split("\n");
let anchor;
try { anchor = locateProviders(lines); }
catch (e) { console.error(`${String(e?.message ?? e)}`); process.exit(1); }
lines = removeRouteBlock(lines, o.route, anchor.childIndent);
if (lines.length !== text.split("\n").length) {
  console.error(`提示：已移除旧的 ${o.route} 条目，按探测结果重新生成（幂等）。`);
  text = lines.join("\n");
}
const block = renderRouteYaml(o.route, profile, anchor.childIndent, YAML) + "\n";
const doc = YAML.parse(text);
if (!Array.isArray(doc)) { console.error(`${o.patch} 顶层不是数组`); process.exit(2); }
const entry = doc.find((e) => e?.id === "llm-pi-ai");
if (!entry) { console.error("补丁里没有 - id: llm-pi-ai 条目，请先按 examples/cordis.patch.yml 建一份"); process.exit(1); }
const providers = entry.config?.providers ?? {};
if (providers[o.route]) console.error(`警告：路由 ${o.route} 已存在，将被文本替换覆盖`);

// 第 3 段：压缩预算（用目标文件里 compaction-basic 的真实 headroom/modelPolicies）
const compactionCfg = compactionConfigFromPatch(doc);
const budget = budgetCheck(compactionCfg);
if (!budget.ok && !o.force) {
  console.error("拒绝写入，这条声明会让 DSH 启动失败或抖动：");
  for (const p of budget.problems) console.error("  ✗ " + p);
  console.error("用一个更小的 --max（或更大的窗口）再试，或加 --force 强行写入。");
  process.exit(1);
}

// ── 预演：在临时目录里合并校验（不碰真实文件）
const merged = structuredClone(doc);
const mEntry = merged.find((e) => e?.id === "llm-pi-ai");
mEntry.config ??= {};
mEntry.config.providers ??= {};
mEntry.config.providers[o.route] = profile;
const tmp = mkdtempSync(join(tmpdir(), "inject-"));
writeFileSync(join(tmp, "merged.yml"), YAML.stringify(merged));

function preflight() {
  // 用 resolve-check 的同一套办法：独立进程跑，避免污染
  const { execFileSync } = require("node:child_process");
  const args = [join(dirname(new URL(import.meta.url).pathname), "resolve-check.mjs"), "--patch", join(tmp, "merged.yml"), "--lint"];
  if (o.pluginRoot) args.push("--plugin-root", o.pluginRoot);
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const pre = preflight();
rmSync(tmp, { recursive: true, force: true });
if (!pre.ok) {
  console.error("预演校验失败，没有写入文件：");
  console.error(pre.out.trim().split("\n").slice(0, 12).map((l) => "  " + l).join("\n"));
  process.exit(1);
}

if (o.dryRun) {
  console.log("预演通过，将写入以下片段：\n" + block);
  console.log("（--dry-run：未改动文件）");
  process.exit(0);
}

// ── 真正的文本插入：插在 llm-pi-ai 的 providers: 之后（保留注释与格式）
const cur = text.split("\n");
let at;
try { at = locateProviders(cur); }
catch (e) { console.error(`${String(e?.message ?? e)}（文件未改）`); process.exit(1); }
const updated = [...cur.slice(0, at.line + 1), ...block.split("\n").slice(0, -1), ...cur.slice(at.line + 1)].join("\n");

// 软链先解析（避免把 dotfiles 软链替换成普通文件），写入走「临时文件 + rename」原子替换
// （cordis.patch.yml 被 dsh-hmr 监听，半截文件会触发一次失败的配置重载）。
const { target: realTarget, viaSymlink } = resolveWriteTarget(o.patch);
if (viaSymlink) console.error(`注意：${o.patch} 是软链，实际写入 ${realTarget}。`);
let bak;
try { bak = backupFile(o.patch, new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "")); }
catch (e) { console.error(`无法创建备份：${String(e?.message ?? e)}（目录只读？）未改动文件。`); process.exit(1); }
try {
  atomicWriteFile(realTarget, updated, {
    check: (t) => { YAML.parse(t); },
  });
} catch (e) {
  try { rollbackFrom(bak, realTarget); } catch {}
  console.error(`写入失败：${String(e?.message ?? e)}（已回滚到 ${bak}）`);
  process.exit(1);
}
// 写入后再验一次，不通过就回滚
const post = (() => {
  const { execFileSync } = require("node:child_process");
  const args = [join(dirname(new URL(import.meta.url).pathname), "resolve-check.mjs"), "--patch", realTarget, "--lint"];
  if (o.pluginRoot) args.push("--plugin-root", o.pluginRoot);
  try { return { ok: true, out: execFileSync(process.execPath, args, { encoding: "utf8" }) }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
})();
if (!post.ok) {
  try { rollbackFrom(bak, realTarget); } catch {}
  console.error("写入后校验失败，已回滚到备份 " + bak);
  console.error(post.out.trim().split("\n").slice(0, 10).map((l) => "  " + l).join("\n"));
  process.exit(1);
}
console.log(`✓ 已写入 ${realTarget}`);
console.log(`  备份：${bak}`);
console.log(`  路由：${o.route} / ${modelId}  ctx=${ctx} max=${maxTokens} input=[${input}]`);
console.log(`  压缩：B=${budget.messageBudgetTokens} threshold=${budget.thresholdTokens} retain=${budget.retainTokens} gap=${budget.gap} ${budget.ok ? "✓" : "⚠"}`);
console.log("  dsh-hmr 会热重载；如果重载校验失败，用备份恢复即可。");
