/**
 * ReviewSurfaceCli — 只读本地 Review CLI 渲染层（REVIEW-SURFACE-1，计划 §6.5）
 *
 * 目标：提供本地 CLI 查看 chapters、raw/editorial 候选、FactGuard、evidence、
 * judge、state commit 和 human-review focus，并可导出匿名 review response。
 *
 * 核心不变量（REVIEW-SURFACE-1 任务书）：
 * - 只读：不生成正文、不修改 winner、不自动写策略信誉、不提交 state。
 * - 不调用模型（无 modelGenerate/callModel）。
 * - 缺文件/blocked/raw-only/editorial 各路径可读。
 * - span 可跳转（span 引用可解析为文本片段）。
 * - expected/actual model 路由分开展示。
 * - 输出不泄露 secret/私有思维（API key、Bearer token、模型内部推理 redacted）。
 * - 损坏 artifact 给诊断错误（不静默）。
 * - schema 版本不支持时只读降级并提示迁移。
 *
 * 边界（L0 工程闭环）：
 * - 纯渲染层：本模块只做数据 → 文本渲染 + redaction，不 spawn 进程、不读文件系统。
 *   调用方（CLI 入口脚本）负责加载 artifact 并传入 PairArtifacts。
 * - 不调用网络模型；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 *
 * 与 EligibleSampleRegistry 的关系：
 * - 本模块消费 EligibleSampleRegistryResult（EDITORIAL-BENEFIT-1 输出）。
 * - 本模块不重新分类 outcome，只渲染已分类的 registry。
 */

import {
  anonymizeReviewerId,
  DEFAULT_HUMAN_REVIEW_PROTOCOL,
  type EligiblePair,
  type EligibleSampleRegistryResult,
  type AnonymousHumanVerdict,
} from "./eligible-sample-registry.js";

// BLOCKED-CANDIDATE-EVIDENCE-CLI-ADOPTION-1：接入 blocked-candidate-evidence/v1 只读渲染。
// import 类型用于本地函数签名（renderBlockedCandidateEvidence 入参）；
// re-export schemaId + 类型使 prod 编译闭包含 blocked-candidate-evidence 模块，并声明消费的 schema。
import {
  BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
  type BlockedCandidateEvidence,
} from "./blocked-candidate-evidence.js";

export {
  BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
  type BlockedCandidateEvidence,
  type BlockedDiagnosticSpan,
} from "./blocked-candidate-evidence.js";

// REVIEW-SURFACE-1-REAL-ADOPTION：接入 human-proxy-provenance schema 只读渲染。
// 真实 Case04/05/08 verdict artifact（gpt5.6-sol 人审代理规范化输出）经本渲染层展示。
// re-export schemaId + 类型使 prod 编译闭包含 human-proxy-provenance 模块。
import {
  HUMAN_PROXY_PROVENANCE_SCHEMA_ID,
  type NormalizedHumanProxyVerdict,
} from "./human-proxy-provenance.js";

export {
  HUMAN_PROXY_PROVENANCE_SCHEMA_ID,
  type NormalizedHumanProxyVerdict,
  type VerdictSpan,
} from "./human-proxy-provenance.js";

// REVIEW-SCHEMA-FREEZE-1：接入冻结的 review-artifact v1 只读契约。
// 仅 re-export，使 review-artifact-schema 进入 prod 编译闭包（tsconfig.prod.json files），
// 并让本 surface 声明其消费的 artifact schema 版本。不改变任何现有渲染行为。
export {
  REVIEW_ARTIFACT_SCHEMA_ID,
  REVIEW_ARTIFACT_SCHEMA_VERSION,
  REVIEW_ARTIFACT_SCHEMA_FULL_ID,
  parseReviewArtifact,
  type ReviewArtifactV1,
  type ReviewArtifactParseResult,
  type ReviewArtifactOutcome,
  type ArtifactSpan,
  type ModelRouting,
  type RouteDescriptor,
} from "./review-artifact-schema.js";

// G7-REVIEW-SURFACE：接入章节代理审批稿只读渲染（计划 §12.2）。
// type-only import：编译时擦除，运行时无依赖；类型来自 governance 模块（已在生产闭包）。
// 仅声明 review-surface 消费的 schema 类型，不引入运行时耦合。
import type { LoadProxyApprovedDraftResult } from "../governance/chapter-proxy-approval-draft-checkpoint.js";
import type { ChapterProxyApprovalArtifact } from "../governance/chapter-proxy-approval-types.js";

export type {
  LoadProxyApprovedDraftResult,
} from "../governance/chapter-proxy-approval-draft-checkpoint.js";
export type { ChapterProxyApprovalArtifact } from "../governance/chapter-proxy-approval-types.js";

// G7-FINALIZATION-PROD-BINDING：将用户定稿操作 + 反馈记录器拉入生产闭包（dist/）。
// value import + re-export：使 tsconfig.prod.json 编译闭包含 finalization / feedback-recorder，
// 供 CLI / handler / 统一编排器消费者调用（计划 §12.2 用户定稿入口）。
// 闭包自包含（仅依赖 node:fs / node:path + governance sibling），不依赖 legacy / eval / lab。
// review-surface-cli 本身仍为只读渲染层；finalization 操作的副作用由调用方（CLI/handler）承担。
export {
  acceptProxyDraft,
  acceptProxyDraftWithEdits,
  rejectAndRegenerate,
  inspectAlternatives,
  rollbackCommittedChapter,
  type AcceptProxyDraftOptions,
  type AcceptProxyDraftWithEditsOptions,
  type RejectAndRegenerateOptions,
  type RollbackCommittedChapterOptions,
  type FinalizationResult,
  type FinalizationAction,
  type InspectAlternativesSummary,
  type RollbackResult,
  type FactGuardRerunFn,
} from "../governance/chapter-proxy-approval-finalization.js";

export {
  recordProxyApprovalFeedback,
  loadProxyApprovalFeedback,
  computeEditedTextDiff,
  resolveFeedbackFilePath,
  type ProxyApprovalFeedbackRecord,
  type RecordProxyApprovalFeedbackOptions,
  type EditedTextDiff,
  type ProxyJudgmentBias,
  type FeedbackAction,
} from "../governance/chapter-proxy-approval-feedback-recorder.js";

// G7-FINALIZATION-ENTRY-PROD-BINDING：定稿真实调用链入口（计划 §12.2 line 585）。
// 接入统一编排器的 checkCandidateFactGuard（真实 FinalFactRecheck）+ commitAndSave（状态派生 + 最终提交）
// + recordProxyApprovalFeedback（反馈归集）。供 CLI / handler / 统一编排器消费者调用。
// 闭包自包含（仅依赖 governance sibling + core/orchestrator sibling），可安全进入生产闭包。
export {
  runFinalization,
  type FinalizationEntryAction,
  type FinalizationEntryOptions,
  type FinalizationEntryResult,
} from "../governance/chapter-proxy-approval-finalization-entry.js";

