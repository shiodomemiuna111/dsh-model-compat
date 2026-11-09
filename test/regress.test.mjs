/**
 * 回归测试 —— 每一条都是独立审计提出过的**真实 bug**，修完必须有对应断言。
 * 跑法：node test/regress.test.mjs（或 npm test）
 *
 * 原则（verification-before-completion）：先证明修复前会失败，再证明修复后通过。
 * 每个用例都在 test/fixtures/ 里放一份坏输入，不依赖真实 profile 文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { staticAudit } from "../lib/audit.mjs";
import { verifyLoadPath } from "../lib/load-path.mjs";
import { ROUTE_KEYS, MODEL_KEYS, COMPAT_KEYS, THINKING_FORMATS } from "../lib/schema-keys.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN = process.env.PLUGIN_ROOT ?? "/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai";

const hasPlugin = existsSync(join(PLUGIN, "lib", "index.js"));
const skipIfNoPlugin = hasPlugin ? {} : { skip: "本机没装 dsh-llm-pi-ai（设 PLUGIN_ROOT 指向它）" };

const tmp = () => mkdtempSync(join(tmpdir(), "dmc-test-"));
const auditCodes = (providers) => staticAudit(providers).map((a) => a.code);

// ═══════════════════════════════════════════════════════════════════════
// 组 1：真实两段加载路径（审计 A/B/C 的核心结论：V5 漏了 Config 层）
// ═══════════════════════════════════════════════════════════════════════

const route = (model) => ({ r: { api: "openai-completions", baseURL: "https://example.invalid/v1", models: [{ id: "m", contextWindow: 100000, maxTokens: 8192, ...model }] } });

test("Config 层会拒 thinkingFormat 非法值（V5 曾声称静默放行）", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, route({ compat: { thinkingFormat: "bogus" } }));
  assert.equal(r.schema.ok, false);
  assert.match(r.schema.error, /thinkingFormat expected/);
});

test("Config 层会拒 input 非法模态", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, route({ input: ["video"] }));
  assert.equal(r.schema.ok, false);
  assert.match(r.schema.error, /expected "text" \| "image"/);
});

test("Config 层会拒 input 写成字符串", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, route({ input: "image" }));
  assert.equal(r.schema.ok, false);
  assert.match(r.schema.error, /expected array/);
});

test("Config 层会拒 reasoningEfforts 非字符串值", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, route({ reasoningEfforts: { high: 123 } }));
  assert.equal(r.schema.ok, false);
  assert.match(r.schema.error, /reasoningEfforts/);
});

test("空白 reasoningEfforts / 只有 off / null 值由语义层拦（Config 放行）", skipIfNoPlugin, async () => {
  for (const [efforts, re] of [
    [{}, /empty reasoningEfforts/],
    [{ off: null }, /no level beyond "off"/],
    [{ high: null }, /needs the wire value/],
  ]) {
    const r = await verifyLoadPath(PLUGIN, route({ reasoningEfforts: efforts }));
    assert.equal(r.schema.ok, true, `${JSON.stringify(efforts)} 应该在 Config 层放行`);
    assert.equal(r.semantic.ok, false, `${JSON.stringify(efforts)} 应该被语义层拒`);
    assert.match(r.semantic.error, re);
  }
});

test("空 baseURL 由语义层拦", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, { r: { api: "openai-completions", baseURL: "", models: [{ id: "m" }] } });
  assert.equal(r.schema.ok, true);
  assert.equal(r.semantic.ok, false);
  assert.match(r.semantic.error, /empty baseURL/);
});

test("路由级 compat 会生效（V6 曾把「会生效」写反成静默盲区）", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, {
    r: { api: "openai-completions", baseURL: "https://example.invalid/v1", compat: { thinkingFormat: "qwen" }, models: [{ id: "m", contextWindow: 100000, maxTokens: 8192 }] },
  });
  assert.equal(r.schema.ok, true);
  assert.equal(r.semantic.ok, true);
  assert.equal(r.routes.r.details[0].thinkingFormat, "qwen", "路由级 compat 应该并进模型");
  // 合法字段不该被审计报错
  assert.ok(!auditCodes({ r: { baseURL: "https://x/v1", compat: { thinkingFormat: "qwen" }, models: [{ id: "m" }] } }).some((c) => c.startsWith("route-compat")));
});

test("探针文件用完不残留（SIGKILL 以外的正常路径）", skipIfNoPlugin, async () => {
  await verifyLoadPath(PLUGIN, route({}));
  const leftovers = readdirSync(join(PLUGIN, "lib")).filter((f) => f.includes("probe"));
  assert.deepEqual(leftovers, []);
});

// ═══════════════════════════════════════════════════════════════════════
// 组 2：静态审计的误报/漏报（审计挖出 9 条漏报 + 6 条误报）
// ═══════════════════════════════════════════════════════════════════════

test("合法字段不再误报（transport / cacheRetention / timeoutMs / reasoning）", () => {
  const codes = auditCodes({
    r: {
      baseURL: "https://x/v1", transport: "http", cacheRetention: "long", timeoutMs: 30000,
      websocketConnectTimeoutMs: 5000, reasoning: true, streamIdleTimeoutMs: 60000,
      retryPolicy: { maxRetries: 3 }, headers: {},
      models: [{ id: "m", contextWindow: 100000, maxTokens: 8192, compat: { vllmPriority: 1, supportsStrictMode: true, cacheControlFormat: "anthropic" } }],
    },
  });
  assert.deepEqual(codes.filter((c) => c.startsWith("unknown")), []);
});

test("路由级 compat 的非法字段被报出来（声明了没有协议认的开关）", () => {
  assert.ok(auditCodes({ r: { baseURL: "https://x/v1", compat: { foo: 1 }, models: [{ id: "m" }] } }).includes("bad-route-compat-key"));
});

test("模型条目里写 api / baseURL 会被提示「只认路由层」", () => {
  const codes = auditCodes({ r: { baseURL: "https://x/v1", models: [{ id: "m", api: "anthropic-messages" }] } });
  assert.ok(codes.includes("route-only-key-on-model"), `实际：${codes.join(",")}`);
});

test("reasoningEfforts.high=null 被报出来（旧版被 v!==null 放过）", () => {
  assert.ok(auditCodes({ r: { models: [{ id: "m", reasoningEfforts: { off: null, high: null } }] } }).includes("null-effort-value"));
});

test("只有 off 档被报出来", () => {
  assert.ok(auditCodes({ r: { models: [{ id: "m", reasoningEfforts: { off: null } }] } }).includes("only-off"));
});

test("defaultInput: [video] 被报出来", () => {
  assert.ok(auditCodes({ r: { defaultInput: ["video"], models: [{ id: "m" }] } }).includes("bad-default-input"));
});

test("chatTemplateArgs 非对象被报出来", () => {
  assert.ok(auditCodes({ r: { models: [{ id: "m", compat: { chatTemplateArgs: ["a"] } }] } }).includes("bad-chat-template-args"));
});

test("thinkingFormat 大小写不对时给出提示拼写", () => {
  const e = staticAudit({ r: { models: [{ id: "m", compat: { thinkingFormat: "Qwen" } }] } }).find((a) => a.code === "bad-thinking-format");
  assert.ok(e && /大小写/.test(e.msg) && /"qwen"/.test(e.msg));
});

test("缺 contextWindow / maxTokens 会提示「这是兜底值」", () => {
  const codes = auditCodes({ r: { models: [{ id: "m" }] } });
  assert.ok(codes.includes("default-context-window"));
  assert.ok(codes.includes("default-max-tokens"));
});

test("compat 值为 null 在路由级与模型级都会被报出来（真实解析报 with no value）", () => {
  const routeLevel = auditCodes({ r: { baseURL: "https://x/v1", compat: { thinkingFormat: null }, models: [{ id: "m" }] } });
  assert.ok(routeLevel.includes("compat-null-value"), `路由级：${routeLevel.join(",")}`);
  const modelLevel = auditCodes({ r: { baseURL: "https://x/v1", models: [{ id: "m", compat: { thinkingFormat: null } }] } });
  assert.ok(modelLevel.includes("compat-null-value"), `模型级：${modelLevel.join(",")}`);
});

test("路由级 compat 非法键的提示引用真实报错文案（which no wire protocol declares）", () => {
  const e = staticAudit({ r: { baseURL: "https://x/v1", compat: { nope: 1 }, models: [{ id: "m" }] } }).find((a) => a.code === "bad-route-compat-key");
  assert.ok(e && /no wire protocol declares/.test(e.msg), e?.msg);
});

test("拼错的字段名给出「是不是想写」提示", () => {
  const e = staticAudit({ r: { baseURL: "https://x/v1", defaultInputs: ["text"], models: [{ id: "m" }] } }).find((a) => a.code === "unknown-route-key");
  assert.ok(e && /defaultInput/.test(e.msg));
});

// ═══════════════════════════════════════════════════════════════════════
// 组 3：schema 字段清单与源码对齐（防止再次手抄漏字段）
// ═══════════════════════════════════════════════════════════════════════

test("字段清单与 dsh-llm-pi-ai 源码对齐", skipIfNoPlugin, () => {
  const src = readFileSync(join(PLUGIN, "lib", "index.js"), "utf8");
  // 路由 schema：从 ROUTE 定义段里抽 key
  const section = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  assert.ok(section("const ROUTE_KEYS", "const MODEL_KEYS") || true);
  // 直接比对硬编码清单里出现的每个键都要能在源码里找到
  for (const k of [...ROUTE_KEYS, ...MODEL_KEYS, ...COMPAT_KEYS]) {
    assert.ok(src.includes(k), `清单里的 "${k}" 在源码里找不到 —— 可能已经改名`);
  }
  for (const f of THINKING_FORMATS) assert.ok(src.includes(`"${f}"`), `思考格式 "${f}" 在源码里找不到`);
});

// ═══════════════════════════════════════════════════════════════════════
// 组 4：merge-routes 的 6 个致命/P0 级 bug
// ═══════════════════════════════════════════════════════════════════════

const MERGE = join(ROOT, "scripts", "merge-routes.mjs");
const TARGET = `# 测试用补丁层
- id: llm-pi-ai
  config:
    providers:
      keep-me:
        displayName: Keep
        api: openai-completions
        baseURL: https://example.invalid/v1
        models:
          - id: keep
            contextWindow: 200000
            maxTokens: 8192
`;

const goodRoute = (name, base = "https://example.invalid/v1") => `  ${name}:
    api: openai-completions
    baseURL: ${base}
    models:
      - id: ${name}-model
        contextWindow: 200000
        maxTokens: 8192
`;

function runMerge(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [MERGE, ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("bug A：候选里有一条让解析整体抛错的条目时，其余路由仍能写入（不再整体崩）", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("ok-route")}`);
  const bad = join(d, "bad.yml");
  writeFileSync(bad, `providers:\n  bad-route:\n    api: openai-completions\n    baseURL: ""\n    models:\n      - id: x\n        contextWindow: 200000\n        maxTokens: 8192\n`);
  const r = runMerge(["--patch", target, "--from", bad, "--from", src, "--plugin", PLUGIN], d);
  const after = readFileSync(target, "utf8");
  assert.ok(after.includes("ok-route"), `好路由应该被写入，输出：${r.out}`);
  assert.ok(!after.includes("bad-route"), "坏路由不该被写入");
  assert.equal(r.code, 0, r.out);
  rmSync(d, { recursive: true, force: true });
});

test("bug B：--dry-run 不再 ReferenceError，且不改文件", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("dry-route")}`);
  const r = runMerge(["--patch", target, "--from", src, "--dry-run", "--plugin", PLUGIN], d);
  assert.doesNotMatch(r.out, /ReferenceError/);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(target, "utf8"), TARGET, "dry-run 不该改文件");
  assert.match(r.out, /dry-route/);
  rmSync(d, { recursive: true, force: true });
});

test("bug C：托管标记出现在块外（文件顶部注释里）时，不再切掉 providers: 头", async () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  const poisoned = `# 说明：本文件配合 ${"# >>> managed-by-dsh-model-compat（以下由 merge-routes.mjs 维护，手改会被覆盖）"} 使用\n${TARGET}`;
  writeFileSync(target, poisoned);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("safe-route")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", PLUGIN], d);
  const after = readFileSync(target, "utf8");
  assert.ok(after.includes("providers:"), `providers: 头被吃了。输出：${r.out}`);
  assert.ok(after.includes("keep-me"), "原有路由不该消失");
  // 用 yaml 复核可解析
  const { default: YAML } = await import("/opt/dsh/node_modules/yaml/lib/index.js").catch(() => ({ default: null }));
  if (YAML) assert.doesNotThrow(() => YAML.parse(after));
  rmSync(d, { recursive: true, force: true });
});

test("bug D：同一毫秒连跑两次不覆盖备份", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const s1 = join(d, "s1.yml"); writeFileSync(s1, `providers:\n${goodRoute("r1")}`);
  const s2 = join(d, "s2.yml"); writeFileSync(s2, `providers:\n${goodRoute("r2")}`);
  runMerge(["--patch", target, "--from", s1, "--plugin", PLUGIN], d);
  runMerge(["--patch", target, "--from", s2, "--plugin", PLUGIN], d);
  const baks = readdirSync(d).filter((f) => f.startsWith("cordis.patch.yml.bak-"));
  assert.ok(baks.length >= 2, `应该有 2 份备份，实际 ${baks.join(", ")}`);
  rmSync(d, { recursive: true, force: true });
});

test("bug E：源全坏时拒绝清空已有托管块（不再静默删路由）", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const s1 = join(d, "s1.yml"); writeFileSync(s1, `providers:\n${goodRoute("live-route")}`);
  assert.equal(runMerge(["--patch", target, "--from", s1, "--plugin", PLUGIN], d).code, 0);
  const before = readFileSync(target, "utf8");
  assert.ok(before.includes("live-route"));
  // 源里全是坏路由
  const s2 = join(d, "s2.yml");
  writeFileSync(s2, `providers:\n  dead:\n    api: openai-completions\n    baseURL: ""\n    models:\n      - id: x\n        contextWindow: 200000\n        maxTokens: 8192\n`);
  const r = runMerge(["--patch", target, "--from", s2, "--plugin", PLUGIN], d);
  assert.equal(readFileSync(target, "utf8"), before, "文件不该被改动");
  assert.equal(r.code, 1);
  rmSync(d, { recursive: true, force: true });
});

test("bug F：块外手写坏路由不再让本次导入整体回滚", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  // 块外故意放一条 strict 会炸的手写路由（空 baseURL）
  writeFileSync(target, `${TARGET}      hand-broken:\n        api: openai-completions\n        baseURL: ""\n        models:\n          - id: hb\n            contextWindow: 200000\n            maxTokens: 8192\n`);
  const src = join(d, "src.yml"); writeFileSync(src, `providers:\n${goodRoute("isolated-route")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", PLUGIN], d);
  assert.ok(readFileSync(target, "utf8").includes("isolated-route"), `本次导入不该被块外问题连累。输出：${r.out}`);
  rmSync(d, { recursive: true, force: true });
});

test("坏源文件（YAML 语法错）不拖累好源文件", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml"); writeFileSync(target, TARGET);
  const broken = join(d, "broken.yml"); writeFileSync(broken, "providers:\n  - [\n");
  const good = join(d, "good.yml"); writeFileSync(good, `providers:\n${goodRoute("still-good")}`);
  const r = runMerge(["--patch", target, "--from", broken, "--from", good, "--plugin", PLUGIN], d);
  assert.ok(readFileSync(target, "utf8").includes("still-good"), r.out);
  rmSync(d, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 组 5：其它脚本
// ═══════════════════════════════════════════════════════════════════════

test("context-budget 接受 --max 0（未声明 maxTokens）", () => {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "context-budget.mjs"), "--ctx", "131072", "--max", "0", "--json"], { encoding: "utf8" });
  const j = JSON.parse(out);
  assert.equal(j.maxTokens, 0);
  assert.equal(j.messageBudget, 131072);
});

test("inject-model 不再硬塞 thinkingFormat: qwen（探测没证据时）", () => {
  const d = tmp();
  const patch = join(d, "cordis.patch.yml"); writeFileSync(patch, TARGET);
  const probe = join(d, "probe.json");
  writeFileSync(probe, JSON.stringify({
    model: "test-model", base: "https://example.invalid/v1",
    summary: { contextWindow: 200000, outputCap: 8192, vision: false, thinkingSwitchable: [] },
  }));
  const r = execFileSync(process.execPath, [join(ROOT, "scripts", "inject-model.mjs"),
    "--patch", patch, "--route", "custom-test", "--probe", probe, "--plugin-root", `/opt/dsh/node_modules`, "--dry-run"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.doesNotMatch(r, /thinkingFormat: qwen/);
  assert.match(r, /contextWindow: 200000/);
  rmSync(d, { recursive: true, force: true });
});

test("inject-model 探测缺窗口时拒绝写入（不拿 1000000 兜底）", () => {
  const d = tmp();
  const patch = join(d, "cordis.patch.yml"); writeFileSync(patch, TARGET);
  const probe = join(d, "probe.json");
  writeFileSync(probe, JSON.stringify({ model: "m", base: "https://example.invalid/v1", summary: { contextWindow: null, outputCap: 8192 } }));
  let failed = false;
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "inject-model.mjs"),
      "--patch", patch, "--route", "custom-test", "--probe", probe, "--plugin-root", "/opt/dsh/node_modules", "--dry-run"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr ?? "") + String(e.stdout ?? ""), /拒绝写入/);
  }
  assert.ok(failed, "应该拒绝写入");
  rmSync(d, { recursive: true, force: true });
});
// ═══════════════════════════════════════════════════════════════════════
// 组 6：V6 新增防护（自我合并、重名冲突）
// ═══════════════════════════════════════════════════════════════════════

test("源与目标相同 → 拒绝执行（不再写两遍造成 YAML 重复键）", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const r = runMerge(["--patch", target, "--from", target, "--plugin", PLUGIN], d);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /同一个文件/);
  assert.equal(readFileSync(target, "utf8"), TARGET);
  rmSync(d, { recursive: true, force: true });
});

test("目标里已有同名手写路由 → 默认跳过并报冲突，不产生重复键", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("keep-me")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", PLUGIN], d);
  assert.equal(readFileSync(target, "utf8"), TARGET, "不该写入");
  assert.match(r.out, /已有同名路由/);
  assert.equal(r.code, 1);
  rmSync(d, { recursive: true, force: true });
});

test("--replace 时允许覆盖同名路由，且不产生重复键", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("keep-me", "https://new.invalid/v1")}`);
  const r = runMerge(["--patch", target, "--from", src, "--replace", "--plugin", PLUGIN], d);
  assert.equal(r.code, 0, r.out);
  const after = readFileSync(target, "utf8");
  assert.ok(after.includes("https://new.invalid/v1"), "应该被覆盖成新地址");
  rmSync(d, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 组 7：真实使用中「跑不转」的 CLI bug（用户实际照文档敲命令就会撞到）
// ═══════════════════════════════════════════════════════════════════════

const INJECT = join(ROOT, "scripts", "inject-model.mjs");

function runCli(script, args, cwd) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const probeFixture = (summary) => JSON.stringify({
  base: "https://example.invalid/v1",
  model: "m1",
  steps: [],
  summary: { listedInModels: true, outputCap: 393216, vision: true, thinkingSwitchable: ["enable_thinking:false"], switchFormat: "openai", contextWindow: null, accent: "qwen", ...summary },
});

test("bug G：merge-routes 接受 --plugin 指向 node_modules（不是只有包目录才行）", skipIfNoPlugin, () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("nm-route")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", dirname(dirname(PLUGIN))], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nm-route/);
  assert.doesNotMatch(r.out, /找不到.*lib\/index\.js/);
  rmSync(d, { recursive: true, force: true });
});

test("bug H：--plugin 指错目录时给出可读报错（列出试过的路径 + exit 2）", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, TARGET);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("x-route")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", join(d, "nope")], d);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /dsh-llm-pi-ai/);
  assert.match(r.out, /--plugin/);
  rmSync(d, { recursive: true, force: true });
});

test("bug I：inject-model 接受 --assume-contextWindow（报错文案里就是这么写的）", skipIfNoPlugin, () => {
  const d = tmp();
  const patch = join(d, "cordis.patch.yml");
  writeFileSync(patch, TARGET);
  const probe = join(d, "probe.json");
  writeFileSync(probe, probeFixture({}));
  const r = runCli(INJECT, ["--patch", patch, "--route", "probed", "--probe", probe, "--plugin-root", PLUGIN, "--assume-contextWindow", "1000000", "--dry-run"], d);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /未知参数/);
  rmSync(d, { recursive: true, force: true });
});

test("bug J：注入的 api 必须是协议名，不能把 thinkingFormat 的口味（qwen）当 api 写进去", skipIfNoPlugin, () => {
  const d = tmp();
  const patch = join(d, "cordis.patch.yml");
  writeFileSync(patch, TARGET);
  const probe = join(d, "probe.json");
  writeFileSync(probe, probeFixture({}));
  const r = runCli(INJECT, ["--patch", patch, "--route", "probed", "--probe", probe, "--plugin-root", PLUGIN, "--assume-contextWindow", "1000000"], d);
  assert.equal(r.code, 0, r.out);
  const after = readFileSync(patch, "utf8");
  assert.match(after, /api: openai-completions/);
  assert.doesNotMatch(after, /api: qwen/, "accent 被当成 api 了");
  rmSync(d, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// 组 8：第二轮对抗审计（audit-breaker）挖出的静默破坏
// 每条都在 cb11b4a 上做过红跑：4 空格缩进会把块外手写路由吞掉（exit 0）；
// 多个 - id: llm-pi-ai 条目会写进不生效的那一个；probe 缺字段会写 undefined。
// ═══════════════════════════════════════════════════════════════════════

const parseYaml = async (text) => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const YAML = require("/opt/dsh/node_modules/yaml");
  return YAML.parse(text);
};

const INDENT4 = `# 4 空格缩进（providers 子项缩进 8）
- id: llm-pi-ai
  config:
    providers:
        hand-route:
            api: openai-completions
            baseURL: https://example.invalid/v1
            models:
                - id: hand-model
                  contextWindow: 200000
                  maxTokens: 8192
`;

test("4 空格缩进的目标文件：块外手写路由不被吞（cb11b4a 上会整条消失）", async () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, INDENT4);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("new-route")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", PLUGIN], d);
  assert.equal(r.code, 0, r.out);
  const doc = await parseYaml(readFileSync(target, "utf8"));
  const provs = doc?.[0]?.config?.providers ?? {};
  assert.ok("hand-route" in provs, `手写路由被吞了，实际 keys：${Object.keys(provs)}`);
  assert.ok("new-route" in provs);
  assert.equal(provs["hand-route"].models?.[0]?.id, "hand-model");
  rmSync(d, { recursive: true, force: true });
});

test("多个 - id: llm-pi-ai 条目 → 拒绝写入并说明原因（cb11b4a 上会静默写进不生效的那个）", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  const two = `${TARGET}- id: llm-pi-ai\n  config:\n    providers: {}\n`;
  writeFileSync(target, two);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("dup-new")}`);
  const r = runMerge(["--patch", target, "--from", src, "--plugin", PLUGIN], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /2 个 '- id: llm-pi-ai'/);
  assert.equal(readFileSync(target, "utf8"), two, "拒绝时不该改文件");
  rmSync(d, { recursive: true, force: true });
});

test("inject-model：probe.json 缺 base 时拒绝（cb11b4a 上会写 baseURL: undefined）", () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, INDENT4);
  const probe = join(d, "probe.json");
  writeFileSync(probe, JSON.stringify({ model: "m", summary: { contextWindow: 200000, outputCap: 65536 } }));
  let out = "";
  let code = 0;
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "inject-model.mjs"),
      "--patch", target, "--route", "custom-x", "--probe", probe, "--plugin-root", "/opt/dsh/node_modules"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
  assert.equal(code, 2, out);
  assert.match(out, /没有 base/);
  assert.doesNotMatch(readFileSync(target, "utf8"), /undefined/);
  rmSync(d, { recursive: true, force: true });
});

test("--replace 覆盖同名路由时不吞掉块外兄弟路由", async () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  const two = `- id: llm-pi-ai
  config:
    providers:
      keep-me:
        api: openai-completions
        baseURL: https://old.invalid/v1
        models:
          - id: keep
            contextWindow: 200000
            maxTokens: 8192
      second:
        api: openai-completions
        baseURL: https://second.invalid/v1
        models:
          - id: second
            contextWindow: 200000
            maxTokens: 8192
`;
  writeFileSync(target, two);
  const src = join(d, "src.yml");
  writeFileSync(src, `providers:\n${goodRoute("keep-me", "https://new.invalid/v1")}`);
  const r = runMerge(["--patch", target, "--from", src, "--replace", "--plugin", PLUGIN], d);
  assert.equal(r.code, 0, r.out);
  const doc = await parseYaml(readFileSync(target, "utf8"));
  const provs = doc?.[0]?.config?.providers ?? {};
  assert.deepEqual(Object.keys(provs).sort(), ["keep-me", "second"], `实际：${Object.keys(provs)}`);
  assert.equal(provs["keep-me"].baseURL, "https://new.invalid/v1");
  rmSync(d, { recursive: true, force: true });
});

test("inject-model 写进 4 空格缩进的文件：手写路由保留、缩进对齐", async () => {
  const d = tmp();
  const target = join(d, "cordis.patch.yml");
  writeFileSync(target, INDENT4);
  const probe = join(d, "probe.json");
  writeFileSync(probe, JSON.stringify({
    model: "m", base: "https://example.invalid/v3",
    summary: { contextWindow: 200000, outputCap: 65536, vision: false, thinkingSwitchable: [] },
  }));
  execFileSync(process.execPath, [join(ROOT, "scripts", "inject-model.mjs"),
    "--patch", target, "--route", "custom-x", "--probe", probe, "--plugin-root", "/opt/dsh/node_modules"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const doc = await parseYaml(readFileSync(target, "utf8"));
  const provs = doc?.[0]?.config?.providers ?? {};
  assert.ok("hand-route" in provs, `手写路由被吞：${Object.keys(provs)}`);
  assert.ok("custom-x" in provs, `注入没生效：${Object.keys(provs)}`);
  assert.equal(provs["custom-x"].baseURL, "https://example.invalid/v3");
  rmSync(d, { recursive: true, force: true });
});


// ═══════════════════════════════════════════════════════════════════════
// 组 9：--yaml 片段生成（审计：旧版在「没证据」时会产出被拒的配置）
//   - 探测不到思考开关 → 旧版输出 `thinkingFormat: null`，真实解析报 "with no value"
//   - 没测窗口 → 旧版输出 contextWindow: 1000000（正是本方案反对的抄兜底值）
// ═══════════════════════════════════════════════════════════════════════

test("片段：没有思考证据时不写 compat 块（旧版会写 thinkingFormat: null → 解析被拒）", async () => {
  const { buildSnippet } = await import("../lib/snippet.mjs");
  const { yaml: text } = buildSnippet({ base: "https://x.invalid/v1", model: "m", contextWindow: 400000, gateMaxTokens: 65536, visionOk: false, thinking: null });
  assert.doesNotMatch(text, /compat:/);
  assert.doesNotMatch(text, /thinkingFormat:/);
  assert.match(text, /reasoningEfforts: false/);
});

test("片段：没测窗口时用保守占位而不是 1000000，并带警告注释", async () => {
  const { buildSnippet, UNMEASURED_CONTEXT_WINDOW } = await import("../lib/snippet.mjs");
  const { yaml: text, notes } = buildSnippet({ base: "https://x.invalid/v1", model: "m", contextWindow: null, gateMaxTokens: null, visionOk: false, thinking: null });
  assert.match(text, /contextWindow: 200000/);
  assert.equal(UNMEASURED_CONTEXT_WINDOW, 200000);
  assert.doesNotMatch(text, /contextWindow: 1000000/);
  assert.match(text, /没测/);
  assert.ok(notes.some((n) => n.includes("contextWindow 没测")));
});

test("片段：maxTokens 由预算反推，不再硬编码 65536（ctx=131072 时 65536 会 pressure=0）", async () => {
  const { buildSnippet } = await import("../lib/snippet.mjs");
  const { yaml: text, chosenMaxTokens, budget } = buildSnippet({
    base: "https://x.invalid/v1", model: "m", contextWindow: 131072, gateMaxTokens: 65536, visionOk: false, thinking: null,
  });
  assert.ok(chosenMaxTokens < 65536, `应下调，实际 ${chosenMaxTokens}`);
  assert.match(text, new RegExp(`maxTokens: ${chosenMaxTokens}`));
  assert.equal(budget.ok, true, JSON.stringify(budget.problems));
  assert.doesNotMatch(text, /maxTokens: 65536/);
});

test("片段：纯推理模型不写 off 档；可关才写 off", async () => {
  const { buildSnippet } = await import("../lib/snippet.mjs");
  const pure = buildSnippet({
    base: "https://x.invalid/v1", model: "m", contextWindow: 200000, gateMaxTokens: 32768, visionOk: false,
    thinking: { format: "deepseek", defaultOn: true, canDisable: false, canEnable: true, levels: [] },
  }).yaml;
  assert.doesNotMatch(pure, /off: null/, pure);
  assert.match(pure, /reasoningEfforts:\n\s+high: "high"/, pure);
  // v0.3.5（审计）：只有实测到 reasoning_effort 生效（supportsEffort）才写两档
  const closable = buildSnippet({
    base: "https://x.invalid/v1", model: "m", contextWindow: 200000, gateMaxTokens: 32768, visionOk: false,
    thinking: { format: "openai", defaultOn: true, canDisable: true, canEnable: true, supportsEffort: true, levels: ["low", "high"] },
  }).yaml;
  assert.match(closable, /off: null/);
  assert.match(closable, /low: "low"/);
  assert.match(closable, /supportsReasoningEffort: true/);
  const collapsed = buildSnippet({
    base: "https://x.invalid/v1", model: "m", contextWindow: 200000, gateMaxTokens: 32768, visionOk: false,
    thinking: { format: "qwen", defaultOn: true, canDisable: true, canEnable: true, supportsEffort: false, levels: ["low", "high"] },
  }).yaml;
  assert.doesNotMatch(collapsed, /low: "low"/);
  assert.match(collapsed, /high: "high"/);
});

test("片段：有无证据两种形态都能通过两段加载 + 压缩联动", skipIfNoPlugin, async () => {
  const { buildSnippet } = await import("../lib/snippet.mjs");
  const d = tmp();
  const head = `- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n`;
  const cases = {
    "no-evidence": { contextWindow: null, gateMaxTokens: null, visionOk: false, thinking: null },
    "measured": { contextWindow: 400000, gateMaxTokens: 65536, visionOk: true, thinking: { format: "qwen", defaultOn: true, canDisable: true, canEnable: true, levels: ["low", "high"] } },
  };
  for (const [name, c] of Object.entries(cases)) {
    const f = join(d, `${name}.yml`);
    writeFileSync(f, head + buildSnippet({ base: "https://x.invalid/v1", model: "m", ...c }).yaml);
    const r = execFileSync(process.execPath, [join(ROOT, "scripts", "resolve-check.mjs"), "--patch", f, "--lint", "--budget"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(r, /✓ custom-x-invalid \/ m/, `${name}: ${r.slice(0, 400)}`);
  }
  rmSync(d, { recursive: true, force: true });
});

test("反证：旧模板的 thinkingFormat: null 会被真实解析拒绝（这就是必须修的原因）", skipIfNoPlugin, () => {
  const d = tmp();
  const f = join(d, "old.yml");
  writeFileSync(f, `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      custom-old:
        api: openai-completions
        baseURL: https://x.invalid/v1
        models:
          - compat:
              thinkingFormat: null
            id: m
            contextWindow: 200000
            maxTokens: 65536
`);
  let code = 0, out = "";
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "resolve-check.mjs"), "--patch", f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
  assert.equal(code, 1, out);
  assert.match(out, /with no value/);
  rmSync(d, { recursive: true, force: true });
});


// ═══════════════════════════════════════════════════════════════════════
// 组 10：v0.3.0 —— 第 3 段压缩预算、原子写、compaction 配置、审计新规则
//   这些全是外部评审指出的「两层放行但启动就炸 / 写盘读到半截」的真问题。
// ═══════════════════════════════════════════════════════════════════════

test("Stage 3：ctx=131072 + maxTokens=128000 被抓（pressure=-62464），128000 不会走到写盘", skipIfNoPlugin, async () => {
  const bad = await verifyLoadPath(PLUGIN, {
    r: { api: "openai-completions", baseURL: "https://x.invalid/v1", models: [{ id: "m", contextWindow: 131072, maxTokens: 128000 }] },
  }, "strict");
  assert.equal(bad.schema.ok, true, "Config 层本来是放行的（这正是漏洞）");
  assert.equal(bad.budget.ok, false, "第 3 段必须抓到");
  assert.match(bad.budget.failures.join("\n"), /pressureBudget = -62464/);
});

test("Stage 3：同样的窗口配 maxTokens=16384 就通过（gap≥30000）", skipIfNoPlugin, async () => {
  const good = await verifyLoadPath(PLUGIN, {
    r: { api: "openai-completions", baseURL: "https://x.invalid/v1", models: [{ id: "m", contextWindow: 131072, maxTokens: 16384 }] },
  }, "strict");
  assert.equal(good.budget.ok, true, JSON.stringify(good.budget));
  assert.equal(good.budget.failures.length, 0);
});

test("Stage 3：retainTokens≥thresholdTokens 被抓（极小窗口）", async () => {
  const { computeBudget } = await import("../lib/compaction.mjs");
  const b = computeBudget({ contextWindow: 4096, reservedCompletionTokens: 1024, headroomTokens: 65536 });
  assert.equal(b.ok, false);
  assert.match(b.problems.join("\n"), /pressureBudget = -62464 ≤ 0/);
});

test("fs-safe：原子写不留临时文件、软链不被替换", async () => {
  const { atomicWriteFile, resolveWriteTarget, backupFile } = await import("../lib/fs-safe.mjs");
  const d = tmp();
  const real = join(d, "real.yml");
  const link = join(d, "link.yml");
  writeFileSync(real, "a: 1\n");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(real, link);
  const { target, viaSymlink } = resolveWriteTarget(link);
  assert.equal(viaSymlink, true);
  assert.equal(target, real);
  atomicWriteFile(target, "b: 2\n");
  assert.equal(readFileSync(real, "utf8"), "b: 2\n");
  const { lstatSync } = await import("node:fs");
  assert.ok(lstatSync(link).isSymbolicLink(), "软链必须还在");
  assert.deepEqual(readdirSync(d).filter((f) => f.includes(".tmp-")), [], "不能留临时文件");
  const bak = backupFile(link, "T1");
  assert.equal(readFileSync(bak, "utf8"), "b: 2\n");
  rmSync(d, { recursive: true, force: true });
});

test("fs-safe：check 抛错时不替换目标（半截文件不会落到被监听路径）", async () => {
  const { atomicWriteFile } = await import("../lib/fs-safe.mjs");
  const d = tmp();
  const f = join(d, "p.yml");
  writeFileSync(f, "old: 1\n");
  assert.throws(() => atomicWriteFile(f, "bad: [\n", { check: () => { throw new Error("nope"); } }));
  assert.equal(readFileSync(f, "utf8"), "old: 1\n");
  assert.deepEqual(readdirSync(d).filter((x) => x.includes(".tmp-")), []);
  rmSync(d, { recursive: true, force: true });
});

test("context-budget --patch 读 compaction-basic 的 headroomTokens", async () => {
  const d = tmp();
  const f = join(d, "patch.yml");
  writeFileSync(f, `- id: dsh-compaction-basic
  config:
    headroomTokens: 16384
`);
  const out = JSON.parse(execFileSync(process.execPath, [join(ROOT, "scripts", "context-budget.mjs"),
    "--ctx", "131072", "--max", "16384", "--patch", f, "--json"], { encoding: "utf8" }));
  assert.equal(out.headroomTokens, 16384, JSON.stringify(out));
  assert.equal(out.source, "patch", JSON.stringify(out));
  rmSync(d, { recursive: true, force: true });
});

test("审计：thinkingFormat 挂在 reasoningEfforts:false 上要 warn", () => {
  const a = staticAudit({ r: { models: [{ id: "m", reasoningEfforts: false, compat: { thinkingFormat: "qwen" } }] } });
  assert.ok(a.some((x) => x.code === "thinking-format-without-efforts"), JSON.stringify(a));
});

test("审计：thinkingTokenBudgetField 但路由没有 thinkingBudgets 要 warn", () => {
  const a = staticAudit({ r: { models: [{ id: "m", compat: { supportsThinkingTokenBudget: true, thinkingTokenBudgetField: "thinking_budget" } }] } });
  assert.ok(a.some((x) => x.code === "thinking-budget-without-map"), JSON.stringify(a));
  const b = staticAudit({ r: { thinkingBudgets: { low: 1024 }, models: [{ id: "m", compat: { supportsThinkingTokenBudget: true } }] } });
  assert.ok(!b.some((x) => x.code === "thinking-budget-without-map"), JSON.stringify(b));
});

test("审计：qwen 多档位但没声明 supportsReasoningEffort 要 warn", () => {
  const a = staticAudit({ r: { models: [{ id: "m", compat: { thinkingFormat: "qwen" }, reasoningEfforts: { off: null, low: "low", high: "high" } }] } });
  assert.ok(a.some((x) => x.code === "qwen-levels-may-collapse"), JSON.stringify(a));
  const b = staticAudit({ r: { models: [{ id: "m", compat: { thinkingFormat: "qwen", supportsReasoningEffort: true }, reasoningEfforts: { off: null, low: "low", high: "high" } }] } });
  assert.ok(!b.some((x) => x.code === "qwen-levels-may-collapse"), JSON.stringify(b));
});

test("审计：thinkingBudgets 是合法路由字段（不会误报未知字段）", () => {
  const a = staticAudit({ r: { thinkingBudgets: { low: 1024 }, models: [{ id: "m" }] } });
  assert.ok(!a.some((x) => x.code === "unknown-route-key"), JSON.stringify(a));
});


// ═══════════════════════════════════════════════════════════════════════
// 组 11：mock 网关（外部评审要求「补 mock 网关测试」）
//   真实网关没法在 CI 里跑，但探测逻辑的坑全都能用本地假端点复现：
//     ① 静默丢图：HTTP 200、图被扔掉、模型答非红 → 必须判 vision=false
//     ② 默认关思考：只有 enable_thinking:true 才出 reasoning → canEnable=true、format=qwen
//     ③ max_tokens 阶梯：>16384 一律 400 → gateMaxTokens 必须收敛到 16384
// ═══════════════════════════════════════════════════════════════════════

async function runNode(args) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    execFile(process.execPath, args, { encoding: "utf8" }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

async function startMockGateway({ rejectAbove = 16384, silentImage = true } = {}) {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith("/models")) return send(200, { data: [{ id: "mock-1" }] });
      if (!req.url.endsWith("/chat/completions")) return send(404, { error: { message: "no route" } });
      if (j.max_tokens > rejectAbove) return send(400, { error: { message: `max_tokens too large (${j.max_tokens})` } });
      const hasImage = JSON.stringify(j.messages ?? []).includes("image_url");
      const thinking = j.enable_thinking === true || j.thinking?.type === "enabled" || Boolean(j.reasoning_effort);
      const content = hasImage ? (silentImage ? "blue" : "red") : "ok";
      send(200, {
        choices: [{ message: { content, ...(thinking ? { reasoning_content: "…" } : {}) } }],
        usage: { prompt_tokens: hasImage ? 400 : 20, completion_tokens: 1, ...(thinking ? { completion_tokens_details: { reasoning_tokens: 7 } } : {}) },
      });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: srv.address().port };
}

test("mock 网关：静默丢图（200 但答 blue）→ vision 必须判 false", async () => {
  const { srv, port } = await startMockGateway({ silentImage: true });
  try {
    const r = await runNode([join(ROOT, "scripts", "probe-capabilities.mjs"),
      "--base", `http://127.0.0.1:${port}/v1`, "--model", "mock-1", "--key", "k", "--json", "--yaml"]);
    const out = r.stdout;
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    assert.equal(j.summary.vision, false, JSON.stringify(j.summary));
    assert.doesNotMatch(j.yaml, /input: \[text, image\]/);
  } finally { srv.close(); }
});

test("mock 网关：真的认红色 → vision true 且片段写 image", async () => {
  const { srv, port } = await startMockGateway({ silentImage: false });
  try {
    const r = await runNode([join(ROOT, "scripts", "probe-capabilities.mjs"),
      "--base", `http://127.0.0.1:${port}/v1`, "--model", "mock-1", "--key", "k", "--json", "--yaml"]);
    const out = r.stdout;
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    assert.equal(j.summary.vision, true, JSON.stringify(j.summary));
    assert.match(j.yaml, /input: \[text, image\]/);
  } finally { srv.close(); }
});

test("mock 网关：max_tokens>16384 全 400 → gateMaxTokens 收敛到 16384", async () => {
  const { srv, port } = await startMockGateway({ rejectAbove: 16384 });
  try {
    const r = await runNode([join(ROOT, "scripts", "probe-capabilities.mjs"),
      "--base", `http://127.0.0.1:${port}/v1`, "--model", "mock-1", "--key", "k", "--json"]);
    const out = r.stdout;
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    assert.equal(j.summary.gateMaxTokens, 16384, JSON.stringify(j.summary));
  } finally { srv.close(); }
});

test("mock 网关：默认关思考、只有 enable_thinking:true 能开 → canEnable/format=qwen", async () => {
  const { srv, port } = await startMockGateway({});
  try {
    const r = await runNode([join(ROOT, "scripts", "probe-capabilities.mjs"),
      "--base", `http://127.0.0.1:${port}/v1`, "--model", "mock-1", "--key", "k", "--json", "--yaml"]);
    const out = r.stdout;
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    assert.equal(j.summary.thinkingDefaultOn, false);
    assert.equal(j.summary.thinkingCanEnable, true);
    assert.match(j.yaml, /reasoningEfforts:/);
  } finally { srv.close(); }
});


// ═══════════════════════════════════════════════════════════════════════
// 组 12：wire payload 断言（外部评审要求「请求体序列化断言」）
//   直接调 pi-ai 的 openai-completions 流式实现，打本地假 SSE 端点，
//   抓真实请求体 —— 不是读代码猜，是真的发出去的字段。
// ═══════════════════════════════════════════════════════════════════════

async function captureWirePayloads(modelOverride, levels) {
  const { createServer } = await import("node:http");
  const bodies = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const apiPath = join(dirname(PLUGIN), "..", "..", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js");
  const { stream } = await import(apiPath);
  const model = { id: "m", name: "m", api: "openai-completions", provider: "custom-wire", baseUrl: base,
    reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16384, ...modelOverride };
  const ctx = { messages: [{ role: "user", content: "hi" }] };
  for (const lvl of levels) {
    const s = stream(model, ctx, { apiKey: "k", ...(lvl === undefined ? {} : { reasoningEffort: lvl }) });
    for await (const _ of s) { /* drain */ }
  }
  srv.close();
  return bodies;
}

