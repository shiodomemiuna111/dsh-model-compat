# dsh-model-compat

给 **DeepSeek Harness (dsh)** 接第三方 OpenAI 兼容端点时，**用证据声明模型能力**，而不是抄厂商宣传数字。

> 背景：DSH 内置的模型目录（`@earendil-works/pi-ai` 的 providers data）里没有你的第三方模型时，
> 窗口、模态、思考档位全都落到默认值（1M 上下文 / 128k 输出 / 只收文本），于是会出现
> 「上下文突然爆」「说看不见图」「思考深度调不了」。**这不是 bug，是没声明。**

本仓库提供 4 个零依赖的 Node 脚本，做三件事：

1. **测**——用真实（便宜的）请求测出这个端点到底有什么能力；
2. **验**——不启动 DSH，直接让 `dsh-llm-pi-ai` 的校验路径解析你写的 YAML，并顺带算压缩联动数字；
3. **跨版本复验**——同一份 YAML 丢给 5 个历史版本，证明方案不是只对新版有效。

---

## 快速开始

```bash
git clone <this-repo> dsh-model-compat && cd dsh-model-compat

# 1) 探能力（--yaml 直接出配置片段；默认不发大请求，加 --window 才探窗口）
node scripts/probe-capabilities.mjs \
  --base https://your-gateway/v1 --model your-model --key-env YOUR_KEY_ENV --yaml

# 2) 把你改好的 YAML 交给解析器验证（不启动 dsh，秒级）
node scripts/resolve-check.mjs --patch examples/cordis.patch.yml \
  --plugin-root /opt/dsh/node_modules --budget

# 3) （可选）跨版本复验
node scripts/probe-matrix.mjs --patch examples/cordis.patch.yml
```

输出示例：

```
✓ custom-apizn / gpt-6.1-sol  ctx=800000  max=65536  input=[text,image]  reasoning=true  levels=low/high

压缩联动（headroom=65536）：
  ✓ custom-apizn: threshold=640000 retain=117514 gap=522486
```

---

## 五个脚本

| 脚本 | 花不花钱 | 干什么 |
|---|---|---|
| `probe-capabilities.mjs` | 几乎不花（默认 <1k token） | 打 /models、基础 chat、max_tokens 上限、思考开关、视觉、流式；`--window` 才做窗口二分（⚠ 每次几十万 token） |
| `resolve-check.mjs` | 不花钱 | 复制插件入口 + 追加一行 export，调用 `resolveProfiles(..., "strict")`，打印每条路由的真实解析结果；`--lint` 逐条隔离找出肇事路由；`--budget` 再算压缩联动 |
| `context-budget.mjs` | 不花钱 | 单独算 threshold / retain / gap，反推「这个 maxTokens 至少要多大的 ctx」 |
| `inject-model.mjs` | 不花钱 | 把探测结果安全写进 `cordis.patch.yml`：写入前隔离预演、写入后复验、失败自动回滚 |
| `probe-matrix.mjs` | 不花钱（只装 npm 包） | 在 `/tmp` 里给每个历史版本搭隔离沙箱，跑同一份 YAML |

都没用第三方依赖；YAML 解析借用 DSH 自带的 `yaml` 包。

---

## 为什么需要这些检查

DSH 的压缩策略（`@deepseek-ai/dsh-compaction-basic`）是这样联动的：

```
B         = contextWindow - maxTokens
pressure  = B - headroomTokens          (默认 65536)
threshold = floor(min(0.8 * contextWindow, pressure))
retain    = floor(B * retainRatio)      (默认 0.16)
```

约束：`pressure > 0`、`retain < threshold`；工程上还要 `threshold - retain >= 30000`，否则压缩完立刻又到阈值（抖动）。

于是「把 maxTokens 抄成 128000，ctx 却只有 131072」会直接 `TargetPressureConfigError`；
而「ctx 抄成 1M，真实窗口只有 128k」则正常压缩永不触发，只能靠一次 400 溢出兜底。

`context-budget.mjs` 就是用来先算一遍再落地的。

---

## 跨版本兼容性（实测）

同一份包含 3 条路由的 YAML，在 5 个版本的 `@deepseek-ai/dsh-llm-pi-ai` 上解析结果**完全一致**：

| 版本 | 发布 | 配套 pi-ai | 结果 |
|---|---|---|---|
| 0.0.1-rc.5 | 2026-08-12 | ^0.82.1 | PASS |
| 0.1.5-rc.3 | 2026-09-22 | ^0.85.1 | PASS |
| 0.1.7-rc.2 | 2026-09-24 | ^0.85.1 | PASS |
| 0.2.1-rc.5 | 2026-10-29 | ^1.1.0 | PASS |
| 0.2.2-rc.1 | 2026-11-04 | ^1.5.0 | PASS |

原因：`providers` 字典格式、`reasoningEfforts` / `thinkingFormat` / `defaultInput` / `compat` 这些字段、
`--patch` 覆盖层、`$DSH_HOME/profiles/<name>/cordis.patch.yml` 约定，从最早的 0.0.1-rc.5 就存在。
详见 [docs/portability.md](docs/portability.md)。

---

## 目录

```
scripts/probe-capabilities.mjs   测端点能力
scripts/resolve-check.mjs        验 YAML 能否被解析 + 压缩联动
scripts/context-budget.mjs       纯计算压缩阈值
scripts/inject-model.mjs         安全写入（预演→写入→复验→回滚）
scripts/probe-matrix.mjs         跨版本沙箱复验
examples/cordis.patch.yml        可直接抄的两种写法
docs/method.md                   方法论：为什么不要抄厂商数字
docs/portability.md              跨版本验证记录与结论
docs/pitfalls.md                 实操踩坑（含本机实测数据）
docs/failure-modes.md            失败模式：一条坏声明会不会毒死全局、卡死怎么兜底
```

## License

MIT
