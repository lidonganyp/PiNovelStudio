/**
 * V2 Legacy Trace Adapter（Task 15 完整实现）
 *
 * 目标（规格 P11 保留资产清单第 12 项 + Task 15 验收口径）：
 * - V2 stage 写入 legacy QualityTraceDocument.gates[]（stage 名加 v2_ 前缀）
 * - V2 repairs 写入 legacy QualityTraceDocument.patches[]
 * - V2 error/降级写入 legacy QualityTraceDocument.failureEnvelopes[]
 * - 跨阶段聚合视图写入 legacy QualityTraceDocument.v2Summary（P44 新增字段）
 * - 与 legacy trace 合并写入（appendExisting 模式），不绕过 legacy 落盘格式
 *
 * 设计原则：
 * - trace 是"可回放证据"，不是"门禁触发器"——V2 通过 trace 暴露候选/比较/选择证据
 * - V2 trace 必须能被 replay benchmark 与 legacy QualityTraceDocument 解析器读取
 * - 写入失败不阻断生成（trace 缺失可补，正文污染不可逆）
 * - 路径约定对齐 legacy：{workspacePath}/{workspaceId}/traces/{chapterId}-quality-trace.json
 *   （V2TraceAdapterOptions.workspacePath 是 workspace 父目录，与 legacy 一致）
 *
 * 实现方式：
 * - 顶层静态 import legacy QualityTraceRecorder（包名导入，node_modules/novel-studio Junction）
 * - 同步可用，flush() 无 async 竞态
 * - setV2Summary 可选：legacy dist 若未含 P44 新增方法则跳过（gates/patches 仍写入）
 */

import { QualityTraceRecorder } from "../../craft/quality-trace-recorder.js";
import type { FailureEnvelope } from "../../craft/failure-envelope.js";
import type { AuditEventRecorder } from "../core/audit/audit-event-recorder.js";
import type { TraceWriteMode } from "../core/audit/trace-write-mode.js";
import type { TraceContentStore } from "../core/audit/trace-content-store.js";
import type {
  Candidate,
  CandidateComparison,
  Diagnostic,
  EditorialPlan,
  FinalSelectionReport,
  SceneContract,
  CompiledContext,
} from "../core/types.js";
import { classifyCandidateSource } from "../core/candidate-source.js";
import type { ModelCallEntry } from "../core/unified-orchestrator.js";

// ============================================================================
// V2TraceRecord — V2 单条 trace 记录
// ============================================================================

export type V2TraceStage =
  | "context_compiled"
  | "scene_contract_planned"
  | "editorial_plan_planned"
  | "candidate_generated"
  | "diagnostic_run"
  | "candidate_compared"
  | "final_selected"
  | "repair_planned"
  | "loopback"
  | "error"
  // Phase D 新增：编排重构后，先生成 rawStage2 候选再构建 SceneContract
  | "rawstage2_generated"
  // Step 5 新增：NovelOS agentic_raw shadow 候选（trajectory + budget snapshot）
  | "novelos_agentic";

// ============================================================================
// A6：完整 judge 证据 trace 结构（计划 §12）
// ============================================================================

/**
 * 单轮裁判证据（first / reverse / arbitration）。
 * 持久化匿名映射、verdict、evidence spans，供回放/审计复现裁判过程。
 */
export interface JudgeRoundTrace {
  round: "first" | "reverse" | "arbitration";
  /** 反匿名后的 winner 候选 id（tie/降级为 null） */
  winnerCandidateId: string | null;
  degraded: boolean;
  degradeReason?: string;
  /** 匿名映射：A/B 标签 ↔ 物理候选 id（可复现顺序随机化） */
  mapping: {
    leftCandidateId: string;
    rightCandidateId: string;
    leftLabel: "A" | "B";
    rightLabel: "A" | "B";
    orderRandomized: boolean;
    seed: number;
  };
  /** 裁判 verdict（降级/parse 失败时为 null） */
  verdict: {
    winner: "A" | "B" | "tie";
    confidence: "clear" | "slight" | "uncertain";
    decisiveReasons: Array<{
      dimension: string;
      betterCandidate: "A" | "B" | "neither";
      evidenceA: Array<{ start: number; end: number; excerpt?: string }>;
      evidenceB: Array<{ start: number; end: number; excerpt?: string }>;
      explanation: string;
    }>;
    factualRisks: string[];
    regressionRisks: string[];
    constitutionAlignment: string;
  } | null;
  /** span 证据校验结果 */
  evidenceValidation: { ok: boolean; errors: string[] };
}

