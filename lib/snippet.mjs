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
 * 思考能力的**声明值**（纯数据，不含 YAML 渲染）——snippet 与 repair 共用这一份，
 * 避免「片段写的」和「自动修正写的」两套规则漂移（审计最容易抓到的就是这种）。
 *
 * @param {{format?:string|null, defaultOn?:boolean, canDisable?:boolean,
 *          canEnable?:boolean, supportsEffort?:boolean, levels?:string[]}|null} t
 * @returns {{compat:object|null, efforts:object|false, notes:string[]}}
 *   compat:  null = 不写（没证据）；否则 {thinkingFormat, supportsReasoningEffort?}
 *   efforts: false = 不写（没证据）；否则 {off?:null, low?:"low", high?:"high", ...}
 */
export function thinkingDecl(t) {
  const notes = [];
  const hasShape = Boolean(t && (t.canDisable || t.canEnable || t.defaultOn));
  if (!hasShape) return { compat: null, efforts: false, notes };

  let levels = (t.levels ?? []).filter((l) => l !== "off");
  if (levels.length > 1 && !t.supportsEffort) {
    levels = [levels[levels.length - 1]];
    notes.push(`只证明了开关能变、没证明档位差异：已裁成一档（${levels[0]}）`);
  }
  const efforts = {};
  if (t.canDisable) efforts.off = null;
  for (const l of levels) efforts[l] = l;
  // 语义层硬要求：至少一个非 off 档（只有 off 会报 offers no level beyond "off"）
  if (Object.keys(efforts).filter((k) => k !== "off").length === 0) efforts.high = "high";

  // v0.3.8（审计 v0.3.7 的 5a）：pi-ai 对未知 provider 默认 supportsReasoningEffort=true
  // （getCompat :1318），所以「不写」≠「不发 reasoning_effort」。实测布尔开关端点
  // （qwen 的 enable_thinking）在 high 档仍会带 reasoning_effort。要真做到「只发布尔开关」，
  // 必须显式写 false。
  const compat = t.format
    ? { thinkingFormat: t.format, supportsReasoningEffort: Boolean(t.supportsEffort) }
    : null;
  if (!t.format) notes.push("没证明思考格式，不写 compat（宁可少写）");
  if (!t.canDisable && hasShape) notes.push("实测关不掉思考（纯推理模型）：不写 off 档，避免 UI 里出现点了没用的开关");
  return { compat, efforts, notes };
}

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

  const decl = thinkingDecl(s.thinking);
  notes.push(...decl.notes);
  const indent = "            ";
  let compat = "";
  if (decl.compat) {
    const lines = Object.entries(decl.compat).map(([k, v]) => `${indent}  ${k}: ${v}    # 由「哪个写法真的改变了 reasoning」推定`);
    compat = `${indent}compat:\n${lines.join("\n")}\n`;
  }
  let efforts;
  if (decl.efforts === false) {
    efforts = `${indent}reasoningEfforts: false\n`;
  } else {
    const lines = Object.entries(decl.efforts).map(([k, v]) => `${indent}  ${k}: ${v === null ? "null" : `"${v}"`}`);
    efforts = `${indent}reasoningEfforts:\n${lines.join("\n")}\n`;
  }
  if (decl.compat?.thinkingFormat === "qwen" && !decl.compat.supportsReasoningEffort) {
    notes.push("qwen 的档位差异依赖 compat.supportsReasoningEffort；只发 enable_thinking 时多档等价");
  }
  const t = s.thinking;

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
/**
 * 从 probe-capabilities 的 summary 推导思考声明（**唯一规则**，inject 与 repair 共用）。
 * v0.3.9（审计 v0.3.8 P2-4）：两个工具此前各自实现，旧 probe 缺 thinkingSwitchable 时
 * repair 写 `{off:null,high:"high"}` 而 inject 写 `false` —— 同一份探针两种结论。
 */
export function thinkingFromProbe(s) {
  const arr = Array.isArray(s?.thinkingSwitchable) ? s.thinkingSwitchable : null;
  if (arr && arr.length === 0) {
    return { compat: null, efforts: false, notes: ["探针明确「开不了思考」（thinkingSwitchable=[]）：不写 compat / reasoningEfforts"] };
  }
  if (!arr) {
    return { compat: null, efforts: false, notes: ["probe 里没有 thinkingSwitchable（旧版探针或手写）：没有思考证据，不写 compat / reasoningEfforts"] };
  }
  const effortProven = arr.some((v) => String(v).startsWith("reasoning_effort"));
  return thinkingDecl({
    format: s.switchFormat ?? null,
    defaultOn: s.thinkingDefaultOn === true,
    canDisable: s.thinkingCanDisable === true,
    canEnable: s.thinkingCanEnable === true,
    supportsEffort: effortProven || s.thinkingSupportsEffort === true,
    levels: effortProven || (s.thinkingCanDisable === true && s.thinkingCanEnable === true) ? ["low", "high"] : ["high"],
  });
}
