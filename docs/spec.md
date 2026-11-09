# 第三方模型能力声明方案 · 规格书

**版本**：0.4.3 ｜ **代码提交**：`HASHX`（仓库 `master` 持续更新，本文以该提交为准） ｜ **仓库**：<https://github.com/shiodomemiuna111/dsh-model-compat> ｜ **许可证**：MIT

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

### 0.0 本轮修订（v0.4.2）——第五轮三份审计后的修正

第五轮把 v0.4.1（`5da81c5` → `e386583`）冻结成 `/tmp/audit-v041`，三名审计员分别做**对抗破坏**（audit-breaker）、**照文档敲 + 核数字**（audit-docs）、**机制正确性核验**（audit-fix-verify）。结论：**1 个 P0、6 个 P1、10 个 P2/P3 成立**，本轮全部处理：

| 审计项 | 结论 | v0.4.2 处理 |
|---|---|---|
| **P0** 探针自己证明「开不了思考」，片段却仍写 `reasoningEfforts {off, high}`；strict 网关每次请求 400 | **成立**（本地 strict mock + 真 pi-ai wire 复现） | 根因是 `canDisable` 在「默认关」时恒为 true。改为「默认关时必须证明**开得起来**，off 档才有意义」；无任何开关证据 → `reasoningEfforts: false`、不写 compat。补组 24 用例锁死 |
| **P1** `repair` 对 BOM 文件恒报「被另一个进程改过（并发写）」 | **成立**（`rawFingerprint` 是死变量） | 写前 `assertUnchanged` 改用**原始字节**指纹（`rawText` 已剥 BOM）；组 24 用真 BOM 文件跑 `--apply` |
| **P1** verify-effective 把 429 TPM 的 `too many tokens` 当「窗口比声明小」的铁证 | **成立** | 分类改为「先排除限流/额度」，且铁证只认**错误文本里服务端自报的窗口数值**（`parseStatedContextLimit`）；自报值 ≥ 声明值 → warning（「多半是这轮请求本身超了」） |
| **P1** 窗口失败分类漏判 DashScope/iFlytek 等 11 种真实措辞 | **成立**（真实会话 2 次被判 unknown） | `lib/probe-heuristics.mjs` 按 pi-ai `overflow.js` 的 27 条重写 `WINDOW_PATTERNS`，并加 `NON_OVERFLOW_PATTERNS` 先判；窗口探测遇 `context-overflow` 时**优先采用服务端自报上限** |
| **P1** 档位判据对无因果网关误判 ~10.8%（每档 2 次 + 2 倍规则） | **成立**（200k 次模拟） | 每档 **3 次交错采样** + **区间分离判据**：`min(high) ≥ max(low) × 1.5` 且绝对差 ≥ max(8, 10%)；组 24 用「按调用顺序变长」的假网关验证不误判 |
| **P1/P2** 中文超限原文被静默丢弃 → 报「没有发现不一致」（false green） | **成立** | 补中文超限正则；**认不出的失败**一律作为 `[unknown]` warning 并附原文，不再吞掉 |
| **P2** 孤儿模型误报：合法 `models: []`（回落目录模型）与 `modelOverrides` 被当成孤儿 | **成立** | 目录模型单列「目录模型（未逐个核对）」不判孤儿；`modelOverrides` 的键计入已声明集合 |
| **P3** `--all-models` 文档说「配合 --route」，实际裸用扫掉所有匹配路由的模型 | **成立** | 强制要求同时给 `--route`（否则 exit 2）；`--help` 同步 |
| §4.4 真实 profile 输出格式与计数（101/22、`请求=2444`）过时 | **成立** | 全部换成 2026-11-09 实测输出（107 条 / 24 组、`请求=2832`、及其 1 条静态审计警告） |

一句话：**第五轮没有推翻方案的机制假设，推翻的是「工具在边界输入上很诚实」这个印象**——P0 属于「工具说全绿，运行必 400」。测试 102 → **107 条（24 组，0 skip）**。

---

### 0.0a 上一轮修订（v0.4.0）——第四轮外部评审后的修正

第四轮评审提出「4 个逻辑漏洞 + 4 处文档自相矛盾」。逐条核验结果：

| 评审意见 | 核验 | v0.4.0 处理 |
|---|---|---|
| ①`request/context.contextWindow` 不等于网关物理窗口，只能证明「本地声明没生效」 | **成立**（该字段是 DSH 本地记录值） | 判据改写为「运行时记录≠当前声明 → HMR 未生效/多层覆盖」；另加真正的证伪条件：**出现 context-overflow 且当时最大单轮输入 < 声明窗口** 才判「实际窗口比声明小」 |
| ②单轮 `inputTokens ≥ threshold` 判矛盾会误报长对话 | **成立**（压缩在下一轮才触发） | 降级为 warning；只有 ≥ `messageBudget`（B = ctx − maxTokens，本该被拒）才判 issue |
| ③挂起的图片在本地硬拦/换模型时会串到别的模型 | **成立** | 图片一律先挂起，由紧接着的 request/assistant 归属；模型切换、`assistant/attempt` 出错时**清空**挂起队列 |
| ④qwen 网关（百炼兼容模式）可能静默忽略 `reasoning_effort`，low/high 仍等价 | **部分成立**（本地无法证明服务端行为；本机 profile 其实显式写了 `supportsReasoningEffort: true`，所以旧审计规则没触发） | 新增审计规则 `qwen-effort-may-be-ignored`（warn，说明需实测）+ `thinking-no-off-level`（多档但无 off）；probe 改为「各档采样 2 次取中位数、high ≥ 2×low 且差 ≥16 才算支持档位」 |
| ⑤`repair --apply` 重渲染会抹掉 headers / retryPolicy / timeoutMs / thinkingBudgets | **不成立**（`renderRouteYaml` 是对整个路由对象做 YAML.stringify，未知字段天然保留） | 实测复现：`headers/retryPolicy/timeoutMs/thinkingBudgets/transport/displayName` 全部原样保留；已补组 22 回归测试锁死这个行为 |
| ⑥窗口探测把 413/429/超时当成窗口边界 | **成立** | 抽出 `lib/probe-heuristics.mjs::classifyWindowStop`：只有 `context-overflow` 才算撞墙；`gateway-limit` 只报「网关限制，无法判定窗口」，并给出「至少这么大」的下界说明 |

