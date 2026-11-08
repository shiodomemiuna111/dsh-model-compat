# 失败模式与兜底

这份文档回答两个问题：**一条坏声明会不会拖累别的端口？模型卡死了怎么办？**

---

## 一、单条坏声明 = 全盘失效（已实测，已修）

### 现象

DSH 加载 `llm-pi-ai` 配置时用的是 **strict** 校验。strict 是「全体或全无」：
一个 provider 的 `contextWindow` 写成 `"128k"`，整份 `cordis.patch.yml` 被拒——
其余 9 个声明完全正确的端口也一起失效。

实测（`resolve-check.mjs` 单独喂各种坏法）：

| 坏法 | strict 行为 |
|---|---|
| `contextWindow: "128k"` | **THROW** 整份被拒 |
| `maxTokens: 0` | **THROW** |
| `reasoningEfforts: {}` | **THROW** |
| `reasoningEfforts: {high: ""}` | **THROW** |
| `baseURL: ""` / 空 provider 名 | **THROW** |
| `input: []` | 不报错，但等于「没声明」，会继承 defaultInput |
| `thinkingFormat: bogus` | **静默通过** ← 危险 |
| `input: ["video"]` | **静默通过** ← 危险 |
| `reasoningEfforts: {high: 123}` | **静默通过** ← 危险 |

最后三行是真正的坑：**strict 放行，运行时才炸**。
`thinkingFormat: bogus` 会被原样记进 `compat`，pi-ai 的 `if/else` 链匹配不上任何分支，
于是**静默退化成 `reasoning_effort`，或者干脆不发任何思考字段**——你的模型看起来「不能调思考」，
其实是字段名拼错了一个字母。

### 修法：两层

**第 1 层 —— `resolve-check.mjs --lint`**：逐条路由单独解析。
哪一条把整份配置毒死，直接点名：

```
逐路由隔离检查（strict，一条不过不会拖累别的）：
  ✓ custom-good [good-model]
  ✗ custom-broken ← contextWindow must be a positive integer
  ✓ custom-also-good [also-model]
```

**第 2 层 —— `merge-routes.mjs`（真正的批量导入）**：

```bash
node scripts/merge-routes.mjs \
  --patch ~/.dsh/profiles/web/cordis.patch.yml \
  --from new-ports.yml --plugin-root /opt/dsh/node_modules
```

流程：
1. 在一个进程里跑完所有候选路由（先 strict 拿第一条错，再 deferred 逐条标记）；
2. 通过的写进**托管块**，失败的列出来跳过；
3. 写前 `.bak` 备份，写完整份文件复验，**复验不过自动回滚**。

```
候选 3 条：通过 1，失败 2
  ✓ custom-import-good
  ✗ custom-import-broken ← contextWindow must be a positive integer
  ✗ custom-import-silent ← model "silent-model" input 含 "video"（只有 text/image 合法）

失败的路由没有写进去，其余路由照常生效。
✓ 已写入 cordis.patch.yml（备份 cordis.patch.yml.bak-...）
```

托管块的形状（块外的手写路由脚本永不改动）：

```yaml
    providers:
      custom-manual: {...}        # 你的，脚本不碰
      # >>> managed-by-dsh-model-compat（以下由 merge-routes.mjs 维护，手改会被覆盖）
      custom-a: {...}
      # <<< managed-by-dsh-model-compat
```

### 为什么不是「插件自动改配置」

DSH 没有「插件加载失败 → 改写配置 → 重试」的钩子。`resolveProfiles` 在挂载时跑一次，
结果要么进表、要么让挂载失败。**能做的不是自愈加载，而是把「写进去的声明一定是能加载的」。**
`merge-routes` 就是这个闸门：先隔离验证，再合并，再复验，验不过回滚。
声明错了不会自己好，但至少不会因为你其中一个端口写错、把已有的十个一起带走。

---

## 二、模型卡死

### 已有的三层兜底（读码确认，非猜测）

| 层 | 机制 | 默认值 |
|---|---|---|
| 流空闲看门狗 | `streamIdleTimeoutMs`：这么久没有新 token 就判 `TIMEOUT` | **300,000ms（5 分钟）** |
| 自动重试 | `retryPolicy`：网络错误 / 429 / 5xx | **5 次**，500ms 起步、×2 退避、上限 10s、±10% 抖动 |
| 手动 | `Esc` 中断、切换模型 | — |

「卡死无法检测」这个担心，在 DSH 里对应的是**空转的流**，而它是有看门狗的：
5 分钟没有任何字节就断，然后按 `retryPolicy` 重试（可重试错误才会重试）。

**不可重试的错误**（400 参数错、401 认证错、内容过滤）会立刻上抛，不会卡住等。

**压缩会不会卡死？** 有一处真实边界：
溢出恢复路径保留 0 条消息（`selectCompactableRange(session, measurement, 0)`），
但如果此时**会话里只有一条消息、且紧挨着 system**，`keepFromIdx <= firstIdx` → 返回 null，
压缩不了。此时只能 `/clear` 或换个更小的问题重来。这是设计边界，不是 bug。

### 解析纯本地，网络挂起不拖累别人

不同 provider 的校验**不发任何网络请求**。实测：把那个已经死掉的局域网地址
（`http://192.168.164.27:7863/v1`）留在配置里，其余路由照样全部 ✓。
代价只在你**切到这个模型发第一条消息**的那一刻。

---

## 三、出问题时的排障顺序

1. `node scripts/resolve-check.mjs --lint` —— 先排除「一条坏声明毒死全体」
2. `node scripts/resolve-check.mjs --budget` —— 再排除压缩联动配错（`TargetPressureConfigError`）
3. 实际发一条消息 —— 400 看它怎么说（`context_length_exceeded` / 不支持的字段 / 认证）
4. 看思考是否真的开：开/关两次请求的 `reasoning_tokens` 有没有稳定差异
5. 看不到图：先看 `input` 有没有 `image`，再看请求里有没有 image part

---

## 四、还没解决 / 已知限制

- **插件失效不会自动修**：见上文，没有钩子。只能靠前置闸门。
- **网关报的错不一定可信**：有的网关对所有 `reasoning_effort` 都返回 200（实测 apizn），
  返回 200 不代表参数生效。
- **窗口只能实测**：`/models` 在实测的两家里都不给窗口与模态。
- **热重载失败会保留旧配置**：改 YAML 不用重启，但校验不过时旧配置继续生效、新配置不加载，
  DSH 会给客户端一条通知。所以先用 `resolve-check` 离线验，再改文件。
