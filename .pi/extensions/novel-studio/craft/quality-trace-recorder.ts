/**
 * PiNovelStudio — Quality trace recorder
 *
 * Persists compact evidence about selected rules, segment evaluations, and
 * accepted/rejected patches for later blind regression and author learning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { FailureEnvelope, FailureSeverity, RetryPlan } from "./failure-envelope.js";
// P7 Stage A 双写：只追加 failure_recorded 审计事件，不切换读路径、不改既有写路径。
import type { AuditEventRecorder } from "../v2/core/audit/audit-event-recorder.js";
import type { AuditStage } from "../v2/core/audit/audit-event-types.js";
import { computeContentHash, stableStringify } from "../v2/core/audit/content-hash.js";
import { mapLegacyFailureClass } from "../v2/core/failure-types.js";
// P7 Stage C-1 写路径开关 + 明细独立内容库 + 投影缓存物化（默认 legacy 不变）。
import { rebuildQualityTraceFromEvents } from "../v2/core/audit/trace-projections.js";
import { createTraceContentStore, type TraceContentStore } from "../v2/core/audit/trace-content-store.js";
import { resolveTraceWriteMode, type TraceWriteMode } from "../v2/core/audit/trace-write-mode.js";
// Phase 7: 以下 legacy type-only import 已内联或降级为 unknown，解除对 dead craft 文件的耦合
// EventDialogueContract / EventProgressionTrace / SegmentRevisionBaselineTrace /
// SegmentCraftMetrics / MicroSectionRepairAttemptRecord 均来自已删除的 legacy 模块

export interface QualityTraceTextEvidence {
  excerpt: string;
  length: number;
  truncated: boolean;
}

export interface QualityTraceRecorderOptions {
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  appendExisting?: boolean;
  /**
   * P7 Stage A 双写：可选审计事件追加口。
   * 未注入时 no-op（默认），生产由 AuditRunSession 实现，测试可注入空 sink。
   */
  auditSink?: AuditEventRecorder;
  /**
   * P7 Stage C：写路径模式。默认（未设置）由 resolveTraceWriteMode() 解析，
   * 读环境变量 PINOVEL_TRACE_WRITE_MODE（"legacy" 强制回退，否则 projection）。
   * Stage C-2 起默认 projection，本字段仅用于显式注入 / 测试。
   */
  writeMode?: TraceWriteMode;
  /**
   * P7 Stage C-1：明细独立内容库。projection 模式下 recordGate 把完整 evidence
   * 追加写到此 store（而非塞进 document.gates[]）。未注入且 writeMode=projection
   * 时自动创建；legacy 模式下忽略。
   */
  contentStore?: TraceContentStore;
}

export type QualityTraceCraftGateResult = "PASS" | "RETRY" | "BLOCK" | "WARNING_PASS";

export interface QualityTraceCraftRewriteHistoryItem {
  attempt: number;
  score: number;
  reason: string;
  issueTypes: string[];
  revisionHints: string[];
  metrics?: unknown;
  retryBaseline?: unknown;
}

export interface QualityTraceCraftGateRecord {
  gate_result: QualityTraceCraftGateResult;
  score: number;
  reason: string;
  issueTypes: string[];
  revisionHints: string[];
  metrics?: unknown;
  rewrite_history: QualityTraceCraftRewriteHistoryItem[];
  adjustment_signals: string[];
}

export interface GetDraftDialogueTraceEvidence {
  event_type?: string;
  narrative_beat?: string;
  dialogue_propulsion_score?: number;
  state_delta?: boolean;
  choice_delta?: number;
  risk_delta?: number;
  causal_chain?: boolean;
  protagonist_active?: boolean;
  contract_coverage?: number;
  style_match_score?: number;
  style_match_score_scope?: "chapter";
  style_match_score_source?: string;
}

export interface QualityTraceChapterStyleEvidenceInput {
  matchScore: number;
  sourceStage: string;
}

/**
 * P42 Stage 2 进攻层修复：每次 Stage 2 event rewrite 的模型路由诊断。
 *
 * 记录每次重写的模型名、失败类型、dialogueRatio、自然感密度、是否改善，
 * 用于判断"连续 2-3 次同一模型在同类问题上无改善"并输出 route recommendation。
 * recommendation 只作为诊断，不自动改 runtime 路由。
 */
export interface RewriteDiagnostic {
  /** attempt 序号（1-based） */
  attempt: number;
  /** 实际使用的模型（provider/model 组合） */
  model: string;
  /** 路由名（narrator_primary / narrator_testing） */
  route?: string;
  /** provider 名（claude / doubao / ...） */
  provider?: string;
  /** 失败类型（dialogue_propulsion / anti_ai / segment_contract / event_progression / coverage） */
  failureType: string;
  /** 本次输出的对白占比 */
  dialogueRatio?: number;
  /** 本次输出的对白推进分 */
  dialoguePropulsion?: number;
  /** 本次输出的有效对白轮次（剔除短指令） */
  effectiveDialogueTurns?: number;
  /** 本次输出的母语自然感命中密度（每千字，若可计算） */
  naturalnessDensity?: number;
  /** 相对上一次重写是否改善（dialogueRatio 上升或 effectiveTurns 上升或 naturalness 下降） */
  improved: boolean;
}

export interface QualityTraceEventRecord {
  eventId: string;
  eventName: string;
  sceneType: string;
  selectedRuleIds: string[];
  selectedFewshotIds: string[];
  contractSummary: string;
  dialogueContract?: unknown;
  evaluation: {
    score: number;
    passed: boolean;
    issueTypes: string[];
    metrics?: unknown;
    revisionHints?: string[];
  };
  progression?: unknown;
  craftGate?: QualityTraceCraftGateRecord;
  getdraftDialogueTrace?: GetDraftDialogueTraceEvidence;
  textEvidence?: QualityTraceTextEvidence;
  attempts: number;
  model: string;
  /**
   * P30 新增：本次事件生成实际使用的路由名（如 "narrator_primary" / "narrator_testing"）。
   * 与 model 配合，便于 replay 时确认 Stage 2 是否真的走了 Doubao 测试通道。
   * 留空表示旧版记录或未启用显式测试路由。
   */
  route?: string;
  /**
   * P30 新增：触发的显式测试路由标识（如 "doubao"）。
   * 仅当 novel_generate_chapter 入参传入 modelTestRoute 时写入；生产默认链路留空。
   */
  modelTestRoute?: string;
  /**
   * P30 新增：实际命中的 provider 名（如 "claude" / "doubao"），来自 FallbackResult.usedProvider。
   * 与 model 字段（"provider/model" 组合串）互补，便于按 provider 聚合统计。
   */
  provider?: string;
  /**
   * P40 新增：微小节生成结果摘要（仅 microSectionEnabled=true 时填）。
   *
   * 每个元素对应一个 MicroSectionPlan 的生成结果摘要，不含完整正文（避免 trace 膨胀），
   * 仅保留 planId / function / wordCount / usedModel / gate 评估结果 / 修复信息，
   * 便于 replay 时聚合统计"小节级 gate 通过率"和"修复触发率"。
   */
  microSectionResults?: QualityTraceMicroSectionResult[];
  /**
   * P40 新增：事件拼接后对话比例 hint 摘要（仅 microSectionEnabled=true 时填）。
   *
   * 当 hintTriggered=true 时，说明事件拼接后对话比例未达 minRatio，
   * Stage 5/8 应在润色/复检时关注对话承载是否补足。
   */
  microSectionDialogue?: QualityTraceMicroSectionDialogue;
  /**
   * P42 Stage 2 进攻层修复：每次 Stage 2 event rewrite 的模型路由诊断数组。
   *
   * 记录每次重写的模型/失败类型/dialogueRatio/自然感密度/是否改善，
   * 用于判断连续多次同模型同问题无改善。仅在该事件触发过重写时填充。
   */
  rewriteDiagnostics?: RewriteDiagnostic[];
  /**
   * P42 Stage 2 进攻层修复：对话生成路由建议。
   *
   * 当同一模型在 dialogue_propulsion 上连续 2+ 次无改善时置 true。
   * 只作为诊断信号写入 trace，不自动改 runtime 路由，
   * 除非已有项目内明确 fallback 机制支持且测试覆盖充分。
   */
  recommendFallbackForDialogueGeneration?: boolean;
}

