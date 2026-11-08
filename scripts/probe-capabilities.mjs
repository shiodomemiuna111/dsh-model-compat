#!/usr/bin/env node
/**
 * probe-capabilities.mjs — 用真实请求测一个 OpenAI 兼容端点的能力，
 * 输出可以直接粘进 cordis.patch.yml 的 YAML 片段。
 *
 * 用法：
 *   node scripts/probe-capabilities.mjs --base https://.../v1 --key-env MY_KEY --model my-model
 *   node scripts/probe-capabilities.mjs --base ... --key sk-xxx --model ... --yaml --json
 *
 * 选项：
 *   --base URL     端点根（到 /v1 为止）            必填
 *   --model ID     模型 id                         必填
 *   --key K        直接给 key                      二选一
 *   --key-env NAME 从环境变量读 key                 二选一
 *   --key-file F   从 $DSH_HOME/.credentials.yaml 读 refs.NAME（--key-env NAME 时自动尝试）
 *   --yaml         打印 cordis.patch.yml 片段
 *   --json         打印 JSON
 *   --no-window    跳过窗口探测（窗口探测会发几十万 token 的输入，可能花钱）
 *   --out DIR      把本次所有响应存到 DIR（默认不存）
 *
 * 探测内容（每项都标注了成本）：
 *   1. /models                    免费
 *   2. 基础 chat                    ~20 token
 *   3. 输出上限 max_tokens=400000    ~20 token（返回体小，不会被截断就不会多花）
 *   4. 思考开关（off 三种写法 / on 三种写法） 每次 ~30 token
 *   5. 视觉 1×1 PNG                ~20 token
 *   6. 流式 SSE 是否带 reasoning 增量  ~30 token
 *   7. 窗口：二分探测                ⚠ 每次几十万 token 输入，默认关闭
 *
 * 退出码：0 成功；1 关键步骤失败；2 用法错误
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function parseArgs(argv) {
  const o = { yaml: false, json: false, window: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") o.base = next();
    else if (a === "--model") o.model = next();
    else if (a === "--key") o.key = next();
    else if (a === "--key-env") o.keyEnv = next();
    else if (a === "--key-file") o.keyFile = next();
    else if (a === "--out") o.out = next();
    else if (a === "--yaml") o.yaml = true;
    else if (a === "--json") o.json = true;
    else if (a === "--no-window") o.window = false;
    else if (a === "--window") o.window = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return o;
}

/** yaml 解析器可能在 DSH 安装目录里，按常见路径逐个试。 */
function loadYamlModule() {
  const tries = ["yaml", "/opt/dsh/node_modules/yaml", process.env.DSH_NODE_MODULES ? `${process.env.DSH_NODE_MODULES}/yaml` : null].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch {} }
  return null;
}

function loadKey(o) {
  if (o.key) return o.key;
  if (o.keyEnv && process.env[o.keyEnv]) return process.env[o.keyEnv];
  const file = o.keyFile ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
  if (o.keyEnv && existsSync(file)) {
    const yaml = loadYamlModule();
    if (yaml) {
      const doc = yaml.parse(readFileSync(file, "utf8"));
      const v = doc?.refs?.[o.keyEnv];
      if (typeof v === "string" && v) return v;
    }
  }
  throw new Error(`拿不到 key：请给 --key 或 --key-env（且同名环境变量/credentials refs 存在）`);
}

class NetError extends Error {}

async function safeFetch(url, init) {
  try { return await fetch(url, init); }
  catch (e) { throw new NetError(`连不上 ${new URL(url).host}：${e?.cause?.code ?? e?.message ?? e}`); }
}