// G7-FINALIZATION-TRIGGER-PROD-BINDING：反馈摄入/健康归集生产触发时机（计划 §0.2 / §12.2）。
// 把 runFinalization -> ingestProxyApprovalFeedbackToStrategy -> aggregateReleaseHealth 三段调用链
// 封装为单一生产触发入口 triggerFinalizationWithFeedbackAndHealth，使内部调用链从"可被 handler
// 调用"升级为"生产自动触发"（用户定稿完成事件触发 ingest + health）。
// 闭包自包含（仅依赖 governance sibling），可安全进入生产闭包（dist/）；
// 不调用模型、不生成章节正文、不修改统一编排器主流程、不新增公开工具、不消费真实 gpt5.6-sol 预算。
export {
  triggerFinalizationWithFeedbackAndHealth,
  type FinalizationTriggerOptions,
  type FinalizationTriggerResult,
  type TriggerStrategyContext,
} from "../governance/chapter-proxy-approval-finalization-trigger.js";

// G7-FEEDBACK-INGESTOR-PROD-BINDING：用户反馈接入策略证据（计划 §12.2 line 587）。
// 把 feedback.jsonl 转化为 UserFeedbackIngestor evidence 写入 strategy-policy.json。
// 闭包自包含（仅依赖 governance sibling + learning sibling + node:fs/node:path），
// 可安全进入生产闭包；不调用模型、不修改 finalText、不阻断正文生成。
export {
  ingestProxyApprovalFeedbackToStrategy,
  ingestAllProxyApprovalFeedback,
  type StrategyContextResolver,
  type IngestProxyApprovalFeedbackOptions,
  type IngestProxyApprovalFeedbackResult,
  type IngestAllProxyApprovalFeedbackOptions,
  type IngestAllProxyApprovalFeedbackResult,
  type SkipReason,
} from "../governance/chapter-proxy-approval-feedback-ingestor.js";

// G7-RELEASE-HEALTH-AGGREGATOR-PROD-BINDING：release 健康报告归集（计划 §12.2 line 587）。
// 只读聚合 feedback.jsonl + strategy-policy.json 生成 release 健康快照；不修改任何文件。
// 闭包自包含（仅依赖 governance sibling + learning sibling + node:fs/node:path），
// 可安全进入生产闭包；可重复调用（幂等只读）。
export {
  aggregateReleaseHealth,
  type ActionBreakdown,
  type AlignmentStats,
  type EditStats,
  type FactGuardStats,
  type RollbackStats,
  type StrategyReputationSnapshot,
  type ReleaseHealthReport,
  type AggregateReleaseHealthOptions,
} from "../governance/release-health-aggregator.js";

// G7-REGISTRY-PROD-BINDING：章节代理审批 artifact registry（计划 §12.2）。
// 生产 handler（chapter-proxy-finalization-handler）inspect 动作需从 registry 加载 artifact。
// registry 含 P0 assertSafeApprovalId 目录穿越防护（字符集白名单 + resolve/relative 检测），
// 生产 inspect 必须复用此安全校验，不得用裸 fs.readFileSync 绕过。
// 闭包自包含（仅依赖 node:fs / node:path + governance sibling），可安全进入生产闭包。
export {
  createChapterProxyApprovalRegistry,
  type ChapterProxyApprovalRegistry,
  type ChapterProxyApprovalRegistryOptions,
} from "../governance/chapter-proxy-approval-registry.js";

// G7-REVIEW-RUNNER-PROD-BINDING：真实代理初审接入生产（计划 §6.3 / §7 / Phase G7）。
// 用户阻断项 P1 修复：runRealChapterProxyReview 已实现并通过 mock 测试，但 runner/caller
// 仅存在于 dist-test，生产 dist 中不存在，也没有生产调用入口。
//
// 通过 review-surface-cli value import + re-export 把 runner + caller 拉入生产闭包（dist/），
// 与 finalization / feedback-recorder / finalization-entry / finalization-trigger /
// feedback-ingestor / release-health-aggregator / registry 同模式。
//
// 边界：runner/caller 本身不调用真实模型（stub caller 零网络；real caller 需独立授权卡 +
// callerOverride 或 NOVELOS_JUDGE_* env，REQUIRES_AUTH 边界由 runner 内部守护）。
// review-surface-cli 本身仍为只读渲染层；真实审批调用的副作用（registry 写入）由调用方
// （handlers/chapter-proxy-review-handler）承担。
export {
  runStubChapterProxyReview,
  runRealChapterProxyReview,
  type ChapterProxyReviewRunnerOptions,
  type StubChapterReviewOptions,
  type RealChapterReviewOptions,
  type ChapterProxyReviewResult,
} from "../governance/chapter-proxy-approval-runner.js";

// G7-REVIEW-CALLER-PROD-BINDING：章节代理审批 caller 工厂（stub + 真实 gpt5.6-sol）。
// caller 工厂是 runner 的依赖（runner 内部 createStubChapterProxyApprovalCaller /
// createRealGpt56SolChapterProxyApprovalCaller），随 runner 一起进入生产闭包。
// 测试用 callChatCompletions 注入 mock；生产用内置 fetch 适配器（需独立授权卡）。
export {
  createStubChapterProxyApprovalCaller,
  createRealGpt56SolChapterProxyApprovalCaller,
  createOpenAIChatCompletionsFn,
  type ChapterProxyApprovalCaller,
  type ChapterProxyCallerCallOptions,
  type ChapterProxyCallerResult,
} from "../governance/chapter-proxy-approval-caller.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * Pair 的 artifact 数据（调用方从文件系统加载）。
 * 所有字段可选：缺失时 renderPairDetail 降级为 error/partial 状态。
 */
export interface PairArtifacts {
  /** raw 候选正文 */
  rawText?: string;
  /** editorial 候选正文 */
  editorialText?: string;
  /** FactGuard 详情（每个候选一条） */
  factGuardDetails?: Array<{
    candidateId: string;
    passed: boolean;
    evidence?: string;
    reason?: string;
  }>;
  /** 故事保存门详情 */
  storyPreservationDetails?: {
    passed: boolean;
    events?: string[];
    reason?: string;
  };
  /** judge 仲裁证据 */
  judgeEvidence?: {
    winner: "raw" | "editorial" | "tie";
    winningSpans?: Array<{ candidateId: string; start: number; end: number; text?: string }>;
    losingSpans?: Array<{ candidateId: string; start: number; end: number; text?: string }>;
    rationale?: string;
  };
  /** state commit 摘要 */
  stateCommitSummary?: {
    committed: number;
    rejected: number;
    quarantined: number;
  };
  /** 人工审阅焦点（advisory） */
  humanReviewFocus?: string[];
  /** schema 版本（来自 DEFAULT_HUMAN_REVIEW_PROTOCOL.formVersion） */
  schemaVersion?: string;
  /** 模型路由（expected/actual 分开） */
  modelRouting?: {
    expected?: { provider?: string; model?: string; route?: string };
    actual?: { provider?: string; model?: string; route?: string };
  };
}

/**
 * Span 跳转链接（可解析为文本片段）。
 */