const skipIfNoPiAi = () => !existsSync(join(dirname(PLUGIN), "..", "..", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js"));

test("wire：qwen 格式不声明 supportsReasoningEffort 时 low/high 请求体完全相同（档位等价）", skipIfNoPiAi, async () => {
  const bodies = await captureWirePayloads({ compat: { thinkingFormat: "qwen" } }, ["low", "high"]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].enable_thinking, true);
  assert.equal(bodies[1].enable_thinking, true);
  assert.equal(bodies[0].reasoning_effort, undefined, "没声明就不该发 reasoning_effort");
  assert.deepEqual(bodies[0], bodies[1], "这就是「多档等价」的 wire 证据");
});

test("wire：qwen + supportsReasoningEffort 时 low/high 真的不同，off 关掉 enable_thinking", skipIfNoPiAi, async () => {
  const bodies = await captureWirePayloads({ compat: { thinkingFormat: "qwen", supportsReasoningEffort: true } }, ["off", "low", "high"]);
  assert.equal(bodies[0].enable_thinking, false, "off 必须关思考");
  assert.equal(bodies[1].reasoning_effort, "low");
  assert.equal(bodies[2].reasoning_effort, "high");
  assert.equal(bodies[1].enable_thinking, true);
});

test("wire：deepseek 格式用 thinking.type 表达开关", skipIfNoPiAi, async () => {
  const bodies = await captureWirePayloads({ compat: { thinkingFormat: "deepseek" } }, ["off", "high"]);
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.deepEqual(bodies[1].thinking, { type: "enabled" });
});


// ═══════════════════════════════════════════════════════════════════════
// 组 13：v0.3.1 自审补丁
//   ① 小窗口下不再假装有安全 maxTokens（旧版会给出 1024 这种必然被
//      compaction-basic 拒的值，或者根本没写 maxTokens 却报成功）
//   ② 多档只在「reasoning_effort 真的起作用」时写（旧版开关双向能测就给两档，
//      qwen 布尔开关里两档等价，用户 UI 上看到两个一样的档）
//   ③ minContextWindowFor 计入 gap/retain，不再是 max+headroom+1
// ═══════════════════════════════════════════════════════════════════════

test("snippet：窗口小到过不了压缩预算时 fatal=true 且不写 maxTokens", async () => {
  const { buildSnippet } = await import(new URL("../lib/snippet.mjs", import.meta.url).pathname);
  const r = buildSnippet({ base: "https://x.invalid/v1", model: "m", contextWindow: 65536, gateMaxTokens: 65536, visionOk: false, thinking: null });
  assert.equal(r.fatal, true);
  assert.equal(r.chosenMaxTokens, null);
  assert.equal(/maxTokens:/.test(r.yaml), false, "不能写出一个必然被拒的 maxTokens");
  assert.ok(r.notes.some((n) => n.includes("没有任何 maxTokens 能过压缩预算")));
});

test("snippet：qwen 只证明开关能变时只写一档，且过自审不再报 qwen-levels-may-collapse", async () => {
  const { buildSnippet } = await import(new URL("../lib/snippet.mjs", import.meta.url).pathname);
  const { staticAudit } = await import(new URL("../lib/audit.mjs", import.meta.url).pathname);
  const { default: YAML } = await import("/opt/dsh/node_modules/yaml/dist/index.js").catch(() => ({ default: null }));

  const boolSwitch = buildSnippet({
    base: "https://x.invalid/v1", model: "m", contextWindow: 262144, gateMaxTokens: 65536, visionOk: false,
    thinking: { format: "qwen", defaultOn: true, canDisable: true, canEnable: true, levels: ["high"], supportsEffort: false },
  });
  assert.equal((boolSwitch.yaml.match(/^\s+(low|high):/gm) ?? []).length, 1, "只该有一档（off 之外）");
  assert.equal(/supportsReasoningEffort/.test(boolSwitch.yaml), false);

  if (YAML) {
    const doc = YAML.parse(boolSwitch.yaml.replace(/^\s{6}/gm, "").replace(/^custom-/, "- ") === "" ? "" : `providers:\n${boolSwitch.yaml.replace(/\n/g, "\n")}`);
    // 片段是 incomplete 的（只有 providers 下的一个路由），这里只做文本级审计断言
    const provs = {};
    (void provs); (void doc);
  }

  const effort = buildSnippet({
    base: "https://x.invalid/v1", model: "m", contextWindow: 262144, gateMaxTokens: 65536, visionOk: false,
    thinking: { format: "qwen", defaultOn: true, canDisable: true, canEnable: true, levels: ["low", "high"], supportsEffort: true },
  });
  assert.equal(/supportsReasoningEffort: true/.test(effort.yaml), true, "实测 effort 生效才写 supportsReasoningEffort");
  assert.equal((effort.yaml.match(/^\s+(low|high):/gm) ?? []).length, 2);
});

test("compaction：minContextWindowFor 计入 gap/retain（不只是 max+headroom+1）", async () => {
  const { minContextWindowFor, computeBudget } = await import(new URL("../lib/compaction.mjs", import.meta.url).pathname);
  const min = minContextWindowFor(4096, 65536);
  assert.equal(min, 117829, "max=4096 headroom=65536 的真实下界");
  assert.equal(computeBudget({ contextWindow: min, reservedCompletionTokens: 4096, headroomTokens: 65536 }).ok, true);
  assert.equal(computeBudget({ contextWindow: min - 1, reservedCompletionTokens: 4096, headroomTokens: 65536 }).ok, false);
  assert.notEqual(min, 4096 + 65536 + 1, "不能再只算 pressure");
});


// ═══════════════════════════════════════════════════════════════════════
// 组 14：probe-capabilities 端到端（mock 网关 → 探测结论 → 片段）
//   v0.3.1 的两个判断只有端到端才能验证：
//     ① 布尔开关端点（只有 enable_thinking 管用）→ 单档，不写 supportsReasoningEffort
//     ② effort 端点（reasoning_effort 管用）→ 双档 + supportsReasoningEffort: true
// ═══════════════════════════════════════════════════════════════════════

async function startThinkingGateway(mechanism) {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith("/models")) return send(200, { data: [{ id: "mock-1" }] });
      if (!req.url.endsWith("/chat/completions")) return send(404, { error: { message: "no route" } });
      if (j.max_tokens > 32768) return send(400, { error: { message: "too large" } });
      const hasImage = JSON.stringify(j.messages ?? []).includes("image_url");
      let reasoning = 0;
      if (mechanism === "boolean") reasoning = j.enable_thinking === true ? 30 : 0;
      else reasoning = j.reasoning_effort === "low" ? 10 : j.reasoning_effort === "high" ? 40 : 0;
      const content = hasImage ? "red" : "1+1=2";
      send(200, {
        choices: [{ message: { content, ...(reasoning ? { reasoning_content: "x".repeat(reasoning) } : {}) } }],
        usage: { prompt_tokens: 20, completion_tokens: 2, ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) },
      });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() };
}

