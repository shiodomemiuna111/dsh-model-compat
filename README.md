# dsh-model-compat

给 **DeepSeek Harness (dsh)** 接第三方 OpenAI 兼容端点时，**用证据声明模型能力**，而不是抄厂商宣传数字。

> 背景：DSH 内置的模型目录（`@earendil-works/pi-ai` 的 providers data）里没有你的第三方模型时，
> 窗口、模态、思考档位全都落到默认值（1M 上下文 / 128k 输出 / 只收文本），于是会出现
> 「上下文突然爆」「说看不见图」「思考深度调不了」。**这不是 bug，是没声明。**

本仓库提供 8 个零依赖的 Node 脚本 + 10 个共享库，做四件事：

1. **测**——用真实（便宜的）请求测出这个端点到底有什么能力；
2. **验**——不启动 DSH，直接让 `dsh-llm-pi-ai` 的校验路径解析你写的 YAML，并顺带算压缩联动数字；
3. **跨版本复验**——同一份 YAML 丢给 5 个历史版本，证明方案不是只对新版有效；
4. **上线后对账 + 自动修正**——从真实会话记录里查「声明 vs 实际」，按探针结果重算并安全改写，全程留 JSONL 日志（含「上次为什么失败」）。

> **v0.4.3**（装上 DSH，可以直接跑）：不再是「克隆下来手动 npm test」的仓库，而是**装进环境就能用**：
> - `npm link` 之后有 8 个命令：`dmc-probe` / `dmc-check` / `dmc-verify` / `dmc-repair` / `dmc-merge` / `dmc-budget` / `dmc-matrix` / `dmc-inject`。
> - `dmc-check` 不给 `--patch` 时**默认检查本机真实 profile**（`$DSH_HOME/profiles/web/cordis.patch.yml`），不再默认跑示例文件。
> - 运行日志默认落到 `$DSH_HOME/dsh-model-compat.log.jsonl`（从任何目录跑都不散落文件），可用 `DSH_MODEL_COMPAT_LOG` 覆盖。
>
> 安装：`git clone <repo> ~/.dsh/tools/dsh-model-compat && cd ~/.dsh/tools/dsh-model-compat && npm link`。更新：`git pull`（npm link 是软链，不用重装）。

> **v0.4.2**（第五轮三份审计后的修复）：三名审计员（对抗破坏 / 照文档敲 / 机制核验）在 v0.4.1 上报了 **1 个 P0 + 6 个 P1 + 10 个 P2/P3**，全部成立并已修：
> - **P0**：探针自己证明「开不了思考」，`--yaml` 片段却仍写 `reasoningEfforts {off, high}`——`resolve-check` 全绿、DSH 能加载，但 pi-ai 实发 `reasoning_effort`，strict 网关**每次请求 400**。根因是默认关时 `canDisable` 恒为 true；现在默认关必须证明「开得起来」才算可关，无开关证据就写 `reasoningEfforts: false`。组 24 用 plain mock 锁死。
> - **P1**：①BOM 补丁永远报「被另一个进程改过」——指纹改用原始字节；②429 TPM 的 `too many tokens` 被当成窗口铁证——先排除限流，铁证只认**错误文本里服务端自报的窗口**；③窗口分类按 pi-ai `overflow.js` 的 27 条重写（DashScope `Range of input length…` 等 11 条此前漏判）；④档位判据改**每档 3 次交错采样 + 区间分离**（`min(high) ≥ max(low)×1.5`），无因果网关误判从 ~10.8% 降下来；⑤中文超限原文不再被静默丢弃。
> - **P2/P3**：孤儿模型不再把 `models: []`（目录模型）和 `modelOverrides` 误报；`--all-models` 强制配 `--route`。
>
> 测试 102 → **107 条（24 组，0 skip）**。

> **v0.4.1**：补一个盲点——`verify-effective` 之前只遍历「补丁里声明了的模型」，于是**会话里真跑过、但当前补丁里已不存在**的 provider/model 被静默跳过（改过路由名 / 删了条目 / 被别的层覆盖，对账都会显示「没有发现不一致」）。现在这类模型单列一行，判 `配置里已没有这个模型` 并给出「用过 N 轮」的证据。属 warning（exit 0），因为「确实删了模型」是合法操作。测试 101 → **102 条（23 组，0 skip）**。

