/**
 * TRACE-WRITE-MODE — quality-trace 写路径模式开关（P7 Stage C-2）
 *
 * Stage C 目标：把 quality-trace.json / TrajectoryStore 从「独立写入」逐步降为
 * 「审计流投影缓存」。分两步执行：
 *   - Stage C-1：加可控开关 + 等价物化，默认 OFF（legacy 不变）。
 *   - Stage C-2（本阶段）：默认值切换为 projection，保留 legacy 强制回退。
 *
 * 开关：环境变量 PINOVEL_TRACE_WRITE_MODE
 *   - "legacy"：强制回退 legacy 模式（quality-trace.json 继续全量写入）
 *   - 其他 / 未设置：projection 模式（明细迁独立内容库，旧文件物化为投影缓存）
 *
 * 注意：本开关只覆盖 quality-trace 写路径；TrajectoryStore 降级是后续独立子阶段，
 * 不在本开关作用范围内。
 *
 * 本模块只做纯函数开关解析，无 I/O、无副作用，便于在生产/测试间复用。
 */

export type TraceWriteMode = "legacy" | "projection";

export const TRACE_WRITE_MODE_ENV = "PINOVEL_TRACE_WRITE_MODE" as const;

/**
 * 解析当前写路径模式。默认 projection（Stage C-2 起切换默认值）；
 * 显式 PINOVEL_TRACE_WRITE_MODE=legacy 时强制回退 legacy。
 *
 * 显式注入 env 便于测试；生产调用不传参数，直接读 process.env。
 */
export function resolveTraceWriteMode(
  env: NodeJS.ProcessEnv = process.env,
): TraceWriteMode {
  return env[TRACE_WRITE_MODE_ENV] === "legacy" ? "legacy" : "projection";
}
