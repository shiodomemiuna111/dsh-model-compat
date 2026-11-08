# 跨版本兼容性

目标：一份 YAML 声明，从最早能装上 pi-ai 适配器的版本，到现在的最新版，行为一致。

## 实测结论（2026-11-08）

> **V6 更正**：下表所说的「逐字段完全一致」**只比对了 4 个字段**
> （`contextWindow` / `maxTokens` / `input` / `reasoning`）。
> `thinkingFormat`、`compat`、思考档位（`thinkingLevelMap`）**没有进比对**
> —— 所以旧版对这几项的兼容性仍是【未验】，别当成已证明。

同一份包含 3 条路由的 `cordis.patch.yml`，交给 5 个版本的 `@deepseek-ai/dsh-llm-pi-ai` 解析：

| 插件版本 | 发布日 | 配套 pi-ai | 结果 |
|---|---|---|---|
| `dsh-llm-pi-ai@0.0.1-rc.5` | 2026-08-12 | ^0.82.1 | PASS |
| `dsh-llm-pi-ai@0.1.5-rc.3` | 2026-09-22 | ^0.85.1 | PASS |
| `dsh-llm-pi-ai@0.1.7-rc.2` | 2026-09-24 | ^0.85.1 | PASS |
| `dsh-llm-pi-ai@0.2.1-rc.5` | 2026-10-29 | ^1.1.0 | PASS |
| `dsh-llm-pi-ai@0.2.2-rc.1` | 2026-11-04 | ^1.3.0（实装 1.5.0） | PASS |

（复现：`node scripts/probe-matrix.mjs --patch your.yml`）
（`@deepseek-ai/dsh` 0.2.2-rc.1 的 `package.json` 里写的是 `^1.3.0`，本机装的是 1.5.0；
  旧版 `^1.5.0` 的说法是错的。）

**环境说明（同样重要）**：上面的「旧版」沙箱里，`dsh-llm-pi-ai` 是真旧版，但其余
`@deepseek-ai/*` 包是**软链到本机新版**的。这是「插件层跨版本」，不是「整机旧版」。
真实旧版 DSH 可能还差别的包，这一点未验证。

## 为什么能用

逐项核对过：

- **`providers` 是字典不是数组**：从 `0.0.1-rc.5` 起就是。各版本的报错原文都在
  `llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles`。
- **声明字段齐全**：`reasoningEfforts`、`thinkingFormat`、`defaultInput`、
  `defaultContextWindow`、`defaultMaxTokens`、`compat`、`input`、`name`、`apiKeyEnv`
  在 0.0.1-rc.5 到 0.2.2-rc.1 全部存在。
- **`thinkingFormat: qwen`** 从最老版本就有（0.0.1-rc.5 实际支持 **8** 种格式，
  新版 11 种，多出 `baseten` / `chat-template` / `qwen-chat-template`）。
  三种协议（`openai-completions` / `openai-responses` / `anthropic-messages`）各版本一致。
- **覆盖层约定一致**：`$DSH_HOME/profiles/<name>/cordis.patch.yml` 与 `--patch extra.yml`
  在 0.1.7-rc.2 和 0.2.2-rc.1 的 `lib/bin.js` 里说明文字完全相同；
  各版本 `dsh-base/cordis.patch.yml` 里 `- id: llm-pi-ai / name: '@deepseek-ai/dsh-llm-pi-ai'` 段落一字不差。

## 差异点（不影响 YAML，但影响脚本）

- **`resolveProfiles` 从不导出**。所有版本只导出
  `{ Config, PiAiAdapter, apply, inject, name, supportedProtocols }`（新版多 `recordKeyFor`）。
  所以 `resolve-check.mjs` 必须「复制入口文件 + 追加一行 export」再 import。
- **老版本 import 了新版没有的符号**：跑跨版本沙箱时需要 shim 补
  `CallId`、`offloadRequestImagesWithPolicy`、`deepEqualJson`、`installSettingsSection`、`settingsNamespace`。
  这只是为了让脚本能在隔离沙箱里跑，**真实 DSH 安装里各包版本自洽，不需要 shim**。
- **`npm install` 会删掉手放在 `node_modules` 里的目录**，所以矩阵脚本的安装顺序是
  pi-ai → 放插件 → 建 shim → symlink。

## 溢出识别也一致

上游返回「上下文超了」时，DSH 靠 pi-ai 的厂商正则表识别。老版 `pi-ai@0.82.1` 的
`dist/utils/overflow.js` 有 33 条正则，新版 1.5.0 有 35 条，**都包含** DashScope/Qwen 的
`/range of input length should be/i`。所以「窗口声明偏大 → 靠 400 兜底恢复」这条路径在旧版也成立。

## 注意

DSH 是 rc 版本，公测期字段仍可能变。`resolve-check.mjs` 的 value 就在于：
**升级 DSH 之后跑一遍，5 秒钟就知道你的声明还成不成立。**
