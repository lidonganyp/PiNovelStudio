/**
 * 生产风险门接口设计（Step 4 of 4，interface only）
 *
 * 设计目标：在 EvidencePlan.mustVerify 和 Agentic loop 检索决策之间插入风险门，
 * 实现"P0/P1 未确认事实必须检索并确认；上下文已覆盖且无高风险未知时允许跳过"。
 *
 * ⚠️ 当前状态：interface only，stub 始终 passed=true（保持生产行为不变）。
 * 实际风险分类与覆盖检查逻辑在 Step 1-3 事实安全重新通过后实现。
 *
 * 集成点（未来，不在本 Step 实现）：
 * - narrative-agent-loop.ts:280 当前默认强制检索 prompt
 * - 未来：loop 调用 coverageGate.checkAndBlock() 决定是否阻断
 *   - passed=true + skippedReason="context_covered" → 跳过检索
 *   - passed=false + failureEnvelope → agent_loop_retry_with_explicit_must_verify_prompt
 * - orchestrator-factguard.ts 可选消费 unverifiedHighRisk 追加 hard diagnostic
 *
 * 硬约束：
 * - FactGuard、权限、预算保持系统控制，风险门不干预
 * - 风险门只决定"是否需要检索/重试"，不决定"是否交付"
 * - 交付决策仍由 FactGuard + StoryPreservation + Completeness 把关
 * - 文学评价权归用户（风险门只管事实安全）
 *
 * 模块位置：novelos/agent/must-verify-coverage-gate.ts
 * 构建目标：tsconfig.eval.json（eval-only，不入 tsconfig.prod.json）
 */

import type { EvidencePlan } from "./evidence-plan.js";

// ============================================================================
// 风险等级
// ============================================================================

/**
 * 事实风险等级。
 *
 * - P0：高影响事实（角色状态变更、世界规则、不可违反事实）→ 必须检索确认
 * - P1：重要事实（关系、时间线、承诺）→ 应当检索确认
 * - P2：低风险事实（次要细节、风格参考）→ 上下文已覆盖时可跳过
 */
export type FactRiskLevel = "P0" | "P1" | "P2";

// ============================================================================
// 分类结果
// ============================================================================

/**
 * mustVerify 项的风险分类结果。
 */
export interface ClassifiedMustVerify {
  /** 原始 mustVerify 项（来自 EvidencePlan.mustVerify） */
  item: string;
  /** 风险等级 */
  riskLevel: FactRiskLevel;
  /** 分类理由（写入 trace） */
  reason: string;
}

// ============================================================================
// 覆盖门输入
// ============================================================================

/**
 * 覆盖门输入。
 *
 * evidencePlan 含 mustVerify 项；trajectoryPath 用于读取 agent loop 收集的证据；
 * inviolableFacts 用于 P0 分类（与不可违反事实文本重叠的项升级为 P0）；
 * contextCoveredFacts 是已在 CompiledContext.facts 中的事实，不要求检索。
 */
export interface CoverageGateInput {
  /** EvidencePlan（含 mustVerify 项） */
  evidencePlan: EvidencePlan;
  /** trajectory 文件路径（读取 confirmed 证据） */
  trajectoryPath: string;
  /** 不可违反的事实（来自 ChapterIntent.inviolableFacts） */
  inviolableFacts: string[];
  /** 已在 CompiledContext.facts 中覆盖的事实（不要求检索） */
  contextCoveredFacts: string[];
}

// ============================================================================
// 覆盖门失败 envelope
// ============================================================================

/**
 * 覆盖门失败时的结构化 envelope（对齐 AGENTS.md FailureEnvelope 规范）。
 *
 * 当 passed=false 时设置，包含未确认的高风险事实证据。
 * 恢复策略：agent_loop_retry_with_explicit_must_verify_prompt。
 */
export interface CoverageGateFailureEnvelope {
  /** 阶段名 */
  stage: "must_verify_coverage_gate";
  /** 门禁名 */
  gate: "unverified_high_risk_facts";
  /** 严重程度（P0/P1 未确认 = hard） */
  severity: "hard";
  /** 未确认的高风险事实证据 */
  evidence: Array<{
    item: string;
    riskLevel: FactRiskLevel;
    reason: string;
  }>;
  /** 是否可恢复（true：可重试 agent loop） */
  recoverable: true;
  /** 重试计划 */
  retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt";
}

// ============================================================================
// 覆盖门结果
// ============================================================================

