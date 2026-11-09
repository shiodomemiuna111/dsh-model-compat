/**
 * load-path.mjs — 按 DSH 的**真实加载路径**验一份 providers。
 *
 * 三段（v0.3.0 补齐第 3 段；外部评审指出的架构漏洞）：
 *
 *   第 1 段 Config(raw)                     —— dsh-llm-pi-ai/lib/index.js:1086
 *   第 2 段 resolveProfiles(raw, strict)    —— 同文件 :1120
 *   第 3 段 resolveCompactSpec(...)         —— **另一个包** dsh-compaction-basic:124-145
 *
 * 前两段只管「字段是不是合法」，完全不管压缩预算；而真正决定 DSH 能不能启动的
 * 是第 3 段：B = ctx - reserved、pressure = B - headroom、retain < threshold。
 * 只跑前两段就会「预演全绿 → 写盘 → 热重载当场抛 TargetPressureConfigError」。
 *
 * 探针策略（v0.3.0 按评审修）：
 *   - 不再往插件 lib/ 目录写固定名 `__loadpath-probe.mjs`：
 *     ① 只读安装目录（普通用户 /usr/lib/node_modules、/opt）会 EACCES；
 *     ② 固定文件名在并发调用时会互删。
 *   - 改为：在 os.tmpdir() 建唯一临时目录，写入入口副本 + `node_modules` 软链，
 *     import 后再整目录删除。只读安装目录也能用（不再需要写权限）。
 *   - 临时目录在 SIGINT/SIGTERM/SIGHUP/exit 都清理（SIGKILL 无法捕获，见 §5 边界）。
 */
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { computeBudget, policyForRoute, reservedCompletionTokensOf } from "./compaction.mjs";

/** 当前存活探针目录；退出/被信号杀掉时也要删干净。 */
const liveProbes = new Set();
let hooksInstalled = false;
function installCleanupHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const purge = () => { for (const p of liveProbes) { try { rmSync(p, { recursive: true, force: true }); } catch {} } };
  process.on("exit", purge);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { purge(); process.exit(130); });
  }
}

/** 找到包含 @deepseek-ai 包的那层 node_modules。 */
function findNodeModules(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (basename(dir) === "node_modules" && existsSync(join(dir, "@earendil-works", "pi-ai"))) return dir;
    const candidate = join(dir, "node_modules");
    if (existsSync(join(candidate, "@earendil-works", "pi-ai"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 建一个可 import 的探针入口。
 * @returns {{dir:string, entry:string, cleanup():void}}
 */
function makeProbe(pluginRoot) {
  installCleanupHooks();
  const srcEntry = join(pluginRoot, "lib", "index.js");
  if (!existsSync(srcEntry)) throw new Error(`找不到 ${srcEntry}`);
  const source = readFileSync(srcEntry, "utf8") + "\nexport { resolveProfiles };\n";

  const nodeModules = findNodeModules(pluginRoot);
  const dir = mkdtempSync(join(tmpdir(), "dsh-loadpath-"));
  liveProbes.add(dir);
  const cleanup = () => { liveProbes.delete(dir); try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  try {
    writeFileSync(join(dir, "index.mjs"), source);
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    // 入口只使用裸包名导入（插件源码里没有相对导入），所以软链一层 node_modules 就够。
    if (nodeModules) symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
    else {
      // 找不到 node_modules（非常规布局）：退回到写进插件目录（旧行为）
      const fallback = join(pluginRoot, "lib", `__loadpath-probe-${process.pid}-${Date.now()}.mjs`);
      writeFileSync(fallback, source);
      cleanup();
      return { dir: null, entry: fallback, cleanup: () => { try { rmSync(fallback, { force: true }); } catch {} } };
    }
  } catch (e) {
    cleanup();
    throw new Error(`建探针失败（临时目录不可写？）：${e?.message ?? e}`);
  }
  return { dir, entry: join(dir, "index.mjs"), cleanup };
}

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
 * @param {{compaction?: any, minGap?: number}} [options]
 *        compaction: compactionConfigFromPatch() 的结果；缺省用 dsh-compaction-basic 默认值
 * @returns {Promise<{schema:{ok:boolean,error:string|null},
 *                     semantic:{ok:boolean,error:string|null},
 *                     routes:Record<string,{models:string[], details:object[], error:string|null}>,
 *                     budget:{ok:boolean, failures:string[], checked:number, skipped:number}}>}
 */
async function verifyLoadPath(pluginRoot, providers, mode = "strict", options = {}) {
  const probe = makeProbe(pluginRoot);
  const compaction = options.compaction ?? null;
  try {
    const mod = await import(`file://${probe.entry}?t=${Date.now()}`);
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
    const collect = async (m) => {
      for (const [route, v] of m) {
        const full = v.piProvider ? await v.piProvider.getModels() : [];
        routes[route] = { models: full.map((x) => x.id), details: full.map(pick), error: firstModelError(v) };
      }
    };
    try {
      await collect(await resolveProfiles(providers, mode));
    } catch (e) {
      semantic.ok = false;
      semantic.error = String(e?.message ?? e).split("\n")[0];
      if (mode === "strict") {
        try { await collect(await resolveProfiles(providers, "deferred")); } catch { /* deferred 也炸 */ }
      }
    }

    // 第 3 段：压缩预算（只需前两段解析出来的模型数字）
    const budget = checkCompaction(routes, providers, compaction, options.minGap);
    return { schema, semantic, routes, budget };
  } finally {
    probe.cleanup();
  }
}

/**
 * 第 3 段：对每个路由的每个模型算一遍 resolveCompactSpec 的三类硬失败。
 * @returns {{ok:boolean, failures:string[], checked:number, skipped:number}}
 */
function checkCompaction(routes, providers, compaction, minGap) {
  const failures = [];
  let checked = 0, skipped = 0;
  for (const [route, info] of Object.entries(routes ?? {})) {
    const routeDefaultMax = providers?.[route]?.defaultMaxTokens;
    for (const m of info.details ?? []) {
      const reserved = reservedCompletionTokensOf(m, routeDefaultMax);
      if (m.contextWindow === null || m.contextWindow === undefined) { skipped++; continue; }
      const policy = policyForRoute(
        compaction ?? {
          headroomTokens: undefined, thresholdRatio: undefined, retainRatio: undefined,
          retainTokens: null, modelPolicies: [],
        },
        route,
        m.id,
      );
      const b = computeBudget({
        contextWindow: m.contextWindow,
        reservedCompletionTokens: reserved,
        headroomTokens: policy.headroomTokens,
        thresholdRatio: policy.thresholdRatio,
        retainRatio: policy.retainRatio,
        retainTokens: policy.retainTokens,
        minGap,
      });
      checked++;
      if (!b.ok) failures.push(`${route}/${m.id}: ${b.problems.join("；")}`);
    }
  }
  return { ok: failures.length === 0, failures, checked, skipped };
}

export { verifyLoadPath, checkCompaction, findNodeModules };