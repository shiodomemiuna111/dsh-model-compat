# 第三方模型能力声明方案 · 规格书

**版本**：0.3.0 ｜ **代码提交**：`15b6882`（仓库 `master` 持续更新，本文以该提交为准） ｜ **仓库**：<https://github.com/shiodomemiuna111/dsh-model-compat> ｜ **许可证**：MIT

**写这份文档的目的**：把方案讲清楚到「别人可以照着实现、也可以照着挑错」的程度，用于外部评审。
本文所有结论都标注来源：**【读码】** = 读了哪个文件哪几行；**【实测】** = 跑了哪条命令、输出了什么；**【未验】** = 没验证，明确标出来。

**核验环境**（本文所有实测都在这个环境里跑）：

| 项 | 值 | 怎么确认的 |
|---|---|---|
| OS | Android 15 手机上的 proot Ubuntu 24.04 aarch64 | 本机 |
| Node | v24.22.1 | `node --version` |
| `@deepseek-ai/dsh-llm-pi-ai` | **0.2.2-rc.1** | 读它的 `package.json` |
| `@earendil-works/pi-ai` | **1.5.0** | 读它的 `package.json` |
| `@deepseek-ai/dsh-compaction-basic` | **0.2.2-rc.1** | 读它的 `package.json` |
| 脚本依赖 | 零第三方依赖（YAML 解析借用 DSH 自带的 `yaml` 包） | `package.json` 没有 dependencies |

> 本文不谈「哪个模型更好」，只谈一件事：**怎么把一个 DSH 模型目录里没有的第三方模型，准确、可验证地声明给 DSH。**

---

## 0. 一页纸摘要

DSH 的模型目录是静态的。你接一个目录里没有的第三方 OpenAI 兼容端点时，`contextWindow` / `maxTokens` / `input` 三个字段**不会**被自动探测，全部落到默认值（1,000,000 / 128,000 / `["text"]`）。于是出现三个症状：**上下文爆、看不见图、思考档位调不了**。这不是 DSH 的 bug，是**没声明**。

本方案不做「自动适配所有厂商」这种不可能的事，而是把这件事拆成一条可验证的流水线：

```
测（真实请求证明能力） → 验（用 DSH 自己的两段加载路径预演） → 写（隔离预演 + 备份 + 回滚）
                                                ↘ 跨版本复验（同一份 YAML 丢给 5 个历史版本）
```

产出是 6 个零依赖脚本 + 7 个共享库 + 一份可直接抄的声明模板 + 63 条回归测试。**核心主张只有一条：声明必须由证据支撑，而证据必须能复现。**

---

## 1. 问题定义

### 1.1 三个症状

| 症状 | 直接原因 | 深层原因 |
|---|---|---|
| 聊到一半「上下文超限」，或长对话突然报 400 | 声明的 `contextWindow` 大于真实窗口 → 压缩阈值算得太高，压缩永不触发 | 目录未命中 → 落默认 1,000,000 |
| 发图给模型，它说「我看不到图」/ 本地直接报错 | `input` 没声明 `image`，DSH 在本地就把图拦了 | 目录未命中 → 落默认 `["text"]` |
| 模型选择器里没有思考深度可调 | `reasoningEfforts` 没声明 / 声明了但 `thinkingFormat` 不对 | 目录未命中 → `reasoning: false` |

### 1.2 根因：目录未命中时落默认值

**【读码】** `@deepseek-ai/dsh-llm-pi-ai` 0.2.2-rc.1 `lib/index.js`：

| 常量 | 值 | 行号 |
|---|---|---|
| `DEFAULT_CONTEXT_WINDOW` | `1e6`（1,000,000） | `:960` |
| `DEFAULT_MAX_TOKENS` | `128e3`（128,000） | `:962` |
| `DEFAULT_INPUT` | `["text"]` | `:973` |

`lib/index.js:963-972` 的注释原文：*nothing can interrogate a gateway for its modalities*。这就是设计意图——**网关不会告诉你它支持什么模态**，所以 DSH 不猜，交给用户声明。

**【读码】** 内置目录确实很大但仍是静态的：`/opt/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/` 下 **43 个厂商文件**、**1712 条模型条目**（按协议分布：openai-completions 695、anthropic-messages 412、bedrock-converse-stream 197、openai-responses 129、openrouter-images 64、typesafe-system-one 50、azure-openai-responses 44、mistral-conversations 34、google-generative-ai 32、pi-messages 28、google-vertex 13、openai-codex-responses 8、cloudflare-workers-ai-system-one 5、openai-decisions 1），其中 `reasoning: true` 1352 条、声明 `image` 模态 1263 条。**没有你那个聚合网关后面的具体模型，这些信息就无从谈起。**

### 1.3 为什么这不算 DSH 的 bug

- 自动探测**能**拿到的东西（窗口、输出上限）DSH 已经做了，见 §2.8；
- 自动探测**拿不到**的东西（模态、思考档位）任何实现都只能靠一次真实请求去证明——而这正是 `probe-capabilities.mjs` 干的事；
- 剩下的工作只是「把证据写进 YAML，并且写之前先验证」。这就是本仓库的全部内容。

---

## 2. 机制事实（方案设计依据）

以下每一条都是方案里某个决定的根据。**如果某条被推翻，对应设计就要改**，所以列在评审最前面。

### 2.1 真实加载是两段，不是一段

**【读码】** `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`：

| 段 | 函数 | 行号 | 做什么 |
|---|---|---|---|
| 第 1 段 | `Config(raw)` | `:1086`（定义）；`:2941` 在 `internal/config` 钩子里调用 | schemastery 结构校验：类型、枚举、必填 |
| 第 2 段 | `resolveProfiles(raw, validation)` | `:1120`（定义）；`:2932` 普通读取用 `"deferred"`（catalog 缺失只记诊断）；`:2938-2945` 的 `internal/config` 钩子先 `Config(raw)` 再 `assertServiceable`（`:1095-1097`，内部是 `resolveProfiles(...)` 默认 strict），配置变更走严格路径 | 语义校验：两两约束、兼容性、生成每个模型的最终属性 |

**这条事实的工程后果**：只跑第 2 段，会把「第 1 段就会拒」的坏值误报成「静默放行」。本仓库第一版就犯过这个错（当时声称「9 种坏写法里 3 种会被 strict 放行」），后来实测推翻了。

实测对照（用本仓库 `lib/load-path.mjs` 直接调真实解析器）：