文档侧同时改掉 4 处自相矛盾：§2.4 的 `headroomTokens` 硬失败表述、§2.7/§3.5 残留的「必须能把 reasoning 归零」旧文案、§3.5 建议 `defaultMaxTokens: 65536`、附录 B 的 probe/repair 退出码。测试 95 → 101 条（22 组）→ 102 条（23 组）→ **107 条（24 组，v0.4.2）**。

---

### 0.0b 上一轮修订（v0.3.9）——第三轮审计后的修正

第三轮三份审计（`audit-breaker-v37` 破坏实验、`audit-docs-v37` 照文档敲、`audit-fix-verify` 机制核验，对象都是冻结副本 `/tmp/audit-v038`）共提出 1 个 P0、4 个 P1、十余条 P2/P3。逐条落地：

| 审计项 | 旧版实际行为 | v0.3.9 |
|---|---|---|
| **P0** compaction 配置不合插件加载规则 | 所有工具仍打 ✓（连 `--apply` 也写进去），DSH 启动才抛 | 新增 `validateCompactionConfig()`，7 处工具入口先拒、一个字节不写 |
| **P1** repair 多路由 | 用 stale 行数组重建，只真改 1 条，却报「已修正 3 个模型」 | 同一数组降序替换 + 断言行数，三条全改 |
| **P1** repair 遇 BOM | 指纹用剥 BOM 后的文本 → 恒判「被并发修改」，BOM 文件修不了 | 指纹对原始字节，BOM 只影响写出内容 |
| **P1** repair 空 probe | 凭空写 `maxTokens: 32768` | 没测到上限且模型原本没写 → 不新增该字段 |
| **P1** repair `--route` | 同路由下别的模型被套用同一份测量 | 只改探针那个模型，新增 `--all-models` 显式放开 |
| **P2** repair 写盘时序 | 先写盘再复验、失败回滚（瞬时不合法） | 写盘前整份预验，不通过不落盘 |
| **P2** 思考声明不一致 | repair 与 inject 对同一份 probe 写出不同结果 | 统一走 `thinkingFromProbe()` |
| **P2** verify-effective | 按 mtime 降序 → latest 被最老会话覆盖；图片挂在 `"?"` | 按时间升序；图片挂起到下一次 `request/*` 再归属 |
| **P3** context-budget | `--ctx 1.5` 出 `undefined` 且 exit 1；文档说 gap 小 exit 1 | 非整数 exit 2 并回显收到的值；gap 只警告，exit 0 |

此外修正了三处「机制不等价」：`thresholdRatio` 越界、`headroomTokens:0` 配显式 `maxTokens`、显式 `retainTokens` 时豁免比例比较。测试 87 → **95 条（21 组）**，新增组 21 五条，每条都有旧代码红 / 新代码绿的红跑证据。

---

### 0.0c 上一轮修订（v0.3.8）——三份对抗审计的结论与修正

这一版不是「又加功能」，而是**三个子代理对 v0.3.7 的对抗审计**（冻结副本 `git archive d14d19d` → `/tmp/audit-v037`，只读，破坏实验全在 `/tmp`）之后的修正。三份审计的关键结论：

| 审计 | 结论 | 我这一版的处理 |
|---|---|---|
| 机制正确性（`audit-fix-verify`） | 8 条 verdict 里 3 条「成立」、5 条「部分成立」 | **成立的照改**：wire 测试空跑、图证据链恒 0、压缩公式三处不等价；**不成立的写成反例**：见下 |
| 破坏实验（`audit-breaker-v37`） | 1 个 P0 + 5 个 P1 + 7 个 P2；「不能给外人用」 | 全部修完，每条都用审计给的复现命令回归验证（P0 的 `target/keep1/keep2` 现在保留） |
| 文档/照抄（`audit-docs-v37`） | 4 条硬伤（提交号、测试数、README 示例输出、参数表与 `--help` 不一致） | 逐条改；参数表改为「以 `--help` 为准」，并加测试组 19 双向对账 |

**被审计推翻、我不再坚持的说法**：

1. 「`lib/compaction.mjs` 是插件公式的唯一副本」→ 改成「语义对齐的独立实现」，并显式列出三处差异（§2.4）。
2. 「不写 `supportsReasoningEffort` 就不会发 `reasoning_effort`」→ 错：pi-ai 对未知 provider 默认 `true`，实测会发（§2.7 的 wire 表）。
3. 「4 条 wire 测试验证了序列化」→ 假：旧写法把跳过条件函数当成了测试体，4 条永远 ✔ 一行没跑。现在 95 条里 0 skip。
4. 「`verify-effective` 能证明发过图」→ 假：旧代码读 `data.message.content`，真实会话里图在 `data.content`，所以「发过图」恒 0（§5 第 17 条）。
5. 「`gap < 30000` 是会被 DSH 拒绝的错误」→ 错：那是工具的工程警告，插件的硬失败只有 `B<=0` / `pressure<=0` / `retain>=threshold` 等（§2.4）。

**审计指出但我保留的**：`repair --apply` 会整块重渲染（丢注释）——这是刻意的取舍，写进 §5 第 12/15 条，并给 `--dry-run` 做默认。

## 0. 一页纸摘要

DSH 的模型目录是静态的。你接一个目录里没有的第三方 OpenAI 兼容端点时，`contextWindow` / `maxTokens` / `input` 三个字段**不会**被自动探测，全部落到默认值（1,000,000 / 128,000 / `["text"]`）。于是出现三个症状：**上下文爆、看不见图、思考档位调不了**。这不是 DSH 的 bug，是**没声明**。

本方案不做「自动适配所有厂商」这种不可能的事，而是把这件事拆成一条可验证的流水线：

```
测（真实请求证明能力） → 验（用 DSH 自己的两段加载路径预演） → 写（隔离预演 + 备份 + 回滚）
                                                ↘ 跨版本复验（同一份 YAML 丢给 5 个历史版本）
```

产出是 8 个零依赖脚本 + 10 个共享库 + 一份可直接抄的声明模板 + 107 条回归测试（含 4 条真实 wire 断言，不再有「跳过也变绿」的空跑用例）。**核心主张只有一条：声明必须由证据支撑，而证据必须能复现。**

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

**【读码】** 内置目录确实很大但仍是静态的：`/opt/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/` 下 **42 个厂商文件**（`.manifest.json` 也算则是 43 个文件）、**1712 条模型条目**（按协议分布：openai-completions 695、anthropic-messages 412、bedrock-converse-stream 197、openai-responses 129、openrouter-images 64、typesafe-system-one 50、azure-openai-responses 44、mistral-conversations 34、google-generative-ai 32、pi-messages 28、google-vertex 13、openai-codex-responses 8、cloudflare-workers-ai-system-one 5、openai-decisions 1），其中 `reasoning: true` 1352 条、声明 `image` 模态 1263 条。**没有你那个聚合网关后面的具体模型，这些信息就无从谈起。**