/**
 * P40 新增：微小节生成结果摘要（用于 trace 持久化）。
 *
 * 不含完整正文（避免 trace 膨胀），仅保留统计/聚合所需字段。
 */
export interface QualityTraceMicroSectionResult {
  /** 小节 ID（如 "E2-S1"） */
  planId: string;
  /** 小节功能（setup / conflict_escalation / information_reveal 等） */
  function: string;
  /** 实际中文字数 */
  wordCount: number;
  /** 实际使用模型 */
  usedModel?: string;
  /** gate 是否通过 */
  gatePassed?: boolean;
  /** gate 评分 */
  gateScore?: number;
  /** gate 命中的 issueTypes */
  gateIssueTypes?: string[];
  /** 是否触发了修复 */
  repairUsed?: boolean;
  /** 修复使用的模型（如 "gpt/gpt-5.5"） */
  repairModel?: string;
  /** 修复策略（structural_dialog_skeleton / chinese_native_patch 等） */
  repairStrategy?: string;
  /** 修复是否耗尽仍失败 */
  repairExhausted?: boolean;
  /**
   * P40-T08 v1.3 新增：每轮修复尝试的明细。
   * 与 gates[].stage2.micro_section.repair.exhausted.evidence.attemptsSummary 同源，
   * 让 failureEnvelope.evidence.partialMicroSectionResults 内可见每轮 comparator/recheck 决策。
   */
  attemptsSummary?: unknown[];
}

/**
 * P40 新增：事件拼接后对话比例 hint 摘要。
 */
export interface QualityTraceMicroSectionDialogue {
  /** 拼接后对话占比 */
  ratio: number;
  /** 事件级 minRatio 阈值 */
  minRatio: number;
  /** 是否触发 hint（ratio < minRatio） */
  hintTriggered: boolean;
  /** hint 文本（仅 hintTriggered=true 时填） */
  hint?: string;
}

export interface QualityTracePatchRecord {
  stage: string;
  accepted: boolean;
  beforeScore: number;
  afterScore: number;
  scoreDelta: number;
  reason: string;
}

export interface QualityTraceGateRecord {
  stage: string;
  status: string;
  passed: boolean;
  blocked: boolean;
  score: number;
  reason: string;
  issueTypes: string[];
  revisionHints: string[];
  evidence?: unknown;
}

export interface QualityTraceFailureEnvelopeRecord extends FailureEnvelope {
  /** 记录时间戳（ISO-8601） */
  recordedAt: string;
  /** 恢复尝试历史（每次重试记录原因和命中证据） */
  attemptHistory?: Array<{
    attempt: number;
    strategy: string;
    reason: string;
    evidence?: unknown;
    outcome: "recovered" | "failed" | "exhausted";
  }>;
}

export interface UserPreferenceRuleSelectionTraceRecord {
  stage: string;
  eventId?: string;
  ruleId: string;
  reason?: string;
  format?: string;
}

export interface UserPreferenceRuleDiagnosticTraceRecord {
  stage: string;
  ruleId: string;
  status: "satisfied" | "unmet" | "unknown" | "schema_error";
  evidence?: string[];
}

export interface UserPreferenceRulesTrace {
  loaded: boolean;
  sourcePath?: string;
  selected: UserPreferenceRuleSelectionTraceRecord[];
  diagnostics: UserPreferenceRuleDiagnosticTraceRecord[];
}

/**
 * P40-T11 新增：进度检查点，用于超时诊断。
 *
 * 当章节生成被外部超时杀掉时，最近的 progressCheckpoint 已落盘（recordProgressCheckpoint
 * 立即 flush），可定位最后执行的事件/小节/模型调用/已用时间，把"无声超时"变成可诊断失败。
 */
export interface QualityTraceProgressCheckpoint {
  /** 最后执行的阶段标识（如 "stage2.event_start" / "stage2.micro_section" / "stage2.micro_section.repair"） */
  lastStage: string;
  /** 最后处理的事件 ID（如 "E1" / "E2"） */
  lastEventId?: string;
  /** 最后处理的微小节 ID（如 "E2-S1"） */
  lastSectionId?: string;
  /** 最后发起的 LLM 调用描述（进程被杀时正卡在哪次调用） */
  lastModelCall?: {
    agent: string;
    route?: string;
    model?: string;
    attempt?: number;
  };
  /** 章节生成已用时间（ms，从 trace createdAt 起算） */
  elapsedMs: number;
  /** checkpoint 写入时间（ISO-8601） */
  updatedAt: string;
}

/**
 * P43 新增：单次 LLM 调用耗时记录。
 *
 * 由 APIFallbackManager 通过模块级 setLLMAttemptListener 回调注入，
 * 不依赖 stderr 解析。status 覆盖 ok / transient_error / permanent_error /
 * timeout / unhealthy_skip，供 performanceProfile.llmTimings 与 Task 2 SLA 快退复用。
 */