```
compat 值为 null（模型级） => schema: PASS | semantic: REJECT
  llm-pi-ai: provider "r" model "m" sets compat "thinkingFormat" with no value; give it one, or remove the key...
compat 值为 null（路由级） => schema: PASS | semantic: REJECT
  llm-pi-ai: provider "r" route sets compat "thinkingFormat" with no value; ...
路由级 compat 未知键        => schema: PASS | semantic: REJECT
  llm-pi-ai: provider "r" route sets compat "nope", which no wire protocol declares; ...
input 写成字符串 "image"    => schema: REJECT | semantic: PASS
  $.providers.r.models[0].input expected array but got image
```

（以上四行是 【实测】；命令见 §6.3。）

### 2.2 未声明 = 继续继承，不是「明确说没有」

**【读码】** `lib/index.js:295-297`：

```js
function declaredInput(configured) {
  return configured === void 0 || configured.length === 0 ? void 0 : [...configured];
}
```

注释（同处）：*Absent and empty mean the same thing — `[]` describes a model that accepts nothing...*。

解析链（`:694` 附近）：`entry.input` → `route.defaultInput` → `DEFAULT_INPUT`。

**工程后果**：`input: []` 和完全不写 `input` 是同一件事——**继承上一层**，不是「这个模型什么都看不了」。想表达「只看文本」，要显式写 `input: [text]`。

### 2.3 `compat` 有两级，语义不同

**【读码】** `lib/index.js`：

| 位置 | 规则 | 行号 |
|---|---|---|
| 路由级 `route.compat` | 逐个并进该路由下每个模型，但**只在该模型协议的 gate 允许时**才生效；不允许则**静默跳过** | `:628` `:633` |
| 模型级 `entry.compat` | 只在该模型协议的 gate 允许时生效；不允许则**直接报错**，文案带 `which does not take it` | `:628` `:637` |
| 路由级字段有没有「接得住」的模型 | 如果一个都没有 → 报 `sets compat "…", but no model on the route speaks a protocol that takes it` | `:730` |
| `compat` 字段名是否合法 | `assertOfferedCompatFields` 校验；未知字段报 `which no wire protocol declares` | `:541` `:681` `:685` |

**工程后果**：**路由级 `compat` 是真的会生效的**（这是早期版本写反过的结论）。它「静默」只发生在「这个模型的协议不吃这个开关」的场景，属于合理设计，不是 bug。

### 2.4 压缩联动：三个数字决定一切

**【读码】** `@deepseek-ai/dsh-compaction-basic/lib/index.js`：

```js
// :124-134 resolveCompactSpec
B         = contextWindow - reservedCompletionTokens   // :757: maxTokens ?? defaultMaxTokens ?? 0
pressure  = B - headroomTokens                          // :63 默认 65536
threshold = floor(min(contextWindow * 0.8, pressure))   // :15 = .8, :132
retain    = floor(B * 0.16)                             // :17 = .16, :133
```

三类**硬失败**（会抛 `TargetPressureConfigError`）：

| 条件 | 行号 | 触发场景 |
|---|---|---|
| `B <= 0` | `:129` | `maxTokens >= contextWindow` |
| `pressure <= 0` | `:131` | `B <= headroomTokens`（默认 65536） |
| `retain >= threshold` | `:134` | 预算被压到极限 |

**工程后果 1（最重要的坑）**：`contextWindow: 131072` + 继承的 `maxTokens: 128000` → `B = 3072` → `pressure = -62464` → **启动即抛错**。所以「窗口按真实值填、但不动 maxTokens」这条路是走不通的，必须**同时**把 `maxTokens` 显式下调。

> **v0.3.0 勘误（外部评审抓到的数据硬伤）**：0.2.2 版这张表把 `131072 / 128000` 与 `threshold=12484 / retain=12483 / gap=1` 写在同一行，**是错的**——那组数对应的是 `ctx=206020, maxTokens=128000`。`131072 / 128000` 根本走不到算 threshold：它在 `pressure<=0`（`:131`）就抛了。现在两行分开写，并且第一行明确标注「不是抖动，是直接失败」。

**工程后果 2**：即使不抛错，`threshold - retain` 太小会导致「压缩完立刻又到阈值」的抖动。本仓库建议 `>= 30000`（工程经验值，不是 DSH 强制）。示例数字：

| ctx | maxTokens | threshold | retain | gap | 判定 |
|---|---|---|---|---|
| 131072 | 128000 | — | — | — | **硬失败**（`pressure=-62464`，不是抖动） |
| 206020 | 128000 | 12484 | 12483 | **1** | **必然抖动**（这正是 198k 反而比 128k 更危险的原因） |
| 131072 | 16384 | 49152 | 18350 | 30802 | 通过 |
| 131072 | 8192 | 57344 | 19660 | 37684 |
| 262144 | 32768 | 163840 | 36700 | 127140 |
| 400000 | 65536 | 268928 | 53514 | 215414 |
| 800000 | 65536 | 640000 | 117514 | 522486 |

（以上各行是 【实测】：`node scripts/context-budget.mjs --ctx … --max … --json`。）

**工程后果 2b（v0.3.0 新增）**：安全取值的下限不是「能加载」，而是「`gap >= 30000`」。给定 `headroom`，`B_min = floor(minGap / (1 - retainRatio)) = floor(30000 / 0.84) = 35715`（`retain < threshold - 30000` 的解），所以 `contextWindow > maxTokens + headroom + 35715`。

**工程后果 3**：`headroomTokens` 是公开配置键（`:63` 读取，`:103` 支持 per-target 覆盖），不是硬编码常量。把 65536 调到 16384，可以让 64k 窗口的模型也能加载（反推公式：`contextWindow > maxTokens + headroomTokens`）。

### 2.5 溢出兜底存在，但不是设计目标

**【读码】** `dsh-compaction-basic/lib/index.js`：

- `:879` 监听 `agent/request-error`；
- 当错误码是 `CONTEXT_WINDOW_EXCEEDED` 且没被取消时，走 `:890` `compactIfNeeded(agent, "context-overflow")`；
- `:937-945` 这个分支用 `selectCompactableRange(agent.session, measurement, 0)`（`:940`）——**retain=0**（尽可能多压）；
- 成功则返回 `{ kind: "retry" }`，默认最多重试 `maxOverflowRetries = 1` 次（`:83`）。

另一方面，溢出判定还看用量是否超声明值，以及错误文本正则：`@deepseek-ai/dsh-llm/lib/index.js:177-179` 的 `isContextWindowExceededError`（4 组正则，含 `maximum context length` / `too long for this model` 等）。

**工程后果**：声明错了不会「直接崩」，但会变成「每次都靠 400 + 一次压缩兜底」，体验差且不可靠。**兜底是安全网，不是设计模式。**

### 2.6 图片：本地硬拦 + 预算卸载