/**
 * 完整 judge 仲裁证据（A6，计划 §12）。
 * 持久化全部轮次的匿名映射、verdict 与 evidence spans，不再只压缩成 auditSummary。
 */
export interface JudgeEvidenceTrace {
  /** 最终选择决策 */
  selection: {
    selectedCandidateId: string | null;
    reason: string;
    needsReverseReview: boolean;
  };
  reverseReviewed: boolean;
  arbitrationTriggered: boolean;
  conflicted: boolean;
  finalSelectedCandidateId: string | null;
  /** 审计摘要（向后兼容，仍保留） */
  auditSummary: string;
  /** 每轮证据（first / reverse / arbitration） */
  rounds: JudgeRoundTrace[];
}

export interface V2TraceRecord {
  /** 阶段标识 */
  stage: V2TraceStage;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 耗时 ms */
  durationMs?: number;
  /** 候选列表（candidate_generated / compared / selected 阶段） */
  candidates?: Candidate[];
  /** 场景契约（scene_contract_planned 阶段） */
  sceneContracts?: SceneContract[];
  /** 诊断结果（diagnostic_run 阶段） */
  diagnostics?: Diagnostic[];
  /** 比较结果（candidate_compared 阶段） */
  comparison?: CandidateComparison;
  /**
   * A6（计划 §12）：完整 judge 仲裁证据。
   * 持久化全部轮次的匿名映射、verdict 与 evidence spans，
   * 不再只压缩成 auditSummary。供回放/审计复现裁判过程。
   */
  judgeEvidence?: JudgeEvidenceTrace;
  /**
   * B4：全部候选的完整 judge 仲裁证据。
   * judgeEvidence 只含最终选中候选的仲裁证据；allJudgeEvidence 含全部 editorial
   * 候选的完整证据（匿名映射/verdict/spans），供回放/审计复现完整裁判过程。
   * 无 editorial 候选或仅单候选时为 undefined（judgeEvidence 已足够）。
   */
  allJudgeEvidence?: JudgeEvidenceTrace[];
  /** 最终选择（final_selected 阶段） */
  finalSelection?: FinalSelectionReport;
  /** 修复计划（repair_planned 阶段） */
  repairPlan?: {
    disposition: string;
    repairs: Array<{ candidateId: string; kind: string; rationale: string }>;
  };
  /** 错误信息（error 阶段） */
  error?: { message: string; code?: string; recoverable: boolean };
  /**
   * P1 修复（第三轮）：完整 FailureEnvelope，用于 blocked 路径透传真实 stage/gate/severity/retryPlan/userActionRequired。
   *
   * 用户验收反例：常规 blocked 路径固定写成 stage=error，适配器再落成 stage/gate=v2_error，
   * 丢失真实 gate、severity、retryPlan、userActionRequired。
   * 新增此字段后，legacy-trace-adapter 优先使用完整 envelope，而非从 error 字段重建。
   */
  failureEnvelope?: FailureEnvelope;
  /** 上下文 hash（所有阶段都记录，便于关联） */
  contextHash?: string;
  /** MODEL-PROMPT-EVOLUTION-1：生产 Bundle hash（system prompt + toolSchema + budget + identity） */
  bundleId?: string;
  /** MODEL-PROMPT-EVOLUTION-1：bundle hash 覆盖的维度（供审计判断覆盖范围） */
  bundleHashDimensions?: string[];
  /** Phase D 新增：rawStage2 候选 id（rawstage2_generated 阶段） */
  rawStage2CandidateId?: string;
  /** Phase D 新增：rawStage2 候选正文长度（rawstage2_generated 阶段） */
  rawStage2TextLength?: number;
  /** Phase D 续新增：rawStage2 缺失标记（空生成重试耗尽时 true，下游契约重生成跳过） */
  rawStage2Missing?: boolean;
  /** Layer 2 新增：editorial_amplified 编辑意图简报（editorial_plan_planned 阶段） */
  editorialPlan?: EditorialPlan;
  /** Layer 2 新增：EditorialPlan 是否降级（editorial_plan_planned 阶段） */
  degraded?: boolean;
  /** Layer 2 新增：EditorialPlan 降级原因（editorial_plan_planned 阶段） */
  degradeReason?: string;
  /** Layer 2 新增：amplified 变体候选 id 列表（candidate_generated 阶段，便于多变体追踪） */
  amplifiedVariantIds?: string[];
  /** Step 1c：模型调用遥测（final_selected 阶段），每次调用的 route/kind/model/duration/ts */
  modelCalls?: ModelCallEntry[];
  /** Step 1c：各阶段耗时 ms（final_selected 阶段） */
  stageTiming?: Record<string, number>;
  /** Step 1d：模型调用预算（final_selected 阶段） */
  modelBudget?: { soft: number; hard: number; used: number; capped: boolean };
  /**
   * MODEL-ROUTING-GOVERNANCE：分层预算 / 观测 / 失败策略 / 质量-成本分析。
   * 由 unified-orchestrator 出口写入 stageResults，再由 unified-entry 持久化到
   * final_selected 与 blocked error 记录，供 quality-trace.json 验收。
   */
  routingGovernance?: unknown;
  layeredBudget?: unknown;
  modelCallObservability?: unknown;
  qualityCostAnalysis?: unknown;
  failureStrategyDecision?: unknown;
  failureStrategyTrace?: unknown;
  /**
   * 成功章节的用户反馈归因上下文。
   * novel_strategy_feedback 可凭 chapterId 从 trace 推断这些字段，避免普通用户手填内部版本键/策略 ID。
   */
  strategyContext?: {
    modelVersion: string;
    selectedStrategyIds: string[];
    sourceChapter: string;
    opportunityType: "author_style" | string;
    /** USER-FEEDBACK-EVIDENCE-PIPELINE-1：完整 StrategyExposure 可选字段 */
    strategyBundleId?: string;
    orchestratorRunId?: string;
    exposureId?: string;
    promptBundleId?: string;
    candidateId?: string;
    deliveredSource?: "raw" | "fallback" | "editorial";
    exposureSnapshot?: unknown;
  };
  /**
   * Step 5：NovelOS agentic_raw shadow 候选摘要（novelos_agentic 阶段）。
   * 持久化 trajectory 路径 + agentic_raw 摘要 + budget snapshot，
   * 供回放/审计复现 NovelOS agent loop 的证据收集与生成过程。
   */
  novelos?: {
    shadowEnabled: boolean;
    /** 正式生产必经阶段；false/省略表示历史 shadow/评测记录。 */
    required?: boolean;
    sessionId?: string;
    trajectoryPath?: string;
    candidateId?: string | null;
    candidateLength?: number;
    stopReason?: string;
    failureReason?: string | null;
    budgetSnapshot?: unknown;
    sourceRefs?: string[];
    toolCalls?: number;
    error?: string;
  };
  /**
   * Phase 4 C9：release governance 绑定（final_selected 阶段）。
   * 用于 canary 证据跨 release 校验：verifyCanaryResultArtifacts 校验
   * chapter trace 内的 releaseGovernance 与目标 release 绑定一致。
   * devMode=true 时 releaseId/environmentFingerprint/approvalRef 可为 null。
   */
  releaseGovernance?: {
    releaseId: string | null;
    environmentFingerprint: string | null;
    approvalRef: string | null;
    devMode: boolean;
    canaryEvidenceRunId?: string | null;
  };
}