export interface LLMTimingEntry {
  /** 调用时间戳（ISO-8601） */
  timestamp: string;
  /** agent / 路由名（如 narrator_primary / chinese_editor_judge） */
  agent: string;
  /** provider 名（doubao / ernie / claude / gpt / glm） */
  provider: string;
  /** 实际模型名 */
  model: string;
  /** attempt 序号（1-based） */
  attempt: number;
  /** 本次 attempt 耗时（ms） */
  elapsedMs: number;
  /** 状态：ok / transient_error / permanent_error / timeout / unhealthy_skip */
  status: "ok" | "transient_error" | "permanent_error" | "timeout" | "unhealthy_skip";
  /** 路由名（与 agent 同，显式保留便于聚合） */
  route?: string;
  /** 失败原因（status≠ok 时填） */
  reason?: string;
  /** Stable identifier for one provider attempt. */
  requestId?: string;
  /** SHA-256 of exact assistant text for successful attempts. */
  responseHash?: string;
  /** 输入 token（仅 OpenAI-compatible 路径精确取自 usage；Claude streaming 路径无 usage，留空） */
  inputTokens?: number;
  /** 输出 token（仅 OpenAI-compatible 路径精确取自 usage；Claude streaming 路径无 usage，留空） */
  outputTokens?: number;
  /**
   * 推理 token（reasoning/thinking token），从 OpenAI-compatible `completion_tokens_details.reasoning_tokens` 提取。
   * Gemini 3.x 是推理模型，`outputTokens`（= `completion_tokens`）可能包含 reasoning tokens；
   * 此字段如果存在可用于区分推理与可见输出。不存在时留空（provider 未返回细分）。
   */
  reasoningTokens?: number;
  /**
   * 缓存命中 token，从 OpenAI-compatible `prompt_tokens_details.cached_tokens` 提取。
   * Gemini 隐式缓存命中时 > 0。不存在时留空（provider 未返回细分）。
   */
  cachedTokens?: number;
}

/** P43 新增：单阶段耗时记录 */
export interface StageTimingEntry {
  stage: string;
  elapsedMs: number;
  /** 额外信息（provider/attempts 等） */
  extra?: Record<string, unknown>;
}

/**
 * P43 新增：章节生成性能剖析报告。
 *
 * 写入 trace 顶层 performanceProfile + handleGenerateChapter 返回结果，
 * 让"黑盒十几分钟"变成可观测：最慢 5 阶段 + 最慢 5 次模型调用 + 重试/fallback/回环消耗。
 */
export interface PerformanceProfile {
  /** 总耗时（ms，从 handleGenerateChapter 入口到返回） */
  totalElapsedMs: number;
  /** 各阶段耗时（key = stage 名，value = elapsedMs） */
  stageTimings: Record<string, number>;
  /** LLM 调用耗时明细 */
  llmTimings: LLMTimingEntry[];
  /** 重试消耗（status≠ok 的 LLM 调用 elapsedMs 之和） */
  retryCostMs: number;
  /** fallback 消耗（非 primary provider 的 ok 调用 elapsedMs 之和，粗略估算） */
  fallbackCostMs: number;
  /** Stage 8→2 对白回环消耗（ms；未触发为 0） */
  loopbackCostMs: number;
  /** 最慢 5 个阶段（按 elapsedMs 降序） */
  topSlowStages: StageTimingEntry[];
  /** 最慢 5 次模型调用（按 elapsedMs 降序） */
  topSlowModelCalls: LLMTimingEntry[];
}

export interface QualityTraceDocument {
  schemaVersion: 1;
  workspaceId: string;
  chapterId: string;
  createdAt: string;
  chapterContract?: unknown;
  events: QualityTraceEventRecord[];
  patches: QualityTracePatchRecord[];
  gates: QualityTraceGateRecord[];
  /** Stage 5/8 GetDraft local repair candidate observations. */
  repairObservations?: Array<{
    ruleId: string;
    observationMode: boolean;
    patchAccepted: boolean;
    rollback: boolean;
  }>;
  /** 阻断归因结构（治理方案 Phase 1） */
  failureEnvelopes?: QualityTraceFailureEnvelopeRecord[];
  /** 用户偏好规则（USER-REVISION-LEARNINGS.md 编译产物）加载/选择/诊断轨迹 */
  userPreferenceRules?: UserPreferenceRulesTrace;
  /**
   * P30 新增：本次章节生成使用的显式测试路由标识（如 "doubao"）。
   * 仅当 novel_generate_chapter 入参传入 modelTestRoute 时写入；生产默认链路留空。
   * 用于人工验收时快速确认 trace 是否走了 Doubao 测试通道。
   */
  modelTestRoute?: string;
  /**
   * P30 新增：本次章节生成 StyleShaper 使用的路由标识（"claude" 默认 / "doubao" A/B）。
   * 仅当 novel_generate_chapter 入参传入 styleShaperRoute 时写入；默认留空表示走 style_shaper 主路由。
   */
  styleShaperRoute?: string;
  /**
   * P31 新增：本次章节生成是否启用 Stage 2.7 Doubao 中文自然化 patch。
   * "doubao" = 已启用；undefined = 未启用（生产默认）。
   * 仅当 novel_generate_chapter 入参传入 chineseNaturalizerRoute 时写入。
   */
  chineseNaturalizerRoute?: string;
  /** P31 新增：Stage 2.7 Doubao patch 被 comparator 接受的事件数 */
  naturalizerAcceptedCount?: number;
  /** P31 新增：Stage 2.7 Doubao patch 被 comparator 拒绝的事件数（保留 Claude 原段） */
  naturalizerRejectedCount?: number;
  /**
   * P34 新增：本次章节生成所运行的构建信息。
   *
   * 由 QualityTraceRecorder 在构造时从 build-info.json（scripts/generate-build-info.mjs
   * 在 npm run build 时生成）读取并写入 trace 顶层。用途：生成服务重启后复测时，
   * 可从 trace 确认当前运行的是哪次构建（buildTimestamp + gitHash），避免长驻进程仍跑旧 dist。
   *
   * 注意：仅作元数据记录，不影响任何门禁判定。
   */
  buildInfo?: QualityTraceBuildInfo;
  /**
   * P35 新增：整章中文网文范式综合分（0-100）。
   *
   * 由 Stage 8 naturalness revision 模块在评分完成后调用 setParadigmScore 写入。
   * 用途：人工验收/replay 时一眼看到范式分状态，便于按范式分排序模型对比样本。
   * 不影响门禁判定（门禁走 stageResults.stage8_chinese_webnovel_paradigm）。
   */
  paradigmScore?: QualityTraceParadigmScore;
  /**
   * P40-T11 新增：进度检查点，用于超时诊断。
   *
   * 由 recordProgressCheckpoint() 在关键节点（事件/小节/模型调用前）更新并立即 flush。
   * 当章节生成被外部超时杀掉时，最近的 checkpoint 已落盘，可定位最后执行位置，
   * 把"无声超时"变成可诊断 FailureEnvelope（含 lastStage/lastEventId/lastSectionId/lastModelCall/elapsedMs）。
   */
  progressCheckpoint?: QualityTraceProgressCheckpoint;
  /**
   * P43 新增：章节生成性能剖析报告。
   *
   * 由 handleGenerateChapter 在返回前用 setPerformanceProfile 写入，
   * 不依赖 stderr 解析。供 replay matrix / 人工验收定位最慢阶段与最慢模型调用。
   */
  performanceProfile?: PerformanceProfile;
  /**
   * P44 新增：Quality Amplifier v2 链路摘要。
   *
   * Phase 7 后由统一主链路经 V2 trace adapter 写入（存在 V2 trace records 时）。
   * V2 阶段证据同时落入 gates[]（stage 名加 v2_ 前缀）、patches[]（修复）、
   * failureEnvelopes[]（降级/错误）；v2Summary 只承载跨阶段聚合视图，便于
   * replay/人工验收一眼看到 V2 运行结果（候选数/winner/正负收益/阶段序列）。
   *
   * 注意：仅作元数据记录，不影响门禁判定。无 V2 records 的链路该字段留空。
   */
  v2Summary?: V2TraceSummary;
}