**【读码】** `dsh-llm-pi-ai/lib/index.js`：

- `:2012`：请求含图但 `model.input` 不含 `image` → **本地**抛 `pi-ai model "X" does not support image input`（`UNSUPPORTED_CONTENT`），请求根本发不出去；
- 图片预算默认值（`resolveProfiles`，`lib/index.js:1132-1140`）：`maxRequestImageBytes = 20,971,520`（20MB）、`maxRequestImages = 50`、`imageOffloadCountQuantum = min(10, maxRequestImages)`、`requestImagePixelBudget = 4,194,304`、`requestImageMaxBytes = 1,048,576`；
- 超预算不是静默丢弃，是抛 `IMAGE_OFFLOAD_REQUIRED`，并且历史里的图可以投影成 `offloadedImageText`（`requestImageHandleText`）。

**工程后果**：
1. 「看不见图」的第一嫌疑永远是 **`input` 没声明 `image`**（本地硬拦），不是预算；
2. 声明了 `image` 但上游不支持 → 上游 400 上抛；
3. 上游网关静默丢图 → 表现同样是「看不见」，这一种**只能靠真实请求排查**（见 §5 已知边界）。

### 2.7 思考格式是 11 种，不是 1 种

**【读码】** `@earendil-works/pi-ai/dist/api/openai-completions.js:605-710` 是真实序列化逻辑，`thinkingFormat` 取值直接决定发什么字段：

| `thinkingFormat` | 实际发出的字段（关键行） |
|---|---|
| `zai` | `thinking: { type, clear_thinking }` + `reasoning_effort`（`:607`） |
| `qwen` | `enable_thinking: !!reasoningEffort`（`:618-619`） |
| `qwen-chat-template` | `chat_template_kwargs: { enable_thinking }`（`:627-629`） |
| `chat-template` | `chat_template_kwargs`（`:633`） |
| `baseten` | `chat_template_args` + `reasoning_effort`（`:639`） |
| `deepseek` | `thinking: { type }` + `reasoning_effort`（`:654`） |
| `openrouter` | `reasoning: { effort }`（`:666`） |
| `ant-ling` / `together` | 各自格式（`:678` / `:684`） |
| `string-thinking` | `thinking: "<level>"`（`:691`） |
| 不写（缺省） | `reasoning_effort` |

另有一条**独立**的预算字段逻辑：`resolveThinkingTokenBudgetField`（`:740`）→ `thinking_token_budget` / `thinking_budget` / `thinking_budget_tokens` 三选一，由 `resolveClampedThinkingBudget`（`:747`）挂在请求顶层。

**【读码】** 可选值清单在 `dsh-llm-pi-ai/lib/index.js:309` 起（11 个）；思考档位 7 个（`:299`：off / minimal / low / medium / high / xhigh / max）。

**工程后果**：`thinkingFormat` 写错**不会自动纠正**，也不会报错——会变成「发了一个网关不认识/忽略的字段」，表现就是「思考调不了」。所以本方案要求：**只有探测到「哪个写法真能把 `reasoning_tokens` 归零」才写这个字段**（见 §3.5）。

### 2.8 协议只有 3 种；自动发现不覆盖模态/档位

**【读码】** `dsh-llm-pi-ai/lib/index.js`：

- `:835-839` `PROTOCOLS` 只有 3 个：`openai-completions` / `openai-responses` / `anthropic-messages`。**【实测】** 手写路由的 `api:` 超出这 3 个会被 Config 拒，报 `$.providers.r.api expected "openai-completions" | "openai-responses" | "anthropic-messages"`（`google-generative-ai`、`bedrock-converse-stream` 都拒）；**但目录路由（不带 `api`）可以命中目录里的其它协议**（例：`{google: {models:[{id:"gemini-2.5-pro"}]}}` → ctx 1048576 / max 65536 / input `[text,image]` / reasoning true）。
- 内置模型发现：`LISTABLE_PROTOCOLS`（`:2292`）只覆盖 OpenAI 系 + Anthropic；`discoverModels`（`:2438`）从 `/models` 读的窗口字段是 `contextWindow / context_window / context_length / max_input_tokens / limit.context`（`:2404`），输出上限字段是 `maxOutputTokens / max_output_tokens / maxTokens / max_tokens / limit.output / top_provider.max_completion_tokens`（`:2405`）。**不读模态，不读思考档位。**

**工程后果**：窗口/输出上限可以「半自动」拿到；**模态和档位必须靠一次真实请求证明**。这就是 probe 脚本的存在理由，也是本方案「不能全自动」的诚实边界。

### 2.9 改 YAML 不需要重启

**【读码】** `@deepseek-ai/dsh-hmr/lib/index.js:850` 监听两个文件：`profile.patchPath`（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）和 `$DSH_HOME/cordis.patch.yml`（`PROFILE_PATCH_FILENAME = "cordis.patch.yml"`，见 `dsh-app-boot/lib/index.js:1327`）。内容变化 → 重新 compose → 走 `internal/config` 校验。

**工程后果**：写错会**当场**失败（校验失败保留旧配置），不会静默生效。所以「写完先 `resolve-check`」比「改完重启看日志」快一个数量级，也避免把运行中的会话搞挂。

---

## 3. 方案

### 3.1 五条设计原则

| 原则 | 来自哪条机制事实 |
|---|---|
| **证据优先**：每个声明字段都要对应一条可复现的探测结果 | §2.8（模态/档位拿不到）、§2.7（格式不对就静默失效） |
| **保守声明**：窗口宁小勿大、`maxTokens` 故意写小、模态只加测过的 | §2.4（压力预算）、§2.6（本地硬拦） |
| **写前验证**：用 DSH 自己的两段加载路径预演，而不是「看起来对」 | §2.1（两段）、§2.9（热重载当场校验） |
| **可回滚**：任何写盘都有备份；失败自动回滚 | §2.9 |
| **单条失败不拖累全局**：strict 全或无的坑要用逐条隔离绕过 | §2.1（strict 一条坏全拒） |

### 3.2 数据流

```
                       ┌─────────────────────────────┐
  第三方端点 ──真实请求──▶│ probe-capabilities.mjs      │
                       │  /models→chat→输出上限→      │
                       │  思考开关→视觉→流式→(窗口)   │
                       └──────────┬──────────────────┘
                                  │ probe.json / --yaml 片段
                                  ▼
                       ┌─────────────────────────────┐
                       │ lib/snippet.mjs             │   ← 「没证据就不写」规则
                       │  证据→YAML 片段（保守）      │
                       └──────────┬──────────────────┘
                                  ▼
                       ┌─────────────────────────────┐
                       │ resolve-check.mjs           │   ← 预演：Config + resolveProfiles
                       │  --lint 逐条隔离  --budget   │
                       └──────────┬──────────────────┘
                          exit 0  │  通过
                                  ▼
                       ┌─────────────────────────────┐
                       │ inject-model / merge-routes │   ← 写入：备份→写→复验→回滚
                       │  托管块 + 缩进探测           │
                       └──────────┬──────────────────┘
                                  ▼
                       ┌─────────────────────────────┐
                       │ probe-matrix.mjs            │   ← 跨版本复验（可选，给要分享的配置用）
                       └─────────────────────────────┘
```

