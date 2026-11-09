/**
 * 用法文本的唯一来源：`node scripts/<x>.mjs --help` 打印这里的内容。
 *
 * 为什么单独放一份：v0.3.7 的审计发现 8 个脚本的 `--help` 与 README/spec 里的参数表
 * 双向漂移（文档写了脚本支持、help 不列；help 列了文档没写）。参数一旦只写在两处，
 * 就会再次漂移，所以用法文本集中到这里，测试组 19 会拿本文件的 flag 列表与
 * 各脚本 parseArgs 里实际接受的 flag 对账。
 */

const COMMON = "  -h, --help            打印这段用法\n";

export const USAGE = {
  "probe-capabilities.mjs": `用法: node scripts/probe-capabilities.mjs --base URL --model ID (--key KEY | --key-env ENV | --key-file FILE) [选项]

必填
  --base URL            端点 baseURL（例 https://gateway/v1）
  --model ID            模型 id
  --key KEY             直接给 key（会进 shell 历史，不推荐）
  --key-env ENV         从环境变量读 key（推荐）
  --key-file FILE       从文件读 key

可选
  --yaml                输出可直接粘进 cordis.patch.yml 的片段（默认：人读报告）
  --json                输出机器可读 JSON（给 repair 的 --probe 用）
  --out DIR             把结果写进 DIR（probe.json / snippet.yml）
  --window              探真实窗口（⚠ 会发几十万 token 的请求，默认关闭）
  --no-window           显式关闭窗口探测（与默认一致，便于脚本显式声明）
  --no-effort-levels    跳过 low/high 档位的双次采样（省 4 个请求；此时只按单档处理）
${COMMON}
退出码: 0 成功；1 关键探测失败（基础 chat 不通 / 窗口太小导致片段 fatal）；2 用法错误
`,

  "resolve-check.mjs": `用法: node scripts/resolve-check.mjs [--patch FILE] [选项]

必填（有默认值）
  --patch FILE          要验证的 patch（可重复；默认 examples/cordis.patch.yml，可用 DSH_HOME_PROFILE_PATCH 覆盖）

可选
  --plugin-root DIR     插件安装目录（含 node_modules）或包目录；找不到时自动试 /opt/dsh/node_modules 等
  --plugin DIR          --plugin-root 的别名
  --lint                逐条路由隔离验证，指出是哪一条把整份配置毒死
  --budget              再算压缩联动（threshold / retain / gap）
  --headroom N          覆盖 headroomTokens（默认读 patch 里的 compaction 配置，没有则 65536）
  --json                机器可读输出
  --quiet               只输出错误（不吞 --help）
${COMMON}
退出码: 0 全通过；1 有路由失败 / 审计报错 / compaction 配置在加载期会被拒；2 用法错误/找不到插件
`,

  "context-budget.mjs": `用法: node scripts/context-budget.mjs --ctx N --max N [选项]

必填
  --ctx N               声明的 contextWindow
  --context-window N    同上（长写法）
  --max N               声明的 maxTokens
  --max-tokens N        同上（长写法）

可选
  --headroom N          剩余预算（默认读 --patch 的 compaction 配置，否则 65536）
  --threshold-ratio R   压缩阈值比例（默认 0.8）
  --retain-ratio R      压缩保留比例（默认 0.16）
  --retain-tokens N     固定保留 token 数（优先于 retain-ratio）
  --min-gap N           工程要求的最小阈值-保留间隔（默认 30000）
  --patch FILE          从这份 patch 读 dsh-compaction-basic 配置
  --provider P          配合 --patch：选 modelPolicies 里的路由
  --model M             配合 --patch：选 modelPolicies 里的模型
  --json                机器可读输出
${COMMON}
退出码: 0 安全（gap 不足只打 ⚠ 警告，仍为 0）；1 有硬失败（DSH 加载/压缩期会抛）；2 用法错误
`,

  "inject-model.mjs": `用法: node scripts/inject-model.mjs --patch FILE --route NAME --probe probe.json [选项]

必填
  --patch FILE          目标 patch（cordis.patch.yml）
  --route NAME          要写入/更新的路由名
  --probe FILE          probe-capabilities.mjs 输出的 JSON

可选
  --plugin-root DIR     插件安装目录（写前预演用）
  --plugin DIR          --plugin-root 的别名
  --dry-run             只打印将写入的内容，不落盘
  --force               预演失败也写（危险；写后仍会复验，失败回滚）
  --assume-ctx N        探针没测到窗口时用这个值
  --assume-contextWindow N   同上（长写法）
  --max N               覆盖推算出的 maxTokens
  --api VALUE           覆盖 api（默认 openai-completions）
  --api-key-env ENV     写 apiKeyEnv
  --display-name NAME   写 displayName
  --layer ROUTE|MODEL   探测结果写成路由级还是模型级字段（默认 ROUTE）
${COMMON}
提示: --probe 要传探测结果 JSON，用 probe-capabilities.mjs 的 --json 生成，不要手写。
退出码: 0 写入成功或 dry-run 通过；1 校验失败/拒绝写入（已回滚）；2 用法错误
`,

  "merge-routes.mjs": `用法: node scripts/merge-routes.mjs --patch FILE --from FILE [--from FILE ...] [选项]

必填
  --patch FILE          目标 patch
  --from FILE           要导入的路由文件（可重复）

可选
  --dry-run             只报告会写什么，不落盘
  --replace             同名路由用新条目替换（会重写该路由块）
  --no-verify           跳过写后复验（不推荐）
  --plugin-root DIR     插件安装目录（逐条隔离验证用）
  --plugin DIR          --plugin-root 的别名
${COMMON}
退出码: 0 有写入或已是最新；1 没有可写入条目/复验失败（已回滚）；2 用法错误
`,

  "probe-matrix.mjs": `用法: node scripts/probe-matrix.mjs --patch FILE [选项]

必填
  --patch FILE          同一份 YAML 要在多版本上复验

可选
  --versions a,b        指定版本（默认 5 个历史版本）
  --work DIR            沙箱工作目录（默认 /tmp 下临时目录）
  --dsh-root DIR        本机 DSH 安装目录（默认 /opt/dsh）
  --keep                保留沙箱目录以便排查
${COMMON}
退出码: 0 全通过且可比字段一致；非 0 有版本失败/不一致
`,

  "verify-effective.mjs": `用法: node scripts/verify-effective.mjs [--patch FILE] [选项]

必填（有默认值）
  --patch FILE          当前声明（默认 $DSH_HOME_PROFILE_PATCH 或 examples/cordis.patch.yml）

可选
  --sessions DIR        会话根目录（默认 $DSH_HOME/sessions）
  --last N              只看最近 N 个会话
  --json                机器可读输出（rows / problems）
  --verbose             打印每个模型的明细行
  --log FILE            写 JSONL 运行日志（默认 dsh-model-compat.log.jsonl）
  --no-log              不写日志
  --node-modules DIR    找 yaml 解析器的 node_modules（默认 /opt/dsh/node_modules）
${COMMON}
退出码: 0 无矛盾；1 有矛盾（矛盾≠警告）；2 用法错误
`,

  "repair.mjs": `用法: node scripts/repair.mjs --patch FILE --probe probe.json [选项]

必填
  --patch FILE          要修正的 patch
  --probe FILE          probe-capabilities.mjs 输出的 JSON

可选
  --apply               真的写盘（默认 dry-run，只打 diff）
  --dry-run             显式 dry-run（默认行为）
  --route NAME          只处理该路由（可重复；默认按 baseURL 主机 + 模型 id 匹配）
  --all-models          配合 --route 时，把该路由下所有模型都按同一份探针修正
                        （默认只修 m.id == 探针 model 的那个；否则会把别人的测量值套过来）
  --plugin-root DIR     插件安装目录（写前/写后校验用）
  --plugin DIR          --plugin-root 的别名
  --log FILE            写 JSONL 运行日志（默认 dsh-model-compat.log.jsonl）
  --no-log              不写日志
  --json                机器可读输出
${COMMON}
注意: --apply 会用 renderRouteYaml 整块重渲染被修正的路由，该路由里的手写注释会丢；
      其余路由与托管块不动。写前跑三段校验 + 整份预验，不通过一个字节都不写。
退出码: 0 无需修正或已修正；1 不可修正/写后校验失败已回滚；2 用法错误
`,
};

export function usageText(scriptName) {
  return USAGE[scriptName] ?? `（没有为 ${scriptName} 维护用法文本）`;
}

/**
 * 从用法文本里抽出它声明的 flag 列表，供测试对账。
 * 只认「行首缩进后紧跟 --flag」的选项行——正文里提到别的脚本参数（如
 * 「probe-capabilities.mjs --json 的输出」）不该被算成本脚本的 flag。
 */
export function flagsOf(scriptName) {
  const text = usageText(scriptName);
  const out = new Set();
  for (const line of text.split("\n")) {
    // 一行一个选项；别名请另起一行（否则描述里提到的别的脚本参数会被误算）。
    const m = line.match(/^\s+(--[A-Za-z][A-Za-z0-9-]*)/);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}