### 1.3 为什么这不算 DSH 的 bug

- 自动探测**能**拿到的东西（窗口、输出上限）DSH 已经做了，见 §2.8；
- 自动探测**拿不到**的东西（模态、思考档位）任何实现都只能靠一次真实请求去证明——而这正是 `probe-capabilities.mjs` 干的事；
- 剩下的工作只是「把证据写进 YAML，并且写之前先验证」。这就是本仓库的全部内容。

---

## 2. 机制事实（方案设计依据）

以下每一条都是方案里某个决定的根据。**如果某条被推翻，对应设计就要改**，所以列在评审最前面。

### 2.1 真实加载：插件自身两段 + 跨插件压缩段（共三段）

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
B         = contextWindow - reservedCompletionTokens   // :758: maxTokens ?? defaultMaxTokens ?? 0
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

> **v0.4.0 澄清（评审指出的字面矛盾）**：插件 `:59-63` 的 `assertPositiveInteger` 校验的对象是
> **压缩摘要请求自己的输出上限** `maxTokens = config.maxTokens ?? headroomTokens`，不是 `headroomTokens` 本身。
> 所以：只写 `headroomTokens: 0` → 推导出 `maxTokens = 0` → 加载期抛错（硬失败）；
> 同时写 `headroomTokens: 0` + 正整数 `config.maxTokens` → **合法**（`headroomTokens` 是非负整数即可）。
> 工具侧对应两条：`hardFailures` 与测试组 20 的两个用例。

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

**v0.3.8 更正：工具判定与插件判定不是一回事。** 审计（audit-fix-verify）实测出三处不等价，已改成显式区分：

- **硬失败（`hardFailures`，DSH 真会抛）**：`B <= 0`、`pressure <= 0`、`retain >= threshold`；`headroomTokens` 不是**非负**整数，或压缩摘要上限 `compaction.maxTokens`（缺省 = `headroomTokens`）不是**正**整数（插件 `:59-63` 的 `assertPositiveInteger` 校验的是后者，所以 `headroomTokens: 0` 单独写会抛、配一个正整数 `maxTokens` 则合法）；`retainRatio >= thresholdRatio`（`validateRatioRetention`）。
- **工程警告（`warnings`，DSH 不检）**：`gap < 30000`。工具把它当「抖动风险」提示，但**不**判 `ok=false`——审计给的实测反例是 `ctx=100000 / max=20000 / headroom=65536`：工具旧版判红，而真实插件能正常启动。
- **保留量优先级**：`policy.retainTokens > policy.retainRatio > 全局 retainTokens/retainRatio`（照 `resolveTargetPolicy` `:94-111` + `resolveRetention` `:148-152`；`:153-157` 是 `validateRatioRetention`）。旧版让全局 `retainTokens` 盖掉 policy 的 `retainRatio`，审计实测出「工具绿 / 真插件抛 TargetPressureConfigError」。

**工程后果 2b（v0.3.1 修正）**：安全取值的下限不是「能加载」，而是「`gap >= 30000`」。但下界**不能**用 `B_min = 30000/0.84` 反推——`threshold = min(0.8·ctx, B − headroom)` 里那项 headroom 也要吃掉 gap。正确做法是数值求解（`lib/compaction.mjs` 的 `minContextWindowFor`）：实测 `maxTokens=4096` 时窗口要 **≥ 117829**、`16384` → **130117**、`65536` → **179269**（headroom=65536、minGap=30000）。v0.3.0 曾写成 `maxTokens + headroom + 35715`，漏了 headroom 进 gap，本版已改正。

**工程后果 3**：`headroomTokens` 是公开配置键（`:63` 读取，`:103` 支持 per-target 覆盖），不是硬编码常量。把 65536 调到 16384，可以让 64k 窗口的模型也能加载（反推公式：`contextWindow > maxTokens + headroomTokens`）。

### 2.5 溢出兜底存在，但不是设计目标

**【读码】** `dsh-compaction-basic/lib/index.js`：

- `:879` 监听 `agent/request-error`；
- 当错误码是 `CONTEXT_WINDOW_EXCEEDED` 且没被取消时，走 `:890` `compactIfNeeded(agent, "context-overflow")`；
- `:937-945` 这个分支用 `selectCompactableRange(agent.session, measurement, 0)`（`:940`）——**retain=0**（尽可能多压）；
- 成功则返回 `{ kind: "retry" }`，默认最多重试 `maxOverflowRetries = 1` 次（`:83`）。

另一方面，溢出判定还看用量是否超声明值，以及错误文本正则：`@deepseek-ai/dsh-llm/lib/index.js:177-179` 的 `isContextWindowExceededError`（**5 个分支**：`dsh-llm/lib/index.js:165` / `:167` / `:169` 三个错误码，加 `:177-179` 的两条正则；旧文档写「4 组正则」是错的）。

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

**v0.3.8 更正（真实 wire 实测，不再是推测）**：`reasoningEffort` 只要非空，`enable_thinking` 就是 `true`——**「不写 `supportsReasoningEffort`」不等于「不发 `reasoning_effort`」**。pi-ai 对未知 provider 的 `getCompat` 默认 `supportsReasoningEffort: true`（默认值来自 `detectCompat` `:1273`，`getCompat` 声明 `:1318`、覆盖 `:1325`），实测请求体：

| 声明 | low 档请求体 | high 档请求体 |
|---|---|---|
| `compat: {thinkingFormat: "qwen"}`（不写 supports） | `{"enable_thinking":true,"reasoning_effort":"low"}` | `{"enable_thinking":true,"reasoning_effort":"high"}` |
| `compat: {thinkingFormat:"qwen", supportsReasoningEffort:false}` | `{"enable_thinking":true}` | `{"enable_thinking":true}`（**两档逐字节相同**） |

所以本方案的 `thinkingDecl` 在「确认不支持档位」时**显式写 `supportsReasoningEffort: false`**；`off` 档在 DSH 里是先转成 `undefined` 再交给 pi-ai（`dsh-llm-pi-ai/lib/index.js:1791` `reasoning === "off" ? void 0 : reasoning`），只有 `undefined` 才会让 `!!reasoningEffort` 变 `false`。测试组 12 的 4 条 wire 用例直接 import pi-ai 的 `stream()` 打本地假 SSE 端点抓请求体（v0.3.8 修了「`skipIfNoPiAi` 写成函数 → 四条永远 ✔ 但一行没跑」的空跑 bug）。

