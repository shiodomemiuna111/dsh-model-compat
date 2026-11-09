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
 *   --no-window    显式关闭窗口探测（默认就是关的；探测会发几十万 token 的输入，可能花钱）
 *   --out DIR      把本次所有响应存到 DIR（默认不存）
 *
 * 探测内容（每项都标注了成本）：
 *   1. /models                    免费
 *   2. 基础 chat                    ~20 token
 *   3. 输出上限：max_tokens 阶梯下探 65536→4096  每档 ~20 token（取网关真正接受的最大值）
 *   4. 思考：双向探测（默认开→试关；默认关→试开） 每次 ~30 token
 *   5. 视觉 32×32 纯红 PNG + 问颜色 + 判 /red/i   ~20 token
 *   6. 流式 SSE 是否带 reasoning 增量  ~30 token
 *   7. 窗口：固定阶梯抽样（1M/2M/4M/8M 字符），取最大成功那次的 prompt_tokens
 *      ×0.95 向下取整到 4096 的倍数 —— 是「安全下界」，不是精确阈值。⚠ 默认关闭
 *
 * 退出码：0 成功；1 关键步骤失败；2 用法错误
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { buildSnippet } from "../lib/snippet.mjs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// 32×32 纯红 PNG（v0.3.0：1×1 可能被「最小尺寸」限制拒，32×32 更稳）
const PNG_RED_32 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";

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