/**
 * 覆盖门检查结果。
 *
 * - passed=true：门禁通过（所有 P0/P1 已确认，或无 mustVerify，或上下文已覆盖）
 * - passed=false：门禁阻断（存在未确认的 P0/P1 项，设置 failureEnvelope）
 *
 * skippedReason 取值：
 * - "no_must_verify"：mustVerify 为空
 * - "context_covered"：所有 P0/P1 已被 contextCoveredFacts 覆盖
 * - "no_high_risk"：无 P0/P1 项（仅 P2）
 * - "stub_not_implemented"：stub 未实现实际检查
 */
export interface CoverageGateResult {
  /** 是否通过 */
  passed: boolean;
  /** 未确认的高风险事实（passed=false 时非空） */
  unverifiedHighRisk: Array<{
    item: string;
    riskLevel: FactRiskLevel;
    reason: string;
  }>;
  /** 已确认的事实（passed=true 时含已匹配的证据） */
  confirmedItems: Array<{
    item: string;
    matchedEvidence: string;
  }>;
  /** 跳过原因（passed=true 时设置） */
  skippedReason?:
    | "no_must_verify"
    | "context_covered"
    | "no_high_risk"
    | "stub_not_implemented";
  /** 失败 envelope（passed=false 时设置） */
  failureEnvelope?: CoverageGateFailureEnvelope;
}

// ============================================================================
// 覆盖门接口
// ============================================================================

/**
 * 生产风险门接口。
 *
 * 实现类需提供 checkAndBlock 方法，消费 CoverageGateInput 并返回 CoverageGateResult。
 */
export interface CoverageGate {
  /**
   * 检查 mustVerify 覆盖情况，决定是否阻断。
   *
   * @param input 覆盖门输入
   * @returns 覆盖门结果
   */
  checkAndBlock(input: CoverageGateInput): CoverageGateResult;
}

// ============================================================================
// Stub 实现（保持生产行为不变）
// ============================================================================

/**
 * 对 mustVerify 项进行风险分类（stub）。
 *
 * ⚠️ Stub 行为：全部返回 P0（最保守分类）。
 *
 * 实际分类规则（未来实现）：
 * - P0：与 inviolableFacts 文本重叠 / 角色身份 / 世界规则硬冲突
 * - P1：含"状态"/"位置"/"时间"关键词
 * - P2：其他（advisory，不强制检索）
 *
 * @param mustVerify mustVerify 项列表
 * @param _inviolableFacts 不可违反的事实（stub 不使用，下划线前缀）
 * @returns 分类结果（stub 全部 P0）
 */
export function assessMustVerifyRisk(
  mustVerify: string[],
  _inviolableFacts: string[],
): ClassifiedMustVerify[] {
  // Stub：全部 P0（最保守，保持生产行为不变）
  return mustVerify.map((item) => ({
    item,
    riskLevel: "P0" as FactRiskLevel,
    reason: "stub: 全部分类为 P0（实际分类逻辑待 Step 1-3 通过后实现）",
  }));
}

/**
 * 检查 mustVerify 覆盖情况（stub）。
 *
 * ⚠️ Stub 行为：始终返回 passed=true + skippedReason="stub_not_implemented"。
 * 不读取 trajectory，不做实际覆盖检查。
 *
 * 实际检查逻辑（未来实现）：
 * 1. 调用 assessMustVerifyRisk 分类
 * 2. 读取 trajectory 提取 confirmed 证据
 * 3. 检查每个 P0/P1 项是否有 confirmed 证据匹配
 * 4. 检查 contextCoveredFacts 是否已覆盖
 * 5. 存在未确认 P0/P1 → passed=false + failureEnvelope
 *
 * @param _input 覆盖门输入（stub 不使用实际数据）
 * @returns 覆盖门结果（stub 始终 passed=true）
 */
export function checkMustVerifyCoverage(
  _input: CoverageGateInput,
): CoverageGateResult {
  // Stub：始终通过（保持生产行为不变，不阻断任何生成）
  // 显式设置 failureEnvelope: undefined 以保证类型结构完整（in 操作符可检测字段存在）。
  return {
    passed: true,
    unverifiedHighRisk: [],
    confirmedItems: [],
    skippedReason: "stub_not_implemented",
    failureEnvelope: undefined,
  };
}

/**
 * 创建 stub 覆盖门工厂。
 *
 * ⚠️ Stub 行为：checkAndBlock 委托 checkMustVerifyCoverage，始终 passed=true。
 *
 * 未来实现时替换为 createMustVerifyCoverageGate()，含实际风险分类与覆盖检查。
 *
 * @returns stub 覆盖门
 */
export function createStubCoverageGate(): CoverageGate {
  return {
    checkAndBlock(input: CoverageGateInput): CoverageGateResult {
      return checkMustVerifyCoverage(input);
    },
  };
}
