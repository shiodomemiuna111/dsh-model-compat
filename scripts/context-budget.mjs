#!/usr/bin/env node
/**
 * context-budget.mjs — 打印一条路由的"压缩联动"数字，检查是否安全。
 *
 * 公式真值来源：lib/compaction.mjs（对应 dsh-compaction-basic/lib/index.js:124-145
 * 的 resolveCompactSpec）。v0.3.0 起：
 *   - 可以 `--patch cordis.patch.yml` 读出该文件里 dsh-compaction-basic 的
 *     headroomTokens / thresholdRatio / retainRatio / retainTokens 与 modelPolicies，
 *     不再只会用编译期默认值（外部评审意见 2）。
 *   - 支持 `--provider/--model` 选中 modelPolicies 里的 per-target 覆盖。
 *
 * 用法：
 *   node scripts/context-budget.mjs --ctx 800000 --max 65536
 *   node scripts/context-budget.mjs --patch /root/.dsh/profiles/web/cordis.patch.yml --ctx 131072 --max 16384 --model deepseek-v4.1-flash-1017
 *   node scripts/context-budget.mjs --ctx 800000 --max 65536 --headroom 16384 --json
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  computeBudget,
  compactionConfigFromPatch,
  policyForRoute,
  minContextWindowFor,
  DEFAULT_HEADROOM_TOKENS,
} from "../lib/compaction.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = { json: false, minGap: undefined, patch: null, provider: null, model: null };
// v0.3.4（审计 P0-1/P1-8）：数值参数必须是有限数。NaN 会让 minContextWindowFor 死循环、
// 也会让「gap ✓」与 exit code 自相矛盾，所以在解析阶段就拒绝。
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => args[++i];
  const num = (flag) => {
    const raw = args[++i];
    const v = Number(raw);
    if (raw === undefined || raw === "" || !Number.isFinite(v)) {
      console.error(`${flag} 需要一个有限数字，收到 ${raw === undefined ? "（缺失）" : JSON.stringify(raw)}`);
      process.exit(2);
    }
    return v;
  };
  if (a === "--ctx" || a === "--context-window") opt.ctx = num("--ctx");
  else if (a === "--max" || a === "--max-tokens") opt.max = num("--max");
  else if (a === "--headroom") opt.headroom = num("--headroom");
  else if (a === "--retain-ratio") opt.retainRatio = num("--retain-ratio");
  else if (a === "--threshold-ratio") opt.thresholdRatio = num("--threshold-ratio");
  else if (a === "--retain-tokens") opt.retainTokens = num("--retain-tokens");
  else if (a === "--min-gap") opt.minGap = num("--min-gap");
  else if (a === "--patch") opt.patch = next();
  else if (a === "--provider") opt.provider = next();
  else if (a === "--model") opt.model = next();
  else if (a === "--json") opt.json = true;
  else if (a === "-h" || a === "--help") { console.log("用法: context-budget.mjs --ctx N --max N [--headroom N] [--patch cordis.patch.yml] [--provider P] [--model M] [--json]"); process.exit(0); }
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}

/** 从 patch 文件里的 compaction-basic 配置取出 headroom 等（找不到就用默认值）。 */
let fromPatch = null;
if (opt.patch) {
  if (!existsSync(opt.patch)) { console.error(`读不到 patch 文件: ${opt.patch}`); process.exit(2); }
  let yaml = null;
  for (const t of ["yaml", "/opt/dsh/node_modules/yaml"]) { try { yaml = require(t); break; } catch {} }
  if (!yaml) { console.error("解析 --patch 需要 yaml 模块（试过 yaml 与 /opt/dsh/node_modules/yaml）"); process.exit(2); }
  let doc;
  try { doc = yaml.parse(readFileSync(opt.patch, "utf8")); }
  catch (e) { console.error(`解析 ${opt.patch} 失败：${String(e?.message ?? e)}（文件坏了 / 是目录 / 没权限；不会改动任何东西）`); process.exit(2); }
  const cfg = compactionConfigFromPatch(doc);
  if (cfg.duplicates?.length) console.error(`警告：patch 里 dsh-compaction-basic 出现 ${cfg.duplicates.length + 1} 次，按 DSH 语义以最后一条为准`);
  fromPatch = policyForRoute(cfg, opt.provider, opt.model);
  if (!cfg.found && !opt.json) console.error(`提示：${opt.patch} 里没有 dsh-compaction-basic 配置块，按默认值计算（headroom=${DEFAULT_HEADROOM_TOKENS}）`);
}