export interface SpanLink {
  label: string;
  candidateId: string;
  start: number;
  end: number;
  text: string;
}

/**
 * 渲染输出。
 */
export interface ReviewSurfaceRenderedOutput {
  /** 命令名 */
  command: string;
  /** 状态：ok / error / insufficient_data / schema_unsupported */
  status: "ok" | "error" | "insufficient_data" | "schema_unsupported";
  /** 渲染后的文本（终端可读） */
  body: string;
  /** redaction 日志（记录哪些内容被 redacted） */
  redactionLog: string[];
  /** span 跳转链接（可解析为文本片段） */
  spanLinks?: SpanLink[];
}

/**
 * Schema 版本检测结果。
 */
export interface SchemaVersionDetection {
  supported: boolean;
  migrationHint?: string;
}

// ============================================================================
// 常量
// ============================================================================

/** 当前支持的 schema 版本集合 */
const SUPPORTED_SCHEMA_VERSIONS = new Set<string>(["anon-v1"]);

/** 未支持版本的迁移提示 */
const UNSUPPORTED_SCHEMA_MIGRATION_HINT =
  "当前 review CLI 只支持 schema 版本 anon-v1；请用 EligibleSampleRegistry 重新整理 artifact，" +
  "或升级 review-surface-cli 以支持新版本。降级为只读模式，不阻断查看。";

// ============================================================================
// 1. renderEligiblePairsList
// ============================================================================

/**
 * 渲染 eligible pairs 列表。
 *
 * - 空 registry → insufficient_data
 * - 非空 → 列出 eligible pairs + excluded samples（含原因）
 */
export function renderEligiblePairsList(
  registry: EligibleSampleRegistryResult
): ReviewSurfaceRenderedOutput {
  const lines: string[] = [];
  const redactionLog: string[] = [];

  lines.push("=== Eligible Sample Registry ===");
  lines.push(`总计：${registry.totalCount} | eligible：${registry.eligibleCount} | excluded：${registry.excludedSamples.length}`);
  lines.push(`insufficient-data：${registry.insufficientData ? "是（< 3 pair，不推断正负收益）" : "否"}`);
  lines.push("");

  if (registry.eligiblePairs.length === 0 && registry.excludedSamples.length === 0) {
    return {
      command: "list",
      status: "insufficient_data",
      body: lines.join("\n") + "\n无 eligible pair（registry 为空）。",
      redactionLog,
    };
  }

  if (registry.eligiblePairs.length > 0) {
    lines.push("--- Eligible Pairs ---");
    for (const pair of registry.eligiblePairs) {
      lines.push(`  [${pair.pairId}] outcome=${pair.outcomeType} judgeWinner=${pair.judgeWinner} case=${pair.runProvenance.caseId} layer=${pair.runProvenance.layer}`);
    }
    lines.push("");
  }

  if (registry.excludedSamples.length > 0) {
    lines.push("--- Excluded Samples（不计 win/loss pair）---");
    for (const ex of registry.excludedSamples) {
      lines.push(`  [${ex.sampleId}] outcome=${ex.outcomeType} reason=${ex.reason}`);
    }
  }

  const status = registry.insufficientData ? "insufficient_data" : "ok";
  return {
    command: "list",
    status,
    body: lines.join("\n"),
    redactionLog,
  };
}

// ============================================================================
// 2. renderPairDetail
// ============================================================================

/**
 * 渲染单个 pair 的详情。
 *
 * - artifacts=null → error（缺文件）
 * - schema 版本不支持 → schema_unsupported（只读降级）
 * - 正常 → ok（含 raw/editorial 文本、FactGuard、judge、state commit、human review focus、span links）
 *
 * 所有输出经 redactSecrets 过滤，不泄露 API key/Bearer token/模型内部推理。
 */
export function renderPairDetail(
  pair: EligiblePair,
  artifacts: PairArtifacts | null
): ReviewSurfaceRenderedOutput {
  const lines: string[] = [];
  const redactionLog: string[] = [];
  const spanLinks: SpanLink[] = [];

  lines.push(`=== Pair Detail: ${pair.pairId} ===`);
  lines.push(`outcome: ${pair.outcomeType} | judgeWinner: ${pair.judgeWinner}`);
  lines.push(`run: ${pair.runProvenance.orchestratorRunId} | case: ${pair.runProvenance.caseId} | layer: ${pair.runProvenance.layer}`);
  lines.push("");

  // artifacts 缺失 → error
  if (!artifacts) {
    return {
      command: "show",
      status: "error",
      body: lines.join("\n") + "\n[ERROR] artifact 缺失（PairArtifacts=null），无法渲染详情。请检查文件系统是否完整。",
      redactionLog,
      spanLinks,
    };
  }

  // schema 版本检查
  const schemaDetection = artifacts.schemaVersion
    ? detectSchemaVersion(artifacts.schemaVersion)
    : { supported: true };
  if (!schemaDetection.supported) {
    return {
      command: "show",
      status: "schema_unsupported",
      body: lines.join("\n") + `\n[SCHEMA UNSUPPORTED] schemaVersion=${artifacts.schemaVersion}\n${schemaDetection.migrationHint}\n\n降级为只读模式，不阻断查看。`,
      redactionLog,
      spanLinks,
    };
  }

  // raw 候选
  if (artifacts.rawText !== undefined) {
    const { redacted, log } = redactSecrets(artifacts.rawText);
    redactionLog.push(...log);
    lines.push("--- Raw 候选 ---");
    lines.push(`  candidateId: ${pair.rawCandidate.candidateId}`);
    lines.push(`  sourcePath: ${pair.rawCandidate.sourcePath}`);
    lines.push(`  sha256: ${pair.rawCandidate.sourceSha256.slice(0, 12)}...`);
    lines.push(`  正文：${redacted}`);
    lines.push("");
  }

  // editorial 候选
  if (artifacts.editorialText !== undefined) {
    const { redacted, log } = redactSecrets(artifacts.editorialText);
    redactionLog.push(...log);
    lines.push("--- Editorial 候选 ---");
    lines.push(`  candidateId: ${pair.editorialCandidate.candidateId}`);
    lines.push(`  sourcePath: ${pair.editorialCandidate.sourcePath}`);
    lines.push(`  sha256: ${pair.editorialCandidate.sourceSha256.slice(0, 12)}...`);
    lines.push(`  正文：${redacted}`);
    lines.push("");
  }

  // FactGuard 详情
  if (artifacts.factGuardDetails && artifacts.factGuardDetails.length > 0) {
    lines.push("--- FactGuard ---");
    for (const fg of artifacts.factGuardDetails) {
      const status = fg.passed ? "PASS" : "BLOCK";
      lines.push(`  [${fg.candidateId}] ${status}${fg.reason ? ` reason=${fg.reason}` : ""}${fg.evidence ? ` evidence=${fg.evidence}` : ""}`);
    }
    lines.push("");
  }

  // 故事保存门
  if (artifacts.storyPreservationDetails) {
    lines.push("--- Story Preservation Gate ---");
    lines.push(`  passed: ${artifacts.storyPreservationDetails.passed}`);
    if (artifacts.storyPreservationDetails.events) {
      lines.push(`  events: ${artifacts.storyPreservationDetails.events.join(", ")}`);
    }
    if (artifacts.storyPreservationDetails.reason) {
      lines.push(`  reason: ${artifacts.storyPreservationDetails.reason}`);
    }
    lines.push("");
  }

  // judge 证据
  if (artifacts.judgeEvidence) {
    lines.push("--- Judge 仲裁 ---");
    lines.push(`  winner: ${artifacts.judgeEvidence.winner}`);
    if (artifacts.judgeEvidence.rationale) {
      lines.push(`  rationale: ${artifacts.judgeEvidence.rationale}`);
    }
    if (artifacts.judgeEvidence.winningSpans) {
      for (const span of artifacts.judgeEvidence.winningSpans) {
        const resolved = resolveSpanLink(span, artifacts);
        if (resolved) {
          spanLinks.push({
            label: `winning-span[${span.candidateId}]`,
            candidateId: resolved.candidateId,
            start: resolved.start,
            end: resolved.end,
            text: resolved.text,
          });
          lines.push(`  winning span [${span.candidateId} ${span.start}:${span.end}]: ${resolved.text}`);
        }
      }
    }
    if (artifacts.judgeEvidence.losingSpans) {
      for (const span of artifacts.judgeEvidence.losingSpans) {
        const resolved = resolveSpanLink(span, artifacts);
        if (resolved) {
          spanLinks.push({
            label: `losing-span[${span.candidateId}]`,
            candidateId: resolved.candidateId,
            start: resolved.start,
            end: resolved.end,
            text: resolved.text,
          });
          lines.push(`  losing span [${span.candidateId} ${span.start}:${span.end}]: ${resolved.text}`);
        }
      }
    }
    lines.push("");
  }

  // state commit 摘要
  if (artifacts.stateCommitSummary) {
    lines.push("--- State Commit ---");
    lines.push(`  committed: ${artifacts.stateCommitSummary.committed} | rejected: ${artifacts.stateCommitSummary.rejected} | quarantined: ${artifacts.stateCommitSummary.quarantined}`);
    lines.push("");
  }

  // human review focus
  if (artifacts.humanReviewFocus && artifacts.humanReviewFocus.length > 0) {
    lines.push("--- Human Review Focus ---");
    for (const focus of artifacts.humanReviewFocus) {
      lines.push(`  - ${focus}`);
    }
    lines.push("");
  }

  // model routing（expected/actual 分开）
  if (artifacts.modelRouting) {
    lines.push("--- Model Routing ---");
    if (artifacts.modelRouting.expected) {
      const e = artifacts.modelRouting.expected;
      lines.push(`  expected: provider=${e.provider ?? "?"} model=${e.model ?? "?"} route=${e.route ?? "?"}`);
    }
    if (artifacts.modelRouting.actual) {
      const a = artifacts.modelRouting.actual;
      lines.push(`  actual: provider=${a.provider ?? "?"} model=${a.model ?? "?"} route=${a.route ?? "?"}`);
    }
    lines.push("");
  }

  return {
    command: "show",
    status: "ok",
    body: lines.join("\n"),
    redactionLog,
    spanLinks,
  };
}

