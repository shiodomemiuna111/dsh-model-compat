/**
 * 默认路径（v0.4.3「装上就能用」）。
 *
 * 安装进 DSH 之后，用户不该每次敲 `--patch ~/.dsh/profiles/web/cordis.patch.yml`。
 * 规则（按优先级）：
 *   1. 命令行显式 `--patch`
 *   2. 环境变量 `DSH_HOME_PROFILE_PATCH`
 *   3. `$DSH_HOME/profiles/web/cordis.patch.yml`（本机真实覆盖层，存在才算）
 *   4. 仓库里的 `examples/cordis.patch.yml`（只用于演示/测试）
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** 本机真实 profile 的覆盖层路径；不存在返回 null。 */
export function localPatchPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const p = join(home, "profiles", "web", "cordis.patch.yml");
  return existsSync(p) ? p : null;
}

/** 默认补丁：env → 本机 profile → 示例。 */
export function defaultPatchPath() {
  return process.env.DSH_HOME_PROFILE_PATCH ?? localPatchPath() ?? join(REPO, "examples", "cordis.patch.yml");
}

/** 默认会话目录（verify-effective 用）：env → $DSH_HOME/sessions。 */
export function defaultSessionsDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return process.env.DSH_MODEL_COMPAT_SESSIONS ?? join(home, "sessions");
}
