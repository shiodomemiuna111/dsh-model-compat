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

async function check(version, dir) {
  const probe = join(dir, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/__probe.mjs");
  const entry = join(dir, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js");
  writeFileSync(probe, readFileSync(entry, "utf8") + "\nexport { resolveProfiles };\n");
  try {
    const { resolveProfiles } = await import(`${probe}?v=${version}`);
    const YAML = require(join(nm, "yaml"));
    const doc = YAML.parse(readFileSync(rp(opt.patch), "utf8"));
    const entryDoc = (Array.isArray(doc) ? doc : []).find((e) => e?.id === "llm-pi-ai");
    const providers = entryDoc?.config?.providers ?? {};
    const routes = await resolveProfiles(providers, "strict");
    const rows = [];
    for (const [route, r] of routes) {
      for (const m of await r.piProvider.getModels()) {
        rows.push(`${route}/${m.id} ctx=${m.contextWindow} max=${m.maxTokens} input=[${m.input}] reasoning=${m.reasoning}`);
      }
    }
    return { version, ok: true, rows };
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
}
process.exit(passed.length === results.length ? 0 : 1);