/**
 * P44 新增：Quality Amplifier v2 trace 摘要。
 *
 * 写入位置：trace 顶层 v2Summary 字段。
 * 数据来源：V2 trace adapter 在 flush 时从累积的 V2TraceRecord 聚合。
 * 设计原则：trace 是"可回放证据"，v2Summary 提供跨阶段聚合视图，
 * 详细候选/比较/选择证据保留在 gates[].evidence 中供深度回放。
 */
export interface V2TraceSummary {
  /** V2 运行模式（full_chain=完整 7 阶段 / rawStage2=早停 / direct_baseline=降级） */
  v2Mode: "full_chain" | "rawStage2" | "direct_baseline";
  /** 候选总数 */
  candidateCount: number;
  /**
   * comparator 比较胜出候选 id（即 CandidateComparison.winnerId，无比较时留空）。
   *
   * 注意：这是"比较器判定的总分最高候选"，不等于 FinalSelector 最终交付候选。
   * 最终交付候选见 finalSelectedId。二者可能不同：当 amplified 是 comparator winner
   * 但未过 clearWin 门槛（confidence/scoreDiff/hard 诊断/antiRegression）时，
   * FinalSelector 会保留 rawStage2，此时 winnerId=amplified、finalSelectedId=rawStage2。
   */
  winnerId?: string;
  /** comparator 比较胜出候选来源（direct_baseline / rawStage2 / v2_amplified 等） */
  winnerSource?: string;
  /** comparator 置信度（CandidateComparison.confidence，0-1），区分于最终选择门槛 */
  comparatorConfidence?: number;
  /** FinalSelector 最终交付候选 id（可能与 winnerId 不同） */
  finalSelectedId?: string;
  /** FinalSelector 最终交付候选来源（direct / rawStage2 / v2_amplified） */
  finalSelectedSource?: string;
  /** 正负收益判定（positive/negative/neutral） */
  projectGain?: "positive" | "negative" | "neutral";
  /** 上下文 hash（关联 ContextCompiler 产物） */
  contextHash?: string;
  /** V2 阶段序列（stage + timestamp + durationMs，不含完整证据，证据在 gates[]） */
  stages: Array<{
    stage: string;
    timestamp: string;
    durationMs?: number;
  }>;
}

/**
 * P35 新增：整章中文网文范式评分 trace 记录。
 *
 * 写入位置：trace 顶层 paradigmScore 字段。
 * 数据来源：ChineseWebnovelParadigmScanner.scoreChapter() + LLM judge 校准结果。
 */
export interface QualityTraceParadigmScore {
  /** 整章综合分（0-100） */
  totalScore: number;
  /** 综合判定 */
  verdict: "pass" | "revise" | "block";
  /** 翻译腔千字密度（取自维度 1） */
  translationToneDensity: number;
  /** 中文母语自然度判定（取自维度 1） */
  nativeNaturalnessVerdict: "pass" | "repair" | "block";
  /** LLM judge 是否已应用（Stage 8 调用后置 true） */
  llmJudgeApplied?: boolean;
  /** LLM judge 状态（ok/timeout/parse_error/skipped） */
  llmJudgeStatus?: "ok" | "timeout" | "parse_error" | "skipped";
  /** 写入该分数的阶段（"stage2" / "stage5" / "stage8" / "resume.stage8"） */
  stage: string;
  /**
   * P42 新增：Stage 8 评分时使用的 sceneType（默认 "general"）。
   *
   * 诊断脚本可从 trace 读取此字段精确复现 scoreChapter 评分，消除"Stage 8 trace 报 82/pass
   * 而本地诊断报 68/revise"的差异。维度 7 scoreTechnique 依赖此字段。
   */
  sceneType?: string;
  /**
   * P42 新增：Stage 8 评分时使用的 genre（默认 "玄幻"，取自 configData.genre）。
   *
   * 维度 8 scoreTypeFit 依赖此字段，缺失时评分不可复现。
   */
  genre?: string;
  /** P35 新增：是否触发范式硬阻断（Stage 8 三条件任一命中） */
  hardBlocked?: boolean;
  /** P35 新增：范式硬阻断原因（hardBlocked=true 时填，便于 trace 诊断） */
  hardBlockReason?: string;
  /** 8 维度详细评分（可选，用于回放对比） */
  dimensions?: Array<{
    id: string;
    label: string;
    score: number;
    weight: number;
    verdict: string;
    evidence: string;
  }>;
}

/**
 * P34 新增：构建信息（buildTimestamp + gitHash + nodeVersion）。
 *
 * scripts/generate-build-info.mjs 在 npm run build 时生成 build-info.json；
 * QualityTraceRecorder 在模块加载时读取一次并缓存，每个 trace 文档构造时 stamp 当前构建信息。
 */
export interface QualityTraceBuildInfo {
  /** 构建时刻（ISO-8601） */
  buildTimestamp: string;
  /** 当前 git HEAD commit hash（无 git 环境则 "unknown-no-git"） */
  gitHash: string;
  /** 构建时 Node.js 版本 */
  nodeVersion?: string;
}

/**
 * P34 新增：模块加载时读取 build-info.json 并缓存。
 *
 * 路径解析兼容源码（craft/ → ../build-info.json）与编译产物（dist/craft/ → ../../build-info.json）。
 * 读取失败时返回 "unbuilt" 占位值，不阻断 trace 写入。
 */
function loadBuildInfo(): QualityTraceBuildInfo {
  const unbuilt: QualityTraceBuildInfo = {
    buildTimestamp: "unbuilt",
    gitHash: "unbuilt",
    nodeVersion: process.version,
  };
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(moduleDir, "..", "build-info.json"),         // 源码：craft/ → 扩展根
      join(moduleDir, "..", "..", "build-info.json"),   // 编译：dist/craft/ → 扩展根
      join(moduleDir, "build-info.json"),                // 兜底
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<QualityTraceBuildInfo>;
        return {
          buildTimestamp: typeof parsed.buildTimestamp === "string" ? parsed.buildTimestamp : unbuilt.buildTimestamp,
          gitHash: typeof parsed.gitHash === "string" ? parsed.gitHash : unbuilt.gitHash,
          nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : unbuilt.nodeVersion,
        };
      }
    }
  } catch {
    // 读取/解析异常：返回占位值，不阻断 trace 写入
  }
  return unbuilt;
}

const CACHED_BUILD_INFO: QualityTraceBuildInfo = loadBuildInfo();

/**
 * 从 gate evidence 中策展读侧证据子集（P7 Stage B-Read）。
 *
 * 只提取 R1-R4 读侧消费的 strategyContext / modelCalls / releaseGovernance 三个
 * 字段，以及不含正文的 generationBaseline 身份投影。
 * 字段，不携带完整候选正文（candidates / finalSelection / judgeEvidence /
 * comparison 等留在旧文件，不进审计流）。缺失字段不写入，确保 payload 不含
 * 大对象/完整正文。evidence 非对象（null/数组/原始值）时返回空对象。
 */
