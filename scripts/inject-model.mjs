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
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const o = { dryRun: false, pluginRoot: null, headroom: 65536, force: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === "--patch") o.patch = next();
  else if (a === "--route") o.route = next();
  else if (a === "--probe") o.probe = next();
  else if (a === "--plugin-root") o.pluginRoot = next();
  else if (a === "--api-key-env") o.apiKeyEnv = next();
  else if (a === "--display-name") o.displayName = next();
  else if (a === "--dry-run") o.dryRun = true;
  else if (a === "--force") o.force = true;
  else if (a === "-h" || a === "--help") { console.log("用法见 scripts/inject-model.mjs 顶部注释"); process.exit(0); }
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}
if (!o.patch || !o.route || !o.probe) { console.error("必须给 --patch / --route / --probe"); process.exit(2); }

function loadYaml() {
  for (const t of ["yaml", "/opt/dsh/node_modules/yaml", o.pluginRoot ? `${dirname(dirname(o.pluginRoot))}/yaml` : null].filter(Boolean)) {
    try { return require(t); } catch {}
  }
  throw new Error("找不到 yaml 解析器（加 --plugin-root 或在 DSH 安装目录下运行）");
}

const probe = JSON.parse(readFileSync(o.probe, "utf8"));
const s = probe.summary ?? {};
const modelId = probe.model;
const ctx = Math.max(Number(s.contextWindow) || 1000000, 1000000);
const maxTokens = Math.min(Number(s.outputCap) || 65536, 65536);
const input = ["text", ...(s.vision ? ["image"] : [])];
const switchable = Array.isArray(s.thinkingSwitchable) && s.thinkingSwitchable.length > 0;
const fmt = s.switchFormat ?? (switchable ? "qwen" : null);
const compatBlock = fmt
  ? `            compat:\n              thinkingFormat: ${fmt}\n              supportsReasoningEffort: true\n`
  : `            compat:\n              supportsReasoningEffort: true\n`;

// 压缩联动自检：不允许写一条注定被拒的声明
const B = ctx - maxTokens;
const pressure = B - o.headroom;
const threshold = Math.floor(Math.min(0.8 * ctx, pressure));
const retain = Math.floor(B * 0.16);
const problems = [];
if (pressure <= 0) problems.push(`ctx ${ctx} 太小：pressure=${pressure} ≤ 0（至少要 ctx > ${maxTokens + o.headroom + 1}）`);
if (retain >= threshold) problems.push(`retain ${retain} ≥ threshold ${threshold}`);
if (threshold - retain < 30000) problems.push(`缓冲带 ${threshold - retain} < 30000，会压缩抖动`);
if (problems.length && !o.force) {
  console.error("拒绝写入，这条声明会让 DSH 启动失败或抖动：");
  for (const p of problems) console.error("  ✗ " + p);
  console.error("用一个更小的 --max（或更大的窗口）再试，或加 --force 强行写入。");
  process.exit(1);
}

const block = `      ${o.route}:
        displayName: ${o.displayName ?? o.route}
        api: openai-completions
        baseURL: ${probe.base}
        apiKeyEnv: ${o.apiKeyEnv ?? "YOUR_KEY_ENV"}
        defaultInput: [text]
        defaultMaxTokens: ${maxTokens}
        models:
          - id: ${modelId}
            name: ${modelId}
            contextWindow: ${ctx}
            maxTokens: ${maxTokens}
            input: [${input.join(", ")}]
${compatBlock}            reasoningEfforts:
              off: null
              low: "low"
              high: "high"
`;

const text = readFileSync(o.patch, "utf8");
const YAML = loadYaml();
const doc = YAML.parse(text);
if (!Array.isArray(doc)) { console.error(`${o.patch} 顶层不是数组`); process.exit(2); }
const entry = doc.find((e) => e?.id === "llm-pi-ai");
if (!entry) { console.error("补丁里没有 - id: llm-pi-ai 条目，请先按 examples/cordis.patch.yml 建一份"); process.exit(1); }
const providers = entry.config?.providers ?? {};
if (providers[o.route]) console.error(`警告：路由 ${o.route} 已存在，将被文本替换覆盖`);

// ── 预演：在临时目录里合并校验（不碰真实文件）
const merged = structuredClone(doc);
const mEntry = merged.find((e) => e?.id === "llm-pi-ai");
mEntry.config ??= {};
mEntry.config.providers ??= {};
mEntry.config.providers[o.route] = YAML.parse("providers:\n" + block).providers?.[o.route] ?? {};
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
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const bak = `${o.patch}.bak-${stamp}`;
copyFileSync(o.patch, bak);
const anchorMatch = text.match(/^(\s*)- id: llm-pi-ai\b[\s\S]*?\n(\s*)providers:\n/m);
if (!anchorMatch) { console.error("找不到 llm-pi-ai.providers: 位置，已放弃（文件未改）"); process.exit(1); }
const insertAt = anchorMatch.index + anchorMatch[0].length;
const updated = text.slice(0, insertAt) + block + text.slice(insertAt);
writeFileSync(o.patch, updated);
// 写入后再验一次，不通过就回滚
const post = (() => {
  const { execFileSync } = require("node:child_process");
  const args = [join(dirname(new URL(import.meta.url).pathname), "resolve-check.mjs"), "--patch", o.patch, "--lint"];
  if (o.pluginRoot) args.push("--plugin-root", o.pluginRoot);
  try { return { ok: true, out: execFileSync(process.execPath, args, { encoding: "utf8" }) }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
})();
if (!post.ok) {
  copyFileSync(bak, o.patch);
  console.error("写入后校验失败，已回滚到备份 " + bak);
  console.error(post.out.trim().split("\n").slice(0, 10).map((l) => "  " + l).join("\n"));
  process.exit(1);
}
console.log(`✓ 已写入 ${o.patch}`);
console.log(`  备份：${bak}`);
console.log(`  路由：${o.route} / ${modelId}  ctx=${ctx} max=${maxTokens} input=[${input}]`);
console.log("  dsh-hmr 会热重载；如果重载校验失败，用备份恢复即可。");
