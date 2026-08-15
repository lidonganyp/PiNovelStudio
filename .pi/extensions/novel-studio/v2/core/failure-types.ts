/**
 * FAILURE-TYPES — 统一失败分类真相源（计划：失败恢复、重试与中断语义 P0）
 *
 * 生产环境只保留五类：
 *   preflight | recoverable | interrupted | blocked | fatal
 *
 * 废止生产语义：soft / hard_block / hard
 * 历史 trace 仅允许通过 mapLegacyFailureClass 只读映射。
 */

/** 生产失败分类（唯一合法集合） */
export type FailureClass =
  | "preflight"
  | "recoverable"
  | "interrupted"
  | "blocked"
  | "fatal";

/** 历史/兼容分类（不得写入新生产 trace） */
export type LegacyFailureClass =
  | "soft"
  | "hard_block"
  | "hard"
  | "preflight"
  | "recoverable"
  | "fatal"
  | "interrupted"
  | "blocked"
  | string;

/**
 * 将历史 severity / soft / hard_block 映射为统一 FailureClass。
 * 仅用于读取旧 trace / 兼容旧调用；新生产路径必须直接写 FailureClass。
 */
export function mapLegacyFailureClass(
  legacy: LegacyFailureClass | null | undefined,
): FailureClass {
  const v = String(legacy ?? "").toLowerCase().trim();
  switch (v) {
    case "preflight":
      return "preflight";
    case "recoverable":
    case "soft":
      return "recoverable";
    case "interrupted":
      return "interrupted";
    case "blocked":
    case "hard_block":
    case "hard":
      return "blocked";
    case "fatal":
      return "fatal";
    default:
      // 未识别 → blocked（保守：不可自动继续）
      return "blocked";
  }
}

/** 该分类是否允许自动恢复尝试 */
export function isAutomaticallyRecoverable(failureClass: FailureClass): boolean {
  return failureClass === "recoverable";
}

/** 该分类是否禁止自动进入 committed */
export function isNonAutoContinue(failureClass: FailureClass): boolean {
  return (
    failureClass === "blocked" ||
    failureClass === "interrupted" ||
    failureClass === "fatal" ||
    failureClass === "preflight"
  );
}

/** UnifiedFailureEnvelope.severity 历史字段 → FailureClass */
export function severityToFailureClass(
  severity: string | undefined | null,
): FailureClass {
  return mapLegacyFailureClass(severity ?? "hard");
}

/**
 * FailureClass → 对外兼容 severity（工具层重试条件仍读 severity）。
 * recoverable 保持 recoverable；其余映射为 preflight/hard/fatal。
 */
export function failureClassToCompatSeverity(
  failureClass: FailureClass,
): "preflight" | "recoverable" | "hard" | "fatal" {
  switch (failureClass) {
    case "preflight":
      return "preflight";
    case "recoverable":
      return "recoverable";
    case "fatal":
      return "fatal";
    case "interrupted":
    case "blocked":
    default:
      return "hard";
  }
}