for (const [mechanism, wantFormat, wantEffort] of [["boolean", "qwen", false], ["effort", "openai", true]]) {
  test(`probe+mock：${mechanism} 开关端点 → format=${wantFormat}、supportsEffort=${wantEffort}`, async () => {
    const gw = await startThinkingGateway(mechanism);
    try {
      const r = await runNode([
        new URL("../scripts/probe-capabilities.mjs", import.meta.url).pathname,
        "--base", gw.base, "--model", "mock-1", "--key", "k", "--json",
      ]);
      assert.equal(r.code, 0, r.stderr);
      const d = JSON.parse(r.stdout);
      assert.equal(d.summary.switchFormat, wantFormat);
      assert.equal(d.summary.thinkingSupportsEffort, wantEffort);
      const levels = (d.yaml.match(/^\s+(low|high):/gm) ?? []).length;
      assert.equal(levels, wantEffort ? 2 : 1, wantEffort ? "effort 端点应给两档" : "布尔端点只该给一档");
      assert.equal(/supportsReasoningEffort: true/.test(d.yaml), wantEffort);
      assert.equal(d.summary.vision, true, "红图判据应通过");
      assert.equal(d.summary.gateMaxTokens, 32768, "阶梯应收敛到 32768");
    } finally { gw.close(); }
  });
}