**工程后果**：`thinkingFormat` 写错**不会自动纠正**，也不会报错——会变成「发了一个网关不认识/忽略的字段」，表现就是「思考调不了」。所以本方案要求：**只有探测到「哪个写法真的改变了思考」（双向探测：默认开测关、默认关测开；判据同时看 `usage.completion_tokens_details.reasoning_tokens`、`choices[0].message.reasoning_content`、`message.reasoning===true`）才写这个字段**（见 §3.3 #4 与 §3.5）。

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

### 3.3 八个脚本（逐个规格）

共同约定：**零第三方依赖**；不启动 DSH；除 `probe-*` 外不联网；写下文件的脚本都会先备份。

> **参数以 `node scripts/<x>.mjs --help` 为准**（v0.3.8）：8 个脚本的用法文本集中到 `lib/usage.mjs`，测试组 19 会拿「源码里真实解析的 `--flag`」与「usage 文本里的 flag」做**双向** diff——漏写、多写都会红。下表是摘要，不是权威清单。

| 脚本 | 作用 | 关键参数 | 退出码 | 花钱 |
|---|---|---|---|---|
| `probe-capabilities.mjs` | 探测端点能力，输出 JSON / YAML 片段 | `--base` `--model`（必填）、`--key`/`--key-env`/`--key-file` 三选一、`--yaml` `--json` `--window` `--out DIR` | 0 成功；1 关键探测失败（基础 chat 不通 / 窗口太小导致片段 fatal）；2 用法错误 | 默认 <1k token（v0.4.0 起再加 4 次档位采样）；`--window` 会发几十万 token 输入 |
| `resolve-check.mjs` | 用真实两段加载路径预演一份 YAML | `--patch`（可重复，默认 `examples/cordis.patch.yml`，可用 `DSH_HOME_PROFILE_PATCH` 覆盖）、`--plugin-root`、`--lint`、`--budget`、`--json`、`--quiet` | 0 全通过；1 有路由失败/审计报错；2 用法或找不到插件 | 不花钱 |
| `context-budget.mjs` | 纯计算 threshold / retain / gap，反推 ctx 下界 | `--ctx` `--max`、`--headroom` `--retain-ratio` `--threshold-ratio` `--min-gap` `--json` | 0 安全（gap 不足只打 ⚠ 警告，仍为 0）；1 有硬失败；2 用法错误 | 不花钱 |
| `inject-model.mjs` | 把一条探测结果安全写进 patch 文件 | `--patch` `--route` `--probe`（必填）、`--plugin-root`、`--dry-run`、`--force`、`--assume-ctx`/`--assume-contextWindow`、`--max`、`--api`、`--api-key-env` | 0 写入成功或 dry-run 通过；1 校验失败/拒绝写入；2 用法错误 | 不花钱 |
| `merge-routes.mjs` | 批量导入路由，单条失败不拖累全局 | `--patch` `--from`（可重复，必填）、`--plugin`/`--plugin-root`、`--dry-run`、`--replace`、`--no-verify` | 0 有写入或已是最新；1 没有可写入条目/复验失败（已回滚）；2 用法错误 | 不花钱 |
| `probe-matrix.mjs` | 跨版本沙箱复验同一份 YAML | `--patch`、`--versions a,b`、`--work DIR`、`--dsh-root`、`--keep` | 0 全通过且一致；非 0 有版本失败 | 不花钱（只装 npm 包） |
| `verify-effective.mjs` | **运行时对账**：读 DSH 会话记录，比对「声明 vs 实际」（v0.3.6） | `--patch`、`--sessions`、`--last N`、`--json`、`--log`/`--no-log`、`--verbose` | 0 无矛盾；1 有矛盾（矛盾≠警告） | 不花钱 |
| `repair.mjs` | **自动修正**：探针结果 → 重算字段 → 三方校验 → 备份 → 原子写 → 写后复验 → 失败回滚（v0.3.6） | `--patch` `--probe`（必填）、`--route`、`--apply`/`--dry-run`（默认 dry-run）、`--log`/`--no-log`、`--plugin-root`、`--json` | 0 无需修正或已修正；1 不可修正/写后校验失败已回滚；2 用法错误 | 不花钱 |

**`probe-capabilities.mjs` 的七个探测项与判据（v0.3.0 全部重写）**：

| # | 探测 | 决定了 | 判据（v0.3.0） | 成本 |
|---|---|---|---|---|
| 1 | `GET /models` 是否含该模型 | 能否用目录路由 | 200 且 id 命中 | 免费 |
| 2 | 基础 chat | key / baseURL / 协议通不通 | 200 且 content 非空（空则加大 max_tokens 重试一次） | ~20 token |
| 3 | `max_tokens` **阶梯下探** | `maxTokens` 或网关输出上限 `gateMaxTokens` | 从 65536 起 65536→49152→32768→24576→16384→12288→8192→4096 逐档试，取**第一个 200** 的档位；全拒则标注「测不出」 | 每档 ~20 token |
| 4 | 思考 **双向**探测 | `reasoningEfforts` / `thinkingFormat` / 有没有 `off` 档 | 先测 baseline 判 `defaultOn`；默认开→试三种关法（`enable_thinking:false` / `thinking:{type:"disabled"}` / `reasoning_effort:"none"`），能归零才 `canDisable`；默认关→试三种开法，能出 reasoning 才 `canEnable`；`reasoning` 判据同时看 `usage.completion_tokens_details.reasoning_tokens`、`.reasoning===true`、`choices[0].message.reasoning_content` | 每次 ~30 token |
| 5 | **32×32 纯红 PNG** + 问颜色 | `input` 要不要加 `image` | **必须答出 red**（`/\bred\b|红/i`）；答 blue/绿/「看不到」或空都判 `vision=false`（模拟静默丢图） | ~20 token |
| 6 | 流式 SSE | UI 能否显示思考过程 | `delta` 里有没有 `reasoning_content` | ~30 token |
| 7 | 固定阶梯窗口探测（**默认关闭**） | `contextWindow` | 1M/2M/4M/8M 字符递进，取最大成功那次的 `prompt_tokens × 0.95`、向下取整到 4096 的倍数 → **安全下界**，不是精确阈值。**只有 `context-overflow` 类错误才算撞墙**；413（反代 body 上限）/429（TPM 限流）/超时按 `lib/probe-heuristics.mjs::classifyWindowStop` 归为 `gateway-limit`，此时只报「至少这么大」并注明「不能据此认定窗口就这么小」 | 几十万 token |

