/**
 * fs-safe.mjs — 安全写盘（v0.3.0，外部评审意见 6）。
 *
 * 三个真实隐患：
 *   1. **半截文件热重载**：cordis.patch.yml 被 dsh-hmr（lib/index.js:850）实时监听。
 *      直接 writeFileSync 会在截断/写入过程中被读到，触发一次失败的配置重载。
 *      做法：写同目录临时文件 → 校验通过 → fs.renameSync 原子替换（同目录 rename 是原子的）。
 *   2. **软链被替换**：如果用户的 cordis.patch.yml 是指向 dotfiles 仓库的软链，
 *      直接 rename 会把软链本身换成普通文件。做法：先 realpathSync 解析到真实路径再写。
 *   3. **回滚也要原子**：回滚同样走临时文件 + rename，避免回滚瞬间又被读到半截。
 */
import { realpathSync, existsSync, writeFileSync, renameSync, rmSync, copyFileSync, chmodSync, statSync, readFileSync } from "node:fs";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";

/**
 * 解析真实写入路径：跟随软链（若存在），保留原文件权限位。
 * @returns {{target:string, viaSymlink:boolean}}
 */
export function resolveWriteTarget(p) {
  if (!existsSync(p)) return { target: p, viaSymlink: false };
  const real = realpathSync(p);
  // v0.3.4（审计 P2-13）：realpath 返回绝对路径，入参常常是相对路径，
  // 直接 `real !== p` 对普通文件也恒真 → 误报「是软链」。必须两边都规范化再比。
  const same = resolvePath(real) === resolvePath(p);
  return { target: real, viaSymlink: !same };
}

/**
 * 并发写保护：记录读入时的内容指纹，写入前再核对一次。
 * 两个进程同时改同一个 patch 时，后写的会把先写的覆盖掉（审计 P1-10 实测丢路由）。
 * @returns {string} 指纹
 */
export function contentFingerprint(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 写入前确认文件没被别的进程改过；变了就抛错（调用方回滚/中止）。
 */
export function assertUnchanged(target, expectedFingerprint) {
  const now = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (contentFingerprint(now) !== expectedFingerprint) {
    throw new Error(`${target} 在我们读过之后被另一个进程改过（并发写）。已中止，避免覆盖别人的改动；请重跑一次。`);
  }
}

/** 同目录临时文件名（隐藏文件，避免被 glob 到）。 */
function tmpPathFor(target) {
  const dir = dirname(target);
  return join(dir, `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
}

/**
 * 原子写入：临时文件 → 可选校验 → rename。
 * @param {string} target 已 realpath 的写入目标
 * @param {string} content
 * @param {{check?:(text:string)=>void}} [opts] check 抛错则不替换、清理临时文件
 */
export function atomicWriteFile(target, content, opts = {}) {
  const exists = existsSync(target);
  const mode = exists ? statSync(target).mode & 0o777 : null;
  const tmp = tmpPathFor(target);
  try {
    writeFileSync(tmp, content, mode === null ? undefined : { mode });
    if (mode !== null) { try { chmodSync(tmp, mode); } catch {} }
    if (opts.check) opts.check(content);
    renameSync(tmp, target);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

/** 备份（同样先解析软链，避免把软链备份成普通文件）。 */
export function backupFile(p, stamp) {
  const { target } = resolveWriteTarget(p);
  const base = `${target}.bak-${stamp}`;
  let out = base;
  for (let n = 1; existsSync(out); n++) out = `${base}-${n}`;
  copyFileSync(target, out);
  return out;
}

/** 原子回滚：把备份内容写回目标。 */
export function rollbackFrom(backupPath, target) {
  atomicWriteFile(target, readFileSync(backupPath, "utf8"));
}