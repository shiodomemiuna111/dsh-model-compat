/**
 * audit.mjs — 静态审计：查出「真实加载路径不会报错，但运行时行为是坏的」写法。
 *
 * ## 背景（V6 重写，2026-11-08）
 *
 * V5 及以前的说法是「strict 会静默放行 thinkingFormat/input/efforts 三种坏值」。
 * 独立审计（三个审计员 + 复核）证明这句话**是错的**：真实加载路径有两步 ——
 *
 *   1. `Config(raw)`            ← schemastery 结构校验（index.js:1086, :2940）
 *   2. `resolveProfiles(...)`   ← 语义校验（index.js:1120）
 *
 * 只调 resolveProfiles 会漏掉第 1 步，那一步有自己的枚举校验：
 *   - `compat.thinkingFormat: "bogus"` → Config REJECT
 *     `$.providers.r.models[0].compat.thinkingFormat expected "openai" | "deepseek" | …`
 *   - `input: ["video"]`            → Config REJECT
 *     `$.providers.r.models[0].input[0] expected "text" | "image" but got "video"`
 *   - `reasoningEfforts: {high: 123}` → Config REJECT
 *   - `reasoningEfforts: {}`、`baseURL: ""` → Config PASS，靠 resolveProfiles 才拦
 *
 * 所以本模块只负责**两层都管不到的**东西：
 *   - 大小写（`"Qwen"` 两层都 PASS，但 pi-ai 的 if/else 只认小写 → 静默退化）
 *   - 路由级 compat（`index.js:631-633` 对 route 级只处理 gate 声明为 "offer" 的字段，
 *     未声明的字段被 `continue` 跳过，不报错也不生效）
 *   - 只写 off 档（`offers no level beyond "off"`，语义层才会抛）
 *   - 窗口/输出落在默认值上（看起来填了，其实是 1M / 128k 兜底）
 *   - 拼错的字段名（两层都静默丢弃）
 *
 * 每条判据都在 test/audit.test.mjs 里有一个真值样本。
 */
import {
  ROUTE_KEYS, MODEL_KEYS, COMPAT_KEYS, THINKING_FORMATS,
  MODALITIES, THINKING_LEVELS, ROUTE_ONLY_MODEL_KEYS,
} from "./schema-keys.mjs";

const FORMAT_SET = new Set(THINKING_FORMATS);
const MODALITY_SET = new Set(MODALITIES);
const LEVEL_SET = new Set(THINKING_LEVELS);
const COMPAT_SET = new Set(COMPAT_KEYS);

/** 字符大小写不敏感地命中的枚举 → 给出「你是不是想写」的提示。 */
function caseHint(value, candidates) {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  const hit = candidates.find((c) => c.toLowerCase() === lower);
  return hit && hit !== value ? hit : null;
}

/**
 * @param {Record<string, any>} providers 形如 cordis.patch.yml 里 llm-pi-ai.config.providers
 * @returns {{level: "error"|"warn", code: string, msg: string}[]}
 *   level=error 表示「这会让运行时行为出错」，调用方应把退出码置 1。
 */
