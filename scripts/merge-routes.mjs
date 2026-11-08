#!/usr/bin/env node
/**
 * merge-routes.mjs — 按 **路由** 粒度合并声明：单条失败不拖累全局。
 *
 * 解决的问题：DSH 的 strict 校验是「全体或全无」。批量导入 10 个端口，
 * 只要有 1 条声明写错，整份 cordis.patch.yml 被拒 —— 其余 9 个也全废。
 *
 * 做法：
 *   1. 候选路由来自 --from 文件；
 *   2. **once 用一个进程跑完全部候选**（deferred 模式），逐路由拿到通过/失败；
 *   3. 通过的写进目标文件里一段自动维护的托管块，失败的列出来并跳过；
 *   4. 写前备份、写后整体复验，复验不过自动回滚。
 *
 * 托管块（脚本管理这段，手改会被覆盖；块外的路由永不改动）：
 *   providers:
 *     custom-manual: {...}
 *     # >>> managed-by-dsh-model-compat
 *     custom-a: {...}
 *     # <<< managed-by-dsh-model-compat
 *
 * 用法：
 *   node scripts/merge-routes.mjs --patch ~/.dsh/profiles/web/cordis.patch.yml \
 *        --from a.yml --from b.yml --plugin-root /opt/dsh/node_modules
 *   ... --dry-run     只看会写什么
 *   ... --no-verify   跳过写后整体复验（不推荐）
 *
 * 退出码：0 = 至少一条可用（或文件已是最新）；1 = 全部失败/复验失败已回滚；2 = 用法错误
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { staticAudit } from "../lib/audit.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BEGIN_MARK = "# >>> managed-by-dsh-model-compat（以下由 merge-routes.mjs 维护，手改会被覆盖）";
const END_MARK = "# <<< managed-by-dsh-model-compat";

const o = { from: [], dryRun: false, verify: true, pluginRoot: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], nx = () => argv[++i];
  if (a === "--patch") o.patch = nx();
  else if (a === "--from") o.from.push(nx());
  else if (a === "--plugin-root") o.pluginRoot = nx();
  else if (a === "--dry-run") o.dryRun = true;
  else if (a === "--no-verify") o.verify = false;
  else if (a === "-h" || a === "--help") { console.log("用法见 scripts/merge-routes.mjs 顶部注释"); process.exit(0); }
  else { console.error(`未知参数 ${a}`); process.exit(2); }
}
if (!o.patch || o.from.length === 0) { console.error("必须给 --patch 和至少一个 --from"); process.exit(2); }

function yamlLib() {
  for (const t of ["yaml", "/opt/dsh/node_modules/yaml"]) { try { return require(t); } catch {} }
  throw new Error("找不到 yaml 解析器（在 DSH 安装目录旁运行，或用 --plugin-root）");
}
const YAML = yamlLib();

function locatePlugin() {
  const tries = [];
  if (o.pluginRoot) tries.push(join(o.pluginRoot, "@deepseek-ai", "dsh-llm-pi-ai"));
  tries.push("/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai");
  for (const t of tries) if (existsSync(join(t, "lib", "index.js"))) return t;
  throw new Error("找不到 @deepseek-ai/dsh-llm-pi-ai（用 --plugin-root 指路）");
}
const pluginRoot = locatePlugin();

/** 一个进程内验证所有候选路由：strict 报第一个错，deferred 逐条标记。 */
async function verifyAll(candidates) {
  const probe = join(pluginRoot, "lib", "__merge-probe.mjs");
  writeFileSync(probe, readFileSync(join(pluginRoot, "lib", "index.js"), "utf8") + "\nexport { resolveProfiles };\n");
  try {
    const { resolveProfiles } = await import(`file://${probe}?t=${Date.now()}`);
    let strictError = null;
    try { await resolveProfiles(candidates, "strict"); } catch (e) { strictError = String(e?.message ?? e); }
    const resolved = await resolveProfiles(candidates, "deferred");
    const per = {};
    for (const [route, v] of resolved) {
      const models = v.piProvider ? (await v.piProvider.getModels()).map((m) => m.id) : [];
      const errs = [...(v.modelErrors ?? new Map()).entries()];
      per[route] = { models, error: errs[0]?.[1] ?? v.catalogError ?? null };
    }
    return { strictError, per };
  } finally { rmSync(probe, { force: true }); }
}

// 1) 收集候选
const candidates = {};
for (const f of o.from) {
  if (!existsSync(f)) { console.error(`跳过不存在的文件 ${f}`); continue; }
  const doc = YAML.parse(readFileSync(f, "utf8"));
  const provs = Array.isArray(doc) ? doc.find((e) => e?.id === "llm-pi-ai")?.config?.providers : doc?.providers;
  for (const [route, p] of Object.entries(provs ?? {})) candidates[route] = p;
}
if (Object.keys(candidates).length === 0) { console.error("没有找到任何候选路由"); process.exit(1); }

// 2) 一次性验证
const { strictError, per } = await verifyAll(candidates);

