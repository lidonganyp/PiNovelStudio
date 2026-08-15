/**
 * TRAJECTORY-WRITE-MODE — TrajectoryStore 写路径模式开关（P7 Stage C-3）
 *
 * Stage C 目标：把 quality-trace.json / TrajectoryStore 从「独立写入」逐步降为
 * 「审计流投影缓存」。分步执行：
 *   - Stage C-2：quality-trace 默认切换 projection（已完成，独立开关 PINOVEL_TRACE_WRITE_MODE）。
 *   - Stage C-3（本阶段）：TrajectoryStore 降级为审计流/内容库投影。
 *
 * 开关：环境变量 PINOVEL_TRAJECTORY_WRITE_MODE
 *   - "legacy"：强制回退 legacy 模式（trajectory.jsonl 继续全量写入，不产内容库）
 *   - 其他 / 未设置：projection 模式（完整明细迁独立内容库 trajectory-content.jsonl，
 *     旧 trajectory.jsonl 继续作为投影缓存全量写，暂不删除）
 *
 * 与 quality-trace 开关（PINOVEL_TRACE_WRITE_MODE）相互独立，二者可分别回退。
 *
 * 本模块只做纯函数开关解析，无 I/O、无副作用，便于在生产/测试间复用。
 */

export type TrajectoryWriteMode = "legacy" | "projection";

export const TRAJECTORY_WRITE_MODE_ENV = "PINOVEL_TRAJECTORY_WRITE_MODE" as const;

/**
 * 解析当前 TrajectoryStore 写路径模式。默认 projection（Stage C-3 起）；
 * 显式 PINOVEL_TRAJECTORY_WRITE_MODE=legacy 时强制回退 legacy。
 *
 * 显式注入 env 便于测试；生产调用不传参数，直接读 process.env。
 */
export function resolveTrajectoryWriteMode(
  env: NodeJS.ProcessEnv = process.env,
): TrajectoryWriteMode {
  return env[TRAJECTORY_WRITE_MODE_ENV] === "legacy" ? "legacy" : "projection";
}
