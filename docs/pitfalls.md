# 实操踩坑（都踩过，附实测数据）

## 1. 别用重复字符串测窗口

`"x".repeat(8000000)` 会被上游 tokenizer 严重低估——实测 8M 个 `x` 上报的 prompt_tokens
远小于字符数（具体倍数依赖该网关的 tokenizer，**这个数字是【未验】的单一观测，别当常数用**）。
用真实单词文本（如 `alpha beta gamma …`）才稳定：约 23 字符 ≈ 5.1 token。

## 2. `/models` 不是能力来源

实测两家：

- 百炼 `GET /compatible-mode/v1/models` → 182 个模型，条目只有 `id/object/created/owned_by`；
- ai.apizn.com → 16 个模型，多一个 `supported_endpoint_types`，仍然没有窗口与模态。

两家都没有能力字段。DSH 的内置发现只能读窗口/输出上限，模态与思考档位只能靠声明。

## 3. 「能调」≠「调了有用」

apizn 对 `reasoning_effort` / `reasoning:{effort}` / `thinking:{type}` / `enable_thinking`
**全部返回 200 不报错**，但 `reasoning_tokens` 在 15~21 之间随机跳动；
同一道题 `high` 一次是 54，重测一次是 14。流式响应还**不返回** `delta.reasoning_content`。

⇒ 判据不能是「返回 200」，必须是「**开/关两次请求的 reasoning_tokens 有稳定差异**」。
`probe-capabilities.mjs` 就是这么判的。

## 4. 思考型模型会把小 `max_tokens` 吃光

百炼的 `reasoning_effort: medium` 在 `max_tokens=256` 时把 256 token 全烧在推理上，
`content` 为空。看起来像「不支持视觉/不回答问题」，实际只是预算不够。
脚本里基础请求用 64 token，空了就重试 1024。

同理：`reasoning_tokens` 字段**缺失**通常表示「没开思考」，不是「未知」。脚本把缺失当 0。

## 5. 压缩联动会直接拒绝你的配置

`contextWindow: 131072` + `maxTokens: 128000` ⇒ `B = 3072`、`pressure = 3072 - 65536 = -62464`，
DSH 直接报 `TargetPressureConfigError`。而 headroom 默认就是 65536，
所以**任何 64k 窗口的模型在默认配置下都装不进去**。

反推：`ctx` 至少要大于 `maxTokens + headroom + 1`。用 `context-budget.mjs` 先算一遍。

## 6. 缓冲带太窄会抖

`threshold - retain` 小于 3 万 token 时，压缩完下一轮立刻又到阈值，表现为「每次回复前都在压缩」。
`resolve-check.mjs --budget` 会把这个标出来。

## 7. 虚标的代价不是死锁，是「没有正常压缩」

外面评审常担心「虚标窗口会让唯一的溢出重试也失败」。实测读码结论：
溢出路径调用的是 `selectCompactableRange(session, measurement, 0)`——**保留 0 条**，
注释原文 *overflow bypasses the normal threshold and retained-tail policy*。
所以虚标 1M 的真实后果是：正常压缩永不触发，只能靠一次 400 换来的兜底压缩。

## 8. `npm install` 会清掉手放的 node_modules 目录

搭跨版本沙箱时，装完 pi-ai 要**重新把插件目录放回去**、重建 shim、重挂 symlink。
`probe-matrix.mjs` 里固定了这个顺序。

## 9. 热重载会校验，失败当场报错

改 `cordis.patch.yml` 不用重启（`dsh-hmr` 监听该文件），但重载时会走严格校验；
校验不过会**当场失败**（行为是读码推断：`dsh-hmr/lib/index.js:850-872` 监听 patch 文件、
重载走 `internal/config` 校验；「保留旧配置」这一点本机没有可复现案例，标【未验】）。
所以先用 `resolve-check.mjs` 离线验，再改文件。
