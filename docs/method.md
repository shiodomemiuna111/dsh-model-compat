# 方法论：用证据声明模型能力

## 为什么不能抄厂商数字

DSH 的模型目录（`@earendil-works/pi-ai` 的 `dist/providers/data/*.json`，43 个厂商、1842 个模型条目）
是**静态的**：它知道 OpenAI 官方模型的窗口，但不知道你那个聚合网关后面到底是什么。

当目录没命中时，`@deepseek-ai/dsh-llm-pi-ai` 用默认值填坑：

| 字段 | 默认值 | 出处 |
|---|---|---|
| `contextWindow` | 1,000,000 | `lib/index.js` 的 `defaultContextWindow` |
| `maxTokens` | 128,000 | `DEFAULT_MAX_TOKENS` |
| `input` | `["text"]` | `DEFAULT_INPUT` |

源码注释写得很直白：*nothing can interrogate a gateway for its modalities*。

于是三个经典故障：

1. **上下文爆**——声明的窗口比真实窗口大，压缩迟迟不触发，最后被上游 400 拒掉；
2. **说看不见图**——没声明 `image`，DSH 在本地就把图拦了（硬错 `does not support image input`）；
3. **思考调不了**——没声明 `reasoningEfforts`，模型选择器里就没有档位可调。

这三件事**都不是 DSH 的 bug**，是配置里没写。

## 三步法

### 第 1 步：测（probe-capabilities.mjs）

每一项都对应一个声明字段：

| 探测 | 决定了什么 | 判据 |
|---|---|---|
| `GET /models` 能否列出该模型 | 能不能用「目录路由」而不是手写路由 | 200 且 id 命中。**注意 /models 通常不含窗口与模态** |
| 基础 chat | key / baseURL / 协议是否通 | 200 且有 content |
| `max_tokens=400000` | `maxTokens` 能写多大 | 200 = 接受；400 = 显式上限低于 400k |
| 三种"关思考"写法 | `thinkingFormat` 选哪个 | 只有**真的能把 `reasoning_tokens` 归零**的写法才算 |
| 1×1 PNG | `input` 要不要加 `image` | 200 且 prompt_tokens 上涨 / 有回答 |
| 流式 SSE | UI 能否显示思考过程 | `delta` 里有没有 `reasoning_content` |
| `--window` 阶梯探测 | `contextWindow` | 用**真实单词文本**按固定阶梯递进，遇到 `context_length_exceeded` 停（不是二分；见 pitfalls） |

### 第 2 步：验（resolve-check.mjs）

写完 YAML 不要靠「看起来对」。脚本会：

1. 找到你本机的 `@deepseek-ai/dsh-llm-pi-ai`；
2. 把 `lib/index.js` 复制成临时文件、追加 `export { resolveProfiles }`（**不改原文件**，用完删除）；
3. 用严格模式解析你的 providers，打印每条路由最终生效的 `contextWindow / maxTokens / input / reasoning / levels`；
4. `--budget` 再算 `threshold / retain / gap`，把会报错的组合提前挑出来。

这一步跑一次不到 2 秒，比「改完重启 DSH，看日志」快一个数量级。

### 第 3 步：跨版本复验（probe-matrix.mjs）

如果你的 YAML 要给别人用（或者你自己的机器是旧版 DSH），用 `probe-matrix.mjs`
在 `/tmp` 里给每个历史版本搭一个隔离沙箱，跑同一份 YAML，比对解析结果是否一致。

## 声明模板（保守优先）

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      custom-yourname:
        displayName: 你的网关
        api: openai-completions
        baseURL: https://.../v1
        apiKeyEnv: YOUR_KEY_ENV
        defaultInput: [text]        # 没声明的模型默认只看文本（保守）
        defaultMaxTokens: 65536
        models:
          - id: your-model
            contextWindow: 800000    # 实测值
            maxTokens: 65536         # 故意低于真实上限，避免单次回复吃掉太多预算
            input: [text, image]     # 实测能看图才写
            compat:
              thinkingFormat: qwen   # 只有探测到"能开/关思考"的证据才写；没有就不写
            reasoningEfforts:        # 只声明实测可复现的档位
              off: null
              low: "low"
              high: "high"
```

四条原则：

1. **窗口填实测值，不填宣传值**。宁小勿大：小了只是提前压缩，大了要靠 400 兜底。
2. **`maxTokens` 故意写小**（32k~64k）。它是单次回复预算；太大只会让 `B = ctx - maxTokens` 变小、压缩更早，还容易被严格网关拒。
3. **档位只声明能复现的**。有的网关对任何 `reasoning_effort` 都返回 200，但效果方差盖过信号——这时要么少声明，要么在 README 里写清「效果不可验证」。
4. **`input` 只加实测过的模态**。`["text","image"]` 写错了不会报错，只会在请求时被上游 400。

## 想要的自动发现（未来）

DSH 有内置的 `registerModelDiscovery`，它会读 `/models` 里的
`contextWindow` / `context_length` / `max_input_tokens` / `limit.context`，
但**明确不读模态与思考档位**（源码注释：*nothing can interrogate a gateway for its modalities*）。

所以本方法论的定位是：**探测脚本先把"能自动拿到的"拿到（窗口/输出上限），
剩下拿不到的（模态/档位）用一次真实请求证明，再写进声明。**