// ============================================================================
// V2TraceAdapter 接口
// ============================================================================

export interface V2TraceAdapter {
  /** 记录一条 V2 trace（映射到 legacy gates[]/patches[]/failureEnvelopes[]，缓冲到 flush） */
  record(record: V2TraceRecord): void;
  /** 把缓冲写入 trace 文件，返回文件路径（失败返回 undefined） */
  flush(): string | undefined;
  /** 读取已缓冲的记录数（测试用） */
  size(): number;
  /**
   * 设置 V2 运行模式（full_chain / rawStage2 / direct_baseline）。
   * 在 flush 前由 orchestrator 调用，写入 v2Summary.v2Mode。
   */
  setV2Mode?(mode: "full_chain" | "rawStage2" | "direct_baseline"): void;
}

// ============================================================================
// V2TraceAdapter 选项
// ============================================================================

export interface V2TraceAdapterOptions {
  /**
   * workspace 父目录路径（与 legacy QualityTraceRecorder 一致）。
   * legacy recorder 内部构造路径：join(workspacePath, workspaceId, "traces", "{chapterId}-quality-trace.json")
   * 即 workspacePath 应是 workspaces/ 目录，workspaceId 是子目录名。
   */
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  /** 是否追加到已有 trace（默认 true，与 legacy 多实例 append 模式一致） */
  append?: boolean;
  /** P7 Stage A 双写：透传给 QualityTraceRecorder 的可选审计事件追加口。 */
  auditSink?: AuditEventRecorder;
  /** P7 Stage C-1：透传写路径模式（默认 resolveTraceWriteMode() 解析）。 */
  writeMode?: TraceWriteMode;
  /** P7 Stage C-1：透传明细独立内容库（projection 模式下 recordGate 分流写入）。 */
  contentStore?: TraceContentStore;
}

