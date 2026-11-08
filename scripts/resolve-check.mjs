#!/usr/bin/env node
/**
 * resolve-check.mjs — 不启动 DSH，直接验证"第三方模型能力声明"能否被
 * 本机安装的 @deepseek-ai/dsh-llm-pi-ai 正确解析。
 *
 * 用法：
 *   node scripts/resolve-check.mjs                     # 检查当前 profile 的 cordis.patch.yml
 *   node scripts/resolve-check.mjs --patch a.yml       # 检查任意覆盖层（可重复）
 *   node scripts/resolve-check.mjs --json              # 机器可读输出
 *
 * 退出码：0 = 全部通过；1 = 有路由解析失败；2 = 用法/环境错误
 *
 * 原理：dsh-llm-pi-ai 的 validate 路径导出 resolveProfiles，但正式入口没导出它。
 * 这里把 lib/index.js 复制成临时文件、补一行 export，再 import 调用；退出时删除。
 * 不修改 node_modules 里的任何原文件。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { staticAudit } from "../lib/audit.mjs";
import { createRequire } from "node:module";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { patches: [], json: false, plugins: [], budget: false, lint: false, quiet: false, headroom: 65536 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--patch") out.patches.push(argv[++i]);
    else if (a === "--plugin-root") out.plugins.push(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--budget") out.budget = true;
    else if (a === "--lint") out.lint = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--headroom") out.headroom = Number(argv[++i]);
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else out.patches.push(a);
  }
  return out;
}

/** 找到 dsh-llm-pi-ai 包目录：优先 --plugin-root，其次从 cwd / 脚本目录向上找 node_modules。 */
function locatePlugin(roots) {
  const candidates = [];
  for (const r of roots) {
    // 允许 --plugin-root 直接指向 dsh-llm-pi-ai 包目录，或指向含 node_modules 的安装目录
    candidates.push(r, `${r}/@deepseek-ai/dsh-llm-pi-ai`, `${r}/node_modules/@deepseek-ai/dsh-llm-pi-ai`);
  }
  for (const base of [process.cwd(), here]) {
    let dir = base;
    for (let i = 0; i < 8; i++) {
      candidates.push(`${dir}/node_modules/@deepseek-ai/dsh-llm-pi-ai`);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const g of (process.env.DSH_GLOBAL_NODE_MODULES ?? "").split(":").filter(Boolean)) {
    candidates.push(`${g}/@deepseek-ai/dsh-llm-pi-ai`);
  }
  for (const c of candidates) {
    if (existsSync(`${c}/lib/index.js`) || existsSync(`${c}/lib/index.mjs`)) {
      const entry = existsSync(`${c}/lib/index.js`) ? `${c}/lib/index.js` : `${c}/lib/index.mjs`;
      return { root: c, entry };
    }
  }
  throw new Error(
    "找不到 @deepseek-ai/dsh-llm-pi-ai。用 --plugin-root 指路，例如：\n" +
      "  --plugin-root /opt/dsh/node_modules   （本机）\n" +
      "  --plugin-root \"$(npm root -g)\"          （npm 全局安装）\n" +
      "或在 DSH 安装目录 / 项目目录下运行本脚本",
  );
}

function loadYaml(pkgPath) {
  try {
    return require(pkgPath);
  } catch {
    return null;
  }
}

/** 极简 YAML 读取：优先用 DSH 自带的 yaml 包，退回到 JSON。 */
let yamlParser = null;
/** 依次尝试几个常见位置加载 yaml 解析器（DSH 自带一份）。 */
async function resolveYamlParser(pluginRoot) {
  if (yamlParser) return yamlParser;
  const tries = ["yaml"];
  if (pluginRoot) {
    // 插件在 <install>/node_modules/@deepseek-ai/dsh-llm-pi-ai 时，yaml 在 <install>/node_modules/yaml
    const nm = dirname(dirname(pluginRoot)); // <install>/node_modules
    tries.push(`${nm}/yaml`, `${pluginRoot}/node_modules/yaml`, `${nm}/js-yaml`);
  }
  for (const t of tries) {
    try { yamlParser = require(t); return yamlParser; } catch {}
  }
  try { yamlParser = await import("yaml"); return yamlParser; } catch {}
  throw new Error("找不到 yaml 解析器：在 DSH 安装目录下运行，或 npm i yaml");
}

async function readYamlFile(file, pluginRoot) {
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const text = readFileSync(file, "utf8");
  const y = await resolveYamlParser(pluginRoot);
  return y.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.quiet && !args.json) console.log = () => {};
  if (args.help) {
    console.log("用法: node scripts/resolve-check.mjs [--patch file.yml ...] [--lint] [--budget] [--json] [--plugin-root DIR]");
    console.log("  --lint    逐条路由隔离 strict 解析，找出会拖垮整份配置的那一条");
    console.log("  --budget  计算压缩联动（threshold / retain / gap）");
    return 0;
  }
  const plugin = locatePlugin(args.plugins);

  // 1) 生成探针：复制入口文件 + 追加 export
  const probeFile = `${plugin.root}/lib/__resolve-check-probe.mjs`;
  const body = readFileSync(plugin.entry, "utf8");
  writeFileSync(probeFile, `${body}\nexport { resolveProfiles };\n`);

  let resolveProfiles;
  try {
    ({ resolveProfiles } = await import(`${probeFile}?t=${Date.now()}`));
  } finally {
    try { unlinkSync(probeFile); } catch {}
  }
  if (typeof resolveProfiles !== "function") {
    throw new Error("该版本的 dsh-llm-pi-ai 没有导出 resolveProfiles（过低或过高）");
  }

  // 2) 合并补丁层里的 llm-pi-ai.providers
  const patches = args.patches.length ? args.patches : [DEFAULT_PATCH];
  let providers = {};
  const loaded = [];
  for (const file of patches) {
    const doc = await readYamlFile(resolvePath(file), plugin.root);
    loaded.push(file);
    const list = Array.isArray(doc) ? doc : [];
    for (const entry of list) {
      if (entry?.id === "llm-pi-ai" && entry.config?.providers) {
        for (const [route, profile] of Object.entries(entry.config.providers)) {
          providers[route] = { ...(providers[route] ?? {}), ...profile };
        }
      }
    }
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(`补丁层里没有 llm-pi-ai.providers：${loaded.join(", ")}`);
  }

  // 2b) 隔离 lint：逐条路由单独 strict 解析，定位"是哪一条把整份配置毒死了"
  let lintReport = null;
  if (args.lint) {
    lintReport = [];
    for (const [route, profile] of Object.entries(providers)) {
      let ok = true, msg = null, models = [];
      try {
        const one = await resolveProfiles({ [route]: profile }, "strict");
        for (const [, r] of one) models = (await r.piProvider.getModels()).map((m) => m.id);
      } catch (e) {
        ok = false;
        msg = String(e?.message ?? e).slice(0, 160);
      }
      lintReport.push({ route, ok, models, error: msg });
    }
    const bad = lintReport.filter((r) => !r.ok);
    if (args.json) {
      // JSON 分支统一在最后输出，这里只记录
    } else {
      console.log("逐路由隔离检查（strict，一条不过不会拖累别的）：");
      for (const r of lintReport) {
        console.log(`  ${r.ok ? "✓" : "✗"} ${r.route}${r.ok ? ` [${r.models.join(", ")}]` : ` ← ${r.error}`}`);
      }
      if (bad.length) console.log(`  注意：真实 DSH 的 strict 校验是"全体或全无"，上面 ${bad.length} 条失败会让整份配置被拒；` + `去掉它们或单独分一个 patch 层即可。`);
    }
  }

  // 2c) 静态审计：strict 放行但运行时会出事的写法
  const audit = staticAudit(providers);
  if (!args.json) {
    if (audit.length === 0) console.log("静态审计：未发现 strict 放行的问题写法。");
    else {
      console.log(`静态审计：发现 ${audit.length} 处 strict 不会拦、但运行时会出事的地方：`);
      for (const a of audit) console.log(`  ${a.level === "error" ? "✗" : "!"} ${a.msg}`);
    }
  }

  // 3) 严格解析（全体）
  let routes;
  try {
    routes = await resolveProfiles(providers, "strict");
  } catch (err) {
    console.error(`解析失败（strict）：${err?.message ?? err}`);
    if (lintReport) {
      const bad = lintReport.filter((r) => !r.ok);
      if (bad.length) console.error(`肇事路由：${bad.map((r) => r.route).join(", ")}`);
    } else {
      console.error(`提示：加 --lint 可以逐条隔离，找出是哪一条把整份配置毒死了。`);
    }
    return 1;
  }

  const report = [];
  let failed = false;
  for (const [route, resolved] of routes) {
    const models = await resolved.piProvider.getModels();
    const errors = [...(resolved.modelErrors?.entries?.() ?? [])].map(([id, msg]) => ({ id, msg: String(msg).slice(0, 200) }));
    if (errors.length && (resolved.modelErrors?.size ?? 0) > 0) failed = true;
    const rows = models.map((m) => ({
      route,
      id: m.id,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      input: m.input ?? null,
      reasoning: Boolean(m.reasoning),
      levels: m.thinkingLevelMap ?? null,
      thinkingFormat: m.compat?.thinkingFormat ?? null,
    }));
    report.push(...rows, ...errors.map((e) => ({ route, error: e.msg })));
  }

  // 可选：检查压缩联动数字（阈值/保留/缓冲带）
  const budget = [];
  if (args.budget) {
    const seen = new Map();
    for (const r of report) {
      if (r.error || !r.contextWindow || !r.maxTokens) continue;
      if (seen.has(r.route)) continue;
      seen.set(r.route, true);
      const B = r.contextWindow - r.maxTokens;
      const pressure = B - args.headroom;
      const threshold = Math.floor(Math.min(0.8 * r.contextWindow, pressure));
      const retain = Math.floor(B * 0.16);
      const gap = threshold - retain;
      const problems = [];
      if (pressure <= 0) problems.push("pressure≤0（会报 TargetPressureConfigError）");
      if (retain >= threshold) problems.push("retain≥threshold（配置被拒）");
      if (gap < 30000) problems.push(`缓冲带 ${gap}<30000（会抖动）`);
      if (problems.length) failed = true;
      budget.push({ route: r.route, B, pressure, threshold, retain, gap, problems });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: !failed && !audit.some((a) => a.level === "error"), audit, patches: loaded, models: report, ...(args.budget ? { budget } : {}), ...(lintReport ? { lint: lintReport } : {}) }, null, 2));
  } else {
    console.log(`插件: ${plugin.root}`);
    console.log(`补丁: ${loaded.join(", ")}`);
    for (const r of report) {
      if (r.error) console.log(`✗ ${r.route}: ${r.error}`);
      else
        console.log(
          `✓ ${r.route} / ${r.id}  ctx=${r.contextWindow}  max=${r.maxTokens}  input=[${r.input}]  reasoning=${r.reasoning}  levels=${r.levels ? Object.entries(r.levels).filter(([, v]) => v).map(([k]) => k).join("/") : "—"}` +
            (r.thinkingFormat ? `  format=${r.thinkingFormat}` : ""),
        );
    }
    if (args.budget) {
      console.log(`\n压缩联动（headroom=${args.headroom}）：`);
      for (const b of budget) {
        console.log(`  ${b.problems.length ? "✗" : "✓"} ${b.route}: threshold=${b.threshold} retain=${b.retain} gap=${b.gap}${b.problems.length ? "  ← " + b.problems.join("；") : ""}`);
      }
    }
  }
  return failed || audit.some((a) => a.level === "error") ? 1 : 0;
}

const DEFAULT_PATCH =
  process.env.DSH_HOME_PROFILE_PATCH ??
  dirname(dirname(new URL(import.meta.url).pathname)) + "/examples/cordis.patch.yml";

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(2);
  });
