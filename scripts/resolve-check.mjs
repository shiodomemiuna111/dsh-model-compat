#!/usr/bin/env node
/**
 * resolve-check.mjs — 不启动 DSH，直接验证"第三方模型能力声明"能否被
 * 本机安装的 @deepseek-ai/dsh-llm-pi-ai 正确解析。
 *
 * 用法：
 *   node scripts/resolve-check.mjs                     # 检查 examples/cordis.patch.yml（默认）
 *   node scripts/resolve-check.mjs --patch a.yml       # 检查任意覆盖层（可重复）
 *
 * 默认补丁可用环境变量 DSH_HOME_PROFILE_PATCH 指向你自己的
 * $DSH_HOME/profiles/<name>/cordis.patch.yml，省得每次敲 --patch。
 *   node scripts/resolve-check.mjs --json              # 机器可读输出
 *
 * 退出码：0 = 全部通过；1 = 有路由解析失败；2 = 用法/环境错误
 *
 * 原理：真实加载路径是两段 —— `Config(raw)`（schemastery 结构校验，index.js:1086/:2940）
 * 再 `resolveProfiles(..., "deferred")`（语义校验，index.js:1120）。V6 起两段都跑，
 * 只跑后者会把「Config 会拒」的坏值误报成静默放行。resolveProfiles 正式入口没导出，
 * 实现：把 lib/index.js 复制成同目录临时文件、补一行 export 再 import；退出时删除。
 * 不修改 node_modules 里的任何原文件（除临时探针，正常/信号退出都会清掉）。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { staticAudit } from "../lib/audit.mjs";
import { verifyLoadPath } from "../lib/load-path.mjs";
import { computeBudget, compactionConfigFromPatch, policyForRoute } from "../lib/compaction.mjs";
import { createRequire } from "node:module";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { usageText } from "../lib/usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { patches: [], json: false, plugins: [], budget: false, lint: false, quiet: false, headroom: 65536 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--patch") out.patches.push(argv[++i]);
    else if (a === "--plugin-root" || a === "--plugin") out.plugins.push(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--budget") out.budget = true;
    else if (a === "--lint") out.lint = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--headroom") {
      // v0.3.4（审计 P1-7）：NaN 会让 computeBudget 的比较全为 false → 预算「全绿」。
      const raw = argv[++i], n = Number(raw);
      if (raw === undefined || raw === "" || !Number.isFinite(n)) throw new Error(`--headroom 需要有限数字，收到 ${raw === undefined ? "（缺失）" : JSON.stringify(raw)}`);
      out.headroom = n;
    }
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
  // 常见 DSH 安装位置（npm -g 的 dsh、官方安装脚本的 /opt/dsh）
  for (const nm of ["/opt/dsh/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"]) {
    candidates.push(`${nm}/@deepseek-ai/dsh-llm-pi-ai`);
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
  if (args.help) {
    console.log(usageText("resolve-check.mjs"));
    return 0;
  }
  // 帮助优先：--quiet 只压正常输出，不吞 --help 与错误
  if (args.quiet && !args.json) console.log = () => {};
  const plugin = locatePlugin(args.plugins);

  let failed = false;

  // 1) 两段加载路径校验（Config → resolveProfiles），探针由 verifyLoadPath 内部管理并清理
  // 2) 合并补丁层里的 llm-pi-ai.providers
  const patches = args.patches.length ? args.patches : [DEFAULT_PATCH];
  let providers = {};
  const loaded = [];
  let compactionConfig = null;   // dsh-compaction-basic 的 headroom / modelPolicies（可能不在补丁里）
  for (const file of patches) {
    const doc = await readYamlFile(resolvePath(file), plugin.root);
    loaded.push(file);
    const c = compactionConfigFromPatch(doc);
    if (c.found) compactionConfig = c;
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

  // 2b) 隔离 lint：逐条路由单独跑两段加载路径，定位"是哪一条把整份配置毒死了"
  let lintReport = null;
  if (args.lint) {
    lintReport = [];
    for (const [route, profile] of Object.entries(providers)) {
      let ok = true, msg = null, models = [];
      try {
        const one = await verifyLoadPath(plugin.root, { [route]: profile }, "strict", { compaction: compactionConfig });
        const r = one.routes[route];
        if (!one.schema.ok) { ok = false; msg = `Config 层：${one.schema.error}`; }
        else if (!one.semantic.ok) { ok = false; msg = `语义层：${one.semantic.error}`; }
        else if (!r || r.error) { ok = false; msg = r?.error ?? "解析失败"; }
        else if (!one.budget.ok) { ok = false; msg = `压缩预算：${one.budget.failures.join("；")}`; }
        else models = r.models;
      } catch (e) {
        ok = false;
        msg = String(e?.message ?? e).slice(0, 200);
      }
      lintReport.push({ route, ok, models, error: msg });
    }
    const bad = lintReport.filter((r) => !r.ok);
    if (!args.json) {
      console.log("逐路由隔离检查（Config + 语义 + 压缩预算，一条不过不会拖累别的）：");
      for (const r of lintReport) {
        console.log(`  ${r.ok ? "✓" : "✗"} ${r.route}${r.ok ? ` [${r.models.join(", ")}]` : ` ← ${r.error}`}`);
      }
      if (bad.length) console.log(`  注意：真实 DSH 的校验是"全体或全无"，上面 ${bad.length} 条失败会让整份配置被拒；` + `去掉它们或单独分一个 patch 层即可。`);
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

  // 3) 严格解析（全体）：先 Config，再语义
  const whole = await verifyLoadPath(plugin.root, providers, "strict", { compaction: compactionConfig });
  if (!whole.schema.ok) {
    console.error(`Config 层拒绝（整份）：${whole.schema.error}`);
    console.error(`提示：这正是 V5 及以前漏掉的一段；加 --lint 可逐条定位。`);
    failed = true;
  }
  if (!whole.semantic.ok) {
    console.error(`语义层拒绝（整份）：${whole.semantic.error}`);
    if (lintReport) {
      const bad = lintReport.filter((r) => !r.ok);
      if (bad.length) console.error(`肇事路由：${bad.map((r) => r.route).join(", ")}`);
    } else {
      console.error(`提示：加 --lint 可以逐条隔离，找出是哪一条把整份配置毒死了。`);
    }
    failed = true;
  }
  if (!whole.budget.ok) {
    console.error(`压缩预算拒绝（整份）：`);
    for (const f of whole.budget.failures) console.error(`  ✗ ${f}`);
    console.error(`提示：这是 dsh-compaction-basic 的检查（第三个包），Config/resolveProfiles 不会拦。`);
    failed = true;
  }
  if (failed && !args.json && !args.lint) return 1;

  // 逐路由结果（deferred 语义下拿到的完整清单）
  const routes = new Map();
  {
    const probe = await verifyLoadPath(plugin.root, providers, "deferred", { compaction: compactionConfig });
    for (const [route, r] of Object.entries(probe.routes)) {
      routes.set(route, r);
    }
  }

  const report = [];
  for (const [route, resolved] of routes) {
    if (resolved.error) {
      failed = true;
      report.push({ route, error: String(resolved.error).slice(0, 300) });
      continue;
    }
    for (const d of resolved.details ?? []) report.push({ route, ...d });
  }

  // 可选：检查压缩联动数字（阈值/保留/缓冲带）——公式来自 lib/compaction.mjs
  const budget = [];
  if (args.budget) {
    const seen = new Set();
    for (const r of report) {
      if (r.error || !r.contextWindow || !r.maxTokens) continue;
      const key = `${r.route}/${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const policy = policyForRoute(
        compactionConfig ?? { headroomTokens: args.headroom, thresholdRatio: 0.8, retainRatio: 0.16, retainTokens: null, modelPolicies: [] },
        r.route,
        r.id,
      );
      const b = computeBudget({
        contextWindow: r.contextWindow,
        reservedCompletionTokens: r.maxTokens,
        headroomTokens: args.headroom === 65536 ? policy.headroomTokens : args.headroom,
        thresholdRatio: policy.thresholdRatio,
        retainRatio: policy.retainRatio,
        retainTokens: policy.retainTokens,
      });
      if (!b.ok) failed = true;
      budget.push({ route: r.route, id: r.id, B: b.messageBudgetTokens, pressure: b.pressureBudgetTokens, threshold: b.thresholdTokens, retain: b.retainTokens, gap: b.gap, problems: b.problems });
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