// ============================================================================
// V2TraceSummary 形状（与 legacy V2TraceSummary 接口对齐）
// ============================================================================

interface V2TraceSummaryShape {
  v2Mode: "full_chain" | "rawStage2" | "direct_baseline";
  candidateCount: number;
  /** comparator 比较胜出候选 id（区别于 finalSelectedId） */
  winnerId?: string;
  /** comparator 比较胜出候选来源 */
  winnerSource?: string;
  /** comparator 置信度（0-1） */
  comparatorConfidence?: number;
  /** FinalSelector 最终交付候选 id */
  finalSelectedId?: string;
  /** FinalSelector 最终交付候选来源 */
  finalSelectedSource?: string;
  projectGain?: "positive" | "negative" | "neutral";
  /** Layer 2 新增：amplified 变体候选 id 列表（多变体追踪，editorial_amplified kind） */
  amplifiedVariantIds?: string[];
  contextHash?: string;
  stages: Array<{ stage: string; timestamp: string; durationMs?: number }>;
}

// ============================================================================
// 完整实现：委托 legacy QualityTraceRecorder
// ============================================================================

/**
 * 创建 V2 trace adapter（Task 15 完整实现）。
 *
 * - record() 把 V2TraceRecord 映射为 gates[]（v2_ 前缀）/patches[]/failureEnvelopes[]
 * - flush() 写入 v2Summary 后调用 legacy recorder.flush()，落盘到 {chapterId}-quality-trace.json
 * - setV2Summary 可选调用：legacy dist 若未含 P44 新增方法则跳过（gates/patches 仍写入）
 *
 * 路径约定（与 legacy 一致）：{workspacePath}/{workspaceId}/traces/{chapterId}-quality-trace.json
 */
