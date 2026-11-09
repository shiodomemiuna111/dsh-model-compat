/**
 * 入口判定（v0.4.3）。
 *
 * 用 `npm link` 装成命令后，`process.argv[1]` 是 `/usr/local/bin/dmc-verify`，
 * 而 `import.meta.url` 是真实文件路径 —— `resolve()` 两者永远不相等，
 * 于是「直接运行」的分支不会执行：脚本静默退出 0，什么都判不出来（假绿）。
 * 这里统一用 realpath 比较，软链 / 相对路径 / 直接运行都能正确识别。
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
