/**
 * compaction.mjs — dsh-compaction-basic 的压缩预算公式（真值来源的唯一副本）。
 *
 * 为什么单独成模块（v0.3.0，外部评审指出）：这份公式在 **另一个包** 里
 * （/opt/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:124-145
 *  resolveCompactSpec），而 dsh-llm-pi-ai 的 Config / resolveProfiles 完全不检查它。
 * 于是「两段校验全绿 → 写盘 → DSH 热重载 → 启动即抛 TargetPressureConfigError」。
 * 本模块被三处复用：
 *   1. scripts/context-budget.mjs（命令行）
 *   2. lib/load-path.mjs 的 Stage 3（写前预演强制跑）
 *   3. lib/snippet.mjs（生成片段时反推安全的 maxTokens）
 *
 * 源码事实（resolveCompactSpec，行号同上）：
 *   messageBudgetTokens  = contextWindow - reservedCompletionTokens
 *   pressureBudgetTokens = messageBudgetTokens - headroomTokens
 *   thresholdTokens      = floor(min(contextWindow * thresholdRatio, pressureBudgetTokens))
 *   retainTokens         = policy.retainTokens ?? floor(messageBudgetTokens * retainRatio)
 * 三类硬失败（顺序即源码顺序）：
 *   ① messageBudgetTokens <= 0   → "... leaving no message budget"
 *   ② pressureBudgetTokens <= 0  → "... leaving no pressure budget"
 *   ③ retainTokens >= thresholdTokens → "retainTokens (...) must be less than threshold tokens ..."
 * 另外 reservedCompletionTokens 的来源是 dsh-compaction-basic/lib/index.js:757：
 *   maxTokens ?? defaultMaxTokens ?? 0（模型级优先，其次路由级 defaultMaxTokens）
 */

/** 与 dsh-compaction-basic 一致：headroom 默认 65536（:63）。 */
export const DEFAULT_HEADROOM_TOKENS = 65536;
/** 与 dsh-compaction-basic 一致：thresholdRatio 默认 0.8（:15）。 */
export const DEFAULT_THRESHOLD_RATIO = 0.8;
/** 与 dsh-compaction-basic 一致：retainRatio 默认 0.16（:17）。 */
export const DEFAULT_RETAIN_RATIO = 0.16;
/**
 * 工程下限（不是 DSH 的硬约束）：压缩后留下的尾巴必须离阈值足够远，
 * 否则下一轮立刻又越线，形成「压缩-请求-又压缩」的抖动。
 * 外部评审给出的经验值是 30000~50000，这里取保守的 30000。
 */
export const MIN_GAP_TOKENS = 30000;

/**
 * 计算一条路由/模型的压缩预算。
 * @param {{contextWindow:number, reservedCompletionTokens:number, headroomTokens?:number,
 *          thresholdRatio?:number, retainRatio?:number, retainTokens?:number|null,
 *          minGap?:number}} o
 */
export function computeBudget(o) {
  const ctx = o.contextWindow;
  const reserved = o.reservedCompletionTokens ?? 0;
  const headroom = o.headroomTokens ?? DEFAULT_HEADROOM_TOKENS;
  const thresholdRatio = o.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const retainRatio = o.retainRatio ?? DEFAULT_RETAIN_RATIO;
  const minGap = o.minGap ?? MIN_GAP_TOKENS;

  // v0.3.1：所有返回都带上生效参数，否则调用方 `budget.headroomTokens ?? DEFAULT`
  // 在「早退分支」（比如 messageBudget≤0）会显示出默认 65536，把用户 patch 里的
  // headroomTokens: 0 悄悄盖掉 —— 这是一个真复现过的显示/计算二义性 bug。
  const base = { contextWindow: ctx, reservedCompletionTokens: reserved, headroomTokens: headroom, thresholdRatio, retainRatio, minGap };
  const problems = [];
  if (!Number.isInteger(ctx) || ctx <= 0) {
    return { ...base, ok: false, problems: [`contextWindow (${ctx}) 必须是正整数`] };
  }
  if (!Number.isInteger(reserved) || reserved < 0) {
    return { ...base, ok: false, problems: [`reservedCompletionTokens (${reserved}) 必须是非负整数`] };
  }

  const messageBudgetTokens = ctx - reserved;
  if (messageBudgetTokens <= 0) {
    problems.push(
      `messageBudget = ${messageBudgetTokens} ≤ 0：请求 maxTokens(${reserved}) 已吃满整个 ${ctx} 窗口（DSH 原文：leaving no message budget）`,
    );
    return { ...base, messageBudgetTokens, ok: false, problems };
  }
  const pressureBudgetTokens = messageBudgetTokens - headroom;
  const thresholdTokens = Math.floor(Math.min(ctx * thresholdRatio, pressureBudgetTokens));
  const retainTokens = o.retainTokens === undefined || o.retainTokens === null ? Math.floor(messageBudgetTokens * retainRatio) : o.retainTokens;
  const gap = thresholdTokens - retainTokens;

  if (pressureBudgetTokens <= 0) {
    problems.push(
      `pressureBudget = ${pressureBudgetTokens} ≤ 0：maxTokens(${reserved}) + headroom(${headroom}) 用完了 ${ctx} 窗口（DSH 原文：leaving no pressure budget）`,
    );
  }
  if (retainTokens >= thresholdTokens) {
    problems.push(`retainTokens (${retainTokens}) ≥ thresholdTokens (${thresholdTokens})：retain 必须小于 threshold（DSH 硬失败）`);
  }
  if (pressureBudgetTokens > 0 && retainTokens < thresholdTokens && gap < minGap) {
    problems.push(`缓冲带 gap = ${gap} < ${minGap}：压缩后会反复触发（工程下限，不是 DSH 硬约束）`);
  }

  return {
    contextWindow: ctx,
    reservedCompletionTokens: reserved,
    headroomTokens: headroom,
    thresholdRatio,
    retainRatio,
    messageBudgetTokens,
    pressureBudgetTokens,
    thresholdTokens,
    retainTokens,
    gap,
    minGap,
    ok: problems.length === 0,
    problems,
  };
}