### 3.3 六个脚本（逐个规格）

共同约定：**零第三方依赖**；不启动 DSH；除 `probe-*` 外不联网；写下文件的脚本都会先备份。

| 脚本 | 作用 | 关键参数 | 退出码 | 花钱 |
|---|---|---|---|---|
| `probe-capabilities.mjs` | 探测端点能力，输出 JSON / YAML 片段 | `--base` `--model`（必填）、`--key`/`--key-env`/`--key-file` 三选一、`--yaml` `--json` `--window` `--out DIR` | 0 成功；1 关键步骤失败；2 用法错误 | 默认 <1k token；`--window` 会发几十万 token 输入 |
| `resolve-check.mjs` | 用真实两段加载路径预演一份 YAML | `--patch`（可重复，默认 `examples/cordis.patch.yml`，可用 `DSH_HOME_PROFILE_PATCH` 覆盖）、`--plugin-root`、`--lint`、`--budget`、`--json`、`--quiet` | 0 全通过；1 有路由失败/审计报错；2 用法或找不到插件 | 不花钱 |
| `context-budget.mjs` | 纯计算 threshold / retain / gap，反推 ctx 下界 | `--ctx` `--max`、`--headroom` `--retain-ratio` `--threshold-ratio` `--min-gap` `--json` | 0 安全；1 有硬失败/抖动风险；2 用法错误 | 不花钱 |
| `inject-model.mjs` | 把一条探测结果安全写进 patch 文件 | `--patch` `--route` `--probe`（必填）、`--plugin-root`、`--dry-run`、`--force`、`--assume-ctx`/`--assume-contextWindow`、`--max`、`--api`、`--api-key-env` | 0 写入成功或 dry-run 通过；1 校验失败/拒绝写入；2 用法错误 | 不花钱 |
| `merge-routes.mjs` | 批量导入路由，单条失败不拖累全局 | `--patch` `--from`（可重复，必填）、`--plugin`/`--plugin-root`、`--dry-run`、`--replace`、`--no-verify` | 0 有写入或已是最新；1 没有可写入条目/复验失败（已回滚）；2 用法错误 | 不花钱 |
| `probe-matrix.mjs` | 跨版本沙箱复验同一份 YAML | `--patch`、`--versions a,b`、`--work DIR`、`--dsh-root`、`--keep` | 0 全通过且一致；非 0 有版本失败 | 不花钱（只装 npm 包） |

**`probe-capabilities.mjs` 的七个探测项与判据（v0.3.0 全部重写）**：

| # | 探测 | 决定了 | 判据（v0.3.0） | 成本 |
|---|---|---|---|---|
| 1 | `GET /models` 是否含该模型 | 能否用目录路由 | 200 且 id 命中 | 免费 |
| 2 | 基础 chat | key / baseURL / 协议通不通 | 200 且 content 非空（空则加大 max_tokens 重试一次） | ~20 token |
| 3 | `max_tokens` **阶梯下探** | `maxTokens` 或网关输出上限 `gateMaxTokens` | 从 65536 起 65536→49152→32768→24576→16384→12288→8192→4096 逐档试，取**第一个 200** 的档位；全拒则标注「测不出」 | 每档 ~20 token |
| 4 | 思考 **双向**探测 | `reasoningEfforts` / `thinkingFormat` / 有没有 `off` 档 | 先测 baseline 判 `defaultOn`；默认开→试三种关法（`enable_thinking:false` / `thinking:{type:"disabled"}` / `reasoning_effort:"none"`），能归零才 `canDisable`；默认关→试三种开法，能出 reasoning 才 `canEnable`；`reasoning` 判据同时看 `usage.completion_tokens_details.reasoning_tokens`、`.reasoning===true`、`choices[0].message.reasoning_content` | 每次 ~30 token |
| 5 | **32×32 纯红 PNG** + 问颜色 | `input` 要不要加 `image` | **必须答出 red**（`/\bred\b|红/i`）；答 blue/绿/「看不到」或空都判 `vision=false`（模拟静默丢图） | ~20 token |
| 6 | 流式 SSE | UI 能否显示思考过程 | `delta` 里有没有 `reasoning_content` | ~30 token |
| 7 | 固定阶梯窗口探测（**默认关闭**） | `contextWindow` | 1M/2M/4M/8M 字符递进，取最大成功那次的 `prompt_tokens × 0.95`、向下取整到 4096 的倍数 → **安全下界**，不是精确阈值 | 几十万 token |

> v0.3.0 修的三处判据漏洞：旧版「输出上限」只发一次 `max_tokens=400000`（多数网关直接 400，测出来的是「不支持 400k」而不是上限）；旧版视觉判据 `200 && (有回答 || prompt_tokens>20)` 里「有回答」恒真（静默丢图的网关全放行）；旧版思考只测「怎么关」（默认关闭的模型会被误判成不可调）。

### 3.4 七个共享库

| 库 | 导出 | 职责 |
|---|---|---|
| `lib/schema-keys.mjs` | `ROUTE_KEYS` `MODEL_KEYS` `ROUTE_ONLY_MODEL_KEYS` `COMPAT_KEYS` `THINKING_FORMATS` `MODALITIES` `THINKING_LEVELS` | 与源码对齐的权威字段清单（测试组 3 会拿源码比对，源码变了就红）。v0.3.0 补上漏掉的 `thinkingBudgets`（源码 `index.js:1063`） |
| `lib/audit.mjs` | `staticAudit(providers) → {level,code,msg}[]` | 不启动 DSH 的静态审计；v0.3.0 新增 3 条「两层都放行但序列化失效」：`thinking-format-without-efforts`、`thinking-budget-without-map`、`qwen-levels-may-collapse` |
| `lib/compaction.mjs` | `computeBudget` `reservedCompletionTokensOf` `compactionConfigFromPatch` `policyForRoute` `pickSafeMaxTokens` `minContextWindowFor` `MAX_TOKENS_LADDER` | **压缩公式的唯一副本**（照 `resolveCompactSpec` 抄），被 context-budget、load-path 第 3 段、snippet 三处复用 |
| `lib/load-path.mjs` | `verifyLoadPath(pluginRoot, providers, mode, options) → {schema, semantic, budget, routes}` | 把插件入口复制成**临时目录里的探针**（不写进 node_modules），补 `export { resolveProfiles }`，跑**三段**：Config → resolveProfiles → 压缩预算 |
| `lib/fs-safe.mjs` | `resolveWriteTarget` `atomicWriteFile` `backupFile` `rollbackFrom` | realpath 跟随软链、同目录临时文件 + 校验 + `rename` 原子替换、带时间戳备份与回滚 |
| `lib/yaml-edit.mjs` | `locateProviders` `removeRouteBlock` `renderRouteYaml` `renderManagedBlock` `findManagedBlock` | 保留注释与格式地增删 providers 条目；缩进从目标文件探测 |
| `lib/snippet.mjs` | `buildSnippet(...) → {yaml, chosenMaxTokens, budget, notes}` | 证据 → YAML 片段的唯一出口；`maxTokens` 由 `pickSafeMaxTokens` 反推，不再硬编码 65536 |