// V6：--max 0 是合法的（未声明 maxTokens 时真实实现按 `maxTokens ?? 0` 处理，B=ctx）。
if (!Number.isFinite(opt.ctx) || opt.ctx <= 0) { console.error("必须给 --ctx（正整数）"); process.exit(2); }
if (!Number.isFinite(opt.max) || opt.max < 0) { console.error("--max 必须是非负整数（0 = 未声明 maxTokens）"); process.exit(2); }

const budget = computeBudget({
  contextWindow: opt.ctx,
  reservedCompletionTokens: opt.max,
  headroomTokens: opt.headroom ?? fromPatch?.headroomTokens,
  thresholdRatio: opt.thresholdRatio ?? fromPatch?.thresholdRatio,
  retainRatio: opt.retainRatio ?? fromPatch?.retainRatio,
  retainTokens: opt.retainTokens ?? fromPatch?.retainTokens ?? null,
  minGap: opt.minGap,
});

let minContextWindow = null;
try { minContextWindow = minContextWindowFor(opt.max, budget.headroomTokens ?? DEFAULT_HEADROOM_TOKENS); }
catch (e) { console.error(`算不出最小窗口：${String(e?.message ?? e)}`); process.exit(2); }
const out = {
  contextWindow: opt.ctx,
  maxTokens: opt.max,
  headroom: budget.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
  messageBudget: budget.messageBudgetTokens,
  pressure: budget.pressureBudgetTokens,
  threshold: budget.thresholdTokens,
  retain: budget.retainTokens,
  gap: budget.gap,
  ok: budget.ok,
  problems: budget.problems ?? [],
  headroomTokens: budget.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
  thresholdRatio: budget.thresholdRatio,
  retainRatio: budget.retainRatio,
  minContextWindow,
  source: opt.patch ? "patch" : "cli",
  patchFile: opt.patch ?? null,
  policy: opt.model ? `${opt.provider ?? "*"}/${opt.model}` : null,
  note: `ctx 小于 ${minContextWindow} 时，${opt.max} 的 maxTokens + ${budget.headroomTokens ?? DEFAULT_HEADROOM_TOKENS} 的 headroom 会把 pressure 压成 0 或负数`,
};
if (opt.json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`contextWindow=${opt.ctx}  maxTokens=${opt.max}  headroom=${out.headroom}  来源=${out.source === "patch" ? (opt.patch + (out.policy ? `（${out.policy}）` : "")) : "命令行/默认值"}`);
  const show = (v) => (v === undefined || v === null ? "—（预算先失败，后面算不出来）" : v);
  console.log(`  messageBudget B = ${budget.messageBudgetTokens}`);
  console.log(`  pressure        = ${show(budget.pressureBudgetTokens)}`);
  console.log(`  threshold       = ${budget.thresholdTokens}   ← 到这开始压缩`);
  console.log(`  retain          = ${budget.retainTokens}     ← 压缩后留多少尾巴`);
  const gapText = Number.isFinite(budget.gap) ? String(budget.gap) : "—（预算先失败，算不出来）";
  console.log(`  gap             = ${gapText}     ${budget.ok ? "✓" : "✗ 见下面的问题"}`);
  if (budget.problems?.length) { console.log("\n问题："); for (const p of budget.problems) console.log(`  ✗ ${p}`); }
  else console.log("\n✓ 这组声明是安全的");
}
process.exit(budget.ok ? 0 : 1);