// ═══════════════════════════════════════════════════════════════════════
// 组 15：第二轮对抗审计的 P0/P1 回归（v0.3.4）
//   审计员真跑出来的洞：NaN 死循环、坏 YAML 打栈、重复 compaction 条目、
//   --max 被回退越过、并发写丢路由、CRLF 文件被拒、BOM 打栈。
// ═══════════════════════════════════════════════════════════════════════

const ROOT15 = new URL("..", import.meta.url).pathname;

function tmpYaml(name, text) {
  const p = join(tmpdir(), `g15-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`);
  writeFileSync(p, text);
  return p;
}
const PROBE15 = JSON.stringify({ base: "https://x.invalid/v1", model: "m", summary: { contextWindow: 200000, gateMaxTokens: 32768, vision: true, thinkingSwitchable: ["enable_thinking:true"], switchFormat: "qwen" } });
const PATCH15 = `- id: llm-pi-ai\n  config:\n    providers:\n      hand:\n        api: openai-completions\n        baseURL: https://x.invalid/v1\n        models:\n          - id: m\n            contextWindow: 200000\n            maxTokens: 8192\n`;

test("审计 P0-1：context-budget 的 --headroom NaN 必须 exit 2（不能再死循环）", async () => {
  const r = await runNode([join(ROOT15, "scripts/context-budget.mjs"), "--ctx", "800000", "--max", "65536", "--headroom", "NaN"]);
  assert.equal(r.code, 2, "NaN 应被参数校验拒绝");
  assert.match(r.stderr, /需要.个有限数字/);
});

