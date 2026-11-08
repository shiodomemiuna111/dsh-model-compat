#!/usr/bin/env node
/**
 * context-budget.mjs — 打印一条路由的"压缩联动"数字，检查是否安全。
 *
 * DSH 的 dsh-compaction-basic 按下面几个量决定什么时候压缩：
 *   messageBudget B = contextWindow - maxTokens
 *   pressure        = B - headroomTokens           (默认 headroom 65536)
 *   threshold       = floor(min(0.8*contextWindow, pressure))
 *   retain          = floor(B * retainRatio)        (默认 0.16)
 * 约束：
 *   pressure > 0               否则 TargetPressureConfigError
 *   retain < threshold         否则启动失败
 *   工程要求 threshold-retain >= 30000   否则压缩后立刻又到阈值（抖动）
 *
 * 用法：
 *   node scripts/context-budget.mjs --ctx 800000 --max 65536
 *   node scripts/context-budget.mjs --ctx 800000 --max 65536 --headroom 16384 --json
 */
const args = process.argv.slice(2);
const opt = { headroom: 65536, retainRatio: 0.16, thresholdRatio: 0.8, minGap: 30000, json: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => Number(args[++i]);
  if (a === "--ctx" || a === "--context-window") opt.ctx = next();
  else if (a === "--max" || a === "--max-tokens") opt.max = next();
  else if (a === "--headroom") opt.headroom = next();
  else if (a === "--retain-ratio") opt.retainRatio = next();
  else if (a === "--threshold-ratio") opt.thresholdRatio = next();
  else if (a === "--min-gap") opt.minGap = next();
  else if (a === "--json") opt.json = true;
  else if (a === "-h" || a === "--help") { console.log("用法: context-budget.mjs --ctx N --max N [--headroom N] [--json]"); process.exit(0); }
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}
if (!opt.ctx || !opt.max) { console.error("必须给 --ctx 和 --max"); process.exit(2); }

const B = opt.ctx - opt.max;
const pressure = B - opt.headroom;
const threshold = Math.floor(Math.min(opt.thresholdRatio * opt.ctx, pressure));
const retain = Math.floor(B * opt.retainRatio);
const gap = threshold - retain;
const problems = [];
if (pressure <= 0) problems.push(`pressure=${pressure} ≤ 0 → DSH 报 TargetPressureConfigError`);
if (retain >= threshold) problems.push(`retain=${retain} ≥ threshold=${threshold} → 配置被拒`);
if (gap < opt.minGap) problems.push(`缓冲带 ${gap} < ${opt.minGap} → 压缩后会反复触发（抖动）`);

// 反推：给定 headroom，ctx 至少要多大才能通过 pressure 约束
const minCtxForPressure = opt.max + opt.headroom + 1;
const out = {
  contextWindow: opt.ctx,
  maxTokens: opt.max,
  messageBudget: B,
  headroom: opt.headroom,
  pressure,
  threshold,
  retain,
  gap,
  ok: problems.length === 0,
  problems,
  minContextWindow: minCtxForPressure,
  note: `ctx 小于 ${minCtxForPressure} 时，${opt.max} 的 maxTokens + ${opt.headroom} 的 headroom 会把 pressure 压成 0 或负数`,
};
if (opt.json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`contextWindow=${opt.ctx}  maxTokens=${opt.max}  headroom=${opt.headroom}`);
  console.log(`  messageBudget B = ${B}`);
  console.log(`  pressure        = ${pressure}`);
  console.log(`  threshold       = ${threshold}   ← 到这开始压缩`);
  console.log(`  retain          = ${retain}     ← 压缩后留多少尾巴`);
  console.log(`  gap             = ${gap}     ${gap >= opt.minGap ? "✓" : "✗ 太小，会抖动"}`);
  if (problems.length) { console.log("\n问题："); for (const p of problems) console.log(`  ✗ ${p}`); }
  else console.log("\n✓ 这组声明是安全的");
}
process.exit(problems.length ? 1 : 0);