> v0.3.0 修的三处判据漏洞：旧版「输出上限」只发一次 `max_tokens=400000`（多数网关直接 400，测出来的是「不支持 400k」而不是上限）；旧版视觉判据 `200 && (有回答 || prompt_tokens>20)` 里「有回答」恒真（静默丢图的网关全放行）；旧版思考只测「怎么关」（默认关闭的模型会被误判成不可调）。

### 3.4 十个共享库

| 库 | 导出 | 职责 |
|---|---|---|
| `lib/schema-keys.mjs` | `ROUTE_KEYS` `MODEL_KEYS` `ROUTE_ONLY_MODEL_KEYS` `COMPAT_KEYS` `THINKING_FORMATS` `MODALITIES` `THINKING_LEVELS` | 与源码对齐的权威字段清单（测试组 3 会拿源码比对，源码变了就红）。v0.3.0 补上漏掉的 `thinkingBudgets`（源码 `index.js:1063`） |
| `lib/audit.mjs` | `staticAudit(providers) → {level,code,msg}[]` | 不启动 DSH 的静态审计；v0.3.0 新增 3 条「两层都放行但序列化失效」：`thinking-format-without-efforts`、`thinking-budget-without-map`、`qwen-levels-may-collapse` |
| `lib/compaction.mjs` | `computeBudget` `validateCompactionConfig` `compactionConfigFromPatch` `policyForRoute` `pickSafeMaxTokens` `minContextWindowFor`（+`hardFailures`/`warnings`） | 工具的**压缩公式唯一实现**，被 context-budget、load-path 第 3 段、snippet、merge-routes、resolve-check、repair 六处复用。⚠ v0.3.8 更正：它与插件 `resolveCompactSpec` **语义对齐但不是逐字等价**——工具额外把「gap < 30000」当工程警告（`warnings`），插件不检；插件的 `config.maxTokens`（默认=headroomTokens，`:59-63`）与 `validateRatioRetention` 现已建模为**硬失败**（`hardFailures`），见 §2.4 |
| `lib/load-path.mjs` | `verifyLoadPath(pluginRoot, providers, mode, options) → {schema, semantic, budget, routes}` | 把插件入口复制成**临时目录里的探针**（不写进 node_modules），补 `export { resolveProfiles }`，跑**三段**：Config → resolveProfiles → 压缩预算 |
| `lib/fs-safe.mjs` | `resolveWriteTarget` `atomicWriteFile` `backupFile` `rollbackFrom` `contentFingerprint` `assertUnchanged` | realpath 跟随软链、同目录临时文件 + 校验 + `rename` 原子替换、带时间戳备份与回滚 |
| `lib/yaml-edit.mjs` | `locateProviders` `findRouteBlock` `removeRouteBlock` `renderRouteYaml` `renderManagedBlock` `findManagedBlock` `detectEol` `normalizeEol` `applyEol` | 保留注释与格式地增删 providers 条目；缩进从目标文件探测 |
| `lib/snippet.mjs` | `buildSnippet(...) → {yaml, chosenMaxTokens, budget, notes}`、`thinkingDecl(t)`、`thinkingFromProbe(probe)` → `{compat, efforts, notes}` | 证据 → YAML 片段的唯一出口；`maxTokens` 由 `pickSafeMaxTokens` 反推，不再硬编码 65536；v0.3.6 把「思考怎么声明」抽成 `thinkingDecl`，probe / snippet / repair 三处共用，避免规则漂移 |
| `lib/probe-heuristics.mjs` | `classifyWindowStop` `isContextOverflowText` `parseStatedContextLimit` `effortProven` `median` `reasoningTokensOf` | 探测判据的纯函数：窗口失败分类（超限 vs 网关限制，按 pi-ai `overflow.js` 的 27 条 + 限流先判）、从错误文本解析**服务端自报窗口**、档位差异显著性（v0.4.2 改**区间分离**：`min(high) ≥ max(low)×1.5` 且差 ≥ max(8,10%)）、多信号思考计数。抽出来的理由是「判据要能单测，而不是只能真发 8MB 请求去验」 |
| `lib/usage.mjs` | `USAGE` `usageText(name)` `flagsOf(name)` | 8 个脚本 `--help` 的唯一来源；测试组 19 拿「源码里真实解析的 `--flag`」与它双向对账 |
| `lib/runlog.mjs` | `attemptKey` `logAttempt` `logChange` `readRecords` `lastFailureFor` `describeFailure` | JSONL 运行日志：同一尝试键的**上一次失败**会被下一次记录自动带出（`prevFailureId`/`prevFailure`），回答「为什么上次没成功」 |

### 3.5 声明决策表（写什么、为什么）

| YAML 字段 | 证据从哪来 | 写错的后果 | 本方案的规则 |
|---|---|---|---|
| `contextWindow` | 真实窗口测试（`--window`）或厂商文档 | 写大 → 压缩不触发，靠 400 兜底；写小 → 提前压缩 | 填**实测**值；没测就写 200000 占位并加警告注释（**不写 1e6**） |
| `maxTokens` | `max_tokens` **阶梯下探**得到的 `gateMaxTokens` | 写太大 → `pressure<=0` 启动失败、或网关 400；写小 → 单次回复短 | 取 `min(gateMaxTokens, floor(ctx×0.2))` 并在阶梯里选第一个满足 `gap>=30000` 的值（由 `pickSafeMaxTokens` 反推；ctx=131072 时结果是 16384，不是 65536） |
| `input` | 32×32 纯红 PNG + 问颜色（必须答 red） | 少写 `image` → 本地硬拦；多写 → 上游 400 | 只加**测过**的模态；默认 `[text]` |
| `reasoningEfforts` | 双向探测（默认开→测关；默认关→测开） | 不写 → 选择器没档位；写错 → 无效；给纯推理模型写 `off` → 用户点了没用/被拒 | 只声明**实测可复现**的档位；`off` **只在实测能关掉思考时写**；没有证据就 `reasoningEfforts: false` |
| `compat.thinkingFormat` | 双向探测（默认开测关 / 默认关测开，多信号判据） | 写错 → 静默失效 | **只有探测到才写**；探测不到**整块 `compat` 都不写**；qwen 系列还会额外警告「网关可能忽略 `reasoning_effort`」 |
| `defaultInput` / `defaultMaxTokens` | —（路由级兜底） | 不写 → 落 1e6 / 128000 | 显式写 `[text]` / **`32768`**（若该路由下还有 128k 窗口的模型，用 `16384`；`65536` 在 128k 窗口下会让 `pressure <= 0`，v0.4.0 已从建议值里删掉） |
| 路由名 | — | 用目录已有 id 会继承目录属性（可能跨协议污染）；未命中则等价手写路由 | 走 OpenAI 兼容反代时统一新建 `custom-*` |