// ============================================================================
// 3. renderBlockedCandidateEvidence (BLOCKED-CANDIDATE-EVIDENCE-CLI-ADOPTION-1)
// ============================================================================

/**
 * 渲染 blocked-candidate-evidence/v1 artifact（hard-block 候选安全证据）。
 *
 * 与 renderPairDetail 的区别：
 * - blocked evidence 是非交付物（blocked=true / deliverable=false），不是 eligible pair。
 * - 渲染 blocked 状态、blockedStage/blockedReason、候选上下文（candidateId/selectedSource）、
 *   hash 指纹（rawSha256/finalTextSha256）、storedText（被阻断正文，已由 builder redact）、
 *   diagnostic spans（FactGuard/completeness 证据片段）、模型元数据、FailureEnvelope 摘要。
 * - storedText 已由 buildBlockedCandidateEvidence 的 redactRawText 过滤 secret/<think>，
 *   本渲染层直接输出，不再重复 redact（避免双重 redaction 混乱）。
 *
 * 核心不变量：
 * - 只读：不生成正文、不修改 finalText、不提交 state、不调用模型。
 * - 不输出 chapterFilePath / stateCommit（blocked 路径无这些字段）。
 * - 输出明确 blocked=true / deliverable=false，便于 Review CLI 与 trace 区分。
 */
export function renderBlockedCandidateEvidence(
  evidence: BlockedCandidateEvidence,
): ReviewSurfaceRenderedOutput {
  const lines: string[] = [];
  const redactionLog: string[] = [];

  lines.push("=== Blocked Candidate Evidence ===");
  lines.push(`schemaId: ${evidence.schemaId}`);
  lines.push(`workspaceId: ${evidence.workspaceId}`);
  lines.push(`chapterId: ${evidence.chapterId} (chapter ${evidence.chapterNumber})`);
  lines.push(`blocked: ${evidence.blocked} | deliverable: ${evidence.deliverable}`);
  lines.push(`blockedStage: ${evidence.blockedStage}`);
  lines.push(`blockedReason: ${evidence.blockedReason}`);
  lines.push(`severity: ${evidence.severity}`);
  lines.push("");

  // 候选上下文（REPAIR 新增字段：final 路径有候选上下文，raw 路径为 null）
  lines.push("--- Candidate Context ---");
  lines.push(`candidateId: ${evidence.candidateId ?? "(null — raw 路径无最终候选上下文)"}`);
  lines.push(`selectedSource: ${evidence.selectedSource ?? "(null — raw 路径)"}`);
  lines.push("");

  // Hash 指纹（身份校验）
  lines.push("--- Hash Fingerprints ---");
  lines.push(`rawSha256: ${evidence.rawSha256}`);
  lines.push(`rawLength: ${evidence.rawLength}`);
  if (evidence.finalTextSha256 != null) {
    lines.push(`finalTextSha256: ${evidence.finalTextSha256}`);
    lines.push(`finalTextLength: ${evidence.finalTextLength}`);
  } else {
    lines.push("finalTextSha256: (null — raw 路径无 finalText)");
  }
  lines.push(`storedSha256: ${evidence.storedSha256}`);
  lines.push("");

  // 被阻断正文（storedText 已由 builder redact secret/<think>）
  lines.push("--- Stored Text (redacted by builder) ---");
  lines.push(evidence.storedText);
  lines.push("");

  // 诊断 spans（FactGuard 错误 / completeness findings 的可定位证据片段）
  if (evidence.diagnosticSpans && evidence.diagnosticSpans.length > 0) {
    lines.push("--- Diagnostic Spans ---");
    for (const span of evidence.diagnosticSpans) {
      lines.push(`  [${span.kind}] resolved=${span.resolved} span=[${span.start}:${span.end}]`);
      lines.push(`    excerpt: ${span.excerpt || "(empty — 未在正文中定位)"}`);
      lines.push(`    reason: ${span.reason}`);
    }
    lines.push("");
  }

  // redaction 日志（builder 记录的 redact 操作）
  if (evidence.redactionLog && evidence.redactionLog.length > 0) {
    lines.push("--- Redaction Log ---");
    for (const entry of evidence.redactionLog) {
      lines.push(`  - ${entry}`);
    }
    lines.push("");
  }

  // raw 模型元数据
  lines.push("--- Raw Model Metadata ---");
  lines.push(`rawModel: ${evidence.rawModel ?? "?"}`);
  lines.push(`rawFinishReason: ${evidence.rawFinishReason ?? "?"}`);
  lines.push(`rawMaxTokens: ${evidence.rawMaxTokens ?? "?"}`);
  lines.push(`modelVersion: ${evidence.modelVersion ?? "?"}`);
  lines.push("");

  // FailureEnvelope 摘要
  lines.push("--- Failure Envelope ---");
  lines.push(`stage: ${evidence.failureEnvelope.stage}`);
  lines.push(`severity: ${evidence.failureEnvelope.severity}`);
  lines.push(`reason: ${evidence.failureEnvelope.reason}`);
  lines.push(`recoverable: ${evidence.failureEnvelope.recoverable}`);
  lines.push(`degradedTo: ${evidence.failureEnvelope.degradedTo}`);
  lines.push("");

  lines.push(`artifactPath: ${evidence.artifactPath}`);
  lines.push(`createdAt: ${evidence.createdAt}`);

  return {
    command: "show",
    status: "ok",
    body: lines.join("\n"),
    redactionLog,
  };
}