/** 口音检测：很多聚合网关其实是某家原生 API 的转发。 */
function accentOf(base) {
  const h = new URL(base).host.toLowerCase();
  const m = [[/bigmodel|zhipu|dashscope|aliyun|volces|qwen|moonshot|kimi|baichuan|minimax|z\.ai|glm/, "qwen"],
             [/openai|azure|apizn|anthropic|claude|deepseek/, "openai"]];
  for (const [re, tag] of m) if (re.test(h)) return tag;
  return "unknown";
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

  // 思考证据（v0.3.0：只认 usage.completion_tokens_details.reasoning_tokens 太脆弱，
  // 很多网关只填 choices[0].message.reasoning_content，或者只给布尔）
  const reasoningOf = (j) => {
    const details = j?.usage?.completion_tokens_details;
    if (typeof details?.reasoning_tokens === "number" && details.reasoning_tokens > 0) return details.reasoning_tokens;
    if (details?.reasoning === true) return 1;
    const rc = j?.choices?.[0]?.message?.reasoning_content;
    if (typeof rc === "string" && rc.trim().length > 0) return rc.length;
    return 0;
  };
  const nonEmpty = (j) => String(j?.choices?.[0]?.message?.content ?? "").trim().length > 0;

  // 2 基础（思考型模型可能把 64 token 全烧在推理上，这里重试一次更大预算）
  r = await chat();
  if (r.status === 200 && !nonEmpty(r.json)) r = await chat({ max_tokens: 1024 });
  save("chat", r);
  step("basic-chat", "~20 token", r.status, r.json?.error ? JSON.stringify(r.json.error).slice(0, 200) : `content=${JSON.stringify(r.json?.choices?.[0]?.message?.content ?? "").slice(0, 40)}`);

  // 3 输出上限：阶梯下探（v0.3.0，外部评审意见 3）
  //    旧版只发一次 max_tokens=400000：多数模型/网关直接 400，测出来是「不支持 400k」，
  //    却被当成「没有输出上限」。现在从 65536 往下一档档试，取网关真正接受的最大值。
  const MAX_TOKENS_LADDER = [65536, 49152, 32768, 24576, 16384, 12288, 8192, 4096];
  let gateMaxTokens = null;
  let capDetail = [];
  for (const n of MAX_TOKENS_LADDER) {
    const rr = await chat({ max_tokens: n });
    save(`max-tokens-${n}`, rr);
    if (rr.status === 200) { gateMaxTokens = n; capDetail.push(`${n}✓`); break; }
    capDetail.push(`${n}✗`);
  }
  if (gateMaxTokens === null) {
    // 全拒：通常是网关限制，不代表模型本身没有上限；保守按 4096 处理并明确标注
    capDetail.push("全部被拒→保守按 4096");
  }
  step("output-cap", "~20 token × 档数", gateMaxTokens ? 200 : 0,
    gateMaxTokens ? `网关接受 max_tokens=${gateMaxTokens}（尝试：${capDetail.join(" ")}）` : `阶梯全部被拒（尝试：${capDetail.join(" ")}），无法测出真实上限`);

  // 4 思考：双向探测（v0.3.0，外部评审意见 2）
  //    旧版只测「怎么关」，遇到「默认关闭、要显式开」的模型会误判成不可调；
  //    遇到「纯推理、关不掉」的模型会白写一个 off 档。
  const question = [{ role: "user", content: "9.11 和 9.9 哪个大？只回答一个词" }];
  const offVariants = {
    "enable_thinking:false": { enable_thinking: false },
    'thinking:{type:"disabled"}': { thinking: { type: "disabled" } },
    "reasoning_effort:none": { reasoning_effort: "none" },
  };
  const onVariants = {
    "enable_thinking:true": { enable_thinking: true },
    'thinking:{type:"enabled"}': { thinking: { type: "enabled" } },
    "reasoning_effort:low": { reasoning_effort: "low" },
  };
  const baseline = await chat({}, question);
  save("thinking-baseline", baseline);
  const baselineReasoning = reasoningOf(baseline.json);
  const defaultOn = baselineReasoning > 0;

  const offResults = {}, onResults = {};
  for (const [name, extra] of Object.entries(offVariants)) {
    const rr = await chat(extra, question);
    offResults[name] = { status: rr.status, reasoning: reasoningOf(rr.json), err: rr.json?.error ? JSON.stringify(rr.json.error).slice(0, 120) : null };
  }
  for (const [name, extra] of Object.entries(onVariants)) {
    const rr = await chat(extra, question);
    onResults[name] = { status: rr.status, reasoning: reasoningOf(rr.json), err: rr.json?.error ? JSON.stringify(rr.json.error).slice(0, 120) : null };
  }
  // 关得掉：默认开时，某个 off 写法把 reasoning 压到 0
  const offWorks = defaultOn
    ? Object.entries(offResults).filter(([, v]) => v.status === 200 && v.reasoning === 0).map(([k]) => k)
    : [];
  // 开得起来：默认关时，某个 on 写法让 reasoning > 0
  const onWorks = !defaultOn
    ? Object.entries(onResults).filter(([, v]) => v.status === 200 && v.reasoning > 0).map(([k]) => k)
    : [];
  const canDisable = defaultOn ? offWorks.length > 0 : true;
  const canEnable = defaultOn ? true : onWorks.length > 0;
  const switchable = defaultOn ? offWorks : onWorks;
  step("thinking-baseline", "~30 token", baseline.status, `默认 ${defaultOn ? "开" : "关"}（reasoning=${baselineReasoning}）`);
  step("thinking-off", "~90 token", offWorks.length || !defaultOn ? 200 : 0,
    defaultOn ? (offWorks.length ? `可关：${offWorks.join("、")}` : `关不掉（纯推理模型？）：${JSON.stringify(offResults)}`) : "默认就是关的，不必测关");
  step("thinking-on", "~90 token", onWorks.length || defaultOn ? 200 : 0,
    defaultOn ? "默认开，无需测开" : (onWorks.length ? `可开：${onWorks.join("、")}` : `开不起来：${JSON.stringify(onResults)}`));

  // 思考格式：按「哪个写法真的改变了 reasoning」推定
  const switchFormat = switchable.length === 0 ? null
    : switchable.some((v) => String(v).startsWith("enable_thinking")) ? "qwen"
    : switchable.some((v) => String(v).startsWith("thinking")) ? "deepseek"
    : switchable.some((v) => String(v).startsWith("reasoning_effort")) ? "openai"
    : null;
  // 档位：只有**证据表明 low/high 真的有差异**时才给多档。
  // v0.3.1 修：旧版只要「开关两个方向都能动」就给 low+high，但 qwen/chat-template
  // 这类布尔开关格式里，多档实际等价（wire payload 测试证明：不声明
  // supportsReasoningEffort 时 low/high 请求体逐字节相同）。判据是：
  // 真正让思考变化的写法是 reasoning_effort（而不是布尔开关）→ 说明网关认 effort。
  const effortMechanism = switchable.some((v) => String(v).startsWith("reasoning_effort"));
  const supportsEffort = effortMechanism;
  const levels = canDisable && canEnable && effortMechanism ? ["low", "high"] : ["high"];
  const thinking = {
    format: switchFormat,
    defaultOn,
    canDisable,
    canEnable,
    levels,
    supportsEffort,
    question,
  };

  // 5 视觉：32×32 纯红 + 让模型说颜色（v0.3.0，外部评审意见 4）
  //    旧判据「有回答 或 prompt_tokens 上涨」里「有回答」恒真 —— 静默丢图的网关会全放行。
  //    现在必须真的把红色认出来；只回「不知道/看不到/白色」都算不可用。
  r = await chat({}, [{
    role: "user",
    content: [
      { type: "text", text: "Reply with one word only: is this image red, blue, or green?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_RED_32}` } },
    ],
  }]);
  save("vision", r);
  const visionText = String(r.json?.choices?.[0]?.message?.content ?? "").trim();
  const visionTokens = r.json?.usage?.prompt_tokens ?? 0;
  const visionSaysRed = /\bred\b|红/i.test(visionText);
  const visionOk = r.status === 200 && visionSaysRed;
  step(
    "vision",
    "~20 token",
    r.status,
    r.status !== 200
      ? `不可用：${JSON.stringify(r.json?.error ?? r.text.slice(0, 160)).slice(0, 200)}`
      : visionOk
        ? `识别正确：答复=${JSON.stringify(visionText).slice(0, 40)}（prompt_tokens=${visionTokens}）`
        : `疑似静默丢图：HTTP 200 但没识别出红色（答复=${JSON.stringify(visionText).slice(0, 60)}，prompt_tokens=${visionTokens}）`,
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

  // 汇总成可粘贴的 YAML（v0.3.0：maxTokens 由 pickSafeMaxTokens 反推，不再硬编码）
  const snippet = buildSnippet({
    base: o.base,
    model: o.model,
    contextWindow,
    gateMaxTokens,
    visionOk,
    thinking,
  });
  findings.yaml = snippet.yaml;
  findings.snippet = { chosenMaxTokens: snippet.chosenMaxTokens, budget: snippet.budget, notes: snippet.notes, fatal: snippet.fatal };
  findings.summary = {
    listedInModels: listed,
    modelFields,
    accent: accentOf(o.base),
    gateMaxTokens,
    thinkingDefaultOn: defaultOn,
    thinkingCanDisable: canDisable,
    thinkingCanEnable: canEnable,
    thinkingSwitchable: switchable,
    thinkingSupportsEffort: supportsEffort,
    vision: visionOk,
    streamDeltaKeys: [...deltaKeys],
    contextWindow,
    switchFormat,
  };

  if (o.json) console.log(JSON.stringify(findings, null, 2));
  else {
    console.log(`端点 ${o.base}  模型 ${o.model}\n`);
    for (const s of findings.steps) console.log(`${s.status === 200 ? "✓" : s.status === 0 ? "·" : "✗"} ${s.name.padEnd(14)} ${s.detail}`);
    if (o.yaml) {
      console.log(`\n--- 可粘贴片段 ---\n${snippet.yaml}`);
      if (snippet.notes.length) console.log(`\n注意：\n${snippet.notes.map((n) => "  · " + n).join("\n")}`);
    }
  }
  // 关键步骤失败才算失败：/models 不可用不算（很多网关不实现），但基础 chat 或输出上限全拒要算；
  // 片段算不出安全配置（窗口太小 / headroom 太大）也算失败——否则用户会拿到一份
  // 必然被 compaction-basic 拒掉、或根本没写 maxTokens 的片段而不知道。
  const basicOk = findings.steps.some((x) => x.name === "basic-chat" && x.status === 200);
  if (!basicOk) return 1;
  if (snippet.fatal) {
    console.error(`\n片段不完整：${snippet.notes[snippet.notes.length - 1] ?? "算不出安全的 maxTokens"}`);
    return 1;
  }
  return 0;
}

main()
  .then((c) => process.exit(typeof c === "number" ? c : 0))
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(e instanceof NetError ? 1 : 2);
  });