### 3.6 片段生成规则

> **v0.3.1+ 的两条分支（审计补）**：①`pickSafeMaxTokens` 返回 `null`（窗口太小、任何 maxTokens 都过不了预算）时，`buildSnippet` 返回 `fatal: true`，**不写** `maxTokens` / `defaultMaxTokens`，只留一行 `# ⚠ 没算出安全的 maxTokens…`，`probe-capabilities` 收到 fatal 会 `exit 1`；②`supportsEffort`（是否实测到 `reasoning_effort` 真的改变 reasoning）为真时，compat 里才写 `supportsReasoningEffort: true`，否则 `levels` 强制裁成一档（旧版只提示不裁，已修）。返回值形状：`{yaml, chosenMaxTokens, budget, notes[], fatal?}`。（修过四个真 bug）

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

### 3.7.1 运行时对账与自愈（v0.3.6 新增）

前面 1–10 条只保证「**写之前**是对的」。但声明有可能在**运行中**被发现不对（网关偷偷换窗口、别的层覆盖了参数、模型换了实现）。v0.3.6 补上闭环的另外两环：

| 环 | 工具 | 输入 → 输出 | 判据（怎么算「没生效」） |
|---|---|---|---|
| 发现 | `verify-effective.mjs` | DSH 会话记录（`$DSH_HOME/sessions/**/session.v4.jsonl.zstd`）+ 当前 patch → 每路由每模型的 `verdict` / `issues` | ①`request/context` 里的运行时 `contextWindow` ≠ 声明值；②实际 `inputTokens` ≥ 压缩阈值；③会话真的发过 `type:"image"` 但声明 `input` 不含 image；④失败按类归并后命中 `context-overflow` / `image-unsupported` / `thinking-rejected`（这些算**矛盾**，auth/rate 只算警告） |
| 修正 | `repair.mjs` | 探测结果 JSON + 当前 patch → 逐字段 diff，`--apply` 才写 | 用 `thinkingDecl` 与 `pickSafeMaxTokens` 重算；写前跑三段校验，写后**再跑一次**；失败 `rollbackFrom` |
| 留痕 | `lib/runlog.mjs` | 每次尝试 → 一行 JSONL | 同 `attemptKey({cmd,patch,route})` 的上一次 `status:"fail"` 会被本次记录带成 `prevFailure`（人读：「上次失败在<阶段>：<报错原文>」） |

关键取舍（**请重点评审**）：

- `repair` **默认 dry-run**，只打 diff；只有 `--apply` 才写。理由：自动改配置的风险高于手工，必须显式二次确认。
- `repair` 无法确定的值**不猜**：探针没测到窗口 → 沿用现有值 + 打印提示；任何 maxTokens 都过不了预算 → 拒绝写盘 exit 1。
- `repair` 重写的是**整块路由 YAML**（`renderRouteYaml`），所以该路由里的注释会丢、格式会重排；它不碰别的路由，也不碰托管块外的内容。
- `verify-effective` 只读会话文件，**不改任何东西**；有矛盾 exit 1（便于放进 CI/定时任务）。
- 会话归属靠「按顺序取最近的 `request/context`/`request/header`」：`assistant/message` 事件本身不带 provider/model（实测），这是 DSH 的事件格式约束，不是猜测。

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
| 1 | `npm test` | **107 pass / 0 fail / 0 skip**（24 个测试组） | 2026-11-09 |
| 2 | `npm run selfcheck` | exit 0（测试 + 示例预算 + 示例两段校验） | 2026-11-09 |
| 3 | `node scripts/resolve-check.mjs --patch /root/.dsh/profiles/web/cordis.patch.yml --lint --budget` | exit 0；5 条真实路由全 ✓，**静态审计 1 条警告**（`qwen-effort-may-be-ignored`：dashscope 路由声明了 `supportsReasoningEffort: true`，百炼可能静默忽略 → 属提示不是错误），预算全绿（gap 444163 / 650486 / 554264 / 554264 / 522486） | 2026-11-09 |
| 4 | `node scripts/probe-matrix.mjs --patch …` | **5/5 版本 PASS**，4 字段一致 | 2026-11-09 |
| 5 | 红跑（旧代码 `cb11b4a` + 新测试） | 组 8 五条 **5/5 fail** | 2026-11-09 |