### 3.5 声明决策表（写什么、为什么）

| YAML 字段 | 证据从哪来 | 写错的后果 | 本方案的规则 |
|---|---|---|---|
| `contextWindow` | 真实窗口测试（`--window`）或厂商文档 | 写大 → 压缩不触发，靠 400 兜底；写小 → 提前压缩 | 填**实测**值；没测就写 200000 占位并加警告注释（**不写 1e6**） |
| `maxTokens` | `max_tokens` **阶梯下探**得到的 `gateMaxTokens` | 写太大 → `pressure<=0` 启动失败、或网关 400；写小 → 单次回复短 | 取 `min(gateMaxTokens, floor(ctx×0.2))` 并在阶梯里选第一个满足 `gap>=30000` 的值（由 `pickSafeMaxTokens` 反推；ctx=131072 时结果是 16384，不是 65536） |
| `input` | 32×32 纯红 PNG + 问颜色（必须答 red） | 少写 `image` → 本地硬拦；多写 → 上游 400 | 只加**测过**的模态；默认 `[text]` |
| `reasoningEfforts` | 双向探测（默认开→测关；默认关→测开） | 不写 → 选择器没档位；写错 → 无效；给纯推理模型写 `off` → 用户点了没用/被拒 | 只声明**实测可复现**的档位；`off` **只在实测能关掉思考时写**；没有证据就 `reasoningEfforts: false` |
| `compat.thinkingFormat` | 同上（哪个写法真能归零） | 写错 → 静默失效 | **只有探测到才写**；探测不到**整块 `compat` 都不写** |
| `defaultInput` / `defaultMaxTokens` | —（路由级兜底） | 不写 → 落 1e6 / 128000 | 建议显式写 `[text]` / `65536` |
| 路由名 | — | 用目录已有 id 会继承目录属性（可能跨协议污染）；未命中则等价手写路由 | 走 OpenAI 兼容反代时统一新建 `custom-*` |

### 3.6 片段生成规则（修过四个真 bug）

旧版把 YAML 模板内联在 `probe-capabilities.mjs` 里，产出的片段有四个真问题（前两个由「照文档真敲」审计发现，后两个由外部评审指出）：

1. 探测不到思考开关时，旧版输出 `thinkingFormat: null` → 真实解析报 `sets compat "thinkingFormat" with no value`，**整份配置被拒**；
2. 没测窗口时，旧版输出 `contextWindow: 1000000` → 正是本方案反对的「抄兜底值」；
3. `maxTokens` 硬编码 65536 → 在 `ctx=131072` 下 `pressure=0`，**启动即抛**；
4. `reasoningEfforts` 硬编码 `off/low/high` → 遇到关不掉思考的模型会写一个无效的 `off` 档。

现在的规则（集中在 `lib/snippet.mjs`，返回 `{yaml, chosenMaxTokens, budget, notes}`）：

- **没有思考证据 → 完全不写 `compat` 块**；
- **没测窗口 → 写 `200000` + `# ⚠ contextWindow 没测…保守占位` 注释**；
- **`maxTokens` 由预算反推**：`≤ min(gateMaxTokens, floor(ctx×0.2))`，且必须 `gap>=30000`；ctx=131072 时自动落到 **16384**（budget 输出 `pressure=49152 retain=18350 gap=30802`）；
- **`off` 档只在 `canDisable` 时写**；纯推理模型只写 `high: "high"`；多档只在两个方向都测出差异时给；
- **`notes[]` 把「为什么这么写」一并打出来**（例如「网关实测上限 65536，但按 ctx×0.2 与压缩预算只推荐 16384」）。

实测（**【实测】**，测试组 9 + mock 组 11）：

```
无证据片段：ctx=200000 max=32768 input=[text]           reasoningEfforts: false   gap=74939
有证据片段：ctx=400000 max=65536 input=[text,image]      off/low/high  qwen       gap=215414
ctx=131072：maxTokens 自动从 65536 下调到 16384（65536 会 pressure=0）
纯推理：只写 high: "high"，不写 off
```

### 3.7 安全写入模型

`inject-model.mjs` 与 `merge-routes.mjs` 共用同一套写盘纪律：

1. **写前隔离预演**：先在临时目录里对「将要写入的内容」跑三段校验（Config → resolveProfiles → 压缩预算）；不过就不写（`inject-model` 可用 `--force` 绕过，`merge-routes` 不行）。
2. **最小文本插入**：保留原文件注释与格式，只插/删必要行；**缩进从目标文件探测**（`locateProviders`），不假设 2 空格或 6 空格。
3. **托管块**：`merge-routes` 只改自己维护的区间（`# >>> managed-by-dsh-model-compat` … `# <<< managed-by-dsh-model-compat`），块外手写路由**永不改动**；标记只认「行首 + 全行匹配」，避免文件头部注释里提到标记就误判。
4. **备份**：`<file>.bak-<UTC 时间戳>`（`merge-routes` 额外带 `-<毫秒>`），同一时间戳冲突自动加 `-1`、`-2`。
5. **写后复验 + 回滚**：写盘 → 重新解析 → 校验托管块内路由；失败则从备份恢复并 exit 1。
6. **拒绝破坏性操作**：源与目标同一文件、多个 `- id: llm-pi-ai` 条目、目标文件读不到/是目录、**源文件全坏**（此时重渲染会把托管块清空 → 静默删掉线上路由）——统统拒绝并说明原因，exit 1，不改文件。
7. **探针不写进 node_modules（v0.3.0）**：探针改成 `mkdtempSync(tmpdir())` 下的独立包（`index.mjs` + `package.json{"type":"module"}` + 软链 `node_modules`），只读安装目录也能用，并发不再互删；`SIGINT/SIGTERM/SIGHUP/exit` 都清理（`SIGKILL` 无法捕获）。
8. **原子写（v0.3.0）**：先写同目录隐藏临时文件 `.<name>.tmp-<pid>-<ts>` → 可选 `check()` 校验（`YAML.parse` + `providers` 还在）→ `renameSync` 原子替换。这样即使被 `dsh-hmr` 监听（`dsh-hmr/lib/index.js:850`），也不会读到半截文件。
9. **软链（v0.3.0）**：写之前 `realpathSync` 解析；如果目标是指向别处的软链，写真实文件并保留软链，不会把软链替换成普通文件。
10. **第 3 段预算校验（v0.3.0）**：`inject-model` / `merge-routes` / `resolve-check` 写前都会跑 `computeBudget`，不过就拒绝（`inject-model` 可用 `--force` 绕过，`merge-routes` 无绕过）。