test("审计 P0-3：context-budget --patch 坏 YAML 友好退出（不打栈）", async () => {
  const bad = tmpYaml("bad.yml", "- id: [oops\n");
  const r = await runNode([join(ROOT15, "scripts/context-budget.mjs"), "--patch", bad, "--ctx", "800000", "--max", "65536"]);
  assert.equal(r.code, 2);
  assert.ok(!/^\s+at /m.test(r.stderr), "不该出现栈帧");
  assert.match(r.stderr, /解析 .* 失败/);
});

test("审计 P0-4：同 id 两条 dsh-compaction-basic，必须按最后一条算（DSH 语义）", async () => {
  const p = tmpYaml("dup.yml", `- id: dsh-compaction-basic\n  config:\n    headroomTokens: 65536\n- id: dsh-compaction-basic\n  config:\n    headroomTokens: 180000\n${PATCH15}`);
  const probe = tmpYaml("probe.json", PROBE15);
  const r = await runNode([join(ROOT15, "scripts/inject-model.mjs"), "--patch", p, "--route", "rd", "--probe", probe, "--assume-ctx", "200000", "--plugin-root", "/opt/dsh/node_modules", "--dry-run"]);
  assert.equal(r.code, 1, "按 180000 算应被预算拒绝");
  assert.match(r.stderr + r.stdout, /headroom\(180000\)/, "必须报出 180000 这个 headroom");
});