function curateGateEvidence(evidence: unknown): Record<string, unknown> {
  const curated: Record<string, unknown> = {};
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return curated;
  }
  const record = evidence as Record<string, unknown>;
  if (record.strategyContext !== undefined) {
    curated.strategyContext = record.strategyContext;
  }
  if (record.modelCalls !== undefined) {
    curated.modelCalls = record.modelCalls;
  }
  if (record.releaseGovernance !== undefined) {
    curated.releaseGovernance = record.releaseGovernance;
  }
  // 身份审计字段不含正文，必须保留在早期阻断与成功 trace 中，才能
  // 区分 active pointer 与 G6 实际绑定的 execution release。
  if (record.generationBaseline !== undefined) {
    curated.generationBaseline = record.generationBaseline;
  }
  return curated;
}

export class QualityTraceRecorder {
  private readonly document: QualityTraceDocument;
  private readonly outputPath: string;
  private readonly auditSink?: AuditEventRecorder;
  private readonly writeMode: TraceWriteMode;
  private readonly contentStore?: TraceContentStore;
  // 发射侧去重：同一 FailureEnvelope 内容只发射一次 failure_recorded（多实例 append 模式）。
  private readonly emittedFailureEventIds = new Set<string>();
  // 发射侧去重：同一 gate 内容只发射一次 gate_evaluated（多实例 append 模式）。
  private readonly emittedGateEventIds = new Set<string>();
  // Stage C-2：projection 下内容库写失败时，完整 evidence 的回退项（flush 物化后补回）。
  private readonly fallbackGates: QualityTraceGateRecord[] = [];
  // 发射侧去重：内容库写失败告警（trace_content_store_write_failed）只发射一次。
  private readonly emittedContentStoreFailureIds = new Set<string>();

  constructor(options: QualityTraceRecorderOptions) {
    this.auditSink = options.auditSink;
    this.writeMode = options.writeMode ?? resolveTraceWriteMode();
    this.outputPath = join(options.workspacePath, options.workspaceId, "traces", `${options.chapterId}-quality-trace.json`);
    this.contentStore =
      options.contentStore ??
      (this.writeMode === "projection"
        ? createTraceContentStore({
            workspacePath: options.workspacePath,
            workspaceId: options.workspaceId,
            chapterId: options.chapterId,
          })
        : undefined);
    this.document = (options.appendExisting !== false ? this.loadExistingDocument(options) : null) || {
      schemaVersion: 1,
      workspaceId: options.workspaceId,
      chapterId: options.chapterId,
      createdAt: new Date().toISOString(),
      events: [],
      patches: [],
      gates: [],
    };
    // P34: stamp 当前构建信息到 trace（每次构造都更新，确保 append 场景下也能反映最新构建）
    this.document.buildInfo = CACHED_BUILD_INFO;
  }

  recordEvent(record: QualityTraceEventRecord): void {
    this.document.events.push(record);
  }

  recordPatch(record: QualityTracePatchRecord): void {
    this.document.patches.push(record);
  }

  recordGate(record: QualityTraceGateRecord): void {
    if (this.writeMode === "projection") {
      // P7 Stage C 明细迁独立内容库：完整 evidence 写 content store，
      // 不再塞进 document.gates[]（旧文件在投影模式下只承载策展投影缓存）。
      // Stage C-2：内容库写失败不得静默丢失完整 evidence——回退进 fallbackGates，
      // flush 物化后补回完整 evidence，并发射非静默 audit 事件。
      const ok = this.contentStore?.writeGate(record.stage, record.evidence) ?? true;
      if (!ok) {
        this.fallbackGates.push(record);
        this.emitContentStoreWriteFailed(record);
      }
    } else {
      this.document.gates.push(record);
    }
    // P7 Stage B-Read 双写：向审计流追加 gate_evaluated，
    // 携带策展读侧证据子集（strategyContext/modelCalls/releaseGovernance，不含完整正文）。
    this.emitGateEvaluated(record);
  }

  recordChapterContract(contract: unknown): void {
    this.document.chapterContract = contract;
  }

  /**
   * P30 新增：记录本次章节生成使用的显式测试路由标识。
   *
   * 由 NarratorAgent 在 execute 入口调用（当 modelTestRoute 被设置时），
   * 写入 trace 顶层 modelTestRoute 字段，便于人工验收/replay 时快速确认
   * Stage 2 是否真的走了 Doubao 测试通道（而非仅靠事件级 model 字段推断）。
   *
   * 注意：仅作元数据记录，不影响任何门禁判定。
   */
  setModelTestRoute(route: string): void {
    this.document.modelTestRoute = route;
  }

  /**
   * P30 新增：记录本次章节生成 StyleShaper 使用的路由标识。
   *
   * 默认 "claude"（走 style_shaper 主路由）；仅当显式传入 styleShaperRoute="doubao"
   * 时记录为 "doubao"，用于后续 A/B 测试溯源。
   */
  setStyleShaperRoute(route: string): void {
    this.document.styleShaperRoute = route;
  }

  /**
   * P31 新增：记录 Stage 2.7 Doubao 中文自然化 patch 是否启用。
   *
   * 由 handleGenerateChapter 在 Stage 2.7 执行后调用（当 chineseNaturalizerRoute="doubao" 时），
   * 写入 trace 顶层 chineseNaturalizerRoute 字段，便于人工验收/replay 时快速确认
   * Stage 2.7 是否真的走了 Doubao 自然化通道。
   *
   * 注意：仅作元数据记录，不影响任何门禁判定。
   */
  setChineseNaturalizerRoute(route: string): void {
    this.document.chineseNaturalizerRoute = route;
  }

  /**
   * P31 新增：记录 Stage 2.7 Doubao patch 接受/拒绝计数。
   * accepted = 通过双重 comparator（StructuralLockComparator + applyQualityCheckedPatch）的事件数；
   * rejected = 被任一 comparator 拒绝、保留 Claude 原段的事件数。
   */
  setNaturalizerCounts(accepted: number, rejected: number): void {
    this.document.naturalizerAcceptedCount = accepted;
    this.document.naturalizerRejectedCount = rejected;
  }

  /**
   * P35 新增：记录整章中文网文范式综合分。
   *
   * 由 Stage 8 naturalness revision 模块在评分完成后调用，写入 trace 顶层 paradigmScore 字段。
   * 用途：人工验收/replay 时一眼看到范式分状态，便于按范式分排序模型对比样本。
   *
   * 注意：仅作元数据记录，不影响门禁判定（门禁走 stageResults.stage8_chinese_webnovel_paradigm）。
   */
  setParadigmScore(score: QualityTraceParadigmScore): void {
    this.document.paradigmScore = score;
  }

