/**
 * merge-routes.mjs — 把一批 providers 路由并进目标 patch 文件，单条失败不拖累全局。
 *
 * V6 修复（针对独立审计发现的 6 个 bug）：
 *   A. 致命：候选里有 baseURL:"" 之类会让解析整体抛错的条目时，原来会让整个流程崩，
 *      「单条失败不拖累全局」在最需要时失效 → 现在逐路由隔离，异常被降级成该条失败。
 *   B. 致命：--dry-run 必定 ReferenceError（managed 未定义）→ 现在在写盘前就返回预览。
 *   C. P0：托管标记出现在块外（比如文件头部注释里提到过它）时，原实现会切掉 providers: 头，
 *      产出非法 YAML，且 YAML.parse 不在 try 内、不回滚 → 现在只认「行首 + 全行匹配」的标记，
 *      并且写盘前后的所有解析都在 try 内、任何异常都回滚并 exit 1。
 *   D. P1：备份名精确到秒，同秒两次运行会覆盖备份 → 改成毫秒 + 存在性自增。
 *   E. P2：源文件全坏时重渲染会把托管块清空、静默删掉线上路由还 exit 0 → 现在源全坏时
 *      **拒绝改动**（保留旧托管块），exit 1。
 *   F. P3：复验用整份文件 strict，块外一条手写坏路由会连累本次导入整体回滚 → 现在复验
 *      只针对「托管块内的路由」+ 检查整份 YAML 仍可解析、providers 结构仍在。
 *
 * 另外：探针文件除了 finally 清理，还注册了 process 退出钩子，SIGINT 时也会删。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { staticAudit } from "../lib/audit.mjs";
import { verifyLoadPath } from "../lib/load-path.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BEGIN_MARK = "# >>> managed-by-dsh-model-compat（以下由 merge-routes.mjs 维护，手改会被覆盖）";
const END_MARK = "# <<< managed-by-dsh-model-compat";

const o = { from: [], patch: null, dryRun: false, verify: true, pluginRoot: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--from") o.from.push(argv[++i]);
  else if (a === "--patch") o.patch = argv[++i];
  else if (a === "--plugin") o.pluginRoot = argv[++i];
  else if (a === "--no-verify") o.verify = false;
  else if (a === "--replace") o.replace = true;
  else if (a === "--dry-run") o.dryRun = true;
  else if (a === "-h" || a === "--help") {
    console.log("用法：node scripts/merge-routes.mjs --patch <cordis.patch.yml> --from <源.yml> [--from ...] [--dry-run] [--no-verify] [--plugin <dsh-llm-pi-ai 目录>]");
    process.exit(0);
  } else { console.error(`未知参数 ${a}`); process.exit(2); }
}
if (!o.patch) { console.error("缺少 --patch"); process.exit(2); }
if (o.from.length === 0) { console.error("缺少 --from"); process.exit(2); }

function yamlLib() {
  for (const name of ["yaml", "@deepseek-ai/dsh-llm-pi-ai/node_modules/yaml", "/opt/dsh/node_modules/yaml"]) {
    try { return require(name); } catch { /* 继续 */ }
  }
  try { return require(join(process.env.DSH_ROOT ?? "/opt/dsh", "node_modules", "yaml")); } catch { /* 继续 */ }
  console.error("找不到 yaml 库（npm i yaml）");
  process.exit(2);
}
const YAML = yamlLib();