// ============================================================================
// 3b. renderHumanProxyVerdict (REVIEW-SURFACE-1-REAL-ADOPTION)
// ============================================================================

/**
 * 渲染 pinovel.human-proxy-provenance/v1 artifact（gpt5.6-sol 人审代理规范化 verdict）。
 *
 * 真实 Case04/05/08 verdict artifact 经本渲染层展示。与 renderPairDetail 的区别：
 * - verdict artifact 不携带完整候选正文，只携带 winningSpans/losingSpans 的 excerpt
 *   （匿名 A/B 侧的文本片段 + 维度 + 说明）。
 * - 渲染 verdictId/preference/anonymousMapping/confidence/worthReplacing、固定审阅者身份
 *   （reviewerType/reviewerModel/humanEquivalent）、策略分区（modelVersion/strategyId/
 *   sourceChapter/productionJudgeAgreement）、winning/losing spans、rationale、provenance。
 * - excerpt 经 redactSecrets 过滤（防 secret 泄露）；rationale 同样过滤。
 *
 * 核心不变量：
 * - 只读：不生成正文、不修改 finalText、不提交 state、不调用模型、不写策略信誉。
 * - 不输出 editorial/raw 标签到 rationale/explanation（匿名 A/B 原则由 verdict schema 保证）。
 * - reviewer 身份固定展示（validated_human_proxy + gpt5.6-sol + humanEquivalent=true）。
 */
export function renderHumanProxyVerdict(
  verdict: NormalizedHumanProxyVerdict,
): ReviewSurfaceRenderedOutput {
  const lines: string[] = [];
  const redactionLog: string[] = [];

  lines.push("=== Human Proxy Verdict ===");
  lines.push(`schemaId: ${verdict.schemaId}`);
  lines.push(`verdictId: ${verdict.verdictId}`);
  lines.push(`preference: ${verdict.preference}`);
  lines.push(`anonymousMapping: A=${verdict.anonymousMapping.A} B=${verdict.anonymousMapping.B}`);
  lines.push(`confidence: ${verdict.confidence} | worthReplacing: ${verdict.worthReplacing ?? "?"}`);
  lines.push("");

  // 固定审阅者身份
  lines.push("--- Reviewer Identity ---");
  lines.push(`reviewerType: ${verdict.reviewerType}`);
  lines.push(`reviewerModel: ${verdict.reviewerModel}`);
  lines.push(`humanEquivalent: ${verdict.humanEquivalent}`);
  lines.push("");

  // 策略分区（按 modelVersion + strategyId 隔离）
  lines.push("--- Strategy Partition ---");
  lines.push(`modelVersion: ${verdict.modelVersion}`);
  lines.push(`strategyId: ${verdict.strategyId}`);
  lines.push(`sourceChapter: ${verdict.sourceChapter}`);
  lines.push(`productionJudgeAgreement: ${verdict.productionJudgeAgreement ?? "(无对比)"}`);
  lines.push("");

  // Winning spans（excerpt + dimension + explanation）
  if (verdict.winningSpans.length > 0) {
    lines.push("--- Winning Spans ---");
    verdict.winningSpans.forEach((span, i) => {
      const { redacted, log } = redactSecrets(span.excerpt);
      redactionLog.push(...log);
      lines.push(`  [${i}] side=${span.side} dimension=${span.dimension}`);
      lines.push(`    excerpt: ${redacted}`);
      lines.push(`    explanation: ${span.explanation}`);
    });
    lines.push("");
  }

  // Losing spans
  if (verdict.losingSpans.length > 0) {
    lines.push("--- Losing Spans ---");
    verdict.losingSpans.forEach((span, i) => {
      const { redacted, log } = redactSecrets(span.excerpt);
      redactionLog.push(...log);
      lines.push(`  [${i}] side=${span.side} dimension=${span.dimension}`);
      lines.push(`    excerpt: ${redacted}`);
      lines.push(`    explanation: ${span.explanation}`);
    });
    lines.push("");
  }

  // Rationale
  lines.push("--- Rationale ---");
  const { redacted: redactedRationale, log: rationaleLog } = redactSecrets(verdict.rationale);
  redactionLog.push(...rationaleLog);
  lines.push(redactedRationale);
  lines.push("");

  // Provenance（来源追溯）
  lines.push("--- Provenance ---");
  lines.push(`sourceArtifactPath: ${verdict.provenance.sourceArtifactPath}`);
  lines.push(`sourceArtifactHash: ${verdict.provenance.sourceArtifactHash}`);
  lines.push(`orchestratorRunId: ${verdict.provenance.orchestratorRunId}`);
  lines.push(`caseId: ${verdict.provenance.caseId}`);
  lines.push(`workspaceId: ${verdict.provenance.workspaceId}`);
  lines.push(`sourceChapter: ${verdict.provenance.sourceChapter}`);
  lines.push("");

  lines.push(`timestamp: ${verdict.timestamp}`);

  return {
    command: "show",
    status: "ok",
    body: lines.join("\n"),
    redactionLog,
  };
}

// ============================================================================
// 4. resolveSpanLink
// ============================================================================

/**
 * 把 span 引用解析为文本片段。
 *
 * - candidateId="raw-XXX" → 从 artifacts.rawText 取
 * - candidateId="ed-XXX" → 从 artifacts.editorialText 取
 * - 未知 candidateId 或越界 → null
 *
 * 越界策略：end 超过文本长度时返回 null（不截断，明确告知越界）。
 */