> **v0.4.0**（第四轮外部评审的核验与修复）：评审提了 4 个逻辑漏洞 + 4 处文档矛盾，逐条核验后 **3 条成立、1 条部分成立、1 条不成立（已实测反驳）**：
>
> - ✅ **成立**：`verify-effective` 的判据被拔高成「能抓网关偷换窗口」——实际上 `request/context` 里的 `contextWindow` 是 **DSH 本地声明值，不是网关回报**，那个检查只能证明「HMR 没生效 / 被别的层覆盖」。现在文案改准，并新增**唯一能证伪大窗口的运行时铁证**：发生 context-overflow 且报错前最大单轮输入 **小于** 声明窗口。
> - ✅ **成立**：单轮 `inputTokens ≥ 压缩阈值` 被当成矛盾（exit 1）会误报正常长会话；降级为 warning（压缩在**下一轮**才触发），只有 `≥ 可用消息预算 ctx-maxTokens` 仍算矛盾。
> - ✅ **成立**：挂起图片会跨模型污染（本地 `UNSUPPORTED_CONTENT` 拦下后换模型重发）；现在换模型、出错、会话边界都清空挂起队列。
> - ◐ **部分成立**：qwen 格式下 `supportsReasoningEffort` 的两难（百炼只认 `enable_thinking`/`thinking_budget`，顶层 `reasoning_effort` 可能被静默忽略）——新增两条审计警告 `qwen-effort-may-be-ignored`、`thinking-no-off-level`；档位判定改为 **每档 2 次采样取中位数 + high ≥ 2×low 且差 ≥16 token**，避免把采样噪声当成能力（新增 `--no-effort-levels`）。
> - ❌ **不成立（实测反驳）**：`repair --apply` 会抹掉 `headers`/`retryPolicy`/`timeoutMs`/`thinkingBudgets`/`transport` —— 实测这些字段**全部原样保留**（`renderRouteYaml` 是整对象 `YAML.stringify`），并补了组 22 回归测试锁死。
> - ✅ **成立**：窗口探测把 413/429/超时当成「撞上窗口上限」——新增 `lib/probe-heuristics.mjs` 的 `classifyWindowStop()`，只有 `context-overflow` 才认边界，网关限制时报「只能证明至少这么大」。
>
> 文档侧 4 处自相矛盾也一并改了（`headroomTokens: 0` 的准确表述、§2.7/§3.5 残留的单向探测文案、`defaultMaxTokens` 建议值 65536 → 32768、附录 B 退出码与 §3.3 失步）。测试 95 → **101 条（22 组，0 skip）**。

> **v0.3.9**（第三轮三个子代理审计后的修复）：①**P0**——compaction 配置不符合插件加载规则时，所有工具仍打 ✓ 连 `--apply` 也写进去，现在新增 `validateCompactionConfig()` 在 7 个入口先拒、一个字节不写；②`repair` 多路由只真改一条却报「已修正 3 个模型」（stale 行数组），现在同数组降序替换并断言行数；③`repair` 对 BOM 文件恒判「被并发修改」、空 probe 时凭空写 `maxTokens`、`--route` 把同路由别的模型一起改——都已修；④写盘改成「先整份预验、再原子写」，思考声明统一走 `thinkingFromProbe()`；⑤`verify-effective` 按时间升序、图片归属修正；⑥context-budget 非整数参数 exit 2、gap 只警告。测试 87 → **95 条（21 组，0 skip）**。
>
> **v0.3.8**（三个子代理对 v0.3.7 的对抗审计后的修复）：①`repair --apply` 的数据丢失级 P0——块尾扫描把 providers 下**兄弟路由**也算进被修块，静默删光后续路由还报成功（现用 `findRouteBlock` 按缩进判定，审计给的 `target/keep1/keep2` 场景已复现保留）；②`merge-routes` 逐条隔离校验时用的永远是默认 compaction 配置（`--no-verify` 能写出 DSH 启动必拒的配置），现在写前一定跑整份预算校验；③`probe` 把「HTTP 200 + 错误 JSON」当成功、视觉把否定句当答对，改为必须 `choices` 非空且必须答出 red；④`verify-effective` 全坏会话时假绿、`--no-log` 仍写日志、用历史会话旧 ctx 判矛盾；⑤`compaction` 区分**硬失败**（DSH 真会抛）与**工程警告**（`gap<30000`），保留量优先级照插件 `resolveTargetPolicy`；⑥思考声明显式写 `supportsReasoningEffort: false`（不写=默认 true，实测仍会发 `reasoning_effort`），并修掉 4 条 wire 测试「永远 ✔ 但一行没跑」的空跑；⑦8 个脚本 `--help` 统一到 `lib/usage.mjs`，测试组 19 做双向对账。测试 82 → **87 条（20 组，0 skip）**。

