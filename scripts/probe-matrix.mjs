#!/usr/bin/env node
/**
 * probe-matrix.mjs — 跨版本兼容矩阵：把同一份 cordis.patch.yml 交给多个
 * 历史版本的 @deepseek-ai/dsh-llm-pi-ai 解析，验证方案不是只对新版本有效。
 *
 * 用法：
 *   node scripts/probe-matrix.mjs --patch path/to/cordis.patch.yml
 *   node scripts/probe-matrix.mjs --patch ... --versions 0.0.1-rc.5,0.2.2-rc.1 --work /tmp/matrix
 *
 * 做法：$WORK/<version>/ 下建一个隔离的 node_modules，把该版本插件与其
 * 匹配的 pi-ai 装进去（其余 @deepseek-ai/* 从本机 DSH 安装目录 symlink），
 * 补一份兼容 shim（老版本 import 了新版已删的名字），然后跑 resolveProfiles。
 *
 * 注意：这是"验证用"的沙箱，不碰真实安装目录；npm install 会清掉手工放的目录，
 * 所以安装顺序是 pi-ai → 放插件 → 建 shim → symlink。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve as rp } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = {
  patch: null,
  versions: ["0.0.1-rc.5", "0.1.5-rc.3", "0.1.7-rc.2", "0.2.1-rc.5", "0.2.2-rc.1"],
  work: "/tmp/dsh-model-compat-matrix",
  dshRoot: "/opt/dsh/node_modules",
  keep: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === "--patch") opt.patch = next();
  else if (a === "--versions") opt.versions = next().split(",").map((s) => s.trim()).filter(Boolean);
  else if (a === "--work") opt.work = next();
  else if (a === "--dsh-root") opt.dshRoot = next();
  else if (a === "--keep") opt.keep = true;
  else if (a === "-h" || a === "--help") { console.log("用法: probe-matrix.mjs --patch file.yml [--versions a,b] [--work DIR] [--dsh-root DIR]"); process.exit(0); }
  else throw new Error(`unknown flag: ${a}`);
}
if (!opt.patch) { console.error("必须给 --patch"); process.exit(2); }

const nm = opt.dshRoot;
const JSON_HEADERS = { name: "", version: "0.0.0-compat", type: "module", exports: { ".": "./index.mjs" } };
const SHIMS = {
  "dsh-llm": `import * as b from "${nm}/@deepseek-ai/dsh-llm/lib/index.js";
export * from "${nm}/@deepseek-ai/dsh-llm/lib/index.js";
export const CallId = b.CallId ?? ((id) => id);
export const offloadRequestImagesWithPolicy = b.offloadRequestImagesWithPolicy ?? (async () => { throw new Error("shim: unavailable"); });
`,
  "dsh-settings": `import * as b from "${nm}/@deepseek-ai/dsh-settings/lib/index.js";
export * from "${nm}/@deepseek-ai/dsh-settings/lib/index.js";
export const deepEqualJson = b.deepEqualJson ?? ((a, c) => JSON.stringify(a) === JSON.stringify(c));
export const installSettingsSection = b.installSettingsSection ?? (() => {});
export const settingsNamespace = b.settingsNamespace ?? ((n) => n);
`,
};
const SYMLINK_DEPS = ["dsh-timeout", "dsh-credentials", "dsh-launch-environment", "dsh-util-values", "dsh-brand", "dsh-attachment", "dsh-fs", "dsh-authorization", "cordis-plugin-loader", "cordis"];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

function prepare(version) {
  const dir = join(opt.work, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `matrix-${version}`, private: true, type: "module" }, null, 2));

  // 1) 拉插件 tarball 看它要哪个 pi-ai
  run("npm", ["pack", `@deepseek-ai/dsh-llm-pi-ai@${version}`, "--silent"], dir);
  const tarball = execFileSync("bash", ["-lc", `ls ${dir}/*.tgz`], { encoding: "utf8" }).trim().split("\n")[0];
  mkdirSync(join(dir, "_pkg"), { recursive: true });
  run("tar", ["xzf", tarball, "-C", join(dir, "_pkg"), "--strip-components=1"]);
  const meta = JSON.parse(readFileSync(join(dir, "_pkg", "package.json"), "utf8"));
  const piAiRange = meta.dependencies?.["@earendil-works/pi-ai"] ?? "^1.0.0";

  // 1b) 插件自带的普通依赖（schemastery / brand / util-values 等）也装进去
  const plainDeps = { ...(meta.dependencies ?? {}) };
  delete plainDeps["@earendil-works/pi-ai"];

  // 2) 装匹配的 pi-ai（用 npm view 解析具体版本）
  const piVersion = run("npm", ["view", `@earendil-works/pi-ai@${piAiRange}`, "version", "--json"], dir)
    .trim()
    .replace(/[\[\]"\s]/g, "")
    .split(",")
    .pop();
  const installArgs = ["install", "--no-audit", "--no-fund", "--silent", `@earendil-works/pi-ai@${piVersion}`,
    ...Object.entries(plainDeps).map(([k, v]) => `${k}@${v}`)];
  run("npm", installArgs, dir);

  // 3) npm install 会清掉手放目录，装完再放插件
  cpSync(join(dir, "_pkg"), join(dir, "node_modules/@deepseek-ai/dsh-llm-pi-ai"), { recursive: true });

  // 4) shim + symlink
  for (const dep of SYMLINK_DEPS) {
    const link = join(dir, "node_modules/@deepseek-ai", dep);
    if (!existsSync(link) && existsSync(join(nm, "@deepseek-ai", dep))) mkdirSync(dirname(link), { recursive: true }) || run("ln", ["-s", join(nm, "@deepseek-ai", dep), link], dir);
  }
  for (const [name, body] of Object.entries(SHIMS)) {
    const d = join(dir, "node_modules/@deepseek-ai", name);
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.mjs"), body);
    writeFileSync(join(d, "package.json"), JSON.stringify({ ...JSON_HEADERS, name: `@deepseek-ai/${name}` }, null, 2));
  }
  return { dir, piVersion };
}

const THINKING_FORMATS_11 = ["openai", "deepseek", "openrouter", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"];

/** 能力探针：不用硬编码枚举，而是拿该版本自己的 Config 逐个试出来。 */
async function capabilityProbes(mod, lib) {
  const caps = {};
  const tryConfig = (cfg) => {
    try { mod.Config(cfg); return true; } catch { return false; }
  };
  const route = (modelExtra, routeExtra) => ({
    providers: { zz: { api: "openai-completions", baseURL: "http://127.0.0.1:9/v1", models: [{ id: "m1", contextWindow: 1024, maxTokens: 64, ...modelExtra }], ...(routeExtra ?? {}) } },
  });

  // 1) 基础形状
  caps.configShape = tryConfig(route({}));

  // 2) thinkingFormat 真实枚举（逐值试，记录接受集合）
  caps.thinkingFormats = THINKING_FORMATS_11.filter((f) => tryConfig(route({ compat: { thinkingFormat: f } })));
  caps.thinkingFormatBogus = tryConfig(route({ compat: { thinkingFormat: "bogus" } }));
  caps.thinkingFormatCase = tryConfig(route({ compat: { thinkingFormat: "Qwen" } }));

  // 3) 模态
  caps.modalities = ["text", "image", "video"].filter((m) => tryConfig(route({ input: [m] })));
  caps.inputAsString = tryConfig(route({ input: "image" }));

  // 4) reasoningEfforts 形状
  caps.efforts = {
    false: tryConfig(route({ reasoningEfforts: false })),
    empty: tryConfig(route({ reasoningEfforts: {} })),
    offNull: tryConfig(route({ reasoningEfforts: { off: null } })),
    highNull: tryConfig(route({ reasoningEfforts: { high: null } })),
    highWire: tryConfig(route({ reasoningEfforts: { high: "high" } })),
    highNumber: tryConfig(route({ reasoningEfforts: { high: 123 } })),
  };

  // 5) 未知字段容忍度（静默接受 = 用户以为自己配了其实没生效）
  caps.unknown = {
    route: tryConfig(route({}, { totallyUnknownRouteKey: 1 })),
    model: tryConfig(route({ totallyUnknownModelKey: 1 })),
    compat: tryConfig(route({ compat: { totallyUnknownCompat: 1 } })),
  };

  // 6) 语义层：默认值 & 重名/重复键行为
  try {
    const resolved = await mod.resolveProfiles({ zz: { api: "openai-completions", baseURL: "http://127.0.0.1:9/v1", models: [{ id: "m1" }] } }, "strict");
    const models = await resolved.get("zz").piProvider.getModels();
    caps.defaults = { ctx: models[0].contextWindow, max: models[0].maxTokens, input: models[0].input };
  } catch (e) {
    caps.defaults = { error: String(e?.message ?? e).slice(0, 120) };
  }

  // 7) 关键导出符号是否存在（脚本依赖的 API 面）
  const src = lib;
  caps.exports = {
    Config: /\bConfig\b/.test(src.split("\n").find((l) => l.includes("z.object")) ? src : src),
    resolveProfiles: /\bfunction resolveProfiles\b|\bresolveProfiles =/.test(src),
    compatProfile: /\bcompatProfile\b/.test(src),
    SUPPORTED_THINKING_FORMATS: /\bSUPPORTED_THINKING_FORMATS\b/.test(src),
  };
  return caps;
}