/** 与 :757 一致：模型级 maxTokens 优先，否则路由级 defaultMaxTokens，否则 0。 */
export function reservedCompletionTokensOf(model, routeDefaultMaxTokens) {
  const v = model?.maxTokens ?? routeDefaultMaxTokens ?? 0;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * 从 cordis.patch.yml 里读 compaction 插件配置（全局 + modelPolicies 覆盖）。
 * @param {any} doc  已 parse 的 YAML（数组形态的 patch 层）
 * @returns {{found:boolean, headroomTokens:number, thresholdRatio:number, retainRatio:number,
 *            retainTokens:number|null, modelPolicies:any[], raw:any}}
 */
export function compactionConfigFromPatch(doc) {
  const out = {
    found: false,
    headroomTokens: DEFAULT_HEADROOM_TOKENS,
    thresholdRatio: DEFAULT_THRESHOLD_RATIO,
    retainRatio: DEFAULT_RETAIN_RATIO,
    retainTokens: null,
    modelPolicies: [],
    raw: null,
  };
  const entries = Array.isArray(doc) ? doc : [];
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e !== "object") continue;
    const name = String(e.name ?? "");
    const id = String(e.id ?? "");
    if (!name.includes("dsh-compaction-basic") && !id.includes("dsh-compaction-basic")) continue;
    const cfg = e.config ?? {};
    // v0.3.4（审计 P0-4）：DSH 的 applyPatches 是顺序执行 target[key] = value，
    // 同 id 出现多次时**后一条整块覆盖前一条**。必须取最后一条，否则工具按第一条
    // 算出「全绿」，DSH 启动时按最后一条直接抛 TargetPressureConfigError。
    if (out.found) (out.duplicates ??= []).push({ index: i, config: cfg });
    out.found = true;
    out.raw = cfg;
    out.headroomTokens = Number.isFinite(cfg.headroomTokens) ? cfg.headroomTokens : undefined;
    out.thresholdRatio = Number.isFinite(cfg.thresholdRatio) ? cfg.thresholdRatio : undefined;
    out.retainRatio = Number.isFinite(cfg.retainRatio) ? cfg.retainRatio : undefined;
    out.retainTokens = Number.isFinite(cfg.retainTokens) ? cfg.retainTokens : undefined;
    out.modelPolicies = Array.isArray(cfg.modelPolicies) ? cfg.modelPolicies : undefined;
  }
  return out;
}

/** 按 provider/model 取合并后的 policy 数字（modelPolicies 覆盖全局）。 */
export function policyForRoute(config, provider, model) {
  const base = {
    headroomTokens: config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
    thresholdRatio: config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
    retainRatio: config.retainRatio ?? DEFAULT_RETAIN_RATIO,
    retainTokens: config.retainTokens ?? null,
  };
  const hit = (config.modelPolicies ?? []).find((p) => p && p.provider === provider && p.model === model);
  if (!hit) return base;
  return {
    headroomTokens: Number.isFinite(hit.headroomTokens) ? hit.headroomTokens : base.headroomTokens,
    thresholdRatio: Number.isFinite(hit.thresholdRatio) ? hit.thresholdRatio : base.thresholdRatio,
    retainRatio: Number.isFinite(hit.retainRatio) ? hit.retainRatio : base.retainRatio,
    retainTokens: Number.isFinite(hit.retainTokens) ? hit.retainTokens : base.retainTokens,
  };
}

/** 生成片段时用的候选 maxTokens 阶梯（从大到小试）。 */
export const MAX_TOKENS_LADDER = [65536, 49152, 32768, 24576, 16384, 12288, 8192, 4096];