### 4.2 107 条测试的分组（24 组）

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
| 9 | 6 | `--yaml` 片段生成（无证据 / 占位窗口 / maxTokens 反推 / 纯推理不写 off / 两形态过三段 / 旧模板反证） |
| 10 | 10 | v0.3.0：第 3 段压缩预算红绿、fs-safe 原子写与软链、`context-budget --patch`、3 条新审计规则、`thinkingBudgets` 不误报 |
| 11 | 4 | **mock 网关**：静默丢图→vision=false、真答红→vision=true、`max_tokens>16384` 全 400→gateMaxTokens 收敛、默认关思考→canEnable + qwen |
| 12 | 4 | **wire payload 断言（v0.3.8 重写）**：直接 import pi-ai 的 `stream()` 打本地假 SSE 端点抓请求体 —— ①不声明 `supportsReasoningEffort` 时**默认仍发** `reasoning_effort: low/high`（推翻旧说法）②显式 `false` 时两档请求体逐字节相同 ③声明 `true` + `reasoningEfforts` 时 `off`→`enable_thinking:false`、low/high 真的不同 ④deepseek 用 `thinking.type` |
| 13 | 3 | v0.3.1 自审：`snippet` 致命（窗口太小）不写死 `maxTokens`、qwen 单档 / effort 双档 + `supportsReasoningEffort`、`minContextWindowFor` 数值下界（4096→117829） |
| 14 | 2 | **probe 端到端**：mock 网关模拟「布尔开关端点」与「effort 端点」，跑完整 probe→结论→片段 链路 |
| 15 | 6 | **第二轮对抗审计的 P0/P1 回归**：NaN 死循环、坏 YAML 打栈、重复 compaction 条目取最后一条、`--max` 被回退越过、CRLF 往返、并发写中止 |
| 16 | 2 | **verify-effective**：用 `zstd` 造真实格式的会话文件，断言 exit 1、`problems=1`，并命中 `contextWindow=131072` / `context-overflow` / `image` 三个 match（不单独断言 inputTokens 阈值）；没有该模型时只标「未使用」不报错 |
| 17 | 2 | **repair**：dry-run 不写盘且给出逐字段 diff；`--apply` 后文件真被改、留备份、写后复验通过、日志里既有 `change` 也有带「写后校验」阶段的 `attempt`；再跑一次「不需要修正」；窗口太小无法算出合法 maxTokens 时拒绝写盘 exit 1 |
| 18 | 1 | **runlog**：同一尝试键先失败后成功，第二次记录自动带 `prevFailureId` + 人读的 `prevFailure` |
| 19 | 1 | **`--help` 与实现双向对账（v0.3.8）**：`lib/usage.mjs` 的键必须与 `scripts/` 一一对应；每个脚本「源码里真实解析的 `--flag`」与「usage 文本里的 flag」双向 diff，漏写/多写都红 |
| 20 | 6 | **compaction 对齐真插件（v0.3.8/v0.3.9）**：policy `retainRatio` 压过全局 `retainTokens`（旧版工具绿、真插件抛）、`headroomTokens:0` 是硬失败（插件 `assertPositiveInteger`）、`thresholdRatio` 越界是硬失败、`headroomTokens:0` + 显式 `maxTokens` 合法、显式 `retainTokens` 时豁免比例比较、`gap` 不足只算 warning（`ok` 仍为 true） |
| 22 | 6 | **第四轮外部评审（v0.4.0）**：窗口失败分类（413/429/超时 ≠ 窗口）、档位采样噪声不判支持、单轮越过阈值只警告、超限+小输入才是窗口铁证、挂起图片不串模型、repair 保留 headers/retryPolicy/thinkingBudgets 等扩展字段 |
| 23 | 1 | **孤儿模型（v0.4.1）**：会话里真跑过、但当前补丁里已没有的 provider/model 必须单列一行（判「配置里已没有这个模型」+ warning），不能静默丢掉证据 |
| 24 | 5 | **第五轮审计（v0.4.2）**：①探针证明开不了思考时片段不许写 `reasoningEfforts`；②effort 顺序噪声不判支持档位；③BOM 补丁能 `repair --apply`；④`--all-models` 必须配 `--route`；⑤认不出的失败（中文超限）不静默丢弃 |
| 21 | 5 | **第三轮审计的 P0/P1 回归（v0.3.9）**：非法 compaction 配置四个工具全拒、repair 多路由全部真改、空 probe 不凭空写 `maxTokens`、`--route` 不污染同路由别的模型、旧 probe 下 repair 与 inject 的思考声明一致 |

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
! 路由 custom-dashscope-aliyuncs / deepseek-v4.1-flash-1017：qwen 系列格式声明了 supportsReasoningEffort: true，部分网关会静默忽略 reasoning_effort（warning，不影响加载）
压缩联动（headroom=65536）：
  ✓ custom-111: threshold=541248 retain=97085 gap=444163
  ✓ custom-dashscope-aliyuncs: threshold=800000 retain=149514 gap=650486
  ✓ custom-modelscope-1/2: threshold=672320 retain=118056 gap=554264
  ✓ custom-apizn: threshold=640000 retain=117514 gap=522486
```

**关于「4 条 ctx=1000000 为什么能过 lint」**（评审 Q&A 里问的）：它们过的是**结构性检查**——三段校验只证明「按你声明的数字算，配置能被加载、压缩不会自相矛盾」，不证明 `1000000` 是这家端点的真实窗口。这四条里的 `1000000` 是**显式写死的**（不是落默认值，所以审计不会报 `default-context-window`），但它们**没有跑过 `--window` 实测**，属于【未验】。真要坐实，得对每个端点跑一次 `probe-capabilities --window`。这也是本方案「声明必须由证据支撑」的自我打脸之处：**本机这份 profile 里就有 4 条未经证据的声明**。

**运行时对账（v0.3.9，**【实测】** 2026-11-09）**：`node scripts/verify-effective.mjs --patch ~/.dsh/profiles/web/cordis.patch.yml --no-log` 读本机 8 个真实会话 / 21776 条事件：

```
✓ 没有发现声明与实际不一致（8 个会话 · 21776 条事件）
  ✓ custom-dashscope-aliyuncs / deepseek-v4.1-flash-1017   一致（已观测）  实际 ctx=1M,131k  最大输入=238k 请求=2832  发过图  有 reasoning
  · custom-modelscope-1 / …  请求=70      · custom-modelscope-2 / …  请求=97
