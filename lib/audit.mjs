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
 *   - 大小写与枚举拼写（`"Qwen"`、`"bogus"` 由 Config 拒；但 `format` 写成未知字段、
 *     或把 compat 写到路由层的**非法键**，需要静态审计先提醒）
 *   - 路由级 compat 的**非法键**（路由级 compat 本身会生效并并进每个模型；
 *     但键必须是某个协议认识的字段，否则语义层报 no model on the route speaks…）
 *   - 只写 off 档（`offers no level beyond "off"`，语义层才会抛）
 *   - 窗口/输出落在默认值上（看起来填了，其实是 1M / 128k 兜底）
 *   - 拼错的字段名（两层都静默丢弃）
 *   - 模型条目里写 `api` / `baseURL`（只认路由层，写在模型上被静默丢弃）
 *
 * 每条判据都在 test/regress.test.mjs 的组 3 里有一个真值样本。
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
    if (r.compat !== undefined && (r.compat === null || typeof r.compat !== "object" || Array.isArray(r.compat))) {
      push("error", "bad-route-compat-shape", `${where}：compat 必须是对象`);
    } else if (r.compat) {
      for (const [k, v] of Object.entries(r.compat)) {
        if (!COMPAT_SET.has(k)) {
          const hint = caseHint(k, [...COMPAT_SET]);
          push("error", "bad-route-compat-key",
            `${where}：compat 字段 "${k}"${hint ? `（想写 "${hint}"？）` : ""} 没有任何协议声明；解析会报 "which no wire protocol declares"`);
        } else if (v === null) {
          push("error", "compat-null-value",
            `${where}：compat.${k}=null；解析会报 "sets compat … with no value"（要么给值，要么删掉这个键）`);
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

      // input：非字符串元素是真正的两层盲区
      if (m.input !== undefined) {
        if (!Array.isArray(m.input)) {
          push("error", "input-not-array", `${mw}：input 必须是数组（写成 ${JSON.stringify(m.input)} 时 Config 层直接拒绝整份配置）`);
        } else {
          for (const im of m.input) {
            if (!MODALITY_SET.has(im)) {
              const hint = caseHint(im, MODALITIES);
              push("error", "bad-modality", `${mw}：input 含 ${JSON.stringify(im)}${hint ? `（想写 "${hint}"？）` : ""}；只有 text / image 合法`);
            }
          }
        }
      }

      // thinkingFormat：Config 层有枚举，非法值与大小写都会被拒（不会静默退化）；这里提前给出可读提示
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
      if (m.compat !== undefined && (m.compat === null || typeof m.compat !== "object" || Array.isArray(m.compat))) {
        push("error", "bad-compat-shape", `${mw}：compat 必须是对象`);
      } else {
        for (const [k, v] of Object.entries(m.compat ?? {})) {
          if (!COMPAT_KEYS.has(k)) {
            const hint = caseHint(k, [...COMPAT_KEYS]);
            push("warn", "unknown-compat-key", `${mw}：compat 未知字段 "${k}"${hint ? `（想写 "${hint}"？）` : ""}`);
          } else if (v === null) {
            push("error", "compat-null-value",
              `${mw}：compat.${k}=null；解析会报 "sets compat … with no value"（要么给值，要么删掉这个键）`);
          }
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

      // ── 5. 三条「两层都放行、但序列化阶段静默失效」的写法（v0.3.0，外部评审意见 7）
      const routeCompat = r.compat ?? {};
      const modelCompat = m.compat ?? {};

      // 5.1 thinkingFormat 挂在 reasoningEfforts:false 上：思考整体关闭，格式没有用武之地
      if (modelCompat.thinkingFormat !== undefined && m.reasoningEfforts === false) {
        push("warn", "thinking-format-without-efforts",
          `${mw}：compat.thinkingFormat=${JSON.stringify(modelCompat.thinkingFormat)} 但 reasoningEfforts=false（思考关闭），这个格式不会产生任何请求字段`);
      }

      // 5.2 写了 thinkingTokenBudgetField（或 supportsThinkingTokenBudget），但路由没给 thinkingBudgets：
      //     预算数值来自路由的 thinkingBudgets，缺了它 resolveClampedThinkingBudget 不会挂任何字段
      const budgetField = modelCompat.thinkingTokenBudgetField ?? routeCompat.thinkingTokenBudgetField;
      const budgetSwitch = modelCompat.supportsThinkingTokenBudget ?? routeCompat.supportsThinkingTokenBudget;
      if ((budgetField !== undefined || budgetSwitch === true) && r.thinkingBudgets === undefined) {
        push("warn", "thinking-budget-without-map",
          `${mw}：声明了 thinking 预算字段/开关，但路由没有 thinkingBudgets；预算值无处可取，请求里不会出现该字段（写 supportsThinkingTokenBudget 时需要配合路由级 thinkingBudgets: {low: 数字, high: 数字…}）`);
      }

      // 5.3 qwen 系列格式：档位差异依赖 compat.supportsReasoningEffort，否则多档全部等价
      const fmt = modelCompat.thinkingFormat ?? routeCompat.thinkingFormat;
      const multiLevel = eff && typeof eff === "object" && !Array.isArray(eff)
        && Object.keys(eff).filter((k) => k !== "off").length > 1;
      const effortProven = modelCompat.supportsReasoningEffort ?? routeCompat.supportsReasoningEffort;
      // v0.4.0（外部评审 2a）：qwen 系列网关（典型是阿里云百炼兼容模式）在服务端只认
      // enable_thinking / thinking_budget，收到顶层 reasoning_effort 往往**静默忽略**。
      // 声明 supportsReasoningEffort: true 会让 pi-ai 照发该字段，请求体虽然不同，
      // 档位在服务端可能完全等价 —— 本地无法证明，只能提示。
      if (["qwen", "qwen-chat-template", "chat-template"].includes(fmt) && effortProven === true) {
        push("warn", "qwen-effort-may-be-ignored",
          `${mw}：qwen 系列格式声明了 supportsReasoningEffort: true，pi-ai 会发顶层 reasoning_effort；但部分 qwen 网关（如百炼兼容模式）只认 enable_thinking / thinking_budget，可能静默忽略该字段 → low/high 在服务端仍然等价。建议用「同一 prompt 各发 2 次、比较 reasoning token 中位数」实测后再决定（probe 的 thinking-effort 步骤已这么做）`);
      }
      // 关不掉思考：有多个档位但一个 off 都没有 → UI 里没有关闭项
      const hasOff = eff && typeof eff === "object" && Object.prototype.hasOwnProperty.call(eff, "off");
      if (multiLevel && !hasOff) {
        push("warn", "thinking-no-off-level",
          `${mw}：reasoningEfforts 有多个档位但没有 off 档 —— 除非这是纯推理模型（关不掉），否则 UI 里将没有「关闭思考」的选项；若只是没测到关法，别急着写多档`);
      }
      if (multiLevel && ["qwen", "qwen-chat-template", "chat-template"].includes(fmt) && !effortProven) {
        push("warn", "qwen-levels-may-collapse",
          `${mw}：thinkingFormat=${JSON.stringify(fmt)} 下多档位是否等价取决于 compat.supportsReasoningEffort；**不声明时 pi-ai 对未知 provider 默认按 true 处理**（openai-completions 会照发 reasoning_effort），想只发 enable_thinking 布尔必须显式写 supportsReasoningEffort: false，否则 low/high 靠 reasoning_effort 区分（先探测确认再决定）`);
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