/**
 * 反推「既不超过网关实测上限、又满足预算约束」的 maxTokens。
 *
 * 规则（v0.3.0，吸收外部评审意见 3）：
 *   - 不超过网关实测上限 gateMax；
 *   - 不超过 floor(contextWindow * 0.2)（避免把 20% 以上的窗口当输出预留）；
 *   - 必须让 computeBudget 无问题（pressure>0 且 gap≥minGap）。
 *
 * @returns {{maxTokens:number|null, reason:string, budget:object|null}}
 */
export function pickSafeMaxTokens(o) {
  const ctx = o.contextWindow;
  const gateMax = Number.isFinite(o.gateMax) && o.gateMax > 0 ? o.gateMax : null;
  const cap = Math.floor(ctx * (o.maxOutputFraction ?? 0.2));
  const limit = gateMax === null ? cap : Math.min(gateMax, cap);
  const candidates = MAX_TOKENS_LADDER.filter((v) => v <= limit);
  if (!candidates.length) {
    // 连 4096 都放不下：退回一个能过压力校验的最小值。
    // v0.3.4（审计 P1-6）：绝不能超过 limit（gateMax 实测上限 / ctx×0.2），
    // 否则 --max 1024 会被这条回退越过，写出 20000 这种网关必拒的值。
    const fallback = Math.min(limit, Math.max(1024, Math.floor(ctx * 0.1)));
    const budget = computeBudget({
      contextWindow: ctx,
      reservedCompletionTokens: fallback,
      headroomTokens: o.headroomTokens,
      thresholdRatio: o.thresholdRatio,
      retainRatio: o.retainRatio,
      retainTokens: o.retainTokens,
      minGap: o.minGap,
    });
    if (budget.ok) return { maxTokens: fallback, reason: `没有候选值 ≤ ${limit}，退回 ${fallback}`, budget };
    return { maxTokens: null, reason: `ctx×0.2=${cap} 比最小候选 4096 还小，且没有任何取值能过压缩预算（${budget.problems.join("；")}）`, budget };
  }
  for (const v of candidates) {
    const budget = computeBudget({
      contextWindow: ctx,
      reservedCompletionTokens: v,
      headroomTokens: o.headroomTokens,
      thresholdRatio: o.thresholdRatio,
      retainRatio: o.retainRatio,
      retainTokens: o.retainTokens,
      minGap: o.minGap,
    });
    if (budget.ok) {
      return {
        maxTokens: v,
        reason: gateMax === null ? `未测网关上限，按 ctx×0.2 取下界 ${v}` : `网关接受 ≥${gateMax}，取 ${v} 以满足预算约束`,
        budget,
      };
    }
  }
  // 所有候选都过不了预算（窗口太小/headroom 太大）：返回最小候选并带上原因
  const v = candidates[candidates.length - 1];
  const budget = computeBudget({
      contextWindow: ctx,
      reservedCompletionTokens: v,
      headroomTokens: o.headroomTokens,
      thresholdRatio: o.thresholdRatio,
      retainRatio: o.retainRatio,
      retainTokens: o.retainTokens,
      minGap: o.minGap,
  });
  return {
    maxTokens: null,
    reason: `ctx=${ctx} 在 headroom=${o.headroomTokens ?? DEFAULT_HEADROOM_TOKENS} 下没有安全取值；连 ${v} 也不满足预算（${(budget.problems ?? []).join("；")}），要调小 headroomTokens 或换更大窗口的模型`,
    budget,
  };
}

/**
 * 给定窗口与 headroom，能通过 pressure 约束的最小 contextWindow。
 * （pressure>0 ⇔ ctx > maxTokens + headroom）
 */
export function minContextWindowFor(maxTokens, headroomTokens = DEFAULT_HEADROOM_TOKENS, minGap = MIN_GAP_TOKENS) {
  // v0.3.4（审计 P0-1）：NaN 会让下面的 hi *= 2 永远为 NaN，`hi > 1e9` 对 NaN 恒 false → 死循环。
  if (!Number.isFinite(maxTokens) || !Number.isFinite(headroomTokens) || !Number.isFinite(minGap)) {
    throw new TypeError(`minContextWindowFor 需要有限数，收到 maxTokens=${maxTokens} headroomTokens=${headroomTokens} minGap=${minGap}`);
  }
  // v0.3.1 修正：旧版只算了 pressure>0（ctx > max+headroom），漏了
  // gap = threshold - retain ≥ minGap 与 retain < threshold。真实下界要大得多：
  // 例如 max=4096 / headroom=65536 时窗口要 ≥ 117829，而不是 69633。
  const test = (ctx) => computeBudget({
    contextWindow: ctx,
    reservedCompletionTokens: maxTokens,
    headroomTokens,
    minGap,
  }).ok;
  let lo = 1, hi = Math.max(1024, maxTokens + headroomTokens + 1);
  while (!test(hi)) {
    lo = hi + 1;
    hi *= 2;
    if (!Number.isFinite(hi) || hi > 1e9) return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (test(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}