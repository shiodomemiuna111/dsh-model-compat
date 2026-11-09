// 运行日志（JSONL）：回答「为什么上一次没成功」，并给下一次尝试提供上下文。
//
// 一条记录一个 JSON 行；同一「尝试键」的多次运行天然串成一条链：
//   attemptKey = sha1(cmd + patch 绝对路径 + patch 内容指纹 + 目标路由)
// 因此同一个 patch 改了又改，仍然能顺着链找到上一次的错误原文。
//
// 记录类型（t 字段）：
//   attempt  一次运行的结论：{cmd, key, patch, status:"ok"|"fail", phases:[{name,ok,detail}], error, prevFailureId}
//   change   一次自动修正的具体字段改动：{key, field, from, to, reason}
// 设计约束：
//   - 只追加，不改写历史（appendFileSync），并发写靠 O_APPEND 的原子性；
//   - 单条记录不超过 ~3KB（报错原文截断到 1500 字符），避免日志无限膨胀；
//   - 文件不存在时自动建目录；写日志失败只 warn，绝不让主流程失败。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

export const MAX_TEXT = 1500;
export const DEFAULT_LOG =
  process.env.DSH_MODEL_COMPAT_LOG ||
  // v0.4.2 装上 DSH 之后，日志默认落在 $DSH_HOME 里（而不是当前目录），
  // 这样从任何 cwd 跑都不会散落一堆 .jsonl；显式 --log 仍然优先。
  `${process.env.DSH_HOME ?? join(homedir(), ".dsh")}/dsh-model-compat.log.jsonl`;

function trunc(s, n = MAX_TEXT) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…[截断，原长 ${t.length}]` : t;
}

export function attemptKey({ cmd, patch, route }) {
  const h = createHash("sha1");
  h.update(String(cmd ?? ""));
  h.update("\u0000");
  h.update(patch ? resolve(String(patch)) : "");
  if (route) h.update(`\u0000${route}`);
  return h.digest("hex").slice(0, 16);
}

export function appendRecord(file, rec) {
  if (!file) return null;
  const out = { ts: new Date().toISOString(), ...rec };
  try {
    mkdirSync(dirname(resolve(file)), { recursive: true });
    appendFileSync(file, `${JSON.stringify(out)}\n`, "utf8");
    return out;
  } catch (e) {
    console.error(`（警告：写日志失败 ${file}：${String(e?.message ?? e)}；不影响本次结果）`);
    return null;
  }
}

export function readRecords(file, { tail = 200 } = {}) {
  if (!file || !existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-tail).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 同一尝试键上最近一次失败（用于「为什么上一次没成功」）。 */
export function lastFailureFor(file, key) {
  const recs = readRecords(file, { tail: 500 });
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const r = recs[i];
    if (r.t === "attempt" && r.key === key && r.status === "fail") return r;
  }
  return null;
}

/** 人读的一句话：「上次失败在 <阶段>：<错误原文>」。 */
export function describeFailure(rec) {
  if (!rec) return null;
  const failedPhase = (rec.phases ?? []).find((p) => !p.ok);
  const where = failedPhase?.name ?? "未知阶段";
  const why = trunc(failedPhase?.detail ?? rec.error ?? "（没有记录错误原文）", 400);
  return `上次失败在${where}：${why}`;
}

/** 给本次运行补上 prevFailure 的因果链，并落盘。返回是否写入成功。 */
export function logAttempt(file, { cmd, patch, route, status, phases, error }) {
  const key = attemptKey({ cmd, patch, route });
  const prev = lastFailureFor(file, key);
  return appendRecord(file, {
    t: "attempt",
    cmd,
    key,
    route: route ?? null,
    patch: patch ? resolve(patch) : null,
    status,
    phases: (phases ?? []).map((p) => ({
      name: p.name,
      ok: Boolean(p.ok),
      detail: p.ok ? undefined : trunc(p.detail),
    })),
    error: error ? trunc(error) : undefined,
    prevFailureId: prev ? prev.ts : null,
    prevFailure: prev ? describeFailure(prev) : undefined,
  });
}

export function logChange(file, { key, field, from, to, reason }) {
  return appendRecord(file, {
    t: "change",
    key,
    field,
    from: from === undefined ? null : from,
    to: to === undefined ? null : to,
    reason: reason ? trunc(reason, 400) : undefined,
  });
}