### 3.8 跨版本矩阵

`probe-matrix.mjs` 在 `/tmp` 给每个目标版本搭隔离沙箱：安装该版本 `dsh-llm-pi-ai` + 匹配的 `pi-ai`，其余 `@deepseek-ai/*` 从本机 DSH 安装目录 `symlink`，再跑 `resolveProfiles`。

- 默认 5 个版本：`0.0.1-rc.5` / `0.1.5-rc.3` / `0.1.7-rc.2` / `0.2.1-rc.5` / `0.2.2-rc.1`；
- 比对的是**可比的 4 个字段**：`contextWindow / maxTokens / input / reasoning`；`thinkingFormat`、`compat`、档位**不在比对范围**（原因见 `docs/portability.md`：老版本支持的格式集合更小，0.0.1-rc.5 只有 8/11）；
- 「完全一致」指这 4 个字段，不是整份解析结果逐字节相同。

---

## 4. 验证证据（全部可复现）

### 4.1 命令与结果

| # | 命令 | 结果 | 时间 |
|---|---|---|---|
| 1 | `npm test` | **47 pass / 0 fail / 0 skip**（9 个测试组） | 2026-11-09 |
| 2 | `npm run selfcheck` | exit 0（测试 + 示例预算 + 示例两段校验） | 2026-11-09 |
| 3 | `node scripts/resolve-check.mjs --patch /root/.dsh/profiles/web/cordis.patch.yml --lint --budget` | exit 0；5 条真实路由全 ✓，静态审计无问题，预算全绿（gap 444163 / 650486 / 554264 / 554264 / 522486） | 2026-11-09 |
| 4 | `node scripts/probe-matrix.mjs --patch …` | **5/5 版本 PASS**，4 字段一致 | 2026-11-09 |
| 5 | 红跑（旧代码 `cb11b4a` + 新测试） | 组 8 五条 **5/5 fail** | 2026-11-09 |

### 4.2 63 条测试的分组

| 组 | 条数 | 覆盖什么 |
|---|---|---|
| 1 | 8 | 真实两段加载路径（哪些坏值在哪一段被拒） |
| 2 | 12 | 静态审计的误报/漏报（审计挖出的 9 条漏报 + 6 条误报） |
| 3 | 1 | `schema-keys.mjs` 字段清单与源码对账（源码变了自动红） |
| 4 | 7 | `merge-routes` 的 6 个致命/P0 bug（A–F + 坏源文件隔离） |
| 5 | 3 | `context-budget --max 0`、`inject-model` 不硬塞格式/不用 1e6 兜底 |
| 6 | 3 | 自我合并拒绝、重名冲突、`--replace` |
| 7 | 4 | 「照文档敲就跑不转」的 4 个 CLI bug（G–J） |
| 8 | 5 | 第二轮对抗审计的静默破坏（缩进假设、重复条目、缺字段、兄弟路由、SIGTERM） |
| 9 | 7 | `--yaml` 片段生成（无证据 / 占位窗口 / maxTokens 反推 / 纯推理不写 off / 两形态过三段 / 旧模板反证） |
| 10 | 9 | v0.3.0：第 3 段压缩预算红绿、fs-safe 原子写与软链、`context-budget --patch`、3 条新审计规则、`thinkingBudgets` 不误报 |
| 11 | 4 | **mock 网关**：静默丢图→vision=false、真答红→vision=true、`max_tokens>16384` 全 400→gateMaxTokens 收敛、默认关思考→canEnable + qwen |

**测试原则**：每条都对应一个真实审计提出的 bug；修完必须同时有「旧代码红 / 新代码绿」的证据（红跑见 §4.1 #5），不是「跑通了就算」。

### 4.3 红跑证据（证明测试真的能抓到 bug）

```
$ cd /tmp/red8 && node --test --test-name-pattern="4 空格缩进|多个 - id|probe.json 缺 base|不吞掉块外兄弟路由|写进 4 空格缩进的文件" test/regress.test.mjs
✖ 4 空格缩进的目标文件：块外手写路由不被吞（cb11b4a 上会整条消失）
✖ 多个 - id: llm-pi-ai 条目 → 拒绝写入并说明原因（cb11b4a 上会静默写进不生效的那个）
✖ inject-model：probe.json 缺 base 时拒绝（cb11b4a 上会写 baseURL: undefined）
✖ --replace 覆盖同名路由时不吞掉块外兄弟路由
✖ inject-model 写进 4 空格缩进的文件：手写路由保留、缩进对齐
ℹ pass 0
ℹ fail 5
```

（`/tmp/red8` = `git archive cb11b4a` 的冻结副本 + 当前测试文件。这就是「先证明修复前会失败」的做法。）

### 4.4 真实 profile 的 5 条路由（本机）

```
✓ custom-111 / cn:deepseek-v4.1-flash              ctx=1000000 max=393216 input=[text]        reasoning=false
✓ custom-dashscope-aliyuncs / deepseek-v4.1-flash-1017  ctx=1000000 max=65536  input=[text,image] reasoning=true levels=low/high format=qwen
✓ custom-modelscope-1 / deepseek-ai/DeepSeek-V4.1-Flash-1017  ctx=1000000 max=262144 input=[text,image] reasoning=true levels=minimal/low/medium/high/xhigh/max format=deepseek
✓ custom-modelscope-2 / deepseek-ai/DeepSeek-V4.1-Flash-1017  （同上）
✓ custom-apizn / gpt-6.1-sol                       ctx=800000  max=65536  input=[text,image] reasoning=true levels=low/high
静态审计：未发现 strict 放行的问题写法。
压缩联动（headroom=65536）：
  ✓ custom-111: threshold=541248 retain=97085 gap=444163
  ✓ custom-dashscope-aliyuncs: threshold=800000 retain=149514 gap=650486
  ✓ custom-modelscope-1/2: threshold=672320 retain=118056 gap=554264
  ✓ custom-apizn: threshold=640000 retain=117514 gap=522486
```

