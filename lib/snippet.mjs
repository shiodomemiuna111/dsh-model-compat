/**
 * snippet.mjs — 把探测结果渲染成可直接粘贴的 cordis.patch.yml 片段。
 *
 * 为什么单独拿出来：旧版把模板内联在 probe-capabilities.mjs 里，导致两个真 bug
 * （V6.2 由「照文档真敲」审计发现）：
 *   1. 探测不到思考开关时仍输出 `thinkingFormat: null` —— 真实解析会报
 *      `sets compat "thinkingFormat" with no value`，整份配置被拒；
 *   2. 没测窗口时输出 `contextWindow: 1000000` —— 正是本方案反对的「抄兜底值」。
 *
 * v0.3.0（外部评审意见 2、3）又改了三条：
 *   - `reasoningEfforts` 不再写死 off/low/high：`off` 只在**实测能关掉思考**时写，
 *     否则 UI 里会出现一个点了没用的「关」档（纯推理模型甚至会被拒）；
 *   - 档位只在**实测证明不同档位有差异**时写多档，否则只写一档；
 *   - `maxTokens` 由 `pickSafeMaxTokens()` 反推（≤min(网关实测上限, floor(ctx×0.2))，
 *     且必须过压缩预算），不再硬编码 65536 —— 65536 在 ctx=131072 下 pressure=0，
 *     会直接触发 TargetPressureConfigError。
 */

import { pickSafeMaxTokens, computeBudget, DEFAULT_HEADROOM_TOKENS } from "./compaction.mjs";

export const UNMEASURED_CONTEXT_WINDOW = 200000;

/**
 * @param {{base:string, model:string, contextWindow:number|null,
 *          gateMaxTokens:number|null,
 *          visionOk:boolean,
 *          thinking:{format:string|null, defaultOn:boolean, canDisable:boolean,
 *                    canEnable:boolean, levels:string[]}|null,
 *          headroomTokens?:number,
 *          minGap?:number}} s
 * @returns {{yaml:string, chosenMaxTokens:number|null, budget:object|null, notes:string[]}}
 */
export function buildSnippet(s) {
  const notes = [];
  let host = "your-gateway";
  try { host = new URL(s.base).hostname.replace(/\./g, "-"); } catch { /* 保留占位 */ }

  const measured = Number.isFinite(s.contextWindow) && s.contextWindow > 0;
  const ctx = measured ? s.contextWindow : UNMEASURED_CONTEXT_WINDOW;
  if (!measured) notes.push(`contextWindow 没测（加 --window 才测）；片段里是保守占位 ${UNMEASURED_CONTEXT_WINDOW}，务必换成实测值`);

  const pick = pickSafeMaxTokens({
    contextWindow: ctx,
    gateMax: s.gateMaxTokens,
    headroomTokens: s.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
    minGap: s.minGap,
  });
  const max = pick.maxTokens;
  const fatal = max === null;
  if (fatal) notes.push(`这个窗口下没有任何 maxTokens 能过压缩预算：${pick.reason}`);
  if (s.gateMaxTokens !== null && s.gateMaxTokens !== undefined && max !== null && max < s.gateMaxTokens) {
    notes.push(`网关实测上限 ${s.gateMaxTokens}，但按 ctx×0.2 与压缩预算只推荐 ${max}`);
  }

  const t = s.thinking;
  const hasThinkingShape = Boolean(t && (t.canDisable || t.canEnable || t.defaultOn));
  const compat = t?.format
    ? `            compat:\n              thinkingFormat: ${t.format}    # 由「哪个写法真的改变了 reasoning」推定\n`
      + (t.supportsEffort ? "              supportsReasoningEffort: true    # 实测 reasoning_effort 生效：档位差异靠它\n" : "")
    : "";
  if (!t?.format) notes.push("没证明思考格式，不写 compat（宁可少写）");
  else if (t.format === "qwen") notes.push("qwen 的档位差异依赖 compat.supportsReasoningEffort；只发 enable_thinking 时多档等价");

  let efforts;
  if (!hasThinkingShape) {
    efforts = "            reasoningEfforts: false\n";
  } else {
    const levels = (t.levels ?? []).filter((l) => l !== "off");
    const lines = [];
    if (t.canDisable) lines.push("              off: null");
    for (const l of levels) lines.push(`              ${l}: "${l}"`);
    // 兜底：语义层要求至少有一个非 off 档（只有 off 会报 offers no level beyond "off"）
    if (lines.length === 0) lines.push(t.canDisable ? "              off: null" : '              high: "high"');
    efforts = `            reasoningEfforts:\n${lines.join("\n")}\n`;
  }
  if (hasThinkingShape && !t.canDisable) notes.push("实测关不掉思考（纯推理模型）：不写 off 档，避免 UI 里出现点了没用的开关");
  if (hasThinkingShape && (t.levels ?? []).length > 1 && !t.supportsEffort) {
    notes.push("只证明了开关能变、没证明 low/high 有差异：只写一档，避免 UI 里出现两个等价档");
  }

  const ctxNote = measured
    ? ""
    : `        # ⚠ contextWindow 没测（加 --window 才测）；下面是保守占位，务必换成实测值\n`;
  const yaml = `      custom-${host}:
        displayName: ${host}
        api: openai-completions
        baseURL: ${s.base}
        apiKeyEnv: YOUR_KEY_ENV
        defaultInput: [text]
${max === null ? "        # ⚠ 没算出安全的 maxTokens：请先调小 headroomTokens 或换更大窗口的模型\n" : `        defaultMaxTokens: ${max}\n`}${ctxNote}        models:
          - id: ${s.model}
            name: ${s.model}
            contextWindow: ${ctx}
${max === null ? "" : `            maxTokens: ${max}\n`}            input: [text${s.visionOk ? ", image" : ""}]
${compat}${efforts}`;
  return { yaml, chosenMaxTokens: max, budget: pick.budget, notes, fatal };
}