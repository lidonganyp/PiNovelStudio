/**
 * ReleaseHealthThresholds — G8 健康判定阈值常量（EVOLUTION-RELEASE-GOVERNANCE-G8）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §8 Phase G8
 * 计划：.trae/documents/g8-health-monitoring-and-retirement-implementation.md §2.2
 *
 * 健康判定阈值用于 release-health-evaluator，定义何时触发：
 * - auto_hold_eligible（连续负收益 → 短期坏信号）
 * - retired_suggestion（长期负收益 → 建议退役）
 * - healthy / warning（健康水位）
 *
 * 设计原则：
 * - 阈值集中管理，便于全局调优与审计
 * - 阈值与 strategy-policy-store 的 MIN_SAMPLE_SIZE 保持一致（=3）
 * - 滞回：RECOVERY_ALIGNMENT_RATE (0.8) > AUTO_HOLD_ALIGNMENT_RATE (0.4)
 *   恢复 active 需更高水位，避免阈值附近抖动反复触发 hold/release
 *
 * 边界（READY_LOCAL）：
 * - 仅导出常量，不含逻辑、不调模型、不读写文件
 * - 可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 */

// ============================================================================
// 健康判定阈值
// ============================================================================

/** 最小样本量：feedback 记录数 < 3 时判定为 insufficient_data */
export const MIN_SAMPLE_SIZE = 3;

/** 健康水位：alignmentRate >= 0.7 判定为 healthy */
export const HEALTHY_ALIGNMENT_RATE = 0.7;

/** auto-hold 触发水位：alignmentRate < 0.4 判定为 auto_hold_eligible */
export const AUTO_HOLD_ALIGNMENT_RATE = 0.4;

/** auto-hold 触发水位：rollbackRate > 0.3 判定为 auto_hold_eligible */
export const AUTO_HOLD_ROLLBACK_RATE = 0.3;

/** auto-hold 触发水位：consecutiveNegative >= 3 判定为 auto_hold_eligible */
export const AUTO_HOLD_CONSECUTIVE_NEGATIVE = 3;

/** retired 建议触发水位：longTermAlignmentRate < 0.3 判定为 retired_suggestion */
export const RETIRED_ALIGNMENT_RATE = 0.3;

/** retired 建议评估窗口：最近 10 个 feedback 评估长期 alignmentRate */
export const RETIRED_EVALUATION_WINDOW = 10;

/**
 * 滞回恢复水位：recoveryAlignmentRate = 0.8
 *
 * 已 held 的 release 恢复 active 需 alignmentRate >= 0.8，
 * 高于 AUTO_HOLD_ALIGNMENT_RATE (0.4)，避免阈值附近抖动反复触发 hold/release。
 *
 * 用户可通过 `evolution:promote --target active_dev --force` override 滞回。
 */
export const RECOVERY_ALIGNMENT_RATE = 0.8;

/** auto-hold 触发水位：factGuardPassRate < 0.5 判定为 auto_hold_eligible */
export const AUTO_HOLD_FACTGUARD_PASS_RATE = 0.5;