export function resolveSpanLink(
  span: { candidateId: string; start: number; end: number },
  artifacts: PairArtifacts
): { candidateId: string; start: number; end: number; text: string } | null {
  let text: string | undefined;
  if (span.candidateId.startsWith("raw")) {
    text = artifacts.rawText;
  } else if (span.candidateId.startsWith("ed")) {
    text = artifacts.editorialText;
  } else {
    return null;
  }

  if (text === undefined) return null;
  if (span.start < 0 || span.end > text.length || span.start > span.end) return null;

  return {
    candidateId: span.candidateId,
    start: span.start,
    end: span.end,
    text: text.slice(span.start, span.end),
  };
}

// ============================================================================
// 5. redactSecrets
// ============================================================================

/**
 * Redact 输出中的 secret 与私有思维。
 *
 * Redaction 规则：
 * 1. API key 模式（sk-XXX / API_KEY=XXX）→ 替换为 [REDACTED:api-key]
 * 2. Bearer token（Bearer XXX）→ 替换为 [REDACTED:bearer-token]
 * 3. 模型内部推理（<think>...</think>）→ 替换为 [REDACTED:internal-reasoning]
 *
 * 正常正文不被误 redact。
 */
export function redactSecrets(text: string): { redacted: string; log: string[] } {
  let redacted = text;
  const log: string[] = [];

  // 1. API key（sk- 后跟至少 10 个字母数字字符）
  const apiKeyPattern = /sk-[a-zA-Z0-9]{10,}/g;
  if (apiKeyPattern.test(redacted)) {
    redacted = redacted.replace(apiKeyPattern, "[REDACTED:api-key]");
    log.push("redacted api-key (sk-XXX pattern)");
  }
  // API_KEY=XXX
  const apiKeyEnvPattern = /API_KEY\s*=\s*[^\s]+/gi;
  if (apiKeyEnvPattern.test(redacted)) {
    redacted = redacted.replace(apiKeyEnvPattern, "API_KEY=[REDACTED:api-key]");
    if (!log.some(l => l.includes("api-key"))) log.push("redacted api-key (API_KEY=XXX pattern)");
  }

  // 2. Bearer token
  const bearerPattern = /Bearer\s+[a-zA-Z0-9._\-]+/g;
  if (bearerPattern.test(redacted)) {
    redacted = redacted.replace(bearerPattern, "Bearer [REDACTED:bearer-token]");
    log.push("redacted bearer-token");
  }

  // 3. 模型内部推理 <think>...</think>
  const thinkPattern = /<think>[\s\S]*?<\/think>/g;
  if (thinkPattern.test(redacted)) {
    redacted = redacted.replace(thinkPattern, "[REDACTED:internal-reasoning]");
    log.push("redacted internal-reasoning (<think> block)");
  }

  return { redacted, log };
}

// ============================================================================
// 6. exportReviewResponse
// ============================================================================

/**
 * 导出匿名 review response。
 *
 * - reviewerRawId 经 anonymizeReviewerId 匿名化（不可逆 SHA-256 前 8 位）。
 * - 输出含 preference / winningSpans / losingSpans / rationale / submittedAt。
 * - 输出不含 model 版本（防 reviewer 锚定模型）。
 * - 输出不含 judge verdict（防锚定裁判结论）。
 *
 * REVIEW-SURFACE-1B 扩展：
 * - 支持结构化 span（structuredSpans: {side, candidateId, start, end}）+ artifacts 解析为文本。
 * - 支持 format="json"：输出机器可读 JSON，便于 round-trip（export → parse → verify）。
 * - 向后兼容：winningSpans/losingSpans 字符串数组 + 无 options 调用仍可工作。
 */
export function exportReviewResponse(
  pair: EligiblePair,
  response: {
    reviewerRawId: string;
    preference: "raw" | "editorial" | "tie" | "undecided";
    /** Legacy：spans 以纯字符串形式给出（仅 text 模式） */
    winningSpans?: string[];
    losingSpans?: string[];
    /** REVIEW-SURFACE-1B：结构化 span，需配合 options.artifacts 解析为文本 */
    structuredSpans?: Array<{
      side: "winning" | "losing";
      candidateId: string;
      start: number;
      end: number;
    }>;
    rationale: string;
    submittedAt: string;
  },
  options?: {
    artifacts?: PairArtifacts;
    format?: "text" | "json";
  }
): ReviewSurfaceRenderedOutput {
  const reviewerAnonId = anonymizeReviewerId(response.reviewerRawId);
  const redactionLog: string[] = [];
  const format: "text" | "json" = options?.format ?? "text";

  // 解析 structuredSpans → 带 text 的 winning/losing 列表
  const winningSpansResolved: Array<{ candidateId: string; start: number; end: number; text: string }> = [];
  const losingSpansResolved: Array<{ candidateId: string; start: number; end: number; text: string }> = [];

  if (response.structuredSpans && response.structuredSpans.length > 0) {
    if (!options?.artifacts) {
      return {
        command: "export",
        status: "error",
        body: "structuredSpans 需要提供 artifacts 才能解析文本。",
        redactionLog,
      };
    }
    for (const ss of response.structuredSpans) {
      const resolved = resolveSpanLink(
        { candidateId: ss.candidateId, start: ss.start, end: ss.end },
        options.artifacts!
      );
      if (!resolved) {
        return {
          command: "export",
          status: "error",
          body: `span 越界或无法解析：candidateId=${ss.candidateId} start=${ss.start} end=${ss.end}`,
          redactionLog,
        };
      }
      const entry = { candidateId: resolved.candidateId, start: resolved.start, end: resolved.end, text: resolved.text };
      if (ss.side === "winning") winningSpansResolved.push(entry);
      else losingSpansResolved.push(entry);
    }
  }

  const winningStringSpans = response.winningSpans ?? [];
  const losingStringSpans = response.losingSpans ?? [];

  if (format === "json") {
    // 机器可读 JSON：不含 reviewerRawId / model 版本 / judge verdict
    const jsonObj = {
      pairId: pair.pairId,
      reviewerAnonId,
      preference: response.preference,
      submittedAt: response.submittedAt,
      winningSpans: winningSpansResolved,
      losingSpans: losingSpansResolved,
      rationale: response.rationale,
    };
    const { redacted, log } = redactSecrets(JSON.stringify(jsonObj, null, 2));
    redactionLog.push(...log);
    return {
      command: "export",
      status: "ok",
      body: redacted,
      redactionLog,
    };
  }

  // 文本格式（legacy 字符串 spans + structuredSpans 解析文本合并展示）
  const lines: string[] = [];
  lines.push("=== Review Response (Anonymized) ===");
  lines.push(`pairId: ${pair.pairId}`);
  lines.push(`reviewerAnonId: ${reviewerAnonId}`);
  lines.push(`preference: ${response.preference}`);
  lines.push(`submittedAt: ${response.submittedAt}`);
  lines.push("");
  lines.push("--- Winning Spans ---");
  for (const ws of winningSpansResolved) {
    lines.push(`  - [${ws.candidateId}:${ws.start}-${ws.end}] ${ws.text}`);
  }
  for (const s of winningStringSpans) {
    const { redacted, log } = redactSecrets(s);
    redactionLog.push(...log);
    lines.push(`  - ${redacted}`);
  }
  lines.push("");
  lines.push("--- Losing Spans ---");
  for (const ls of losingSpansResolved) {
    lines.push(`  - [${ls.candidateId}:${ls.start}-${ls.end}] ${ls.text}`);
  }
  for (const s of losingStringSpans) {
    const { redacted, log } = redactSecrets(s);
    redactionLog.push(...log);
    lines.push(`  - ${redacted}`);
  }
  lines.push("");
  lines.push("--- Rationale ---");
  const { redacted: redactedRationale, log: rationaleLog } = redactSecrets(response.rationale);
  redactionLog.push(...rationaleLog);
  lines.push(redactedRationale);

  return {
    command: "export",
    status: "ok",
    body: lines.join("\n"),
    redactionLog,
  };
}

