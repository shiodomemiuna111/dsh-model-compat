/**
 * schema-keys.mjs — DSH 配置的「权威」字段清单与枚举值。
 *
 * 这份清单来自 dsh-llm-pi-ai 0.2.2-rc.1 的 schemastery 定义
 * （/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1000-1090）。
 * 审计教训（2026-11-08）：上一版白名单是手抄的，漏了 transport / cacheRetention /
 * timeoutMs / websocketConnectTimeoutMs / reasoning 等**真实在用**的字段，导致
 * 合法配置被误报成「未知字段会静默丢弃」。这里改为与源码对齐，并把比对脚本
 * 放进 test/regress.test.mjs 的组 3，源码变了会红。
 */

/** 路由（providers.<route>）允许的字段。 */
export const ROUTE_KEYS = new Set([
  "displayName", "api", "baseURL", "apiKeyEnv", "models", "modelOverrides",
  "compat", "defaultInput", "defaultContextWindow", "defaultMaxTokens",
  "headers", "reasoning", "thinkingBudgets", "cacheRetention", "transport", "timeoutMs",
  "websocketConnectTimeoutMs", "streamIdleTimeoutMs", "maxRequestImageBytes",
  "maxRequestImages", "imageOffloadCountQuantum", "requestImagePixelBudget",
  "requestImageMaxBytes", "retryPolicy",
]);

/**
 * 模型条目允许的字段（源码 modelFields + id）。
 * 注意：`api` / `baseURL` / `provider` **不在**模型层；写在这里会被静默丢弃
 * （只在路由层生效）。审计实测：模型里写 api 不改变协议，仍沿用路由的 api。
 */
export const MODEL_KEYS = new Set([
  "id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts", "compat",
]);

/** 写进模型条目但只认路由层的字段（写了不生效，属于常见手误）。 */
export const ROUTE_ONLY_MODEL_KEYS = new Set(["api", "baseURL", "provider", "apiKeyEnv", "displayName"]);

/** compat 允许的字段。模型级与路由级都接受；路由级会并进该路由下每个模型（index.js:627-634）。 */
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
