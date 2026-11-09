# dsh-model-compat

给 **DeepSeek Harness (dsh)** 接第三方 OpenAI 兼容端点时，**用证据声明模型能力**，而不是抄厂商宣传数字。

> 背景：DSH 内置的模型目录（`@earendil-works/pi-ai` 的 providers data）里没有你的第三方模型时，
> 窗口、模态、思考档位全都落到默认值（1M 上下文 / 128k 输出 / 只收文本），于是会出现
> 「上下文突然爆」「说看不见图」「思考深度调不了」。**这不是 bug，是没声明。**

本仓库提供 6 个零依赖的 Node 脚本 + 7 个共享库，做三件事：

1. **测**——用真实（便宜的）请求测出这个端点到底有什么能力；
2. **验**——不启动 DSH，直接让 `dsh-llm-pi-ai` 的校验路径解析你写的 YAML，并顺带算压缩联动数字；
3. **跨版本复验**——同一份 YAML 丢给 5 个历史版本，证明方案不是只对新版有效。

> **v0.3.1**（自审）：`inject-model` 的 `reasoningEfforts` 不再写死；`snippet` 在小窗口下直接判 `fatal` 而不是给出必然被拒的 `maxTokens`；`minContextWindowFor` 计入 `gap>=30000`（4096 → 117829）；qwen 布尔开关只写一档并补 `supportsReasoningEffort`。测试 71 条（组 14 补了 probe 端到端）。
>
> **v0.3.4**（第二轮子代理审计后的修复）：4 个 P0（NaN 死循环、BOM 打栈、坏 YAML 打栈、同 id 两条 compaction 取错条目）+ 6 个 P1（probe 字段名、`--max` 越界、NaN 预算全绿、只验单层、并发丢路由）+ P2（CRLF/BOM/软链误报）。测试 71 → **77 条**（新增组 15）。
>
> **v0.3.0**（对外部评审的回应）：探测判据全部重写（`max_tokens` 阶梯下探、思考双向探测、32×32 纯红 PNG 判颜色、多信号 reasoning 判据）；新增**第 3 段**压缩预算校验（`dsh-compaction-basic` 的 `TargetPressureConfigError` 写前就能抓到）；写盘改 `realpath + 临时文件 + rename` 原子替换；探针移出 `node_modules`；`context-budget --patch` 能读你的 compaction 配置；补 mock 网关测试。测试 → **77 条**（含 mock 网关与 wire payload 断言）。

---

## 快速开始

```bash
git clone https://github.com/shiodomemiuna111/dsh-model-compat.git && cd dsh-model-compat

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

## 六个脚本

| 脚本 | 花不花钱 | 干什么 |
|---|---|---|
| `probe-capabilities.mjs` | 几乎不花（默认 <1k token） | 打 /models、基础 chat、max_tokens 上限、思考开关、视觉、流式；`--window` 才做窗口探测（固定阶梯，不是二分；⚠ 每次几十万 token） |
| `resolve-check.mjs` | 不花钱 | 复制插件入口 + 追加一行 export，调用 `resolveProfiles(..., "strict")`，打印每条路由的真实解析结果；`--lint` 逐条隔离找出肇事路由；`--budget` 再算压缩联动 |
| `context-budget.mjs` | 不花钱 | 单独算 threshold / retain / gap，反推「这个 maxTokens 至少要多大的 ctx」 |
| `inject-model.mjs` | 不花钱 | 把探测结果安全写进 `cordis.patch.yml`：写入前隔离预演、写入后复验、失败自动回滚 |
| `probe-matrix.mjs` | 不花钱（只装 npm 包） | 在 `/tmp` 里给每个历史版本搭隔离沙箱，跑同一份 YAML |
| `merge-routes.mjs` | 不花钱 | 批量导入路由：逐条隔离验证 → 只写通过的 → 写后复验 → 失败回滚 |

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

同一份包含 2 条路由的 YAML，在 5 个版本的 `@deepseek-ai/dsh-llm-pi-ai` 上，**可比的四个字段（ctx / max / input / reasoning）逐字段一致**（`thinkingFormat`、`compat`、思考档位不在比对范围内，见 portability.md）：

| 版本 | 发布 | 配套 pi-ai | 结果 |
|---|---|---|---|
| 0.0.1-rc.5 | 2026-08-12 | ^0.82.1 | PASS |
| 0.1.5-rc.3 | 2026-09-22 | ^0.85.1 | PASS |
| 0.1.7-rc.2 | 2026-09-24 | ^0.85.1 | PASS |
| 0.2.1-rc.5 | 2026-10-29 | ^1.1.0 | PASS |
| 0.2.2-rc.1 | 2026-11-04 | ^1.3.0（实装 1.5.0） | PASS |

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
scripts/merge-routes.mjs         批量导入（单条失败不拖累全局）
scripts/probe-matrix.mjs         跨版本沙箱复验
examples/cordis.patch.yml        可直接抄的两种写法
docs/method.md                   方法论：为什么不要抄厂商数字
docs/portability.md              跨版本验证记录与结论
docs/pitfalls.md                 实操踩坑（含本机实测数据）
docs/failure-modes.md            失败模式：一条坏声明会不会毒死全局、卡死怎么兜底
docs/spec.md                     规格书（给外部评审：机制事实 + 方案 + 证据 + 已知边界）
```

## License

MIT

---

## 批量导入端口：单条失败不拖累全局

DSH 的 strict 校验是「全体或全无」：**一条坏声明 → 整份配置被拒 → 其它端口也全废。**

> V6 勘误：旧版这里写「9 种坏法里有 3 种 strict 放行」是**错的**。DSH 真实加载是两段
> （`Config()` 结构校验 + `resolveProfiles()` 语义校验），那 3 种第一段就拒了。
> 另一个曾被写反的结论：**路由级 `compat` 是会生效的**（`index.js:627` 把它并进该路由下每个模型）；
> 真正会静默丢的是**写在模型条目里的 `api` / `baseURL`**（只认路由层）和**拼错的未知字段**。
> 现在 `resolve-check.mjs` 两段都跑（v0.3.0 起还有第 3 段压缩预算），静态审计也覆盖这两类手误。

两道闸门：

```bash
# 1) 诊断：哪一条把整份配置毒死
node scripts/resolve-check.mjs --lint

# 2) 导入：逐路由隔离验证 → 只写入通过的 → 写后复验 → 失败自动回滚
node scripts/merge-routes.mjs \
  --patch ~/.dsh/profiles/web/cordis.patch.yml \
  --from new-ports.yml --plugin /opt/dsh/node_modules
```

`merge-routes` 只写入自己维护的托管块（`# >>> managed-by-dsh-model-compat` … `# <<<`），
块外的手写路由永不改动。详见 [docs/failure-modes.md](docs/failure-modes.md)。

## 模型卡死

DSH 自带三层兜底，不需要额外处理：流空闲看门狗（`streamIdleTimeoutMs`，默认 5 分钟无字节即判 TIMEOUT）、
自动重试（`retryPolicy`：5 次 / 500ms 起指数退避 / 上限 10s）、手动 Esc。
不可重试的错误（400 参数错、401）会立刻上抛，不会挂住。
校验本身是纯本地的——**一个死掉的网关地址不会拖累其它路由的加载**。