**关于「4 条 ctx=1000000 为什么能过 lint」**（评审 Q&A 里问的）：它们过的是**结构性检查**——三段校验只证明「按你声明的数字算，配置能被加载、压缩不会自相矛盾」，不证明 `1000000` 是这家端点的真实窗口。这四条里的 `1000000` 是**显式写死的**（不是落默认值，所以审计不会报 `default-context-window`），但它们**没有跑过 `--window` 实测**，属于【未验】。真要坐实，得对每个端点跑一次 `probe-capabilities --window`。这也是本方案「声明必须由证据支撑」的自我打脸之处：**本机这份 profile 里就有 4 条未经证据的声明**。

### 4.5 跨版本（**【实测】** 2026-11-09）

```
5/5 个版本通过
✓ 所有通过的版本解析结果完全一致（4 个可比字段）

版本          配置  thinkingFormat 枚举                 bogus  Qwen  模态         unknown(route/model/compat)
0.0.1-rc.5    ✓    8/11 …                            ✗      ✗     text,image   ✓/✓/✓
0.1.5-rc.3    ✓    11/11 …                           ✗      ✗     text,image   ✓/✓/✓
0.1.7-rc.2    ✓    11/11 …                           ✗      ✗     text,image   ✓/✓/✓
0.2.1-rc.5    ✓    11/11 …                           ✗      ✗     text,image   ✓/✓/✓
0.2.2-rc.1    ✓    11/11 …                           ✗      ✗     text,image   ✓/✓/✓
```

（`bogus` ✗ = 非法 `thinkingFormat` 被拒；`Qwen` ✗ = 大小写不对被拒；`unknown` 列 = 未知字段被静默接受——这是 DSH 的真实行为，所以本方案用静态审计补这一层。）

### 4.6 报错文案对照表（写文档/写测试都依赖这些原文）

| 场景 | 真实报错（节选） | 层 |
|---|---|---|
| `compat: { thinkingFormat: null }` | `sets compat "thinkingFormat" with no value; give it one, or remove the key` | 语义 |
| 路由级 compat 未知键 | `route sets compat "nope", which no wire protocol declares` | 语义 |
| 模型级 compat 协议不吃 | `model "m" sets compat "…", but its api is "…", which does not take it` | 语义 |
| 路由级 compat 无人接 | `sets compat "…", but no model on the route speaks a protocol that takes it` | 语义 |
| `input: "image"`（字符串） | `$.providers.r.models[0].input expected array but got image` | 结构 |
| `reasoningEfforts: null` | `has an empty reasoningEfforts; declare the offered levels` | 语义 |
| `maxTokens >= ctx` | `reserves … completion tokens of its … context window, leaving no message budget`（`TargetPressureConfigError`） | 压缩 |
| `maxTokens + headroom >= ctx` | `… leaving no pressure budget; reduce the effective request maxTokens or compaction headroomTokens`（`TargetPressureConfigError`） | 压缩 |
| 含图但模型不支持 | `pi-ai model "m" does not support image input`（`UNSUPPORTED_CONTENT`） | 本地硬拦 |

---

## 5. 已知边界与不精确之处（请重点评审这一节）

诚实清单，按「影响程度」排序：

1. **窗口探测不是精确值**：固定阶梯（1M/2M/4M/8M 字符）+ `prompt_tokens × 0.95` 取整到 4096 的倍数，得到的是**安全下界**。真实阈值可能更高，也可能因输入内容（中文/代码）而不同。
2. **模态与思考档位无法自动证明**：只能靠真实请求的**行为差异**判断。v0.3.0 把判据收紧到「必须答出红色」「必须出现 reasoning 信号」，并用 mock 网关覆盖了「静默丢图」「默认关思考」两种坏网关（组 11）；但真实网关的怪行为（例如图像被压缩到模糊、reasoning 只偶尔出现）仍可能误判。
3. **预算检查是算术，不是真值**：`resolve-check --budget` 只能保证「按你声明的数字算，压缩不会自相矛盾」，**不能**保证「你声明的数字是真的」。数字造假时它会一路 ✓（示例：`ctx=1e6 max=128000` → threshold 800000 / gap 660480，全绿——但真实窗口 128k 时这套声明是错的）。
4. **`SIGKILL` 时临时探针目录可能残留（v0.3.0 起位置变了）**：探针不再写进 `node_modules`，而是在系统临时目录下（`dsh-loadpath-*`）；`SIGKILL` 无法捕获，残留的只是临时目录，不影响 DSH 安装。
5. **`--replace` 删除旧条目时，紧邻的注释会留在原地**（不破坏 YAML，但不整洁）。
6. **跨版本沙箱是「近似环境」**：它把目标版本的插件 + 匹配的 `pi-ai` 装进 `/tmp`，其余 `@deepseek-ai/*` 用本机版本的 symlink。所以它验证的是「插件版本差异」，不是「整套 DSH 版本差异」。
7. **未覆盖**：`cost` / `promptCache` / `modelOverrides` 的自动生成、工具调用能力、图片细节等级、`headers` / `retryPolicy` 的推荐值——这些目前仍是手写。
8. **平台**：只在 Linux（Android proot / aarch64）验证；macOS / Windows 的路径分隔符与权限差异未测（脚本用的是 `node:path`，理论上没问题，但**未验**）。
9. **`--window` 会真的花钱**：默认关闭，文档里也标了成本；本仓库所有实测都没跑过它（**未验**真实端点上的表现）。
10. **同一厂商的「思考」语义可能不同**：`enable_thinking` / `thinking.type` / `reasoning_effort` 三种写法在不同网关下含义不同（例如有的 `reasoning_effort` 只影响「思考预算」不影响开关）。探测只能证明「这个写法在这家端点上改变了行为」，不能证明「厂商文档说的是同一件事」。
11. **`dsh --profile web --dump-config` 不做校验**：它是打印配置，不是校验入口（**【实测】** 塞 `compat.thinkingFormat: bogus` + `contextWindow: "not-a-number"` 仍 exit 0）。所以别拿它当验证手段——用 `resolve-check`。

---

## 6. 复现步骤

### 6.1 最小复现（不花钱，不需要网络）

```bash
git clone https://github.com/shiodomemiuna111/dsh-model-compat && cd dsh-model-compat
npm test                                   # 63 条回归
npm run selfcheck                          # 测试 + 示例配置两段校验 + 预算
node scripts/context-budget.mjs --ctx 131072 --max 128000   # 看「为什么会失败」
```