async function post(o, key, path, body) {
  const t0 = Date.now();
  const res = await safeFetch(`${o.base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ms: Date.now() - t0, text, json };
}
async function get(o, key, path) {
  const t0 = Date.now();
  const res = await safeFetch(`${o.base.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ms: Date.now() - t0, text, json };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.base || !o.model) {
    console.log("用法: probe-capabilities.mjs --base URL --model ID (--key K | --key-env NAME) [--yaml] [--json] [--window]");
    return o.help ? 0 : 2;
  }
  const key = loadKey(o);
  const findings = { base: o.base, model: o.model, steps: [] };
  const save = (name, r) => {
    if (!o.out) return;
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, `${name}.json`), r.text);
  };
  const step = (name, cost, status, detail) => findings.steps.push({ name, cost, status, detail });

  // 1 /models
  let r = await get(o, key, "/models");
  save("models", r);
  const ids = (r.json?.data ?? []).map((m) => m.id);
  const listed = ids.includes(o.model);
  const entry = (r.json?.data ?? []).find((m) => m.id === o.model);
  const modelFields = entry ? Object.keys(entry) : [];
  step("models", "免费", r.status, `${r.status === 200 ? `${ids.length} 个模型` : "不可用"}；包含本模型=${listed}；字段=${modelFields.join("/") || "—"}`);

  const chat = (extra, messages) =>
    post(o, key, "/chat/completions", {
      model: o.model,
      messages: messages ?? [{ role: "user", content: "1+1=?" }],
      max_tokens: 64,
      stream: false,
      ...extra,
    });

  // reasoning_tokens 缺失 = 没开思考（很多网关省略这个字段而不是给 0）
  const reasoningOf = (j) => {
    const v = j?.usage?.completion_tokens_details?.reasoning_tokens;
    return typeof v === "number" ? v : 0;
  };
  const nonEmpty = (j) => String(j?.choices?.[0]?.message?.content ?? "").trim().length > 0;

  // 2 基础（思考型模型可能把 64 token 全烧在推理上，这里重试一次更大预算）
  r = await chat();
  if (r.status === 200 && !nonEmpty(r.json)) r = await chat({ max_tokens: 1024 });
  save("chat", r);
  step("basic-chat", "~20 token", r.status, r.json?.error ? JSON.stringify(r.json.error).slice(0, 200) : `content=${JSON.stringify(r.json?.choices?.[0]?.message?.content ?? "").slice(0, 40)}`);

  // 3 输出上限
  let maxTokens = null;
  r = await chat({ max_tokens: 400000 });
  save("max-tokens-400k", r);
  if (r.status === 200) maxTokens = 393216;
  step("output-cap", "~20 token", r.status, r.status === 200 ? `accepts max_tokens=400000 ⇒ 声明 maxTokens 可到 393216` : `拒绝 400000：${JSON.stringify(r.json?.error ?? r.text.slice(0, 120)).slice(0, 200)}`);

  // 4 思考开关
  const offVariants = { "enable_thinking:false": { enable_thinking: false }, 'thinking:{type:"disabled"}': { thinking: { type: "disabled" } }, "reasoning_effort:none": { reasoning_effort: "none" } };
  const onVariants = { baseline: {}, "enable_thinking:true": { enable_thinking: true }, 'thinking:{type:"enabled"}': { thinking: { type: "enabled" } }, "reasoning_effort:low": { reasoning_effort: "low" } };
  const offResults = {}, onResults = {};
  for (const [name, extra] of Object.entries(offVariants)) {
    const rr = await chat(extra, [{ role: "user", content: "9.11 和 9.9 哪个大？只回答一个词" }]);
    offResults[name] = { status: rr.status, reasoning: reasoningOf(rr.json), err: rr.json?.error ? JSON.stringify(rr.json.error).slice(0, 120) : null };
  }
  for (const [name, extra] of Object.entries(onVariants)) {
    const rr = await chat(extra, [{ role: "user", content: "9.11 和 9.9 哪个大？只回答一个词" }]);
    onResults[name] = { status: rr.status, reasoning: reasoningOf(rr.json), err: rr.json?.error ? JSON.stringify(rr.json.error).slice(0, 120) : null };
  }
  const switchable = Object.entries(offResults).filter(([, v]) => v.status === 200 && v.reasoning === 0).map(([k]) => k);
  step("thinking-off", "~90 token", switchable.length ? 200 : 0, switchable.length ? `可关：${switchable.join("、")}` : `没有任何写法能把 reasoning 归零：${JSON.stringify(offResults)}`);
  step("thinking-on", "~120 token", 200, JSON.stringify(onResults));

  // 5 视觉
  r = await chat({}, [{ role: "user", content: [{ type: "text", text: "这张图主要是什么颜色？一个词。" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1PX}` } }] }]);
  save("vision", r);
  const visionText = String(r.json?.choices?.[0]?.message?.content ?? "").trim();
  const visionTokens = r.json?.usage?.prompt_tokens ?? 0;
  const visionOk = r.status === 200 && (visionText.length > 0 || visionTokens > 20);
  step(
    "vision",
    "~20 token",
    r.status,
    visionOk
      ? `答复=${JSON.stringify(visionText).slice(0, 40)}${visionText ? "" : "（无正文，但 prompt_tokens 上涨，图应已解析）"}`
      : `不可用或未解析：${JSON.stringify(r.json?.error ?? r.text.slice(0, 160)).slice(0, 200)}`,
  );

  // 6 流式
  const t0 = Date.now();
  const sres = await safeFetch(`${o.base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: o.model, stream: true, stream_options: { include_usage: true }, max_tokens: 64, messages: [{ role: "user", content: "说一句话。" }] }),
  });
  const stext = await sres.text();
  save("stream", { text: stext });
  const deltaKeys = new Set();
  let streamUsage = null;
  for (const line of stext.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let j; try { j = JSON.parse(payload); } catch { continue; }
    if (j.usage) streamUsage = j.usage;
    Object.keys(j.choices?.[0]?.delta ?? {}).forEach((k) => deltaKeys.add(k));
  }
  step("stream", "~30 token", sres.status, `delta 字段=[${[...deltaKeys]}]；usage=${streamUsage ? `completion=${streamUsage.completion_tokens}` : "无"}（${Date.now() - t0}ms）`);

  // 7 窗口（可选）
  let contextWindow = null;
  if (o.window) {
    const unit = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ";
    const mk = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    let lo = 0, hi = null, lastOk = null;
    for (const chars of [1000000, 2000000, 4000000, 8000000]) {
      const rr = await chat({ max_tokens: 16 }, [{ role: "user", content: `Count words: ${mk(chars)}` }]);
      if (rr.status === 200) { lastOk = rr.json?.usage?.prompt_tokens ?? null; lo = chars; }
      else { hi = chars; step("window-probe", "⚠ 大输入", rr.status, `chars=${chars} → ${JSON.stringify(rr.json?.error ?? rr.text.slice(0, 80)).slice(0, 160)}`); break; }
    }
    if (lastOk) contextWindow = Math.floor((lastOk * 0.95) / 4096) * 4096;
    step("window", "⚠ 几十万 token 输入", lastOk ? 200 : 0, lastOk ? `最大成功 prompt_tokens=${lastOk}${hi ? `，char=${hi} 失败` : ""} ⇒ 建议声明 ${contextWindow}` : "探测失败");
  } else {
    step("window", "跳过", 0, "默认不探测（花钱）；加 --window 才跑");
  }

  // 汇总成可粘贴的 YAML
  const supportsReasoning = switchable.length > 0;
  const levels = supportsReasoning
    ? `            reasoningEfforts:\n              off: null\n              low: "low"\n              high: "high"\n`
    : `            reasoningEfforts: false\n`;
  const yamlSnippet = `      custom-${new URL(o.base).hostname.replace(/\./g, "-")}:
        displayName: ${new URL(o.base).hostname}
        api: openai-completions
        baseURL: ${o.base}
        apiKeyEnv: YOUR_KEY_ENV
        defaultInput: [text]
        defaultMaxTokens: 65536
        models:
          - compat:
              thinkingFormat: qwen        # 有"可关"证据才写；没有就删掉这行
            id: ${o.model}
            name: ${o.model}
            contextWindow: ${contextWindow ?? 1000000}
            maxTokens: ${maxTokens ?? 65536}
            input: [text${visionOk ? ", image" : ""}]
${levels}`;
  findings.yaml = yamlSnippet;
  findings.summary = {
    listedInModels: listed,
    modelFields,
    outputCap: maxTokens,
    thinkingSwitchable: switchable,
    vision: visionOk,
    streamDeltaKeys: [...deltaKeys],
    contextWindow,
  };

  if (o.json) console.log(JSON.stringify(findings, null, 2));
  else {
    console.log(`端点 ${o.base}  模型 ${o.model}\n`);
    for (const s of findings.steps) console.log(`${s.status === 200 ? "✓" : s.status === 0 ? "·" : "✗"} ${s.name.padEnd(14)} ${s.detail}`);
    if (o.yaml) console.log(`\n--- 可粘贴片段 ---\n${yamlSnippet}`);
  }
  return findings.summary.outputCap || o.noOutputCheck ? 0 : 1;
}

main()
  .then((c) => process.exit(typeof c === "number" ? c : 0))
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(e instanceof NetError ? 1 : 2);
  });