> **v0.3.7**（用户三问：有没有按键 / 怎么知道生效 / 没生效怎么自动修正并记日志）：新增两个脚本 `verify-effective.mjs`（读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`，比对运行时 `contextWindow`、实际 inputTokens、真实发图、失败类别）与 `repair.mjs`（默认 dry-run 出 diff，`--apply` 才写：三段校验 → 备份 → 原子写 → 写后复验 → 失败回滚）；新增 `lib/runlog.mjs`（JSONL，下一次尝试自动带出上一次失败原因）；`lib/snippet.mjs` 抽出 `thinkingDecl`，probe / snippet / repair 共用一套「思考怎么声明」规则。测试 77 → **82 条**（组 16/17/18）。

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

输出示例（对 `examples/cordis.patch.yml` 的真实输出，示例里的 key 是占位符，需要自己替换）：

```
✓ custom-example-a / example-a-model  ctx=800000  max=65536  input=[text,image]  reasoning=true  levels=low/high  format=qwen
✓ custom-example-b / example-b-model  ctx=400000  max=32768  input=[text,image]  reasoning=true  levels=high

压缩联动（headroom=65536）：
  ✓ custom-example-a: threshold=640000 retain=117514 gap=522486
  ✓ custom-example-b: threshold=301696 retain=58757 gap=242939
```

---

## 八个脚本

| 脚本 | 花不花钱 | 干什么 |
|---|---|---|
| `probe-capabilities.mjs` | 几乎不花（默认 <1k token） | 打 /models、基础 chat、max_tokens 上限、思考开关、视觉、流式；`--window` 才做窗口探测（固定阶梯，不是二分；⚠ 每次几十万 token） |
| `resolve-check.mjs` | 不花钱 | 复制插件入口 + 追加一行 export，调用 `resolveProfiles(..., "strict")`，打印每条路由的真实解析结果；`--lint` 逐条隔离找出肇事路由；`--budget` 再算压缩联动 |
| `context-budget.mjs` | 不花钱 | 单独算 threshold / retain / gap，反推「这个 maxTokens 至少要多大的 ctx」 |
| `inject-model.mjs` | 不花钱 | 把探测结果安全写进 `cordis.patch.yml`：写入前隔离预演、写入后复验、失败自动回滚 |
| `probe-matrix.mjs` | 不花钱（只装 npm 包） | 在 `/tmp` 里给每个历史版本搭隔离沙箱，跑同一份 YAML |
| `merge-routes.mjs` | 不花钱 | 批量导入路由：逐条隔离验证 → 只写通过的 → 写后复验 → 失败回滚 |
| `verify-effective.mjs` | 不花钱 | **运行时对账**：读 DSH 会话记录，查出「声明 ctx ≠ 运行时 ctx」「输入越过压缩阈值」「发了图却没声明 image」「context-overflow 类失败」。有矛盾 exit 1 |
| `repair.mjs` | 不花钱 | **自动修正**：探针结果 → 重算 `contextWindow`/`maxTokens`/`input`/思考声明 → 三段校验 → 备份 → 原子写 → 写后复验 → 失败回滚。默认 dry-run |

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
scripts/verify-effective.mjs     运行时对账（声明 vs 实际会话）
scripts/repair.mjs               按探针结果自动修正（dry-run / --apply）
examples/cordis.patch.yml        可直接抄的两种写法
docs/method.md                   方法论：为什么不要抄厂商数字
docs/portability.md              跨版本验证记录与结论
docs/pitfalls.md                 实操踩坑（含本机实测数据）
docs/failure-modes.md            失败模式：一条坏声明会不会毒死全局、卡死怎么兜底
lib/runlog.mjs                   运行日志（JSONL，带「上次失败原因」）
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
