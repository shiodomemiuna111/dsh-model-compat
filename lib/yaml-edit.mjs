/**
 * yaml-edit.mjs — 在「保留注释与格式」的前提下增删 providers 条目的文本工具。
 *
 * 教训（对抗审计）：不要假设缩进。旧实现写死「路由键 = providers 缩进 + 2」
 * 和「条目固定 6 空格」，遇到 4 空格缩进的文件时会把块外手写路由吞进托管块，
 * 变成未知字段却仍然报 ✓（exit 0）。这里改为从目标文件里**探测**子缩进。
 */
export const BEGIN_MARK = "# >>> managed-by-dsh-model-compat";
export const END_MARK = "# <<< managed-by-dsh-model-compat";

const indentOf = (line) => line.length - line.replace(/^[ \t]+/, "").length;
const isBlank = (line) => line.trim() === "";
const isComment = (line) => line.trim().startsWith("#");
const TABS = /^[ \t]*\t/;

/**
 * 找到 llm-pi-ai 条目里的 providers: 行，并探测子条目的缩进。
 * @param {string[]} lines
 * @returns {{line:number, providersIndent:number, childIndent:number, blockEnd:number, entryLine:number}}
 */
export function locateProviders(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id: llm-pi-ai[ \t]*$/);
    if (m) entries.push({ line: i, indent: m[1].length });
  }
  if (entries.length === 0) {
    throw new Error("找不到 '- id: llm-pi-ai' 条目（目标补丁里没有这个插件？）");
  }
  if (entries.length > 1) {
    throw new Error(
      `补丁里有 ${entries.length} 个 '- id: llm-pi-ai' 条目（第 ${entries.map((e) => e.line + 1).join("、")} 行）。`
      + "DSH 只认其中一个，写入另一个等于白写；请先合并成一个再运行。",
    );
  }
  const { line: entryLine, indent: entryIndent } = entries[0];

  // 找本条目下的 providers:
  let providerLine = -1;
  let blockEnd = lines.length;
  for (let i = entryLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const ind = indentOf(line);
    if (!isBlank(line) && !isComment(line) && ind <= entryIndent) { blockEnd = i; break; }
    if (providerLine < 0 && /^([ \t]*)providers:[ \t]*$/.test(line) && ind > entryIndent) providerLine = i;
  }
  if (providerLine < 0) {
    throw new Error("llm-pi-ai 条目里没有找到 providers:（确认其 config 下有 providers:）");
  }
  if (lines.slice(providerLine, blockEnd).some((l) => TABS.test(l))) {
    throw new Error("providers 块里有 tab 缩进；YAML 只允许空格缩进，请先改成空格");
  }

  // 探测 providers 子条目的缩进（取最浅的非空非注释行的缩进）
  let childIndent = null;
  for (let i = providerLine + 1; i < blockEnd; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    const ind = indentOf(line);
    if (ind <= indentOf(lines[providerLine])) break;
    childIndent = childIndent === null ? ind : Math.min(childIndent, ind);
  }
  if (childIndent === null || childIndent <= indentOf(lines[providerLine])) {
    childIndent = indentOf(lines[providerLine]) + 2;
  }
  return { line: providerLine, providersIndent: indentOf(lines[providerLine]), childIndent, blockEnd, entryLine };
}

/** 一条路由条目在 YAML 文本里的行块（route 键 + 其下所有更深缩进的行）。 */
export function removeRouteBlock(lines, route, childIndent) {
  const out = lines.slice();
  const key = `${" ".repeat(childIndent)}${route}:`;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== key) continue;
    let j = i + 1;
    while (j < out.length) {
      const l = out[j];
      if (isBlank(l)) { j++; continue; }
      // 缩进 <= 键缩进 → 兄弟键/上级，立刻停（旧实现用 < 导致吞掉兄弟路由）
      if (indentOf(l) <= childIndent) break;
      j++;
    }
    out.splice(i, j - i);
    return out;
  }
  return out;
}

/** 把 {route: profile} 渲染成 YAML 行（第一行是路由键，缩进 = childIndent）。 */
export function renderRouteYaml(route, profile, childIndent, YAML) {
  if (!YAML) throw new Error("renderRouteYaml 需要传入 yaml 解析器（由脚本从 DSH 安装目录加载）");
  const doc = YAML.stringify({ [route]: profile }).replace(/\n+$/, "");
  const pad = " ".repeat(childIndent);
  return doc.split("\n").map((l) => (l === "" ? "" : pad + l)).join("\n");
}

/** 渲染整个托管块（标记行与路由同缩进）。 */
export function renderManagedBlock(list, childIndent, YAML) {
  if (list.length === 0) return [];
  const pad = " ".repeat(childIndent);
  const body = list.map(({ route, profile }) => renderRouteYaml(route, profile, childIndent, YAML)).join("\n");
  return [`${pad}${BEGIN_MARK}`, ...body.split("\n"), `${pad}${END_MARK}`];
}

/** 找托管块（容器行必须是「行首可选空白 + 整行就是标记」）。 */
export function findManagedBlock(lines) {
  // 标记允许尾部带说明文字（历史版本写过不同的后缀），只比对前缀。
  const at = (l, mark) => l.trim().startsWith(mark);
  let beginLine = -1;
  for (let i = 0; i < lines.length; i++) if (at(lines[i], BEGIN_MARK)) { beginLine = i; break; }
  if (beginLine < 0) return null;
  let endLine = -1;
  for (let i = beginLine + 1; i < lines.length; i++) if (at(lines[i], END_MARK)) { endLine = i; break; }
  if (endLine < 0) throw new Error("托管块的开始标记存在但结束标记缺失（文件可能被手工改坏）");
  return { beginLine, endLine };
}

export { indentOf, isBlank, isComment };