### 6.2 验证你自己的 YAML

```bash
node scripts/resolve-check.mjs --patch path/to/your-cordis.patch.yml \
  --plugin-root /opt/dsh/node_modules --lint --budget
```

`--plugin-root` 可以写 DSH 安装根（含 `node_modules`）、也可以直接写包目录；不写时脚本会从 cwd 向上找，最后兜底试 `/opt/dsh/node_modules`、`/usr/local/lib/node_modules`、`/usr/lib/node_modules`。

### 6.3 验证本文里引用的解析器行为

```bash
node --input-type=module -e '
import { verifyLoadPath } from "./lib/load-path.mjs";
const providers = { r: { api: "openai-completions", baseURL: "https://x.invalid/v1",
  models: [{ id: "m", contextWindow: 1000, maxTokens: 100, compat: { thinkingFormat: null } }] } };
const r = await verifyLoadPath("/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai", providers);
console.log("schema:", r.schema.ok ? "PASS" : r.schema.error);
console.log("semantic:", r.semantic.ok ? "PASS" : r.semantic.error);
'
```

### 6.4 探测一个真实端点（会花很少的钱）

```bash
node scripts/probe-capabilities.mjs --base https://your-gateway/v1 \
  --model your-model --key-env YOUR_KEY_ENV --yaml
```

### 6.5 跨版本

```bash
node scripts/probe-matrix.mjs --patch examples/cordis.patch.yml
```

---

## 7. 给评审 AI 的 8 个问题

请按「能否证伪」来回答，尽量给出文件/行号或命令，而不是印象：

1. **§2.1 两段加载的结论是否准确？** 有没有第三段校验（例如 `assertServiceable` 的路径）被我漏掉？`deferred` 与 `strict` 在启动/写入两个入口的用法是否如我所述？
2. **§2.4 压缩公式与三类硬失败是否有遗漏？** 尤其是 `retainTokens` 显式配置时（`policy.retainTokens !== void 0`）公式的变化、以及 `modelPolicies` per-target 覆盖的实际生效路径。
3. **§2.3 路由级 compat 的「静默跳过」是否只在 gate 不允许时发生？** 有没有可能「字段合法、gate 允许、但序列化时又被丢掉」的第三种失败模式？
4. **§3.5 的保守取值（`maxTokens` 32768~65536、`contextWindow` 填实测值）** 在大窗口（≥1M）模型上是否会带来不可接受的提前压缩？有没有更优的 headroom/thresholdRatio 组合？
5. **§3.6 的「没证据就不写 compat」是否过于保守？** 有没有「不写 compat 就一定错」的协议（例如某些网关必须显式 `enable_thinking` 才开思考）？
6. **§3.7 的写盘纪律** 还有哪些破坏场景没覆盖？（我已知：SIGKILL 残留、`--replace` 注释残留、并发两个进程同时写同一文件未加锁。）
7. **§4 的证据强度**：63 条测试 + 5 个版本矩阵，够不够支撑「方案可用」？还缺哪一类测试（例如真实 DSH 启动后的端到端会话测试——我目前只做到「不启动 DSH 的等价校验」）？
8. **§5 的边界**里，哪一条在你看来是「必须修才能交付」，哪一条可以接受为已知限制？

---

## 附录 A：字段与枚举清单（来自源码，测试组 3 会持续对账）

- **路由级字段**（`profile` schema，`lib/index.js:1049-1083`）：`displayName` `api` `baseURL` `apiKeyEnv` `models` `modelOverrides` `compat` `defaultInput` `defaultContextWindow` `defaultMaxTokens` `headers` `reasoning` `thinkingBudgets`（`{minimal,low,medium,high}` 数字）`cacheRetention`（`none|short|long`）`transport`（`sse|websocket|websocket-cached|auto`）`timeoutMs` `websocketConnectTimeoutMs` `streamIdleTimeoutMs` `maxRequestImageBytes` `maxRequestImages` `imageOffloadCountQuantum` `requestImagePixelBudget` `requestImageMaxBytes` `retryPolicy`
- **模型级字段**：`id` `name` `contextWindow` `maxTokens` `input` `reasoningEfforts` `compat`
- **只在路由层生效、写进模型层会被静默丢弃**：`api` `baseURL` `provider` `apiKeyEnv` `displayName`
- **思考档位**：`off` `minimal` `low` `medium` `high` `xhigh` `max`（7 个，`index.js:299`）
- **思考格式**：`openai` `deepseek` `openrouter` `together` `baseten` `zai` `qwen` `chat-template` `qwen-chat-template` `string-thinking` `ant-ling`（11 个，`index.js:309`）
- **模态**：`text` `image`（2 个，`index.js:282`）
- **协议**：`openai-completions` `openai-responses` `anthropic-messages`（手写路由只认这 3 个，`index.js:835`）

## 附录 B：退出码汇总

| 脚本 | 0 | 1 | 2 |
|---|---|---|---|
| `probe-capabilities` | 成功 | 关键步骤失败（输出上限被拒等） | 用法错误 |
| `resolve-check` | 全部通过 | 有路由解析失败 / 审计有 error | 用法错误 / 找不到插件 |
| `context-budget` | 安全 | 有硬失败或 gap 太小 | 参数错误 |
| `inject-model` | 写入成功或 dry-run 通过 | 校验失败 / 拒绝写入 | 用法错误 |
| `merge-routes` | 有写入或已最新 | 没有可写入条目 / 复验失败（已回滚） | 用法错误 |
| `probe-matrix` | 全通过且一致 | 有版本失败 | 用法错误 |

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| 两段加载 | `Config()` 结构校验 + `resolveProfiles()` 语义校验，缺一不可 |
| \(B\) / messageBudget | `contextWindow - maxTokens`，可供消息使用的 token 数 |
| pressure | `B - headroomTokens`，必须 > 0，否则启动抛错 |
| threshold | 触发压缩的 token 数 = `floor(min(0.8·ctx, pressure))` |
| retain | 压缩后保留的尾部 token 数 = `floor(B · 0.16)` |
| gap | `threshold - retain`，本方案建议 ≥ 30000（防抖动） |
| 托管块 | `# >>> managed-by-dsh-model-compat` … `# <<<` 之间，脚本只改这里 |
| 红跑 | 先在旧代码上跑新测试，确认它**失败**，再在修复后的代码上跑绿 |
| 目录路由 | 不写 `api`/`baseURL`，直接用 `@earendil-works/pi-ai` 内置目录里的厂商与模型 |
| 手写路由 | 自己写 `api`/`baseURL`/`models`，目录信息可选叠加 |