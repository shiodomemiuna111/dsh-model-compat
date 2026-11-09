/**
 * snippet.mjs — 把探测结果渲染成可直接粘贴的 cordis.patch.yml 片段。
 *
 * 为什么单独拿出来：旧版把模板内联在 probe-capabilities.mjs 里，导致两个真 bug
 * （V6.2 由「照文档真敲」审计发现）：
 *   1. 探测不到思考开关时仍输出 `thinkingFormat: null` —— 真实解析会报
 *      `sets compat "thinkingFormat" with no value`，整份配置被拒；
 *   2. 没测窗口时输出 `contextWindow: 1000000` —— 正是本方案反对的「抄兜底值」。
 *
 * 现在的规则：
 *   - 没有思考证据 → 完全不写 compat 块；
 *   - 没测窗口 → 写 200000 并注明「未实测的保守占位」（200000 是 maxTokens=65536 时
 *     仍能满足 pressure>0 与 gap>=30000 的一个安全值，见 scripts/context-budget.mjs）。
 */

export const UNMEASURED_CONTEXT_WINDOW = 200000;

/**
 * @param {{base:string, model:string, contextWindow:number|null, maxTokens:number|null,
 *          visionOk:boolean, switchFormat:string|null, reasoningSwitchable:boolean}} s
 * @returns {string} 以 6 空格缩进的路由片段（放在 providers: 下）
 */
export function buildSnippet(s) {
  let host = "your-gateway";
  try { host = new URL(s.base).hostname.replace(/\./g, "-"); } catch { /* 保留占位 */ }
  const ctx = Number.isFinite(s.contextWindow) && s.contextWindow > 0 ? s.contextWindow : UNMEASURED_CONTEXT_WINDOW;
  const max = Number.isFinite(s.maxTokens) && s.maxTokens > 0 ? s.maxTokens : 65536;
  const compat = s.switchFormat
    ? `            compat:\n              thinkingFormat: ${s.switchFormat}    # 探测到「能真正关掉思考」的写法才写这行\n`
    : "";
  const efforts = s.reasoningSwitchable
    ? `            reasoningEfforts:\n              off: null\n              low: "low"\n              high: "high"\n`
    : `            reasoningEfforts: false\n`;
  const ctxNote = Number.isFinite(s.contextWindow) && s.contextWindow > 0
    ? ""
    : `        # ⚠ contextWindow 没测（加 --window 才测）；下面是保守占位，务必换成实测值\n`;
  return `      custom-${host}:
        displayName: ${host}
        api: openai-completions
        baseURL: ${s.base}
        apiKeyEnv: YOUR_KEY_ENV
        defaultInput: [text]
        defaultMaxTokens: 65536
${ctxNote}        models:
          - id: ${s.model}
            name: ${s.model}
            contextWindow: ${ctx}
            maxTokens: ${max}
            input: [text${s.visionOk ? ", image" : ""}]
${compat}${efforts}`;
}