export function createLegacyTraceAdapter(
  options: V2TraceAdapterOptions,
): V2TraceAdapter {
  const recorder = new QualityTraceRecorder({
    workspacePath: options.workspacePath,
    workspaceId: options.workspaceId,
    chapterId: options.chapterId,
    appendExisting: options.append !== false,
    auditSink: options.auditSink,
    writeMode: options.writeMode,
    contentStore: options.contentStore,
  });
  const records: V2TraceRecord[] = [];
  let v2Mode: "full_chain" | "rawStage2" | "direct_baseline" = "full_chain";

  return {
    record(record: V2TraceRecord): void {
      records.push(record);
      // 映射到 legacy gates[]
      recorder.recordGate(mapRecordToGate(record));
      // 映射 repairs 到 patches[]
      if (record.repairPlan) {
        for (const repair of record.repairPlan.repairs) {
          recorder.recordPatch({
            stage: "v2_repair",
            accepted: repair.kind !== "chapter_rewrite" && repair.kind !== "no_op",
            beforeScore: 0,
            afterScore: 0,
            scoreDelta: 0,
            reason: `${repair.kind}: ${repair.rationale}`,
          });
        }
      }
      // 映射 error 到 failureEnvelopes[]
      // P1 修复（第三轮）：优先使用完整 failureEnvelope（含真实 gate/severity/retryPlan/userActionRequired），
      // 而非从 error 字段重建（旧逻辑固定 stage/gate=v2_error，丢失真实阻断阶段信息）。
      if (record.failureEnvelope) {
        recorder.recordFailureEnvelope({
          stage: record.failureEnvelope.stage,
          gate: record.failureEnvelope.gate,
          severity: record.failureEnvelope.severity,
          reason: record.failureEnvelope.reason,
          evidence: record.failureEnvelope.evidence ?? record.failureEnvelope.stage,
          recoverable: record.failureEnvelope.recoverable,
          retryPlan: record.failureEnvelope.retryPlan,
          userActionRequired: record.failureEnvelope.userActionRequired,
        });
      } else if (record.error) {
        recorder.recordFailureEnvelope({
          stage: `v2_${record.stage}`,
          gate: `v2_${record.stage}`,
          severity: record.error.recoverable ? "recoverable" : "hard_block",
          reason: record.error.message,
          evidence: record.error.code,
          recoverable: record.error.recoverable,
        });
      }
    },
    setV2Mode(mode: "full_chain" | "rawStage2" | "direct_baseline"): void {
      v2Mode = mode;
    },
    size(): number {
      return records.length;
    },
    flush(): string | undefined {
      try {
        // setV2Summary 可选：legacy dist 若未含 P44 新增方法则跳过（gates/patches 仍写入）
        const anyRecorder = recorder as unknown as {
          setV2Summary?(summary: V2TraceSummaryShape): void;
        };
        if (typeof anyRecorder.setV2Summary === "function") {
          anyRecorder.setV2Summary(buildV2Summary(records, v2Mode));
        }
        return recorder.flush();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[V2TraceAdapter] delegating flush failed: ${msg}`);
        return undefined;
      }
    },
  };
}

// ============================================================================
// 映射辅助：V2TraceRecord → QualityTraceGateRecord
// ============================================================================

function mapRecordToGate(record: V2TraceRecord): {
  stage: string;
  status: string;
  passed: boolean;
  blocked: boolean;
  score: number;
  reason: string;
  issueTypes: string[];
  revisionHints: string[];
  evidence?: unknown;
} {
  const hasError = !!record.error;
  const stage = `v2_${record.stage}`;
  // 各阶段语义化 status/reason
  let status = hasError ? "ERROR" : "PASS";
  let reason = hasError
    ? (record.error?.message ?? `V2 stage ${record.stage} failed`)
    : `V2 stage ${record.stage} completed`;
  let score = 0;

  if (record.stage === "candidate_compared" && record.comparison) {
    score = record.comparison.confidence;
    reason = `winner=${record.comparison.winnerId} confidence=${record.comparison.confidence.toFixed(2)}`;
  } else if (record.stage === "final_selected" && record.finalSelection) {
    score = record.finalSelection.projectGain === "positive" ? 1 : 0;
    reason = `selected=${record.finalSelection.selectedCandidateId} source=${record.finalSelection.selectedSource} gain=${record.finalSelection.projectGain}`;
  } else if (record.stage === "candidate_generated" && record.candidates) {
    score = record.candidates.length;
    reason = `${record.candidates.length} candidates generated`;
  } else if (record.stage === "diagnostic_run" && record.diagnostics) {
    const fatal = record.diagnostics.filter((d) => d.severity === "fatal").length;
    reason = `${record.diagnostics.length} diagnostics (${fatal} fatal)`;
    status = fatal > 0 ? "BLOCK" : "PASS";
  } else if (record.stage === "repair_planned" && record.repairPlan) {
    reason = `disposition=${record.repairPlan.disposition} repairs=${record.repairPlan.repairs.length}`;
  } else if (record.stage === "editorial_plan_planned") {
    reason = `variants=${record.editorialPlan?.variantStrategies.length ?? 0} degraded=${record.degraded ?? false} source=${record.editorialPlan?._source ?? "unknown"}`;
    if (record.degraded) {
      status = "WARN";
    }
  } else if (record.stage === "error") {
    status = "ERROR";
    reason = record.error?.message ?? "unknown error";
  }

  return {
    stage,
    status,
    passed: !hasError && status !== "BLOCK" && status !== "ERROR",
    blocked: status === "BLOCK" || status === "ERROR",
    score,
    reason,
    issueTypes: [],
    revisionHints: [],
    evidence: record, // 完整 V2 record 作为证据供深度回放
  };
}

// ============================================================================
// 聚合辅助：从 records 构建 V2TraceSummary
// ============================================================================

function buildV2Summary(
  records: V2TraceRecord[],
  v2Mode: "full_chain" | "rawStage2" | "direct_baseline",
): V2TraceSummaryShape {
  let candidateCount = 0;
  let candidates: Candidate[] | undefined;
  let comparatorWinnerId: string | undefined;
  let comparatorConfidence: number | undefined;
  let finalSelectedId: string | undefined;
  let finalSelectedSource: string | undefined;
  let projectGain: "positive" | "negative" | "neutral" | undefined;
  let contextHash: string | undefined;
  let amplifiedVariantIds: string[] | undefined;

  for (const r of records) {
    if (r.contextHash) contextHash = r.contextHash;
    if (r.stage === "candidate_generated" && r.candidates) {
      candidateCount = r.candidates.length;
      candidates = r.candidates;
      // Layer 2：收集 editorial_amplified 变体候选 id（多变体追踪）
      const editorialVariantIds = r.candidates
        .filter((c) => c.kind === "editorial_amplified")
        .map((c) => c.id);
      if (editorialVariantIds.length > 0) {
        amplifiedVariantIds = editorialVariantIds;
      }
    }
    if (r.stage === "candidate_compared" && r.comparison) {
      // comparator 比较胜出候选（总分最高），区别于 FinalSelector 最终交付候选
      comparatorWinnerId = r.comparison.winnerId;
      comparatorConfidence = r.comparison.confidence;
    }
    if (r.stage === "final_selected" && r.finalSelection) {
      finalSelectedId = r.finalSelection.selectedCandidateId;
      finalSelectedSource = r.finalSelection.selectedSource;
      projectGain = r.finalSelection.projectGain;
    }
  }

  // 推导 comparator winner 的 source（从候选列表按 id 查找并分类）
  let winnerSource: string | undefined;
  if (comparatorWinnerId && candidates) {
    const winnerCandidate = candidates.find((c) => c.id === comparatorWinnerId);
    if (winnerCandidate) {
      winnerSource = classifyCandidateSource(winnerCandidate);
    }
  }

  return {
    v2Mode,
    candidateCount,
    // winnerId = comparator 比较胜出候选（≠ finalSelectedId，后者是最终交付候选）
    winnerId: comparatorWinnerId,
    winnerSource,
    comparatorConfidence,
    finalSelectedId,
    finalSelectedSource,
    projectGain,
    amplifiedVariantIds,
    contextHash,
    stages: records.map((r) => ({
      stage: r.stage,
      timestamp: r.timestamp,
      durationMs: r.durationMs,
    })),
  };
}

// ============================================================================
// 辅助：从 CompiledContext 提取 contextHash（供 record.contextHash 用）
// ============================================================================

export function deriveContextHashFromCompiled(context: CompiledContext): string {
  // 轻量签名：facts/openLoops/characterStates 数量
  return [
    `f${context.facts.length}`,
    `l${context.openLoops.length}`,
    `c${context.characterStates.length}`,
    `w${context.worldRules.length}`,
    `s${context.styleReferences.length}`,
  ].join("-");
}