const good = [], bad = [];
for (const route of Object.keys(candidates)) {
  const r = per[route];
  const issues = staticAudit({ [route]: candidates[route] }).filter((a) => a.level === "error").map((a) => a.msg);
  if (r && r.error === null && r.models.length > 0 && issues.length === 0) good.push({ route, profile: candidates[route] });
  else bad.push({ route, why: r?.error ?? issues[0] ?? "解析失败（无具体信息）" });
}

// 3) 渲染托管块
/**
 * 渲染托管块。indent = **providers: 下一层**（路由键本身）应有的缩进列宽。
 * 关键：路由键必须比 providers: 多缩进 2 格，否则 YAML 会把它们当成 config 的
 * 兄弟键而不是 providers 的值（踩过这个坑）。
 */
function renderManaged(list, indent) {
  if (list.length === 0) return "";
  const pad = " ".repeat(indent);
  const obj = Object.fromEntries(list.map((g) => [g.route, g.profile]));
  const body = YAML.stringify({ providers: obj }).split("\n")
    .filter((l) => l !== "" && l !== "providers:")
    .map((l) => " ".repeat(Math.max(0, indent - 2)) + l)
    .join("\n");
  return `${pad}${BEGIN_MARK}\n${body}\n${pad}${END_MARK}`;
}

/** 找到 providers: 这一行，返回插入点与路由键应有的缩进列宽。 */
function locateProviders(text) {
  const m = text.match(/^([ \t]*)- id: llm-pi-ai\b[\s\S]*?\n([ \t]*)providers:[ \t]*\n/m);
  if (!m) throw new Error("找不到 llm-pi-ai.providers: 锚点（确认目标文件里有 '- id: llm-pi-ai' 且其 config 下有 providers:）");
  return { at: m.index + m[0].length, indent: m[2].length + 2 };
}

function splice(text, render) {
  const hasBegin = text.indexOf(BEGIN_MARK), hasEnd = text.indexOf(END_MARK);
  const { at, indent } = locateProviders(text);
  if (hasBegin >= 0 && hasEnd > hasBegin) {
    const lineStart = text.lastIndexOf("\n", hasBegin) + 1;
    const endLine = text.indexOf("\n", hasEnd);
    const block = render(indent);
    return text.slice(0, lineStart) + block + (endLine >= 0 ? text.slice(endLine) : "\n");
  }
  return text.slice(0, at) + render(indent) + "\n" + text.slice(at);
}

const target = readFileSync(o.patch, "utf8");
const hasManaged = target.indexOf(BEGIN_MARK) >= 0;
let next = target;
if (good.length > 0 || hasManaged) {
  try { next = splice(target, (ind) => renderManaged(good, ind)); }
  catch (e) { console.error(String(e?.message ?? e)); process.exit(2); }
}

// 4) 报告
console.log(`候选 ${Object.keys(candidates).length} 条：通过 ${good.length}，失败 ${bad.length}`);
for (const g of good) console.log(`  ✓ ${g.route}`);
for (const b of bad) console.log(`  ✗ ${b.route} ← ${String(b.why).slice(0, 150)}`);
if (bad.length) console.log(`\n失败的路由**没有**写进去，其余路由照常生效（strict 全或无的坑被绕过了）。`);
if (strictError && bad.length === 0) console.log(`\n注意：strict 仍报错（其它层次的问题）：${strictError.slice(0, 160)}`);

if (o.dryRun) { console.log("\n（--dry-run：未改动文件）\n" + (managed || "(无变更)")); process.exit(good.length ? 0 : 1); }
if (next === target) { console.log("\n文件已是最新，未改动。"); process.exit(good.length ? 0 : 1); }

// 5) 写前备份 → 写入 → 整体复验 → 失败回滚
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const bak = `${o.patch}.bak-${stamp}`;
copyFileSync(o.patch, bak);
writeFileSync(o.patch, next);

if (o.verify) {
  // 复验时把托管块里的路由也算进去：用 deferred 重新解析整份文件
  const doc = YAML.parse(next);
  const provs = doc.find((e) => e?.id === "llm-pi-ai")?.config?.providers ?? {};
  const again = await verifyAll(provs);
  const stillBad = Object.entries(again.per).filter(([route, v]) => v.error !== null || v.models.length === 0 || staticAudit({ [route]: provs[route] }).some((a) => a.level === "error"));
  if (again.strictError || stillBad.length) {
    copyFileSync(bak, o.patch);
    console.error(`\n整体复验失败，已回滚到 ${bak}`);
    if (again.strictError) console.error(`  strict：${again.strictError.slice(0, 200)}`);
    for (const [r, v] of stillBad) console.error(`  ✗ ${r} ← ${String(v.error).slice(0, 160)}`);
    process.exit(1);
  }
}
console.log(`\n✓ 已写入 ${o.patch}（备份 ${bak}）`);
console.log(`  托管块内 ${good.length} 条；块外的手写路由未改动。`);
process.exit(0);