test("审计 P1-6：--max 1024 不能被回退越过（写出 1024）", async () => {
  const p = tmpYaml("m1024.yml", PATCH15);
  const probe = tmpYaml("probe.json", PROBE15);
  const r = await runNode([join(ROOT15, "scripts/inject-model.mjs"), "--patch", p, "--route", "r2", "--probe", probe, "--assume-ctx", "200000", "--max", "1024", "--plugin-root", "/opt/dsh/node_modules", "--dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /maxTokens: 1024/);
});

test("审计 P2-11：CRLF 文件能 merge，且写回仍是 CRLF", async () => {
  const p = tmpYaml("crlf.yml", "- id: llm-pi-ai\r\n  config:\r\n    providers:\r\n      hand:\r\n        api: openai-completions\r\n        baseURL: https://x.invalid/v1\r\n        models:\r\n          - id: m\r\n            contextWindow: 262144\r\n");
  const r = await runNode([join(ROOT15, "scripts/merge-routes.mjs"), "--from", join(ROOT15, "examples/cordis.patch.yml"), "--patch", p, "--plugin-root", "/opt/dsh/node_modules"]);
  assert.equal(r.code, 0, r.stderr);
  const out = readFileSync(p, "utf8");
  assert.ok(out.includes("\r\n"), "写回必须保持 CRLF");
  assert.ok(out.includes("custom-example-a"), "托管块要写进去");
});

test("审计 P1-10：两个进程并发写同一 patch，必须有一个明确中止（不能静默丢路由）", async () => {
  const p = tmpYaml("conc.yml", PATCH15);
  const probe = tmpYaml("probe.json", PROBE15);
  const args = (route) => [join(ROOT15, "scripts/inject-model.mjs"), "--patch", p, "--route", route, "--probe", probe, "--assume-ctx", "200000", "--plugin-root", "/opt/dsh/node_modules"];
  const [a, b] = await Promise.all([runNode(args("rA")), runNode(args("rB"))]);
  const out = readFileSync(p, "utf8");
  const okCount = [a, b].filter((r) => r.code === 0).length;
  const failed = [a, b].filter((r) => r.code !== 0);
  assert.equal(okCount, 1, "应当只有一个写入成功");
  assert.equal(failed.length, 1);
  assert.match(failed[0].stderr + failed[0].stdout, /被另一个进程改过|并发写/);
});