```

v0.3.7 曾用同一段数据判出「声明 1e6、运行时 131072 → 矛盾 exit 1」，那是**旧判据的误报**：它拿历史会话的旧 ctx 当现值。v0.3.8 起改成「只用最近一次请求的 ctx 判矛盾，更早的不同值降为提示」。

**v0.4.0 补充一个更根本的限制**（第四轮评审指出、我们确认成立）：`request/context` 里的 `contextWindow` 是 **DSH 本地记录**当时内存中的声明值，**不是网关回报的物理窗口**——上游 OpenAI 兼容网关根本不会在响应里返回窗口大小。所以这个比较能证明的只有「该会话跑的是旧声明（HMR 未生效 / 多层覆盖 / 中途改过）」，**不能证明网关窗口大小**。要证伪「声明窗口 > 真实窗口」，唯一铁证是：**出现 context-overflow，且当时最大单轮输入仍小于声明窗口**（这时报告会明确写出「实际窗口 < 声明的 N」）。

这正是 §5.3 说的「数字造假时预算检查会一路 ✓」的现实版：它能在**上线后**把矛盾抓出来，而不是等一次 400。同一份报告也给出了「哪些模型真的被用过 / 发过多少图 / 有没有 reasoning 信号」。

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

（`bogus` ✗ = 非法 `thinkingFormat` 被拒；`Qwen` ✗ = 大小写不对被拒；`unknown` 列 = 未知字段被静默接受——这是 DSH **Config 层**的真实行为（语义层 0.1.5+ 会 REJECT 路由级未知 compat 键，见 §4.5 注），所以本方案用静态审计补这一层。）

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
11. **运行时对账只能看「已经发生过的会话」**（v0.3.6）：`verify-effective` 依赖 DSH 的会话格式（`session.v4.jsonl.zstd` 里的 `request/context`、`assistant/message` 等事件）。格式变了就要跟着改；而且它只能证明「声明与实际不符」，不能证明「实际就是这家端点的物理上限」（网关可能同时限制了窗口和 max_tokens）。
12. **`repair --apply` 会重排版式并丢掉该路由内的注释**（v0.3.6）：它用 `renderRouteYaml` 整块重渲染。字段值是对的、YAML 是对的，但手写注释不会保留。想保留注释就只用 `--dry-run` 看 diff，然后手改。
13. **自动修正只覆盖「能由探针决定」的字段**：`contextWindow`（探针没测到就沿用原值并提示）、`maxTokens`（预算反推）、`input`、`reasoningEfforts` / `compat`。`cost`、`headers`、`retryPolicy`、`modelOverrides` 不自动改。
14. **`dsh --profile web --dump-config` 不做校验**：它是打印配置，不是校验入口（**【实测】** 塞 `compat.thinkingFormat: bogus` + `contextWindow: "not-a-number"` 仍 exit 0）。所以别拿它当验证手段——用 `resolve-check`。

15. **`repair --apply` 会整块重渲染被修路由**（v0.3.8 确认）：手工写的注释、字段顺序、引号风格都会被 YAML 重新序列化；**不再**删除兄弟路由（旧版 P0：`repair.mjs` 扫描块尾时把 providers 下同缩进的兄弟路由也算进来，`--apply` 会静默删光被修路由之后的所有路由并 exit 0；v0.3.8 改用 `findRouteBlock` 按缩进判定，并用审计给的 `target/keep1/keep2` 复现验证保留）。
16. **并发写入**（v0.3.8）：`inject-model` / `repair` / `merge-routes` 写盘前都做内容指纹校验（`assertUnchanged`），窗口内被别人改过就中止并提示备份；但「两个人同时写同一文件」仍可能一个成功一个被拒（安全，不是合并）。
17. **`verify-effective` 只认「能读出来的会话」**：所有会话都读不出时 exit 2 并列出失败原因（v0.3.8 修掉「假绿 exit 0」）；但会话格式仍然依赖 DSH 实现（`session.v4.jsonl.zstd` 的 `request/context`、`assistant/message` 等事件名），格式改了就得跟改。
18. **工具与插件的判定有一处刻意的差异**：`gap < 30000` 是工具的工程建议，不是插件规则（见 §2.4）。如果你只想「能加载」，可以用 `--min-gap 0` 放宽。

---
19. **档位判据仍然是启发式**（v0.4.2）：`min(high) ≥ max(low)×1.5` + 每档 3 次，能把「按调用顺序变长」的假网关挡掉，但不能证明「网关真的按 effort 调预算」——最硬的证据仍是跑一次真任务，比较同一 prompt 在 low/high 下的实际耗时与 token。判据只在「有证据支持」时才写 `supportsReasoningEffort: true`，没证据就单档。
20. **`verify-effective` 的「铁证」依赖错误文本里的自报窗口**（v0.4.2）：只有服务端在超限错误里写清 `maximum context length is N` / `Range of input length should be [1, N]` 这类措辞时，才能判「声明 > 真实窗口」；措辞不认识就只给 warning（并打印原文），不冒充铁证。

## 6. 复现步骤

### 6.1 最小复现（不花钱，不需要网络）

```bash
git clone https://github.com/shiodomemiuna111/dsh-model-compat && cd dsh-model-compat
npm test                                   # 107 条回归（24 组）
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
7. **§4 的证据强度**：107 条测试（其中 4 条真跑 pi-ai 序列化）+ 5 个版本矩阵，够不够支撑「方案可用」？还缺哪一类测试（例如真实 DSH 启动后的端到端会话测试——我目前只做到「不启动 DSH 的等价校验」）？
8. **§5 的边界**里，哪一条在你看来是「必须修才能交付」，哪一条可以接受为已知限制？

---

## 附录 A：字段与枚举清单（来自源码，测试组 3 会持续对账）

- **路由级字段**（`profile` schema，`lib/index.js:1050-1084`）：`displayName` `api` `baseURL` `apiKeyEnv` `models` `modelOverrides` `compat` `defaultInput` `defaultContextWindow` `defaultMaxTokens` `headers` `reasoning` `thinkingBudgets`（`{minimal,low,medium,high}` 数字）`cacheRetention`（`none|short|long`）`transport`（`sse|websocket|websocket-cached|auto`）`timeoutMs` `websocketConnectTimeoutMs` `streamIdleTimeoutMs` `maxRequestImageBytes` `maxRequestImages` `imageOffloadCountQuantum` `requestImagePixelBudget` `requestImageMaxBytes` `retryPolicy`
- **模型级字段**：`id` `name` `contextWindow` `maxTokens` `input` `reasoningEfforts` `compat`
- **只在路由层生效、写进模型层会被静默丢弃**：`api` `baseURL` `provider` `apiKeyEnv` `displayName`
- **思考档位**：`off` `minimal` `low` `medium` `high` `xhigh` `max`（7 个，`index.js:299`）
- **思考格式**：`openai` `deepseek` `openrouter` `together` `baseten` `zai` `qwen` `chat-template` `qwen-chat-template` `string-thinking` `ant-ling`（11 个，`index.js:309`）
- **模态**：`text` `image`（2 个，`index.js:282`）
- **协议**：`openai-completions` `openai-responses` `anthropic-messages`（手写路由只认这 3 个，`index.js:835`）

## 附录 B：退出码汇总

| 脚本 | 0 | 1 | 2 |
|---|---|---|---|
| `probe-capabilities` | 成功 | 关键步骤失败（基础 chat 不通 / 窗口太小导致片段 `fatal`） | 用法错误 |
| `resolve-check` | 全部通过 | 有路由解析失败 / 审计有 error | 用法错误 / 找不到插件 |
| `context-budget` | 安全（gap 不足仅警告） | 有硬失败（DSH 会抛） | 参数错误（非整数等） |
| `inject-model` | 写入成功或 dry-run 通过 | 校验失败 / 拒绝写入 | 用法错误 |
| `merge-routes` | 有写入或已最新 | 没有可写入条目 / 复验失败（已回滚） | 用法错误 |
| `probe-matrix` | 全通过且一致 | 有版本失败 | 用法错误 |
| `verify-effective` | 没有发现不一致 | 有矛盾（声明与实际不符） | 用法错误 / 一个会话都读不出 |
| `repair` | dry-run 有 diff、或无需修正（全部与探针一致）、或 apply 成功 | 拒绝修正 / 校验不通过（未改动文件） | 用法错误 |

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