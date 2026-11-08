/**
 * schema-keys.mjs — DSH 配置的「权威」字段清单与枚举值。
 *
 * 这份清单来自 dsh-llm-pi-ai 0.2.2-rc.1 的 schemastery 定义
 * （/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1000-1090）。
 * 审计教训（2026-11-08）：上一版白名单是手抄的，漏了 transport / cacheRetention /
 * timeoutMs / websocketConnectTimeoutMs / reasoning 等**真实在用**的字段，导致
 * 合法配置被误报成「未知字段会静默丢弃」。这里改为与源码对齐，并把比对脚本
 * 放进 test/schema-keys.test.mjs，源码变了会红。
 */

/** 路由（providers.<route>）允许的字段。 */
export const ROUTE_KEYS = new Set([
  "displayName", "api", "baseURL", "apiKeyEnv", "models", "modelOverrides",
  "compat", "defaultInput", "defaultContextWindow", "defaultMaxTokens",
  "headers", "reasoning", "cacheRetention", "transport", "timeoutMs",
  "websocketConnectTimeoutMs", "streamIdleTimeoutMs", "maxRequestImageBytes",
  "maxRequestImages", "imageOffloadCountQuantum", "requestImagePixelBudget",
  "requestImageMaxBytes", "retryPolicy",
]);

/** 模型条目允许的字段。 */
export const MODEL_KEYS = new Set([
  "id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts",
  "compat", "api", "baseURL", "provider",
]);

/** compat 允许的字段（模型级）。路由级 compat 字段会被静默丢弃 —— 见 ROUTE_COMPAT_IS_IGNORED。 */
export const COMPAT_KEYS = new Set([
  "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort",
  "supportsUsageInStreaming", "supportsFinishReason", "maxTokensField",
  "requiresToolResultName", "requiresAssistantAfterToolResult",
  "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat", "chatTemplateKwargs", "chatTemplateArgs",
  "supportsThinkingTokenBudget", "thinkingTokenBudgetField",
  "vllmPriority", "supportsMaxOutputTokens", "supportsStrictMode",
  "cacheControlFormat", "supportsLongCacheRetention",
  "supportsEagerToolInputStreaming", "supportsCacheControlOnTools",
  "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature",
  "supportsStrictTools",
]);

/** pi-ai 认识的思考格式（THINKING_FORMATS，全小写，区分大小写匹配）。 */
export const THINKING_FORMATS = [
  "openai", "deepseek", "openrouter", "together", "baseten", "zai", "qwen",
  "chat-template", "qwen-chat-template", "string-thinking", "ant-ling",
];

/** 输入模态。 */
export const MODALITIES = ["text", "image"];

/** 思考档位。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 路由层写 compat 不会报错，但也不会生效（index.js:631-633 只处理 model 级）。 */
export const ROUTE_COMPAT_IS_IGNORED = true;