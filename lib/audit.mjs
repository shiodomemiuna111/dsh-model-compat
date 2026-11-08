/**
 * audit.mjs — 查 strict 校验放行、但运行时会出事的写法（静态审计）。
 *
 * 被 resolve-check.mjs 与 merge-routes.mjs 共用，保证两条路径判据一致。
 * 实测（2026-11-08，dsh-llm-pi-ai 0.2.2-rc.1）以下写法 strict 全部 PASS：
 *   - compat.thinkingFormat 写成不存在的值 → 原样记进 compat，pi-ai 的 if/else 链
 *     匹配不上就静默退化成 reasoning_effort 或不发任何思考字段
 *   - input: ['video'] → 原样接受，请求时才被上游拒
 *   - reasoningEfforts: {high: 123} → 原样接受，发出去是个数字
 *   - 顶层 / 模型上的未知字段 → 静默丢弃
 */
/**
 * staticAudit — 查 strict 校验放行、但会在运行时出事的写法（"静默错误"）。
 *
 * 实测这些 strict 全部 PASS，但结果是坏的：
 *   - compat.thinkingFormat 写成不存在的值 → 被原样记进 compat；pi-ai 的 if/else 链
 *     匹配不上就**静默退化成 reasoning_effort 或不发任何思考字段**
 *   - input: ['video'] → 原样接受，请求时才被上游拒
 *   - reasoningEfforts: {high: 123} → 原样接受，实际发出去是个数字
 *   - 顶层/模型的未知字段 → 静默丢弃
 */
function staticAudit(providers) {
  const FORMATS = new Set(["openai", "deepseek", "openrouter", "together", "baseten", "zai",
    "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"]);
  const MODALITIES = new Set(["text", "image"]);
  const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const ROUTE_KEYS = new Set(["displayName", "api", "baseURL", "apiKeyEnv", "models", "modelOverrides",
    "compat", "defaultInput", "defaultContextWindow", "defaultMaxTokens", "headers", "retryPolicy",
    "streamIdleTimeoutMs", "maxRequestImageBytes", "maxRequestImages", "imageOffloadCountQuantum",
    "requestImagePixelBudget", "requestImageMaxBytes", "thinkingBudgets"]);
  const MODEL_KEYS = new Set(["id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts",
    "compat", "api", "baseURL", "provider"]);
  const COMPAT_KEYS = new Set(["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort",
    "supportsUsageInStreaming", "supportsFinishReason", "maxTokensField", "requiresToolResultName",
    "requiresAssistantAfterToolResult", "requiresThinkingAsText",
    "requiresReasoningContentOnAssistantMessages", "thinkingFormat", "chatTemplateKwargs",
    "chatTemplateArgs", "supportsThinkingTokenBudget", "thinkingTokenBudgetField"]);
  const out = [];
  for (const [route, r] of Object.entries(providers)) {
    const where = `路由 ${route}`;
    for (const k of Object.keys(r ?? {})) {
      if (!ROUTE_KEYS.has(k)) out.push({ level: "warn", msg: `${where}：未知字段 "${k}"（DSH 会静默丢弃，拼错就等于没写）` });
    }
    if (r?.compat && r.compat.thinkingFormat !== undefined && !FORMATS.has(r.compat.thinkingFormat)) {
      out.push({ level: "error", msg: `${where}：compat.thinkingFormat="${r.compat.thinkingFormat}" 不是合法值；`
        + `strict 不会拦，但 pi-ai 的 if/else 链匹配不上 → 思考字段静默退化为 reasoning_effort（或干脆不发）。`
        + `合法值：${[...FORMATS].join(" / ")}` });
    }
    const models = r?.models ?? [];
    for (const m of Array.isArray(models) ? models : []) {
      const mw = `${where} / ${m?.id ?? "(无 id)"}`;
      for (const k of Object.keys(m ?? {})) {
        if (!MODEL_KEYS.has(k)) out.push({ level: "warn", msg: `${mw}：未知字段 "${k}"` });
      }
      if (Array.isArray(m?.input)) {
        for (const im of m.input) {
          if (!MODALITIES.has(im)) out.push({ level: "error", msg: `${mw}：input 含 "${im}"，只有 text / image 合法（strict 放行，请求时才炸）` });
        }
      }
      if (m?.compat && m.compat.thinkingFormat !== undefined && !FORMATS.has(m.compat.thinkingFormat)) {
        out.push({ level: "error", msg: `${mw}：thinkingFormat="${m.compat.thinkingFormat}" 非法（strict 会拦，但如果是走 compat 合并路径可能漏）` });
      }
      for (const [k, v] of Object.entries(m?.reasoningEfforts ?? {})) {
        if (!LEVELS.has(k)) out.push({ level: "warn", msg: `${mw}：reasoningEfforts 的键 "${k}" 不是标准档位（${[...LEVELS].join("/")}）` });
        if (v !== null && typeof v !== "string") out.push({ level: "error", msg: `${mw}：reasoningEfforts.${k}=${JSON.stringify(v)} 不是字符串，发到上游会被当非法值` });
      }
      if (Array.isArray(m?.compat?.chatTemplateKwargs)) out.push({ level: "warn", msg: `${mw}：chatTemplateKwargs 应该是对象` });
      for (const k of Object.keys(m?.compat ?? {})) {
        if (k !== "thinkingFormat" && k !== "chatTemplateKwargs" && k !== "chatTemplateArgs"
          && k !== "supportsReasoningEffort" && k !== "supportsThinkingTokenBudget"
          && k !== "thinkingTokenBudgetField" && !COMPAT_KEYS.has(k)) {
          out.push({ level: "warn", msg: `${mw}：compat 未知字段 "${k}"` });
        }
      }
    }
  }
  return out;
}

export { staticAudit };