  /**
   * P43 新增：写入章节生成性能剖析报告。
   *
   * 由 handleGenerateChapter 在返回前调用（用本地 stageTimings + llmTimings +
   * loopback 计时组装 PerformanceProfile 后传入），写入 trace 顶层 performanceProfile。
   * 调用方负责 flush（通常与其他 trace 写入合并）。
   *
   * 注意：trace recorder 在本代码库为多实例 append 模式（每阶段各自 createQualityTraceRecorder），
   * 因此 performanceProfile 由 orchestrator 单点组装后写入，避免多实例分别累计导致重复/漂移。
   */
  setPerformanceProfile(profile: PerformanceProfile): void {
    this.document.performanceProfile = profile;
  }

  /**
   * P44 新增：写入 Quality Amplifier v2 链路摘要。
   *
   * 由 V2 trace adapter（legacy-trace-adapter.ts）在 flush 时调用，
   * 把 V2 运行模式/候选数/winner/正负收益/阶段序列写入 trace 顶层 v2Summary。
   * V2 阶段详细证据（candidates/comparison/finalSelection）保留在 gates[].evidence。
   *
   * 注意：仅作元数据记录，不影响门禁判定。appendExisting 模式下跨实例保留。
   */
  setV2Summary(summary: V2TraceSummary): void {
    this.document.v2Summary = summary;
  }

  /**
   * P40-T11 新增：记录进度检查点并立即写盘。
   *
   * 用于超时诊断：在关键节点（事件/小节/模型调用前）调用，更新 progressCheckpoint
   * 并立即 flush。当章节生成被外部超时杀掉时，最近的 checkpoint 已落盘，
   * 验收脚本可据此合成可诊断 FailureEnvelope（lastStage/lastEventId/lastSectionId/lastModelCall/elapsedMs）。
   *
   * 注意：每次调用都会同步写盘（writeFileSync），不宜在热路径高频调用。
   * 建议在事件级/小节级/模型调用级入口调用，而非每个 token 或每个 gate。
   */
  recordProgressCheckpoint(data: {
    lastStage: string;
    lastEventId?: string;
    lastSectionId?: string;
    lastModelCall?: { agent: string; route?: string; model?: string; attempt?: number };
  }): void {
    const elapsedMs = Date.now() - new Date(this.document.createdAt).getTime();
    this.document.progressCheckpoint = {
      ...data,
      elapsedMs,
      updatedAt: new Date().toISOString(),
    };
    try {
      this.flush();
    } catch {
      // flush 失败不阻断主流程；checkpoint 已存内存，下次 flush 仍会写盘
    }
  }

  recordRepairObservations(observations: Array<{ ruleId: string; observationMode: boolean; patchAccepted: boolean; rollback: boolean }>): void {
    if (observations.length === 0) return;
    if (!Array.isArray(this.document.repairObservations)) {
      this.document.repairObservations = [];
    }
    this.document.repairObservations.push(...observations);
  }

  /**
   * 记录用户偏好规则在 Stage 2 被选中（事件级）。
   * 懒初始化 userPreferenceRules 对象，确保即使无加载也有选择轨迹。
   */
  recordUserPreferenceRuleSelection(record: UserPreferenceRuleSelectionTraceRecord): void {
    if (!this.document.userPreferenceRules) {
      this.document.userPreferenceRules = { loaded: true, selected: [], diagnostics: [] };
    }
    this.document.userPreferenceRules.selected.push(record);
  }

  /**
   * 记录用户偏好规则诊断结果（Stage 0 schema_error / Stage 8 satisfied/unmet/unknown）。
   * unmet 只作软诊断证据，不触发硬阻断（遵守 memory 约束：编辑类问题不 block）。
   */
  recordUserPreferenceRuleDiagnostic(record: UserPreferenceRuleDiagnosticTraceRecord): void {
    if (!this.document.userPreferenceRules) {
      this.document.userPreferenceRules = { loaded: true, selected: [], diagnostics: [] };
    }
    this.document.userPreferenceRules.diagnostics.push(record);
  }

  /**
   * 标记用户偏好规则加载状态（loaded + sourcePath），由 narrator 在 Stage 0 加载后调用。
   */
  recordUserPreferenceRulesLoaded(loaded: boolean, sourcePath?: string): void {
    if (!this.document.userPreferenceRules) {
      this.document.userPreferenceRules = { loaded, sourcePath, selected: [], diagnostics: [] };
      return;
    }
    this.document.userPreferenceRules.loaded = loaded;
    if (sourcePath !== undefined) {
      this.document.userPreferenceRules.sourcePath = sourcePath;
    }
  }

  /**
   * 记录 FailureEnvelope（治理方案 Phase 1）。
   *
   * 每次阻断归因都写入 trace，确保可回放、可诊断。
   * attemptHistory 记录每次恢复尝试的原因和命中证据。
   */
  recordFailureEnvelope(
    envelope: FailureEnvelope,
    attemptHistory?: QualityTraceFailureEnvelopeRecord["attemptHistory"],
  ): void {
    // P7 Stage A 双写：向审计流追加 failure_recorded（§5.2 完整 8 字段）。
    this.emitFailureRecorded(envelope);
    // P7 Stage D：projection 模式下 failureEnvelopes[] 收敛为可重建投影缓存——
    // 由 materializeProjectionCache 从审计流 rebuildQualityTraceFromEvents 物化。
    // 仅当「发射侧 recordEvent」与「重建侧 getEntries」均可用时才走物化路径，
    // 否则（无审计流或只有单侧 sink）回退直接写入，避免 failureEnvelopes 静默丢失
    // （failureEnvelope 无独立内容库，不落盘即彻底丢失，故必须兜底）。
    if (this.canRebuildFailureEnvelopesFromAudit()) {
      // attemptHistory 是 §5.2 标注的 unreconstructed 字段（审计事件 payload 不携带），
      // 经核对当前无任何生产/eval 调用方传递 attemptHistory，故物化时安全丢弃，
      // 由 rebuildQualityTraceFromEvents 的 unreconstructed 清单显式声明缺位。
      return;
    }
    // 直接写入（legacy 模式，或 projection 无完整审计流可重建）。
    if (!Array.isArray(this.document.failureEnvelopes)) {
      this.document.failureEnvelopes = [];
    }
    const record: QualityTraceFailureEnvelopeRecord = {
      ...envelope,
      recordedAt: new Date().toISOString(),
      attemptHistory,
    };
    this.document.failureEnvelopes.push(record);
  }

  /**
   * P7 Stage D：projection 模式下能否从审计流重建 failureEnvelopes[]。
   *
   * 需同时满足「发射侧 recordEvent」（recordFailureEnvelope 能把 failure_recorded
   * 写进审计流）与「重建侧 getEntries」（materializeProjectionCache 能读回并逐字段
   * 还原）。任一缺失即回退直接写入，避免 failureEnvelope 无独立内容库、不落盘即
   * 彻底丢失。
   */
  private canRebuildFailureEnvelopesFromAudit(): boolean {
    return (
      this.writeMode === "projection" &&
      typeof this.auditSink?.recordEvent === "function" &&
      typeof this.auditSink?.getEntries === "function"
    );
  }