function locatePlugin() {
  if (o.pluginRoot) return resolve(o.pluginRoot);
  const guess = join(process.env.DSH_ROOT ?? "/opt/dsh", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai");
  if (!existsSync(guess)) {
    console.error(`找不到 dsh-llm-pi-ai（试过 ${guess}）；用 --plugin 指定`);
    process.exit(2);
  }
  return guess;
}
const pluginRoot = locatePlugin();

// ── 1. 收集候选：每个源文件独立 try，一个坏文件不拖累其它
const candidates = {};
for (const f of o.from) {
  if (!existsSync(f)) { console.error(`跳过不存在的文件 ${f}`); continue; }
  try {
    const doc = YAML.parse(readFileSync(f, "utf8"));
    const provs = Array.isArray(doc) ? doc.find((e) => e?.id === "llm-pi-ai")?.config?.providers : doc?.providers;
    if (!provs || typeof provs !== "object") { console.error(`跳过 ${f}：没找到 llm-pi-ai.config.providers`); continue; }
    for (const [route, p] of Object.entries(provs)) candidates[route] = p;
  } catch (e) {
    console.error(`跳过 ${f}：YAML 解析失败 —— ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
if (Object.keys(candidates).length === 0) { console.error("没有找到任何候选路由"); process.exit(1); }

// ── 2. 逐路由隔离验证（修复 A：整体解析抛错时降级成逐条结果）
async function verifyIsolated() {
  const good = [], bad = [];
  let batch = null;
  try {
    batch = await verifyLoadPath(pluginRoot, candidates, "strict");
  } catch (e) {
    batch = { schema: { ok: true, error: null }, semantic: { ok: true, error: null }, routes: {} };
    console.error(`批量校验异常（降级为逐条）：${String(e?.message ?? e).split("\n")[0]}`);
  }
  for (const [route, profile] of Object.entries(candidates)) {
    const audit = staticAudit({ [route]: profile }).filter((a) => a.level === "error");
    if (audit.length > 0) { bad.push({ route, why: audit.map((a) => a.msg).join("；") }); continue; }

    // 单条隔离：这条自己能不能过两段加载路径
    let single;
    try {
      single = await verifyLoadPath(pluginRoot, { [route]: profile }, "strict");
    } catch (e) {
      bad.push({ route, why: `校验时抛错：${String(e?.message ?? e).split("\n")[0]}` });
      continue;
    }
    const r = single.routes[route];
    if (!single.schema.ok) { bad.push({ route, why: `Config 层拒绝：${single.schema.error}` }); continue; }
    if (!single.semantic.ok) { bad.push({ route, why: `语义层拒绝：${single.semantic.error}` }); continue; }
    if (!r || r.error) { bad.push({ route, why: r?.error ?? "解析失败（无具体信息）" }); continue; }
    if (r.models.length === 0) { bad.push({ route, why: "解析成功但没有任何模型" }); continue; }
    good.push({ route, profile });
  }
  return { good, bad, batch };
}
const { good, bad, batch } = await verifyIsolated();

// ── 3. 防御：源与目标相同（自我合并）会在写入后产生重复键
for (const f of o.from) {
  if (existsSync(f) && resolve(f) === resolve(o.patch)) {
    console.error(`源文件与目标是同一个文件：${f}\n这会把同一批路由写两遍（YAML 重复键）。请改用别的源文件。`);
    process.exit(2);
  }
}

// ── 4. 冲突检测：目标文件里已有同名路由（且不在托管块内）
const targetLines = readFileSync(o.patch, "utf8").split("\n");
const targetProviders = {};
{
  try {
    const d = YAML.parse(targetLines.join("\n"));
    Object.assign(targetProviders, (Array.isArray(d) ? d.find((e) => e?.id === "llm-pi-ai")?.config?.providers : d?.providers) ?? {});
  } catch (e) {
    console.error(`目标文件解析失败（未改动）：${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  }
}
const managedRouteNames = new Set();
let managedBlock = null;
try { managedBlock = findManaged(targetLines); } catch (e) { console.error(String(e?.message ?? e)); process.exit(1); }
const childIndent = (() => {
  try { return locateProviders(targetLines).indent; } catch { return null; }
})();
if (managedBlock && childIndent !== null) {
  const keyIndent = " ".repeat(childIndent);
  for (const l of targetLines.slice(managedBlock.beginLine + 1, managedBlock.endLine)) {
    if (l.startsWith(keyIndent) && !l.startsWith(keyIndent + " ") && /^[ \t]*[^#\s][^:]*:\s*$/.test(l)) {
      managedRouteNames.add(l.trim().replace(/:\s*$/, ""));
    }
  }
}
const toRemove = [];   // --replace 时要先删掉的块外路由
const conflicts = good.filter((g) => g.route in targetProviders && !managedRouteNames.has(g.route));
for (const c of conflicts) {
  if (o.replace) {
    // 覆盖：保留在 good 里（稍后写进托管块），同时把块外的旧条目删掉
    toRemove.push(c.route);
    console.error(`覆盖：块外已有同名路由 ${c.route}，--replace 已启用，将从原位置移除后写入托管块。`);
  } else {
    const i = good.indexOf(c);
    if (i >= 0) good.splice(i, 1);
    bad.push({ route: c.route, why: "已有同名路由（块外手写）→ 跳过；要覆盖请加 --replace，否则改名或先删原条目" });
  }
}

// ── 5. 渲染托管块
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

/** 找到 llm-pi-ai 条目下的 providers:，返回插入点与路由键缩进。不跨条目。 */
function locateProviders(input) {
  const lines = (Array.isArray(input) ? input : String(input).split("\n"));
  let entryIndent = null;
  let sawEntry = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mEntry = line.match(/^([ \t]*)- id: llm-pi-ai[ \t]*$/);
    if (mEntry) { entryIndent = mEntry[1].length; sawEntry = true; continue; }
    if (!sawEntry) continue;
    // 同缩进的另一个 `- id:` 表示 llm-pi-ai 条目已结束（修复隔离性问题）
    if (entryIndent !== null && new RegExp(`^ {${entryIndent}}- `).test(line)) {
      throw new Error("llm-pi-ai 条目里没有找到 providers:（在下一个条目之前就结束了）");
    }
    const mProv = line.match(/^([ \t]*)providers:[ \t]*$/);
    if (mProv && mProv[1].length > entryIndent) {
      return { line: i, indent: mProv[1].length + 2 };
    }
  }
  throw new Error("找不到 llm-pi-ai.providers: 锚点（确认目标文件里有 '- id: llm-pi-ai' 且其 config 下有 providers:）");
}

/** 找托管块（必须行首、整行等于标记）。返回 {beginLine, endLine} 或 null。 */
function findManaged(lines) {
  const isBegin = (l) => l.replace(/^[ \t]*/, "") === BEGIN_MARK;
  const isEnd = (l) => l.replace(/^[ \t]*/, "") === END_MARK;
  let beginLine = -1;
  for (let i = 0; i < lines.length; i++) if (isBegin(lines[i])) { beginLine = i; break; }
  if (beginLine < 0) return null;
  let endLine = -1;
  for (let i = beginLine + 1; i < lines.length; i++) if (isEnd(lines[i])) { endLine = i; break; }
  if (endLine < 0) throw new Error("托管块的开始标记存在但结束标记缺失（文件可能被手工改坏）");
  return { beginLine, endLine };
}

/** 删掉一条块外路由（从它的键行起，到下一个缩进 ≤ 它的行之前）。 */
function removeRouteLines(lines, routeName, childIndent) {
  const keyIndent = " ".repeat(childIndent);
  const out = lines.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== `${keyIndent}${routeName}:`) continue;
    let j = i + 1;
    while (j < out.length) {
      const l = out[j];
      if (l.trim() === "") { j++; continue; }
      const ind = l.length - l.replace(/^ +/, "").length;
      if (ind < childIndent) break;
      j++;
    }
    out.splice(i, j - i);
    break;
  }
  return out;
}

function splice(text, render) {
  let lines = text.split("\n");
  const { line, indent } = locateProviders(lines);
  if (toRemove.length > 0) {
    // 修复：路由键与 renderManaged 写出的缩进一致（= providers 的子缩进），
    // 之前误用 indent-2 导致匹配不到、旧路由没删掉 → 写回后 Map keys must be unique。
    for (const rn of toRemove) lines = removeRouteLines(lines, rn, indent);
  }
  const managed = findManaged(lines);
  const block = render(indent);
  if (managed) {
    return [...lines.slice(0, managed.beginLine), ...block.split("\n"), ...lines.slice(managed.endLine + 1)].join("\n");
  }
  // 插到 providers: 行之后
  return [...lines.slice(0, line + 1), ...block.split("\n"), ...lines.slice(line + 1)].join("\n");
}

// ── 6. 报告
console.log(`候选 ${Object.keys(candidates).length} 条：通过 ${good.length}，失败 ${bad.length}`);
for (const g of good) console.log(`  ✓ ${g.route}`);
for (const b of bad) console.log(`  ✗ ${b.route} ← ${String(b.why).slice(0, 200)}`);
if (bad.length) console.log("\n失败的路由**没有**写进去，其余路由照常生效（strict 全或无的坑被绕过了）。");

if (good.length === 0) {
  const why = conflicts.length > 0
    ? `全部 ${conflicts.length} 条与目标文件里已有的路由同名（块外手写）。要覆盖请加 --replace。`
    : "没有一条通过校验。";
  console.error(`\n没有可写入的条目：${why}\n未改动文件。`);
  process.exit(1);
}

const target = readFileSync(o.patch, "utf8");
const hasManaged = managedBlock !== null;

let next = target;
if (good.length > 0 || hasManaged) {
  try { next = splice(target, (ind) => renderManaged(good, ind)); }
  catch (e) { console.error(`生成失败（未改动文件）：${String(e?.message ?? e)}`); process.exit(1); }
  // 修复 C：写盘前的语法检查也在 try 内
  try {
    const check = YAML.parse(next);
    const provs = Array.isArray(check) ? check.find((e) => e?.id === "llm-pi-ai")?.config?.providers : null;
    if (!provs || typeof provs !== "object") throw new Error("合并后 llm-pi-ai.config.providers 不见了");
  } catch (e) {
    console.error(`合并结果不合法（未改动文件）：${String(e?.message ?? e).split("\n").slice(0, 2).join(" / ")}`);
    process.exit(1);
  }
}

// 修复 B：--dry-run 在这里就返回，不再引用未定义的 managed
if (o.dryRun) {
  console.log("\n（--dry-run：未改动文件）预览：\n");
  console.log(next === target ? "(无变更)" : next);
  process.exit(good.length > 0 ? 0 : 1);
}
if (next === target) { console.log("\n文件已是最新，未改动。"); process.exit(0); }

// ── 7. 写前备份（修复 D：毫秒 + 自增）→ 写入 → 复验 → 失败回滚
function backupPath(base) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "") + "-" + String(Date.now() % 1000).padStart(3, "0");
  let p = `${base}.bak-${stamp}`;
  for (let n = 1; existsSync(p); n++) p = `${base}.bak-${stamp}-${n}`;
  return p;
}
const bak = backupPath(o.patch);
copyFileSync(o.patch, bak);

