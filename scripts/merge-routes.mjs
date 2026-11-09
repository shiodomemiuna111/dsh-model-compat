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
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { staticAudit } from "../lib/audit.mjs";
import { verifyLoadPath } from "../lib/load-path.mjs";
import { locateProviders, removeRouteBlock, renderManagedBlock, findManagedBlock, detectEol, normalizeEol, applyEol } from "../lib/yaml-edit.mjs";
import { compactionConfigFromPatch } from "../lib/compaction.mjs";
import { resolveWriteTarget, atomicWriteFile, backupFile, rollbackFrom, contentFingerprint, assertUnchanged } from "../lib/fs-safe.mjs";
import { usageText } from "../lib/usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BEGIN_MARK = "# >>> managed-by-dsh-model-compat";
const END_MARK = "# <<< managed-by-dsh-model-compat";

const o = { from: [], patch: null, dryRun: false, verify: true, pluginRoot: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--from") o.from.push(argv[++i]);
  else if (a === "--patch") o.patch = argv[++i];
  else if (a === "--plugin" || a === "--plugin-root") o.pluginRoot = argv[++i];
  else if (a === "--no-verify") o.verify = false;
  else if (a === "--replace") o.replace = true;
  else if (a === "--dry-run") o.dryRun = true;
  else if (a === "-h" || a === "--help") {
    console.log(usageText("merge-routes.mjs"));
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

function isPluginDir(dir) {
  return existsSync(join(dir, "lib", "index.js"));
}

/**
 * 找到 @deepseek-ai/dsh-llm-pi-ai 包目录。
 * 接受三种写法（用户/README 里都可能这么写，别让它静默走错）：
 *   1. 包目录本身    /opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai
 *   2. node_modules  /opt/dsh/node_modules
 *   3. DSH 安装根    /opt/dsh
 */
function locatePlugin() {
  const explicit = o.pluginRoot !== null && o.pluginRoot !== undefined;
  const roots = explicit ? [resolve(o.pluginRoot)] : [resolve(process.env.DSH_ROOT ?? "/opt/dsh", "node_modules")];

  const tried = [];
  for (const r of roots) {
    const candidates = [
      r,
      join(r, "@deepseek-ai", "dsh-llm-pi-ai"),
      join(r, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai"),
      join(r, "node_modules"),
    ];
    for (const c of candidates) {
      if (!isPluginDir(c)) { tried.push(c); continue; }
      return c;
    }
  }
  // 用户显式给了 --plugin 却找不到：直接报错，不要偷偷用别的安装（那会让你以为改的是 A 实际改了 B）
  if (explicit) {
    console.error(`--plugin ${o.pluginRoot} 下没有 @deepseek-ai/dsh-llm-pi-ai（要能看到 lib/index.js）。试过：\n` +
      [...new Set(tried)].map((t) => `  ${t}`).join("\n") +
      "\n三种写法都行：/opt/dsh  或  /opt/dsh/node_modules  或  <包目录>");
    process.exit(2);
  }
  // 没给 --plugin 时，再从 cwd / 脚本目录向上找
  for (const base of [process.cwd(), here]) {
    let dir = base;
    for (let i = 0; i < 8; i++) {
      const c = join(dir, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai");
      if (isPluginDir(c)) return c;
      tried.push(c);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  console.error(
    "找不到 @deepseek-ai/dsh-llm-pi-ai 包目录（要能看到 lib/index.js）。试过：\n" +
    [...new Set(tried)].slice(0, 8).map((t) => `  ${t}`).join("\n") +
    "\n用法：--plugin /opt/dsh/node_modules  或  --plugin /opt/dsh  或  --plugin <包目录>"
  );
  process.exit(2);
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

// 目标文件里 dsh-compaction-basic 的配置（读到目标文件后才填；先声明避免 TDZ）
// 修正 P1-3：目标文件的 compaction 配置必须在逐条隔离验证之前读到，
// 否则 verifyIsolated 拿 null/default 判预算 → --no-verify 能写出 DSH 拒载的配置。
let targetCompaction = null;
let targetCompactionReady = false;

// ── 2. 逐路由隔离验证（修复 A：整体解析抛错时降级成逐条结果）
function loadTargetCompaction() {
  if (targetCompactionReady) return;
  try {
    const d = YAML.parse(readFileSync(o.patch, "utf8"));
    targetCompaction = compactionConfigFromPatch(d);
  } catch (e) {
    console.error(`读不到目标文件 ${o.patch}：${String(e?.message ?? e).split("\n")[0]}\n（文件不存在 / 是目录 / 没有权限；不会改动任何东西）`);
    process.exit(1);
  }
  targetCompactionReady = true;
}

async function verifyIsolated() {
  loadTargetCompaction();
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

    // 单条隔离：这条自己能不能过「两段加载 + 第 3 段压缩预算」
    let single;
    try {
      single = await verifyLoadPath(pluginRoot, { [route]: profile }, "strict", { compaction: targetCompaction });
    } catch (e) {
      bad.push({ route, why: `校验时抛错：${String(e?.message ?? e).split("\n")[0]}` });
      continue;
    }
    const r = single.routes[route];
    if (!single.schema.ok) { bad.push({ route, why: `Config 层拒绝：${single.schema.error}` }); continue; }
    if (!single.semantic.ok) { bad.push({ route, why: `语义层拒绝：${single.semantic.error}` }); continue; }
    if (!r || r.error) { bad.push({ route, why: r?.error ?? "解析失败（无具体信息）" }); continue; }
    if (r.models.length === 0) { bad.push({ route, why: "解析成功但没有任何模型" }); continue; }
    // 第 3 段：压缩预算（前两段全绿但启动会抛 TargetPressureConfigError 的情形）
    if (!single.budget.ok) { bad.push({ route, why: `压缩预算不通过：${single.budget.failures.join("；")}` }); continue; }
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
let targetText;
let rawTarget = "";
try { rawTarget = readFileSync(o.patch, "utf8"); targetText = normalizeEol(rawTarget); }
catch (e) {
  console.error(`读不到目标文件 ${o.patch}：${String(e?.message ?? e)}\n（文件不存在 / 是目录 / 没有权限；不会改动任何东西）`);
  process.exit(1);
}
const targetLines = targetText.split("\n");
const targetProviders = {};
{
  try {
    const d = YAML.parse(targetLines.join("\n"));
    targetCompaction = compactionConfigFromPatch(d);
    Object.assign(targetProviders, (Array.isArray(d) ? d.find((e) => e?.id === "llm-pi-ai")?.config?.providers : d?.providers) ?? {});
  } catch (e) {
    console.error(`目标文件解析失败（未改动）：${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  }
}
const managedRouteNames = new Set();
let managedBlock = null;
try { managedBlock = findManagedBlock(targetLines); } catch (e) { console.error(String(e?.message ?? e)); process.exit(1); }
const childIndent = (() => {
  try { return locateProviders(targetLines).childIndent; } catch { return null; }
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

// ── 5. 渲染与写回（缩进从目标文件探测，见 lib/yaml-edit.mjs）
function splice(text, list) {
  let lines = text.split("\n");
  const { line, childIndent } = locateProviders(lines);
  for (const rn of toRemove) lines = removeRouteBlock(lines, rn, childIndent);
  const block = renderManagedBlock(list, childIndent, YAML);
  const managed = findManagedBlock(lines);
  if (managed) {
    return [...lines.slice(0, managed.beginLine), ...block, ...lines.slice(managed.endLine + 1)].join("\n");
  }
  return [...lines.slice(0, line + 1), ...block, ...lines.slice(line + 1)].join("\n");
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

let target;
try { target = normalizeEol(readFileSync(o.patch, "utf8")); }
catch (e) {
  console.error(`读不到目标文件 ${o.patch}：${String(e?.message ?? e)}（文件不存在 / 是目录 / 没有权限）`);
  process.exit(1);
}
const hasManaged = managedBlock !== null;

let next = target;
if (good.length > 0 || hasManaged) {
  try { next = splice(target, good); }
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

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "") + "-" + String(Date.now() % 1000).padStart(3, "0");
}

// 修正 P1-3（后半）：--no-verify 只跳过「写后复验」，写入前的整份压缩预算校验照跑。
// 否则能写出 DSH 启动即拒的配置还报「✓ 已写入」。
try {
  const merged = Object.assign({}, targetProviders);
  for (const g of good) merged[g.route] = g.profile;
  const whole = await verifyLoadPath(pluginRoot, merged, "strict", { compaction: targetCompaction });
  if (whole.budget && whole.budget.ok === false) {
    console.error(`压缩预算拒绝（未改动文件）：${whole.budget.failures.slice(0, 4).join("；")}`);
    process.exit(1);
  }
  if (!whole.schema.ok) {
    console.error(`Config 层拒绝（未改动文件）：${whole.schema.error}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`写入前整份校验无法完成（未改动文件）：${String(e?.message ?? e).split("\n")[0]}`);
  process.exit(1);
}

// ── 7. 写前备份（软链先解析）→ 原子写入（临时文件 + rename）→ 复验 → 失败原子回滚
const { target: realTarget, viaSymlink } = resolveWriteTarget(o.patch);
if (viaSymlink) console.error(`注意：${o.patch} 是软链，实际写入 ${realTarget}（不会把软链替换成普通文件）。`);
let bak;
try { bak = backupFile(o.patch, stamp()); }
catch (e) { console.error(`无法创建备份：${String(e?.message ?? e)}（目录只读？）未改动文件。`); process.exit(1); }

function rollback(reason) {
  try { rollbackFrom(bak, realTarget); } catch (e) { console.error(`回滚失败！${String(e?.message ?? e)}`); }
  console.error(`\n${reason}\n已回滚到 ${bak}`);
  process.exit(1);
}

try {
  // 写入全程不产生「半截文件」：先写同目录临时文件、校验通过才 rename 覆盖目标。
  // 这对被 dsh-hmr 实时监听的 cordis.patch.yml 是必须的（评审意见 6）。
  assertUnchanged(realTarget, contentFingerprint(rawTarget));
  atomicWriteFile(realTarget, applyEol(next, detectEol(rawTarget)), {
    check: (text) => {
      const d = YAML.parse(text);
      const provs = Array.isArray(d) ? d.find((e) => e?.id === "llm-pi-ai")?.config?.providers : d?.providers;
      if (!provs || typeof provs !== "object") throw new Error("写入前复验：llm-pi-ai.config.providers 不见了");
    },
  });
} catch (e) { rollback(`写盘失败：${String(e?.message ?? e)}`); }

if (o.verify) {
  try {
    // 修复 F：只复验托管块里的路由，块外手写的问题不连累本次导入
    const check = YAML.parse(readFileSync(realTarget, "utf8"));
    const provsOf = (d) => (Array.isArray(d) ? d.find((e) => e?.id === "llm-pi-ai")?.config?.providers : null);
    const nowProvs = provsOf(check);
    if (!nowProvs || typeof nowProvs !== "object") throw new Error("复验：llm-pi-ai.config.providers 不见了");
    const mine = {};
    for (const g of good) {
      if (!(g.route in nowProvs)) throw new Error(`复验：刚写入的路由 ${g.route} 没出现在 providers 里`);
      mine[g.route] = nowProvs[g.route];
    }
    const again = await verifyLoadPath(pluginRoot, mine, "strict", { compaction: targetCompaction });
    if (!again.schema.ok) throw new Error(`复验 Config 层：${again.schema.error}`);
    if (!again.budget.ok) throw new Error(`复验压缩预算：${again.budget.failures.join("；")}`);
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
console.log(`\n✓ 已写入 ${realTarget}（备份 ${bak}${viaSymlink ? `，原路径是软链 ${o.patch}` : ""}）`);
console.log(`  托管块内 ${good.length} 条；块外的手写路由未改动。`);
if (batch?.strictError && bad.length === 0) console.log(`  提示：整批一起解析仍报错（单条隔离已通过）：${batch.strictError.slice(0, 160)}`);
process.exit(0);