async function check(version, dir) {
  const libDir = join(dir, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib");
  const probe = join(libDir, "__probe.mjs");
  const entry = join(libDir, "index.js");
  const src = readFileSync(entry, "utf8");
  const hasConfig = /\bconst Config = |\bconst Config=|let Config/.test(src) || /\bConfig = z\.object/.test(src);
  writeFileSync(probe, src + `\nexport { resolveProfiles${hasConfig ? ", Config" : ""} };\n`);
  try {
    const mod = await import(`${probe}?v=${version}`);
    const YAML = require(join(nm, "yaml"));
    const doc = YAML.parse(readFileSync(rp(opt.patch), "utf8"));
    const entryDoc = (Array.isArray(doc) ? doc : []).find((e) => e?.id === "llm-pi-ai");
    const providers = entryDoc?.config?.providers ?? {};
    const routes = await mod.resolveProfiles(providers, "strict");
    const rows = [];
    for (const [routeName, r] of routes) {
      for (const m of await r.piProvider.getModels()) {
        rows.push(`${routeName}/${m.id} ctx=${m.contextWindow} max=${m.maxTokens} input=[${m.input}] reasoning=${m.reasoning}`);
      }
    }
    const caps = hasConfig ? await capabilityProbes(mod, src) : { error: "该版本没有 Config（结构层不可探测）" };
    return { version, ok: true, rows, caps };
  } catch (e) {
    return { version, ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    try { rmSync(probe, { force: true }); } catch {}
  }
}

const results = [];
for (const v of opt.versions) {
  process.stdout.write(`… ${v} `);
  try {
    const { dir, piVersion } = prepare(v);
    const r = await check(v, dir);
    results.push({ ...r, piAi: piVersion });
    console.log(r.ok ? `PASS (pi-ai ${piVersion})` : `FAIL (pi-ai ${piVersion})`);
    if (!r.ok) console.log(`   ${r.error}`);
  } catch (e) {
    results.push({ version: v, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    console.log(`ERROR ${String(e?.message ?? e).slice(0, 160)}`);
  }
}
if (!opt.keep) rmSync(opt.work, { recursive: true, force: true });

const passed = results.filter((r) => r.ok);
console.log(`\n${passed.length}/${results.length} 个版本通过`);
if (passed.length) {
  const sig = new Set(passed.map((r) => r.rows.join("|")));
  console.log(sig.size === 1 ? "✓ 所有通过的版本解析结果完全一致" : `✗ 解析结果不一致（${sig.size} 种）`);

  // ── 能力矩阵：不只比 4 个字段，还比「结构层到底接不接受」
  console.log("\n能力矩阵（✓=接受 / ✗=拒绝 / - = 该版本探测不到）");
  const mark = (v) => (v === true ? "✓" : v === false ? "✗" : "-");
  console.log("版本          配置  thinkingFormat 枚举                 bogus  Qwen  模态            unknown(route/model/compat)");
  const allFormats = new Set();
  for (const r of passed) for (const f of r.caps?.thinkingFormats ?? []) allFormats.add(f);
  for (const r of passed) {
    const c = r.caps ?? {};
    const fmts = c.thinkingFormats ?? [];
    console.log(
      `${r.version.padEnd(13)} ${mark(c.configShape)}   ${String(fmts.length).padStart(2)}/11 ${fmts.join(",").slice(0, 34).padEnd(36)} ${mark(c.thinkingFormatBogus)}   ${mark(c.thinkingFormatCase)}   ${(c.modalities ?? []).join(",").padEnd(14)} ${mark(c.unknown?.route)}/${mark(c.unknown?.model)}/${mark(c.unknown?.compat)}`
    );
  }
  // 我方示例配置用到的能力，逐项要求每个版本都支持
  const required = [
    ["thinkingFormat: qwen", (c) => (c.thinkingFormats ?? []).includes("qwen")],
    ["thinkingFormat 枚举已校验（bogus 必须被拒）", (c) => c.thinkingFormatBogus === false],
    ["input: image", (c) => (c.modalities ?? []).includes("image")],
    ["reasoningEfforts {high:\"high\"}", (c) => c.efforts?.highWire === true],
  ];
  console.log("\n本项目示例配置依赖的能力：");
  for (const [label, test] of required) {
    const fail = passed.filter((r) => r.caps && !test(r.caps)).map((r) => r.version);
    console.log(`  ${fail.length ? "✗" : "✓"} ${label}${fail.length ? `（缺失：${fail.join(", ")}）` : "（全部版本具备）"}`);
  }
}
process.exit(passed.length === results.length ? 0 : 1);
