/**
 * 探测判据的小工具（纯函数，便于单测）。
 *
 * v0.4.0（外部评审 4 / 2b）把它们从 scripts/probe-capabilities.mjs 里抽出来：
 * 判据一旦内联在脚本里就只能靠「真发 8MB 请求」来验证，抽成纯函数后可以直接单测。
 */

/** 是否是「上下文超限」类错误（与 dsh-llm 的 isContextWindowExceededError 同族）。 */
const WINDOW_RE = /context[_ ](length|window)|maximum context|too many tokens|input is too long|prompt is too long|exceeds? the maximum/i;
/** 是否是网关/传输层限制（413 体积上限、429 限流、超时、连接被重置）。 */
const GATEWAY_RE = /413|payload too large|request entity too large|429|too many requests|rate limit|timeout|timed out|ECONNRESET|socket hang up|ECONNREFUSED|ENOTFOUND/i;

/**
 * 判断一次「大输入」请求失败到底意味着什么。
 * @param {{status:number, errText:string}} r
 * @returns {"context-overflow"|"gateway-limit"|"unknown-error"|"ok"}
 */
export function classifyWindowStop({ status, errText } = {}) {
  if (status === 200) return "ok";
  const text = String(errText ?? "");
  if (WINDOW_RE.test(text)) return "context-overflow";
  if (GATEWAY_RE.test(text)) return "gateway-limit";
  if (status === 413 || status === 429 || status === 408) return "gateway-limit";
  return "unknown-error";
}

/** 中位数（空数组 → 0）。 */
export function median(nums) {
  const a = (nums ?? []).filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.floor(a.length / 2)];
}

/**
 * 「档位真的能拉长思考」的判据：high 的中位数至少是 low 的 2 倍，且差距 ≥16 token。
 * 单次微请求的 reasoning token 天然抖动（同 prompt 可能 15/28），只比一次会把噪声当能力。
 * @param {number[]} lowReasonings low 档多次采样的 reasoning token 数
 * @param {number[]} highReasonings high 档多次采样的 reasoning token 数
 */
export function effortProven(lowReasonings, highReasonings) {
  const lo = median(lowReasonings);
  const hi = median(highReasonings);
  return hi - lo >= 16 && hi >= lo * 2;
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