  /**
   * P7 Stage A 双写：在 quality-trace.json 继续写入的同时，向审计流追加一条
   * failure_recorded 事件（内容寻址 eventId，发射侧去重，写失败不抛）。
   *
   * eventId = failureRecorded:<sha256(stage|gate|severity|reason|canonicalEvidence)>，
   * 保证同一阻断归因在 append 多实例 / 重试下只发射一次，且可复现。
   */
  private emitFailureRecorded(envelope: FailureEnvelope): void {
    if (!this.auditSink?.recordEvent) return;
    const canonicalEvidence = stableStringify(envelope.evidence ?? null);
    const canonical = [
      envelope.stage,
      envelope.gate ?? "",
      envelope.severity,
      envelope.reason,
      canonicalEvidence,
    ].join("|");
    const eventId = `failureRecorded:${computeContentHash(canonical)}`;
    if (this.emittedFailureEventIds.has(eventId)) return;
    this.emittedFailureEventIds.add(eventId);
    try {
      this.auditSink.recordEvent({
        eventType: "failure_recorded",
        eventId,
        stage: (envelope.stage && envelope.stage.trim()
          ? envelope.stage
          : "unknown") as AuditStage,
        status: "failed",
        failureClass: mapLegacyFailureClass(envelope.severity),
        gate: envelope.gate || undefined,
        decisionReason: envelope.reason,
        userActionRequired: envelope.userActionRequired,
        payload: {
          // §5.2：payload 原样携带完整 FailureEnvelope（非摘要），
          // 供 Stage B 投影 rebuildQualityTraceFromEvents 逐字段还原 failureEnvelopes[]。
          envelope: {
            stage: envelope.stage,
            gate: envelope.gate,
            severity: envelope.severity,
            reason: envelope.reason,
            evidence: envelope.evidence ?? null,
            recoverable: envelope.recoverable,
            retryPlan: envelope.retryPlan ?? null,
            userActionRequired: envelope.userActionRequired ?? null,
          },
          source: "quality_trace",
        },
      });
    } catch {
      // 审计事件追加失败不阻断 trace 写入主路径
    }
  }

  /**
   * P7 Stage B-Read 双写：在 quality-trace.json 继续写入的同时，向审计流追加一条
   * gate_evaluated 事件（内容寻址 eventId，发射侧去重，写失败不抛）。
   *
   * eventId = gateEvaluated:<sha256(stage|status|passed|blocked|canonicalEvidence)>，
   * 保证同一门禁在多实例 append / 重试下只发射一次，且可复现。
   *
   * payload.evidence 只携带策展读侧证据子集（strategyContext/modelCalls/
   * releaseGovernance），不携带完整候选正文（candidates/finalSelection/
   * judgeEvidence 留在旧文件，不进审计流，遵守「payload 禁止完整正文」）。
   */
  private emitGateEvaluated(record: QualityTraceGateRecord): void {
    if (!this.auditSink?.recordEvent) return;
    const curatedEvidence = curateGateEvidence(record.evidence);
    const canonical = [
      record.stage,
      record.status,
      record.passed ? "1" : "0",
      record.blocked ? "1" : "0",
      stableStringify(curatedEvidence),
    ].join("|");
    const eventId = `gateEvaluated:${computeContentHash(canonical)}`;
    if (this.emittedGateEventIds.has(eventId)) return;
    this.emittedGateEventIds.add(eventId);
    const status = record.blocked
      ? ("blocked" as const)
      : record.passed
        ? ("completed" as const)
        : ("failed" as const);
    try {
      this.auditSink.recordEvent({
        eventType: "gate_evaluated",
        eventId,
        stage: "gate",
        status,
        gate: record.stage,
        decisionReason: record.reason,
        payload: {
          gateStage: record.stage,
          passed: record.passed,
          blocked: record.blocked,
          score: record.score,
          reason: record.reason,
          issueTypes: Array.isArray(record.issueTypes) ? record.issueTypes : [],
          revisionHints: Array.isArray(record.revisionHints)
            ? record.revisionHints
            : [],
          evidence: curatedEvidence,
        },
      });
    } catch {
      // 审计事件追加失败不阻断 trace 写入主路径
    }
  }

  /**
   * P7 Stage C-2 双写：内容库写失败时发射非静默审计信号，避免「完整 evidence 未进
   * 内容库」这件事无迹可寻。完整 evidence 已回退进 document.gates（见 recordGate），
   * 本事件仅作可观测告警（eventTypeHint=trace_content_store_write_failed）。
   *
   * 内容寻址 eventId（stage+reason），append 多实例 / 重试下只发射一次。
   */
  private emitContentStoreWriteFailed(record: QualityTraceGateRecord): void {
    if (!this.auditSink?.recordEvent) return;
    const canonical = [record.stage, record.reason].join("|");
    const eventId = `traceContentStoreWriteFailed:${computeContentHash(canonical)}`;
    if (this.emittedContentStoreFailureIds.has(eventId)) return;
    this.emittedContentStoreFailureIds.add(eventId);
    try {
      this.auditSink.recordEvent({
        eventType: "custom",
        eventId,
        stage: "gate",
        status: "failed",
        gate: record.stage,
        decisionReason: "quality-trace 内容库写失败，完整 evidence 已回退进旧文件",
        payload: {
          eventTypeHint: "trace_content_store_write_failed",
          gateStage: record.stage,
          reason: record.reason,
        },
      });
    } catch {
      // 审计事件追加失败不阻断 trace 写入主路径
    }
  }

  recordChapterStyleEvidence(input: QualityTraceChapterStyleEvidenceInput): void {
    if (!Number.isFinite(input.matchScore)) {
      return;
    }

    const sourceStage = input.sourceStage.trim();
    for (const event of this.document.events) {
      event.getdraftDialogueTrace = {
        ...(event.getdraftDialogueTrace || {}),
        style_match_score: input.matchScore,
        style_match_score_scope: "chapter",
        style_match_score_source: sourceStage || "unknown",
      };
    }
  }

  flush(): string {
    if (this.writeMode === "projection") {
      this.materializeProjectionCache();
    }
    mkdirSync(join(this.outputPath, ".."), { recursive: true });
    writeFileSync(this.outputPath, `${JSON.stringify(this.document, null, 2)}\n`, "utf-8");
    return this.outputPath;
  }

