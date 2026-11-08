/**
 * load-path.mjs — 按 DSH 的**真实两段加载路径**验一份 providers。
 *
 * DSH 挂载 dsh-llm-pi-ai 时（/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js）：
 *
 *   :2938  ctx.on("internal/config", (fiber, next) => {
 *   :2940      const candidate = Config(raw);          ← 第 1 段：schemastery 结构校验
 *   :2931      const next2 = resolveProfiles(raw, "deferred");  ← 第 2 段：语义解析
 *
 * 只跑 resolveProfiles 会漏掉第 1 段，从而把「Config 会拒」的坏值误报成「静默放行」。
 * 本模块把两段都跑一遍，返回每段的独立结论。审计教训之一。
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

/** 当前探针路径；退出/被信号杀掉时也要删干净（审计：SIGTERM 会留残留文件）。 */
const liveProbes = new Set();
let hooksInstalled = false;
function installCleanupHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const purge = () => { for (const p of liveProbes) { try { rmSync(p, { force: true }); } catch {} } };
  process.on("exit", purge);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { purge(); process.exit(130); });
  }
}
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

/** 只保留报告需要的字段。 */
function pick(m) {
  return {
    id: m.id,
    contextWindow: m.contextWindow ?? null,
    maxTokens: m.maxTokens ?? null,
    input: m.input ?? null,
    reasoning: Boolean(m.reasoning),
    levels: m.thinkingLevelMap ?? null,
    thinkingFormat: m.compat?.thinkingFormat ?? null,
  };
}

/** 取第一个模型级错误。 */
function firstModelError(v) {
  return [...(v.modelErrors ?? new Map()).entries()][0]?.[1] ?? v.catalogError ?? null;
}

/**
 * @param {string} pluginRoot  含 lib/index.js 的 dsh-llm-pi-ai 目录
 * @param {Record<string, any>} providers
 * @param {string} [mode] "strict" | "deferred"（resolveProfiles 的语义校验强度）
 * @returns {Promise<{schema:{ok:boolean,error:string|null}, semantic:{ok:boolean,error:string|null}, routes:Record<string,{models:string[], details:object[], error:string|null}>}>}
 */
async function verifyLoadPath(pluginRoot, providers, mode = "strict") {
  const libDir = join(pluginRoot, "lib");
  const entry = join(libDir, "index.js");
  if (!existsSync(entry)) throw new Error(`找不到 ${entry}`);

  // 探针要放在插件目录内（否则相对导入解析不到），并且必须 try/finally 清理。
  installCleanupHooks();
  const probe = join(libDir, "__loadpath-probe.mjs");
  liveProbes.add(probe);
  writeFileSync(probe, readFileSync(entry, "utf8") + "\nexport { resolveProfiles };\n");
  try {
    // 拿 Config：本文件末尾的 export 没带它（它本来就在插件里导出）
    const mod = await import(`file://${probe}?t=${Date.now()}`);
    const { Config, resolveProfiles } = mod;

    // 第 1 段
    let schema = { ok: true, error: null };
    try {
      Config({ providers });
    } catch (e) {
      schema = { ok: false, error: String(e?.message ?? e).split("\n")[0] };
    }

    // 第 2 段（即使第 1 段失败也跑，好让报告同时给出两层的意见）
    const semantic = { ok: true, error: null };
    const routes = {};
    try {
      const map = await resolveProfiles(providers, mode);
      for (const [route, v] of map) {
        const full = v.piProvider ? await v.piProvider.getModels() : [];
        const models = full.map((m) => m.id);
        routes[route] = { models, details: full.map(pick), error: firstModelError(v) };
      }
    } catch (e) {
      semantic.ok = false;
      semantic.error = String(e?.message ?? e).split("\n")[0];
      // strict 是一条错误打断全部；换 deferred 拿到逐路由结果
      if (mode === "strict") {
        try {
          const map = await resolveProfiles(providers, "deferred");
          for (const [route, v] of map) {
            const full = v.piProvider ? await v.piProvider.getModels() : [];
            routes[route] = { models: full.map((m) => m.id), details: full.map(pick), error: firstModelError(v) };
          }
        } catch {
          /* deferred 也炸就只留 semantic.error */
        }
      }
    }
    return { schema, semantic, routes };
  } finally {
    liveProbes.delete(probe);
    rmSync(probe, { force: true });
  }
}

export { verifyLoadPath };