// ============================================================================
// 6b. renderDiff (REVIEW-SURFACE-1B)
// ============================================================================

/**
 * 渲染 raw vs editorial 的行级 diff，便于审阅者定位 span。
 *
 * - 任一文本缺失 → error（不静默）。
 * - 完全相同 → 标记无差异。
 * - 否则 → LCS 行级 diff：`- ` 仅 raw 行，`+ ` 仅 editorial 行，`  ` 共同行。
 *
 * 不调用模型；不修改 finalText；不是 gate。
 */
export function renderDiff(artifacts: PairArtifacts): ReviewSurfaceRenderedOutput {
  const redactionLog: string[] = [];

  if (artifacts.rawText === undefined || artifacts.editorialText === undefined) {
    return {
      command: "diff",
      status: "error",
      body: "renderDiff 失败：rawText 或 editorialText 缺失，无法对比。",
      redactionLog,
    };
  }

  const { redacted: rawRedacted, log: rawLog } = redactSecrets(artifacts.rawText);
  const { redacted: edRedacted, log: edLog } = redactSecrets(artifacts.editorialText);
  redactionLog.push(...rawLog, ...edLog);

  if (rawRedacted === edRedacted) {
    return {
      command: "diff",
      status: "ok",
      body: "=== Diff: raw vs editorial ===\n（无差异 / identical）",
      redactionLog,
    };
  }

  const rawLines = rawRedacted.split("\n");
  const edLines = edRedacted.split("\n");
  const diffEntries = computeLineDiff(rawLines, edLines);

  const lines: string[] = [];
  lines.push("=== Diff: raw vs editorial ===");
  for (const entry of diffEntries) {
    if (entry.type === "common") {
      lines.push(`  ${entry.text}`);
    } else if (entry.type === "raw_only") {
      lines.push(`- ${entry.text}`);
    } else {
      lines.push(`+ ${entry.text}`);
    }
  }

  return {
    command: "diff",
    status: "ok",
    body: lines.join("\n"),
    redactionLog,
  };
}

/** LCS 行级 diff 内部辅助。 */
function computeLineDiff(
  a: string[],
  b: string[]
): Array<{ type: "common" | "raw_only" | "ed_only"; text: string }> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: Array<{ type: "common" | "raw_only" | "ed_only"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "common", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "raw_only", text: a[i] });
      i++;
    } else {
      result.push({ type: "ed_only", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "raw_only", text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "ed_only", text: b[j] });
    j++;
  }
  return result;
}

// ============================================================================
// 6c. parseStructuredSpanRef (REVIEW-SURFACE-1B)
// ============================================================================

/**
 * 解析结构化 span 引用字符串 `candidateId:start-end` 为 {candidateId, start, end}。
 *
 * - 合法：`ed-001:0-7` → {candidateId:"ed-001", start:0, end:7}
 * - start === end 合法（空 span，0 长度）
 * - 非法格式 / 负数 / start > end → null（不抛异常）
 */
export function parseStructuredSpanRef(
  ref: string
): { candidateId: string; start: number; end: number } | null {
  if (typeof ref !== "string") return null;
  const match = ref.match(/^([^:]+):(\d+)-(\d+)$/);
  if (!match) return null;
  const candidateId = match[1];
  const start = parseInt(match[2], 10);
  const end = parseInt(match[3], 10);
  if (start > end) return null;
  return { candidateId, start, end };
}

// ============================================================================
// 6d. verifyReviewResponse (REVIEW-SURFACE-1B)
// ============================================================================

/**
 * 验证已导出的 review response 的完整性（reload 后校验）。
 *
 * 检查项：
 * 1. preference ∈ {raw, editorial, tie, undecided}
 * 2. reviewerAnonId 以 `anon-` 前缀（防 reviewer 身份泄漏）
 * 3. 所有 span（winning + losing）的 candidateId 已知、可解析、未越界
 * 4. span.text 与实际解析文本一致（防篡改）
 * 5. rationale 不含 secret（API key / Bearer token / 模型内部推理）
 *
 * 返回 {ok, errors}；ok=true 当且仅当 errors 为空。
 */