function staticAudit(providers) {
  const out = [];
  const push = (level, code, msg) => out.push({ level, code, msg });

  for (const [route, r] of Object.entries(providers ?? {})) {
    const where = `路由 ${route}`;
    if (r === null || typeof r !== "object") {
      push("error", "route-not-object", `${where}：不是对象`);
      continue;
    }

    // ── 1. 路由级未知字段（两层都静默丢弃）
    for (const k of Object.keys(r)) {
      if (!ROUTE_KEYS.has(k)) {
        const hint = caseHint(k, [...ROUTE_KEYS]);
        push("warn", "unknown-route-key",
          `${where}：未知字段 "${k}"${hint ? `（是不是想写 "${hint}"？）` : ""} —— DSH 会静默丢弃，拼错等于没写`);
      }
    }

    // ── 2. 路由级 compat：会生效（并进该路由下每个模型），但只认协议接受的字段
    if (r.compat && typeof r.compat === "object") {
      for (const k of Object.keys(r.compat)) {
        if (!COMPAT_SET.has(k)) {
          const hint = caseHint(k, [...COMPAT_SET]);
          push("error", "bad-route-compat-key",
            `${where}：compat 字段 "${k}" 没有协议声明${hint ? `（想写 "${hint}"？）` : ""} —— 解析会报 "no model on the route speaks a protocol that takes it"`);
        }
      }
    }

    // ── 3. 默认输入模态：defaultInput 只有 [image] 会让所有未声明的模型「假装能看图」
    if (Array.isArray(r.defaultInput)) {
      for (const im of r.defaultInput) {
        if (!MODALITY_SET.has(im)) {
          push("error", "bad-default-input", `${where}：defaultInput 含 "${im}"（只有 text / image 合法）`);
        }
      }
      if (r.defaultInput.length > 0 && !r.defaultInput.includes("text")) {
        push("warn", "default-input-no-text",
          `${where}：defaultInput 里没有 "text"，所有未写 input 的模型都会被当成只收图`);
      }
    }

    // ── 4. 逐个模型
    const models = r.models;
    if (!Array.isArray(models) || models.length === 0) {
      push("warn", "no-models", `${where}：没有 models 条目`);
      continue;
    }
    for (const m of models) {
      const mw = `${where} / ${m?.id ?? "(无 id)"}`;
      if (m === null || typeof m !== "object") { push("error", "model-not-object", `${mw}：不是对象`); continue; }

      for (const k of Object.keys(m)) {
        if (!MODEL_KEYS.has(k)) {
          if (ROUTE_ONLY_MODEL_KEYS.has(k)) {
            push("warn", "route-only-key-on-model",
              `${mw}：字段 "${k}" 只在路由层生效，写在模型条目里会被静默丢弃（模型级的 api 不会改变协议，仍沿用路由的 api）`);
          } else {
            const hint = caseHint(k, [...MODEL_KEYS]);
            push("warn", "unknown-model-key", `${mw}：未知字段 "${k}"${hint ? `（是不是想写 "${hint}"？）` : ""}`);
          }
        }
      }

      // input：非字符串元素是真正的两层盲区（字符串 "image" 会被按字符拆开）
      if (m.input !== undefined) {
        if (!Array.isArray(m.input)) {
          push("error", "input-not-array", `${mw}：input 必须是数组（写成字符串 ${JSON.stringify(m.input)} 会被按字符拆开）`);
        } else {
          for (const im of m.input) {
            if (!MODALITY_SET.has(im)) {
              const hint = caseHint(im, MODALITIES);
              push("error", "bad-modality", `${mw}：input 含 ${JSON.stringify(im)}${hint ? `（想写 "${hint}"？）` : ""}；只有 text / image 合法`);
            }
          }
        }
      }

      // thinkingFormat：两层都拦非法值，但**大小写**都放过 → 静默退化
      const tf = m.compat?.thinkingFormat;
      if (tf !== undefined) {
        if (!FORMAT_SET.has(tf)) {
          const hint = caseHint(tf, THINKING_FORMATS);
          push("error", "bad-thinking-format", hint
            ? `${mw}：thinkingFormat=${JSON.stringify(tf)} 大小写不对（合法值是 "${hint}"）；Config 层直接拒绝整份配置，不会静默退化`
            : `${mw}：thinkingFormat=${JSON.stringify(tf)} 不是 pi-ai 认识的值（合法：${THINKING_FORMATS.join(" / ")}）`);
        }
      }

      // 模型级 compat 未知字段
      for (const k of Object.keys(m.compat ?? {})) {
        if (!COMPAT_KEYS.has(k)) {
          const hint = caseHint(k, [...COMPAT_KEYS]);
          push("warn", "unknown-compat-key", `${mw}：compat 未知字段 "${k}"${hint ? `（想写 "${hint}"？）` : ""}`);
        }
      }
      if (m.compat?.chatTemplateKwargs !== undefined && (typeof m.compat.chatTemplateKwargs !== "object" || Array.isArray(m.compat.chatTemplateKwargs))) {
        push("error", "bad-chat-template-kwargs", `${mw}：chatTemplateKwargs 必须是对象`);
      }
      if (m.compat?.chatTemplateArgs !== undefined && (typeof m.compat.chatTemplateArgs !== "object" || Array.isArray(m.compat.chatTemplateArgs))) {
        push("error", "bad-chat-template-args", `${mw}：chatTemplateArgs 必须是对象`);
      }

      // reasoningEfforts：语义层的坑（Config 放行、strict 才抛）
      const eff = m.reasoningEfforts;
      if (eff !== undefined) {
        if (eff === false) {
          // 显式关闭思考，合法
        } else if (eff === null || typeof eff !== "object" || Array.isArray(eff)) {
          push("error", "bad-efforts-shape", `${mw}：reasoningEfforts 必须是 false 或对象`);
        } else {
          const keys = Object.keys(eff);
          if (keys.length === 0) {
            push("error", "empty-efforts", `${mw}：reasoningEfforts 是空对象；要么删掉，要么至少给一个档位`);
          } else if (keys.every((k) => k === "off")) {
            push("error", "only-off", `${mw}：reasoningEfforts 只有 off，等于关掉思考；删除这个字段或加一档`);
          }
          for (const [k, v] of Object.entries(eff)) {
            if (!LEVEL_SET.has(k)) {
              const hint = caseHint(k, THINKING_LEVELS);
              push("warn", "unknown-effort-key", `${mw}：reasoningEfforts 的键 "${k}" 不是标准档位${hint ? `（想写 "${hint}"？）` : ""}（${THINKING_LEVELS.join("/")}）`);
            }
            if (k === "off") {
              if (v !== null && v !== "") push("warn", "off-effort-value", `${mw}：reasoningEfforts.off 通常是 null/空串，当前是 ${JSON.stringify(v)}`);
            } else if (v === null || v === "") {
              push("error", "null-effort-value",
                `${mw}：reasoningEfforts.${k}=${JSON.stringify(v)}；只有 off 允许留空，其它档位必须给线上真实值（strict 会抛 "needs the wire value dispatch should send"）`);
            } else if (typeof v !== "string") {
              push("error", "bad-effort-value", `${mw}：reasoningEfforts.${k}=${JSON.stringify(v)} 不是字符串`);
            }
          }
        }
      }

      // 窗口/输出：看起来填了、其实是兜底值
      if (m.contextWindow === undefined) {
        push("warn", "default-context-window",
          `${mw}：没写 contextWindow，会用 defaultContextWindow（默认 1000000）—— 这是猜的，不是实测的`);
      }
      if (m.maxTokens === undefined) {
        push("warn", "default-max-tokens",
          `${mw}：没写 maxTokens，会用 defaultMaxTokens（默认 128000）—— 多数网关会直接 400`);
      }
    }
  }
  return out;
}

export { staticAudit };