  /**
   * P7 Stage C/D 投影缓存物化：projection 模式下，旧文件只承载可重建子集的投影缓存。
   *
   * gates[] 从审计流（auditSink.getEntries）经 rebuildQualityTraceFromEvents 重建为
   * 策展读侧证据子集（strategyContext/modelCalls/releaseGovernance，不含完整正文）；
   * failureEnvelopes[] 同样从审计流逐字段还原（§5.2 8 字段等价），完整明细已在
   * content store。events[]/patches[]/v2Summary/performanceProfile 等仍为直接写入
   * （审计流不携带这些字段，见 rebuildQualityTraceFromEvents.unreconstructed）。
   *
   * Stage C-2：内容库写失败的回退项在物化后补回完整 evidence（按 stage+reason 匹配
   * 策展子集，覆盖为完整 evidence），确保完整明细不因内容库失败而静默丢失。
   *
   * 无 getEntries 时静默跳过（保持 legacy 行为），不阻断 flush。
   */
  private materializeProjectionCache(): void {
    const entries = this.auditSink?.getEntries?.() ?? [];
    const rebuilt = rebuildQualityTraceFromEvents(entries, {
      workspaceId: this.document.workspaceId,
      chapterId: this.document.chapterId,
    });
    this.document.gates = rebuilt.gates.map((g) => ({
      stage: g.stage,
      status: g.status,
      passed: g.passed,
      blocked: g.blocked,
      score: g.score ?? 0,
      reason: g.reason,
      issueTypes: g.issueTypes,
      revisionHints: g.revisionHints,
      evidence: g.evidence,
    }));
    // 内容库写失败回退：完整 evidence 覆盖策展子集（不得静默丢失）。
    for (const fb of this.fallbackGates) {
      const idx = this.document.gates.findIndex(
        (g) => g.stage === fb.stage && g.reason === fb.reason,
      );
      if (idx >= 0) {
        this.document.gates[idx] = { ...this.document.gates[idx], evidence: fb.evidence };
      } else {
        this.document.gates.push(fb);
      }
    }
    // P7 Stage D：failureEnvelopes[] 也从审计流物化（§5.2 8 字段逐字段等价）。
    // recordedAt 取审计事件 timestamp（best-effort，缺失回退 now）；attemptHistory 为
    // unreconstructed 字段，物化时丢弃（recordFailureEnvelope 已核对无生产调用方传递）。
    // 仅当审计流可重建（recordEvent + getEntries 均可用）时物化，否则保留
    // recordFailureEnvelope 的直接写入（无独立内容库，不得静默丢失）。
    if (this.canRebuildFailureEnvelopesFromAudit()) {
      this.document.failureEnvelopes = rebuilt.failureEnvelopes.map(
        (e): QualityTraceFailureEnvelopeRecord => ({
          stage: e.stage,
          gate: e.gate ?? "",
          severity: e.severity as FailureSeverity,
          reason: e.reason,
          evidence: e.evidence ?? null,
          recoverable: e.recoverable,
          // retryPlan / userActionRequired 按 rebuildQualityTraceFromEvents 的归一化
          // 结果原样透传（保留 null / boolean 等运行时值），与 §5.2 双向一致契约对齐，
          // 不得再二次归一化（否则 null→undefined 会破坏与投影的逐字段等价）。
          retryPlan: e.retryPlan as RetryPlan | undefined,
          userActionRequired: e.userActionRequired as string[] | undefined,
          recordedAt: e.recordedAt ?? new Date().toISOString(),
        }),
      );
    }
  }

  private loadExistingDocument(options: QualityTraceRecorderOptions): QualityTraceDocument | null {
    if (!existsSync(this.outputPath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.outputPath, "utf-8")) as Partial<QualityTraceDocument>;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.workspaceId !== options.workspaceId ||
        parsed.chapterId !== options.chapterId
      ) {
        return null;
      }

      return {
        schemaVersion: 1,
        workspaceId: options.workspaceId,
        chapterId: options.chapterId,
        createdAt: parsed.createdAt || new Date().toISOString(),
        chapterContract: parsed.chapterContract,
        events: Array.isArray(parsed.events) ? parsed.events as QualityTraceEventRecord[] : [],
        patches: Array.isArray(parsed.patches) ? parsed.patches as QualityTracePatchRecord[] : [],
        gates: Array.isArray((parsed as Partial<QualityTraceDocument>).gates)
          ? (parsed as Partial<QualityTraceDocument>).gates as QualityTraceGateRecord[]
          : [],
        repairObservations: Array.isArray((parsed as Partial<QualityTraceDocument>).repairObservations)
          ? (parsed as Partial<QualityTraceDocument>).repairObservations
          : undefined,
        failureEnvelopes: Array.isArray((parsed as Partial<QualityTraceDocument>).failureEnvelopes)
          ? (parsed as Partial<QualityTraceDocument>).failureEnvelopes as QualityTraceFailureEnvelopeRecord[]
          : undefined,
        // 单点迁移：保留 userPreferenceRules 轨迹，确保 33+ 个 recorder 实例跨实例累积。
        // 不做 shape 校验，narrator/loader 写入时已保证结构正确。
        userPreferenceRules: (parsed as Partial<QualityTraceDocument>).userPreferenceRules,
        // P30/P31: 顶层路由标识跨 appendExisting 实例保留，避免后续 recorder 加载时
        // 丢失 modelTestRoute/styleShaperRoute/chineseNaturalizerRoute 及 naturalizer 计数。
        modelTestRoute: (parsed as Partial<QualityTraceDocument>).modelTestRoute,
        styleShaperRoute: (parsed as Partial<QualityTraceDocument>).styleShaperRoute,
        chineseNaturalizerRoute: (parsed as Partial<QualityTraceDocument>).chineseNaturalizerRoute,
        naturalizerAcceptedCount: (parsed as Partial<QualityTraceDocument>).naturalizerAcceptedCount,
        naturalizerRejectedCount: (parsed as Partial<QualityTraceDocument>).naturalizerRejectedCount,
        // P35: 范式分跨 appendExisting 实例保留，避免后续 recorder 加载时丢失 paradigmScore。
        paradigmScore: (parsed as Partial<QualityTraceDocument>).paradigmScore,
        // P40-T11: 进度检查点跨 appendExisting 实例保留，避免后续 recorder 加载时丢失最近的超时诊断信息。
        progressCheckpoint: (parsed as Partial<QualityTraceDocument>).progressCheckpoint,
        // P43 Task 1：performanceProfile 跨 appendExisting 实例保留，避免后续 recorder 加载时丢失耗时剖析。
        // 由 orchestrator 单点组装后写入，appendExisting 不应清空。
        performanceProfile: (parsed as Partial<QualityTraceDocument>).performanceProfile,
        // P44：v2Summary 跨 appendExisting 实例保留，避免 V2 degrade-to-legacy 时
        // 后续 legacy recorder 加载丢失 V2 阶段摘要（V2 已写 gates[]/failureEnvelopes[]，
        // v2Summary 是跨阶段聚合视图，appendExisting 不应清空）。
        v2Summary: (parsed as Partial<QualityTraceDocument>).v2Summary,
      };
    } catch {
      return null;
    }
  }
}

export function createQualityTraceRecorder(options: QualityTraceRecorderOptions): QualityTraceRecorder {
  return new QualityTraceRecorder(options);
}

export function createQualityTraceTextEvidence(
  text: string,
  maxChars = 900
): QualityTraceTextEvidence {
  const normalized = text.replace(/\s+/g, " ").trim();
  const safeLimit = Math.max(80, maxChars);

  return {
    excerpt: normalized.slice(0, safeLimit),
    length: normalized.length,
    truncated: normalized.length > safeLimit,
  };
}