export function verifyReviewResponse(
  response: {
    pairId?: string;
    reviewerAnonId?: string;
    preference?: string;
    submittedAt?: string;
    winningSpans?: Array<{ candidateId: string; start: number; end: number; text: string }>;
    losingSpans?: Array<{ candidateId: string; start: number; end: number; text: string }>;
    rationale?: string;
  },
  artifacts: PairArtifacts
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. preference 合法性
  const validPrefs = ["raw", "editorial", "tie", "undecided"];
  if (!validPrefs.includes(response.preference || "")) {
    errors.push(`preference 非法或缺失：${response.preference}`);
  }

  // 2. reviewerAnonId 匿名化
  const anonId = response.reviewerAnonId || "";
  if (!anonId.startsWith("anon-")) {
    errors.push(`reviewerAnonId 未匿名化或缺失（必须以 anon- 前缀，防 reviewer 泄漏）：${anonId}`);
  }

  // 3 & 4. span 解析 + text 一致性
  const allSpans: Array<{ candidateId: string; start: number; end: number; text: string; side: string }> = [
    ...(response.winningSpans || []).map(s => ({ ...s, side: "winning" })),
    ...(response.losingSpans || []).map(s => ({ ...s, side: "losing" })),
  ];
  for (const span of allSpans) {
    const cid = span.candidateId;
    if (!cid.startsWith("raw") && !cid.startsWith("ed")) {
      errors.push(`candidate 未知：candidateId=${cid}（必须以 raw / ed 前缀）`);
      continue;
    }
    const text = cid.startsWith("raw") ? artifacts.rawText : artifacts.editorialText;
    if (text === undefined) {
      errors.push(`candidate 文本缺失：candidateId=${cid}`);
      continue;
    }
    if (span.start < 0 || span.end > text.length || span.start > span.end) {
      errors.push(`span 越界：candidateId=${cid} start=${span.start} end=${span.end} textLength=${text.length}`);
      continue;
    }
    const actualText = text.slice(span.start, span.end);
    if (actualText !== span.text) {
      errors.push(`span text 不一致（疑似篡改）：candidateId=${cid} start=${span.start} end=${span.end} expected='${actualText}' actual='${span.text}'`);
    }
  }

  // 5. rationale secret 泄漏
  const rationale = response.rationale || "";
  const { log: rationaleLog } = redactSecrets(rationale);
  if (rationaleLog.length > 0) {
    errors.push(`rationale 含 secret（API key / Bearer token / 模型内部推理），疑似泄漏：${rationaleLog.join("; ")}`);
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================================
// 7. detectSchemaVersion
// ============================================================================

/**
 * 检测 schema 版本是否受支持。
 *
 * - 已知版本（anon-v1）→ supported=true
 * - 未知版本 → supported=false + migrationHint
 */
export function detectSchemaVersion(version: string): SchemaVersionDetection {
  if (SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    return { supported: true };
  }
  return {
    supported: false,
    migrationHint: UNSUPPORTED_SCHEMA_MIGRATION_HINT,
  };
}

// ============================================================================
// 8. renderChapterProxyDraft（G7-REVIEW-SURFACE，计划 §12.2）
// ============================================================================

/**
 * 章节代理审批稿渲染输入。
 *
 * - draft：从 chapter-approvals/{approvalId}.draft.meta.json 加载的代理审批稿（含正文）
 * - approval：从 registry 加载的 ChapterProxyApprovalArtifact（审批摘要/风险/rationale）
 * - hasPending：本章是否有未确认 pending（hasPendingProxyDraft 结果）
 *
 * draft 和 approval 均可为 null（调用方负责加载，缺失时传 null）。
 * 纯只读渲染层：不调用模型、不修改 finalText、不提交状态、不写 chapters/。
 */
export interface RenderChapterProxyDraftInput {
  draft: LoadProxyApprovedDraftResult | null;
  approval: ChapterProxyApprovalArtifact | null;
  hasPending: boolean;
}

/**
 * 渲染章节代理审批稿（计划 §12.2）。
 *
 * Review Surface 默认只展示代理审批稿、审批摘要和风险。
 *
 * 渲染规则：
 * - draft=null && approval=null → insufficient_data（无可渲染内容）
 * - 有数据 → ok：
 *   - 标题 + approvalId/chapterId + pending 状态
 *   - 审批摘要（approval 存在时）：finalStatus / recommendedSource / reviewerType /
 *     reviewerModel / reviewerModelVersion / forward+reverse verdict / decidedAt
 *   - 风险（approval 存在时）：HOLD_FOR_REGENERATION 给出 BLOCK 提示；risks[] 经 redactSecrets
 *   - losing spans（approval 存在且非空时）：经 redactSecrets
 *   - rationale（approval 存在时）：经 redactSecrets
 *   - 代理审批稿正文（draft 存在时）：candidateId / selectedSource / savedAt / draftFilePath + 正文
 *
 * 所有文本输出经 redactSecrets 过滤，不泄露 API key / Bearer token / 模型内部推理。
 *
 * 纯只读：不调用模型、不修改输入对象、不提交状态、不写 chapters/。
 */
export function renderChapterProxyDraft(
  input: RenderChapterProxyDraftInput,
): ReviewSurfaceRenderedOutput {
  const { draft, approval, hasPending } = input;
  const lines: string[] = [];
  const redactionLog: string[] = [];

  const approvalId = draft?.approvalId ?? approval?.approvalId ?? "(unknown)";
  const chapterId = draft?.chapterId ?? approval?.chapterId ?? "(unknown)";

  lines.push("=== Chapter Proxy Draft ===");
  lines.push(`approvalId: ${approvalId}`);
  lines.push(`chapterId: ${chapterId}`);
  lines.push(
    `pending: ${hasPending ? "是（未确认，commitAndSave 被守护阻断）" : "否"}`,
  );
  lines.push("");

  // draft 和 approval 都缺失 → insufficient_data
  if (!draft && !approval) {
    return {
      command: "show_proxy_draft",
      status: "insufficient_data",
      body:
        lines.join("\n") +
        "\n[INSUFFICIENT DATA] draft 和 approval 均缺失，无可渲染的代理审批稿。",
      redactionLog,
    };
  }

  // 审批摘要（approval 存在时）
  if (approval) {
    lines.push("--- Approval Summary ---");
    lines.push(`finalStatus: ${approval.finalStatus}`);
    lines.push(`recommendedSource: ${approval.recommendedSource}`);
    lines.push(`recommendedCandidateId: ${approval.recommendedCandidateId}`);
    lines.push(`reviewerType: ${approval.reviewerType}`);
    lines.push(`reviewerModel: ${approval.reviewerModel}`);
    lines.push(`reviewerModelVersion: ${approval.reviewerModelVersion}`);
    lines.push(`forwardVerdict: ${approval.forwardVerdict} | reverseVerdict: ${approval.reverseVerdict}`);
    lines.push(`decidedAt: ${approval.decidedAt}`);
    lines.push("");

    // 风险
    lines.push("--- Risks ---");
    if (approval.finalStatus === "HOLD_FOR_REGENERATION") {
      lines.push(
        "  [BLOCK] finalStatus=HOLD_FOR_REGENERATION，不产出代理审批稿，要求重新生成",
      );
    }
    if (approval.risks && approval.risks.length > 0) {
      for (const risk of approval.risks) {
        const { redacted, log } = redactSecrets(risk);
        redactionLog.push(...log);
        lines.push(`  - ${redacted}`);
      }
    } else if (approval.finalStatus !== "HOLD_FOR_REGENERATION") {
      lines.push("  (无风险声明)");
    }
    lines.push("");

    // losing spans
    if (approval.losingSpans && approval.losingSpans.length > 0) {
      lines.push("--- Losing Spans ---");
      for (const span of approval.losingSpans) {
        const { redacted, log } = redactSecrets(span);
        redactionLog.push(...log);
        lines.push(`  - ${redacted}`);
      }
      lines.push("");
    }

    // rationale
    if (approval.rationale) {
      lines.push("--- Rationale ---");
      const { redacted, log } = redactSecrets(approval.rationale);
      redactionLog.push(...log);
      lines.push(redacted);
      lines.push("");
    }
  }

  // 代理审批稿正文（draft 存在时）
  if (draft) {
    lines.push("--- Proxy Draft Text ---");
    lines.push(`candidateId: ${draft.candidateId}`);
    lines.push(`selectedSource: ${draft.selectedSource}`);
    lines.push(`savedAt: ${draft.savedAt}`);
    lines.push(`draftFilePath: ${draft.draftFilePath}`);
    const { redacted, log } = redactSecrets(draft.finalText);
    redactionLog.push(...log);
    lines.push("");
    lines.push(redacted);
    lines.push("");
  }

  return {
    command: "show_proxy_draft",
    status: "ok",
    body: lines.join("\n"),
    redactionLog,
  };
}