function rollback(reason) {
  try { copyFileSync(bak, o.patch); } catch (e) { console.error(`回滚失败！${String(e?.message ?? e)}`); }
  console.error(`\n${reason}\n已回滚到 ${bak}`);
  process.exit(1);
}

try { writeFileSync(o.patch, next); }
catch (e) { rollback(`写盘失败：${String(e?.message ?? e)}`); }

if (o.verify) {
  try {
    // 修复 F：只复验托管块里的路由，块外手写的问题不连累本次导入
    const check = YAML.parse(readFileSync(o.patch, "utf8"));
    const provsOf = (d) => (Array.isArray(d) ? d.find((e) => e?.id === "llm-pi-ai")?.config?.providers : null);
    const nowProvs = provsOf(check);
    if (!nowProvs || typeof nowProvs !== "object") throw new Error("复验：llm-pi-ai.config.providers 不见了");
    const mine = {};
    for (const g of good) {
      if (!(g.route in nowProvs)) throw new Error(`复验：刚写入的路由 ${g.route} 没出现在 providers 里`);
      mine[g.route] = nowProvs[g.route];
    }
    const again = await verifyLoadPath(pluginRoot, mine, "strict");
    if (!again.schema.ok) throw new Error(`复验 Config 层：${again.schema.error}`);
    const stillBad = [];
    for (const g of good) {
      const r = again.routes[g.route];
      if (!again.semantic.ok) { stillBad.push([g.route, again.semantic.error]); break; }
      if (!r || r.error) { stillBad.push([g.route, r?.error ?? "解析失败"]); continue; }
      if (r.models.length === 0) stillBad.push([g.route, "没有模型"]);
    }
    if (stillBad.length) throw new Error(`复验失败：${stillBad.map(([r, w]) => `${r} ← ${String(w).slice(0, 120)}`).join("；")}`);
  } catch (e) {
    rollback(`复验失败：${String(e?.message ?? e)}`);
  }
}
console.log(`\n✓ 已写入 ${o.patch}（备份 ${bak}）`);
console.log(`  托管块内 ${good.length} 条；块外的手写路由未改动。`);
if (batch?.strictError && bad.length === 0) console.log(`  提示：整批一起解析仍报错（单条隔离已通过）：${batch.strictError.slice(0, 160)}`);
process.exit(0);