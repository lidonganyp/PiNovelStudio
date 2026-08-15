/**
 * SIGKILL-FAULT-INJECTION — 真实子进程硬杀注入（仅测试基础设施）
 *
 * RUN-LIFECYCLE P8 真实 SIGKILL 注入验收需要：在 commitAndSave 事务边界（正文保存前/后、
 * 状态提交前/后）与内容库原子写（临时文件→rename）之间，让真实子进程在指定故障点
 * 同步阻塞，等待外部测试框架发送 SIGKILL，从而暴露跨进程残留状态的真实退出恢复行为。
 *
 * 设计约束：
 *   - 生产零开销：本钩子仅在 `PINOVEL_SIGKILL_FAULT_POINT === faultPoint` 且
 *     `PINOVEL_SIGKILL_MARKER_DIR` 已设置时生效；生产永不设置这两个 env，函数立即返回。
 *   - 同步阻塞：写 marker 文件后 `Atomics.wait(..., timeout=10min)` 阻塞主线程，
 *     使进程停留在故障点；SIGKILL 不可被 catch，故后续代码不会执行。
 *   - 超时兜底：10 分钟后返回 "timed-out"，进程自然继续（测试框架应在 marker 出现后
 *     立即 SIGKILL，通常远早于超时）。避免测试框架失效时子进程永久悬挂。
 *   - 失败不抛：注入失败（无 marker 目录等）静默返回，绝不阻断业务主路径。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 故障点阻断超时（毫秒）：10 分钟，兜底防悬挂 */
const FAULT_BLOCK_TIMEOUT_MS = 600_000;

/**
 * 在指定故障点注入真实 SIGKILL 阻断。
 *
 * 仅当 `process.env.PINOVEL_SIGKILL_FAULT_POINT === faultPoint` 且
 * `PINOVEL_SIGKILL_MARKER_DIR` 已设置时，写 marker 并同步阻塞；否则立即返回。
 */
export function injectSigkillFault(faultPoint: string): void {
  const target = process.env.PINOVEL_SIGKILL_FAULT_POINT;
  if (!target || target !== faultPoint) return;
  const markerDir = process.env.PINOVEL_SIGKILL_MARKER_DIR;
  if (!markerDir) return;
  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `${faultPoint}.marker`), "reached\n", "utf-8");
    // 同步阻塞主线程，等待外部 SIGKILL；超时兜底返回，不永久悬挂。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FAULT_BLOCK_TIMEOUT_MS);
  } catch {
    // 注入失败不阻断主路径（仅测试启用，生产永不触发）。
  }
}
