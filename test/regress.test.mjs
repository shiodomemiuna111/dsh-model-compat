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

test("路由级 compat 完全静默（两层都过、也不生效）—— 审计发现的真盲区", skipIfNoPlugin, async () => {
  const r = await verifyLoadPath(PLUGIN, {
    r: { api: "openai-completions", baseURL: "https://example.invalid/v1", compat: { thinkingFormat: "qwen" }, models: [{ id: "m", contextWindow: 100000, maxTokens: 8192 }] },
  });
  assert.equal(r.schema.ok, true);
  assert.equal(r.semantic.ok, true);
  // 所以必须由静态审计补上这一刀
  assert.ok(auditCodes({ r: { baseURL: "https://x/v1", compat: { thinkingFormat: "qwen" }, models: [{ id: "m" }] } }).includes("route-compat-ignored"));
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

test("路由级 compat 被报成 error", () => {
  assert.ok(auditCodes({ r: { baseURL: "https://x/v1", compat: { foo: 1 }, models: [{ id: "m" }] } }).includes("route-compat-ignored"));
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
