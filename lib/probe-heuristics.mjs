/**
 * 探测判据的小工具（纯函数，便于单测）。
 *
 * v0.4.2（第五轮子代理审计 P1-1/P1-3/P2-1）：窗口失败的分类改成与
 * `@earendil-works/pi-ai/dist/utils/overflow.js` 同一族正则 + 先排除
 * 「限流 / 服务不可用」这类非溢出错误，并新增 `parseStatedContextLimit()`
 * 从错误文本里读出**服务端自报的窗口上限**——这是判断「声明是否大于真实窗口」
 * 唯一可靠来源（不能用「成功请求的最大输入」代替失败请求的输入）。
 */

/**
 * 与 pi-ai 的 OVERFLOW_PATTERNS 对齐（按其 docs 里的提供方样例逐条抄）。
 * 顺序无关；先过 NON_OVERFLOW。
 */
const WINDOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic / z.ai
  /prompt exceeds max length/i, // z.ai CN
  /request_too_large/i, // Anthropic 413
  /input is too long for requested model/i, // Bedrock
  /exceeds the context window/i, // OpenAI
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))?/i, // OpenAI 兼容代理 / LiteLLM
  /context window exceeded/i, // LiteLLM
  /input token count.*exceeds the maximum/i, // Gemini
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4
  /model_context_window_exceeded/i, // z.ai finish_reason
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /range of input length should be/i, // DashScope / Qwen
  /context[_\s-]?length[_\s-]?exceeded/i, // 通用兜底
  /too many tokens/i, // 通用兜底
  /token limit exceeded/i, // 通用兜底
  // v0.4.2（第五轮审计 P2-2）：中文端点（DashScope/百炼等）的超限原文
  /(?:输入|上下文|提示|请求)[^。；\n]{0,12}(?:过长|太长|超过|超出)/,
  /(?:超过|超出)[^。；\n]{0,12}(?:上下文|窗口|最大长度|长度限制)/,
  /上下文长度超限|窗口超限/,
];

/** 明确不是「窗口溢出」的错误：限流、服务不可用、鉴权/额度。 */
const NON_OVERFLOW_PATTERNS = [
  /^(?:Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
  /request exceeds the maximum number of requests/i,
  /insufficient (?:balance|quota|credit)/i,
  /quota exceeded/i,
  /invalid api key|unauthorized|401/i,
  // 「每分钟 token 数」是限流，不是窗口
  /tokens? per minute|\bTPM\b/i,
];

/** 413 / Cerebras 无 body —— 请求体积溢出（与 pi-ai 一致地按「文本形状」判定）。 */
const BODY_413 = /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i;
const BODYLESS_40X = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/** 是否是「上下文超限」类错误。 */
export function isContextOverflowText(text) {
  const t = String(text ?? "");
  if (!t) return false;
  if (NON_OVERFLOW_PATTERNS.some((re) => re.test(t))) return false;
  if (BODY_413.test(t) || BODYLESS_40X.test(t)) return true;
  return WINDOW_PATTERNS.some((re) => re.test(t));
}

/** 是否是网关/传输层限制（体积上限、限流、超时、连接被重置）。 */
const GATEWAY_RE = /payload too large|request entity too large|request exceeds the maximum number of requests|too many requests|rate limit|insufficient (?:balance|quota|credit)|timeout|timed out|ECONNRESET|socket hang up|ECONNREFUSED|ENOTFOUND/i;

/**
 * 判断一次「大输入」请求失败到底意味着什么。
 * @param {{status:number, errText:string}} r
 * @returns {"ok"|"context-overflow"|"gateway-limit"|"unknown-error"}
 */
export function classifyWindowStop({ status, errText, body } = {}) {
  if (status === 200) return "ok";
  const text = `${String(errText ?? "")}${body ? ` ${typeof body === "string" ? body : JSON.stringify(body)}` : ""}`;
  if (isContextOverflowText(text)) return "context-overflow";
  if (GATEWAY_RE.test(text)) return "gateway-limit";
  if (status === 413 || status === 429 || status === 408) return "gateway-limit";
  return "unknown-error";
}

/** 从错误文本里读服务端自报的窗口上限（读不到返回 null）。 */
export function parseStatedContextLimit(text) {
  const t = String(text ?? "");
  const patterns = [
    /maximum context length is ([\d,]+) tokens/i,
    /maximum context length(?: of |\s*\()([\d,]+)/i,
    /context length \(([\d,]+) tokens\)/i,
    /range of input length should be \[1, ([\d,]+)\]/i,
    /maximum prompt length is ([\d,]+)/i,
    /exceeds the limit of ([\d,]+)/i,
    /configured context size is ([\d,]+) tokens?/i,
    /model'?s context length \(([\d,]+) tokens?\)/i,
    /exceeded model token limit: ([\d,]+)/i,
    /exceeds (?:the )?maximum allowed input length of ([\d,]+) tokens?/i,
    /maximum of ([\d,]+) tokens/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = Number(String(m[1]).replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** 中位数（偶数个取中间两数的均值；空数组 → 0）。 */
export function median(nums) {
  const a = (nums ?? []).filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 「档位真的能拉长思考」的判据（v0.4.2 改成相对判据，见第五轮审计 P2-2）：
 * high 的中位数至少是 low 的 1.5 倍，且差 ≥ max(8, high 的 10%)。
 * 旧版用「≥2 倍 + 差 ≥16」在上中位偏大的样本上误判率高（同分布 22%~30% 误判）。
 * @param {number[]} lowReasonings
 * @param {number[]} highReasonings
 */
export function effortProven(lowReasonings, highReasonings) {
  const lo = median(lowReasonings);
  const hi = median(highReasonings);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return false;
  // v0.4.2（第五轮审计 P1-3 / P2-2）：只比中位数会被采样噪声骗（同分布里高的一次
  // 碰巧落在 high 档）。改成**区间分离**判据：high 的最小值必须 ≥ low 最大值的 1.5 倍，
  // 且绝对差 ≥ max(8, 10%)。采样次数由调用方保证 ≥3（交错采样）。
  const loMax = Math.max(...lowReasonings.filter(Number.isFinite), 0);
  const hiMin = Math.min(...highReasonings.filter(Number.isFinite), Infinity);
  if (!Number.isFinite(hiMin)) return false;
  if (loMax <= 0) return hiMin >= 8; // low 档完全不思考、high 有：档位确实生效
  const need = Math.max(8, loMax * 0.1);
  return hiMin >= loMax * 1.5 && hiMin - loMax >= need;
}

/** 从一次 chat 的响应体里数出「思考了的证据」（多信号，见 §2.7）。 */
export function reasoningTokensOf(json) {
  if (!json || typeof json !== "object") return 0;
  const u = json.usage ?? {};
  const detail = u.completion_tokens_details ?? {};
  const fromUsage = Number(detail.reasoning_tokens ?? u.reasoning_tokens ?? 0);
  const msg = json.choices?.[0]?.message ?? {};
  const fromContent = typeof msg.reasoning_content === "string" ? msg.reasoning_content.length : 0;
  const flag = msg.reasoning === true || detail.reasoning === true ? 1 : 0;
  return Math.max(Number.isFinite(fromUsage) ? fromUsage : 0, fromContent, flag);
}