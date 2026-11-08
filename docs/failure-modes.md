# 失败模式与自愈设计

插件不会"自动发现并自动修正"——DSH 里这套声明是**静态配置**，没有一个后台线程替你试错。
所以这个项目把"能不能自愈"拆成四个可验证的问题，每条结论都带实测命令。

---

## 1. 一条坏声明会不会毒死全部？

**会，而且没有任何局部隔离。** `resolveProfiles(providers, "strict")` 在插件挂载时执行，
任意一条抛错就整体 THROW，整份 `cordis.patch.yml` 被拒。实测：

| 坏法 | strict 结果 | deferred 结果 |
|---|---|---|
| 某模型 `contextWindow: "128k"` | **THROW** `model "x" contextWindow must be a positive integer` | 该路由 `catalogError=true`，模型列表为空，**其它路由照常** |
| 某模型 `reasoningEfforts: {}` | **THROW** `has an empty reasoningEfforts` | OK（该路由仍在但档位异常） |
| 某模型 `compat.thinkingFormat: bogus` | PASS（**静默接受**） | PASS |
| `input: ['video']` | PASS（**静默接受**，请求时才被上游拒） | PASS |
| `baseURL: ""` / `displayName: ""` / 空 provider 名 | **THROW**（deferred 也 THROW，没有救） | THROW |
| `defaultInput: []` | **THROW**（deferred 也 THROW） | THROW |
| `models` 写成字符串 | **THROW** `Cannot read properties of undefined` | THROW |

**自愈手段**：`node scripts/resolve-check.mjs --patch your.yml --lint`
逐路由隔离解析，直接告诉你是哪一条肇事的：

```
逐路由隔离检查（strict，一条不过不会拖累别的）：
  ✓ custom-good [good-model]
  ✗ custom-broken ← llm-pi-ai: provider "custom-broken" model "broken-model" contextWindow must be a positive integer
  ✓ custom-also-good [also-model]
```

**唯一的"自动"**：`scripts/inject-model.mjs` 写入前先做隔离预演，预演不过拒绝写入；
写入后再验一次，不过自动回滚到备份。堵住的正是"批量导入时一条坏数据弄崩全局"。

---

## 2. 某个端口连不上，会不会拖慢全部？

**不会。** 路由校验是**纯本地**的：只检查字符串与数字，不碰网络。
实测：把 `custom-111`（局域网 192.168.164.27，已经不可达）留在配置里，
`resolve-check` 依然 3 条全 ✓，耗时不变。

连不上的代价只发生在**你切到那个模型并发起请求时**：
`probe-capabilities.mjs` 实测报 `连不上 192.168.164.27:7863：UND_ERR_SOCKET`，退出码 1，不卡住。

---

## 3. 模型卡死不动怎么办？

三层，从里到外：

| 层 | 机制 | 默认值 | 怎么调 |
|---|---|---|---|
| 流空闲看门狗 | `streamIdleTimeoutMs`，超时抛 `TIMEOUT` | 300,000 ms（5 分钟） | 路由级字段，可写 60,000 收紧 |
| 重试 | `retryPolicy`，默认 `mode: normal`、5 次、指数退避 500ms→10s、抖动 10%，重试 `TIMEOUT/TRANSPORT/RATE_LIMIT/SERVER/EMPTY_RESPONSE` | 5 次 | 路由级字段 |
| 手动 | `Esc` 中断 / `handoff` | — | — |

**注意**：看门狗判的是"**流里多久没有新 token**"，不是"整条回复多久"。
推理型模型长思考时如果上游不推心跳，5 分钟无输出会被判 TIMEOUT——
这是**故意的**：卡死就该断，而不是无限等。`probe-capabilities.mjs` 会测流式是否能通。

---

## 4. 压缩会不会卡死？

不会死锁，但有两个**真实边缘**：

- **retain=0 的溢出路径**：上游 400 后 `selectCompactableRange(session, measurement, 0)`
  保留 0 条，只留最后一条；注释原文 *overflow bypasses the normal threshold and retained-tail policy*。
- **压缩不了的情形**：`keepFromIdx <= firstIdx` 直接返回 null——**只有一条消息、且紧挨着
  system 消息**时没有可压缩的区间。这时溢出无法自愈，只能靠 `/clear` 换会话。
- **工具配对被拆**：`toolPairingBalancedBefore` 会避免把 tool call 和 tool result 拆开，
  所以压缩范围会回退到配对边界，极端情况下可能压得比预期少。

**自愈手段**：`scripts/context-budget.mjs` 在改配置前就把 `pressure ≤ 0`、`retain ≥ threshold`、
`gap < 30000` 挑出来（这三种是"自己把配置写坏"的路径）。

---

## 5. 为什么不做真正的"自动发现 + 自动改写"？

- DSH 的 `discoverModels` 只读窗口/输出上限，**明确不读模态与思考档位**
  （源码注释：*nothing can interrogate a gateway for its modalities*）。
- 实测两家网关的 `/models` 都不给能力字段（百炼只有 4 个字段，apizn 多个 endpoint 类型）。
- 没有插件钩子能在"配置加载失败"时改写配置——挂了就是挂了。

所以定位很明确：**自动拿到能拿到的（窗口/输出上限），剩下的一次真实请求证明，写进声明，
写完再验一遍、验不过回滚。** 这是工程上能做到的最接近"自愈"的闭环。
