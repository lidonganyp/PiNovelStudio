/**
 * QualityEvidenceRunReport — 单次生成运行质量证据报告（QUALITY-15 最小切片）
 *
 * 目标：把 QUALITY-10~14 的证据链汇总成一个"单次生成运行质量证据报告"，
 * 写入 stageResults，供人工复盘和后续 UI/CLI 展示使用。
 * **只做报告，不做裁判，不做门禁，不改 prompt，不改 winner。**
 *
 * 核心原则（QUALITY-15 任务书）：
 * - 不新增 hard gate；报告只是审计汇总，不是 gate。
 * - 不引入文学总分、pass/fail、grade、score、weightedScore、rankedScore。
 * - 不改 finalText；报告只读 stageResults 中的证据字段。
 * - 不强制生成 candidate；no-op / 无 candidate 时仍生成报告（说明无 editorial）。
 * - 不改 judge prompt；报告不进入 judge prompt（报告在 judge 返回后才编译）。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则；报告不进入 winner 决策。
 * - 不调用真实模型；报告编译是纯本地字段搬运 + 计数。
 * - 不恢复 Stage0-8 控制权。
 * - humanReviewFocus 只汇总 evidence 引用/摘要，不得是改写建议。
 *
 * 回答的五个问题（任务书）：
 * 1. raw 有哪些诊断风险？ → rawEvidenceSummary
 * 2. editorial candidate 有没有回应？ → candidateResponseSummary
 * 3. candidate 风险有没有进入裁判审计附件？ → judgeAuditSummary
 * 4. 最终交付的是 raw 还是 editorial？ → runSummary.selectedSource
 * 5. 哪些证据需要人工复核？ → humanReviewFocus
 *
 * 接入位置（unified-orchestrator，QUALITY-10 final craftEvidenceEnvelope 之后）：
 * - 主成功路径：runCraftEvidenceEnvelope(finalText, ...) 之后、return 之前。
 * - deliverRaw 路径：runCraftEvidenceEnvelope(rawCandidate.text, ...) 之后、return 之前。
 * - hardBlock 路径：runCraftEvidenceEnvelope("", "", ...) 之后、return 之前（写 skipped report）。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：直接复用 QUALITY-10~14 的类型契约（CraftEvidenceEnvelope / EditorialOpportunityAdvisory /
 *   EditorialEvidenceResponseTrace / EditorialCandidateRiskAdvisory / JudgeEvidenceAdvisoryAttachment）。
 * - B：无（本任务是新的报告编译层，不修改已有 prompt 注入模式）。
 * - C：qualitative-evidence-scanner 的"诚实原则、不带总分"范式（只读证据，不复用控制权）。
 * - D：无（不引入 legacy 概念；报告完全由 stageResults 字段派生）。
 * - E（退役，不得继承）：
 *   - 旧 CandidateComparator 的机械 11 维等权总分（已被 JudgeArbitrator 取代）。
 *   - 旧 DiagnosticSuite 的 pass|warning|fail 总判定 + suggestedRepair 重写命令。
 *   - Stage0-8 任何 gate/block/rewrite 控制权。
 *   - 报告不得成为新的 hard gate、不得生成改写建议、不得用于 winner 选择。
 *
 * 确定性本地编译：零 LLM 调用，纯字段搬运 + 计数。
 */

import type { CraftEvidenceEnvelope, EnvelopeFinding } from "./craft-evidence-envelope.js";
import type { EditorialOpportunityAdvisory } from "./editorial-opportunity-advisory.js";
import type { EditorialEvidenceResponseTrace } from "./editorial-evidence-response-trace.js";
import type {
  EditorialCandidateRiskAdvisory,
  CandidateRiskAdvisory,
} from "./editorial-candidate-risk-advisory.js";
import type { JudgeEvidenceAdvisoryAttachment } from "./judge-evidence-advisory-attachment.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 运行摘要：最终交付来源与候选信息。
 *
 * 不变量：
 * - selectedSource 只允许 "raw" | "editorial" | "blocked"（blocked = hardBlock 路径）。
 * - hasEditorialCandidate = candidates 中是否存在 editorial_amplified kind 的候选。
 * - judgeAttachmentPresent = stageResults.judgeEvidenceAdvisoryAttachment 是否存在且非 skipped。
 */
export interface RunSummary {
  /** 最终交付来源 */
  selectedSource: "raw" | "editorial" | "blocked";
  /** 最终选中的候选 id（hardBlock 时为空串） */
  selectedCandidateId: string;
  /** 最终交付正文长度（hardBlock 时为 0） */
  finalTextLength: number;
  /** 是否有 editorial candidate（无 candidate 时为 false） */
  hasEditorialCandidate: boolean;
  /** judge evidence advisory attachment 是否存在且非 skipped */
  judgeAttachmentPresent: boolean;
}

/**
 * raw 阶段证据摘要（从 rawCraftEvidenceEnvelope 派生）。
 *
 * 不变量：
 * - riskCount / humanReviewCount / partialCount 来自 envelope 的 StatusCount.total。
 * - topRawFindings 只搬运 findingId / source / dimension / status / evidence（摘要，不含改写建议）。
 * - envelope 为 skipped 或 undefined 时，所有 count=0，topRawFindings=[]。
 */
export interface RawEvidenceSummary {
  /** status=risk 的总数 */
  riskCount: number;
  /** status=human_review 的总数 */
  humanReviewCount: number;
  /** status=partial 的总数 */
  partialCount: number;
  /** top raw findings（从 envelope.topFindings 搬运，最多 5 条） */
  topRawFindings: RawFindingSummary[];
  /** raw envelope 是否 skipped 或缺失 */
  envelopeSkipped: boolean;
}

/**
 * 单条 raw finding 摘要（不含改写建议字段）。
 */
export interface RawFindingSummary {
  /** finding id */
  findingId: string;
  /** 证据来源 */
  source: string;
  /** 维度 id */
  dimension: string;
  /** 证据状态 */
  status: string;
  /** 观察到的事实（摘要，非改写建议） */
  evidence: string;
}

/**
 * 候选响应摘要（从 QUALITY-12 traces + QUALITY-13 advisory 派生）。
 *
 * 不变量：
 * - candidateCount = editorial candidates 数量（从 advisory 或 traces 推断）。
 * - addressedCount / partialCount / unchangedCount / unverifiedCount 汇总所有 trace 的 items。
 * - riskAdvisoryLevels 列出每个候选的 advisoryLevel（none/watch/risk/unverified）。
 * - 无 candidate 时所有 count=0，levels=[]。
 */
export interface CandidateResponseSummary {
  /** editorial candidate 数量 */
  candidateCount: number;
  /** responseType=addressed 的总数 */
  addressedCount: number;
  /** responseType=partially_addressed 的总数 */
  partialCount: number;
  /** responseType=unchanged 的总数 */
  unchangedCount: number;
  /** responseType=unverified 的总数 */
  unverifiedCount: number;
  /** 每个候选的风险审计级别列表 */
  riskAdvisoryLevels: string[];
  /** traces 是否 skipped 或缺失 */
  tracesSkipped: boolean;
}

/**
 * 裁判审计摘要（从 QUALITY-14 judgeEvidenceAdvisoryAttachment 派生）。
 *
 * 不变量：
 * - attachmentCount = attachment.entries.length。
 * - editorialAttachmentCount / rawAttachmentCount 按 candidateKind 分桶。
 * - unresolvedFindingRefs 汇总所有 editorial entry 的 unresolvedFindingRefs（去重）。
 * - attachment 为 skipped 或 undefined 时，所有 count=0，refs=[]。
 */
export interface JudgeAuditSummary {
  /** 附件条目总数 */
  attachmentCount: number;
  /** editorial 侧附件条目数 */
  editorialAttachmentCount: number;
  /** raw 侧附件条目数 */
  rawAttachmentCount: number;
  /** 未回应的 finding 引用列表（去重） */
  unresolvedFindingRefs: string[];
  /** attachment 是否 skipped 或缺失 */
  attachmentSkipped: boolean;
}

/**
 * 人工复核焦点项（只含引用/摘要，不含改写建议）。
 *
 * 不变量：
 * - 只允许 evidenceRef / dimensionId / candidateId / reason 四个字段。
 * - reason 是证据摘要（观察事实），不是"怎么改"的建议。
 * - 最多 10 条（HUMAN_REVIEW_FOCUS_LIMIT）。
 */
export interface HumanReviewFocusItem {
  /** 证据引用（source:dimensionId 或 findingId） */
  evidenceRef: string;
  /** 维度 id */
  dimensionId: string;
  /** 候选 id（finalText envelope 的 finding 时为 "finalText"） */
  candidateId: string;
  /** 复核原因（证据摘要，非改写建议） */
  reason: string;
}

/**
 * QualityEvidenceRunReport — 写入 stageResults.qualityEvidenceRunReport 的结构。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / score / grade / pass / fail / fix /
 *   recommendedAction / hardBlock / gate / weightedScore / rankedScore / satisfied（任务书）。
 * - 任何触发改文/重写/候选生成的字段。
 * - 任何 gate/hard_block 权限字段。
 * - 任何用于 SelectionPolicy winner 决策的字段。
 * - 任何进入 judge prompt 的字段。
 */
export interface QualityEvidenceRunReport {
  /** 运行摘要 */
  runSummary: RunSummary;
  /** raw 阶段证据摘要 */
  rawEvidenceSummary: RawEvidenceSummary;
  /** 候选响应摘要 */
  candidateResponseSummary: CandidateResponseSummary;
  /** 裁判审计摘要 */
  judgeAuditSummary: JudgeAuditSummary;
  /** 人工复核焦点（最多 10 条，只含引用/摘要） */
  humanReviewFocus: HumanReviewFocusItem[];
  /** 性质声明：审计报告，非改写命令，非质量评分，非 winner 选择依据，非 hard gate */
  proxyNote: string;
  meta: {
    /** 报告编译时间戳（ms） */
    compiledAt: number;
    /** 报告来源标识（固定值，标识 post-envelope 汇总） */
    source: "quality_evidence_run_report";
  };
}

// ============================================================================
// 常量
// ============================================================================

/** proxyNote 固定声明（防止下游误用为改写命令/质量评分/winner 选择依据/hard gate） */
const PROXY_NOTE =
  "质量证据运行报告，非改写命令，非质量评分，非 winner 选择依据，非 hard gate";

/** meta.source 固定值 */
const REPORT_SOURCE = "quality_evidence_run_report" as const;

/** topRawFindings 截断上限 */
const TOP_RAW_FINDINGS_LIMIT = 5;

/** humanReviewFocus 截断上限（任务书规定最多 10 条） */
const HUMAN_REVIEW_FOCUS_LIMIT = 10;

// ============================================================================
// 构建输入
// ============================================================================

/**
 * 报告编译输入。
 *
 * 接收最终交付信息 + stageResults 中的 QUALITY-10~14 字段，
 * 编译为单次生成运行质量证据报告。
 *
 * 所有 stageResults 字段都是可选的：缺失时报告对应部分标记为 skipped/空，
 * 不抛错，不阻断流程。
 */
export interface CompileRunReportInput {
  /** 最终交付来源 */
  selectedSource: "raw" | "editorial" | "blocked";
  /** 最终选中的候选 id */
  selectedCandidateId: string;
  /** 最终交付正文长度 */
  finalTextLength: number;
  /** 是否有 editorial candidate */
  hasEditorialCandidate: boolean;
  /** QUALITY-10 raw 阶段 craft evidence envelope（raw 候选的诊断证据） */
  rawCraftEvidenceEnvelope?: CraftEvidenceEnvelope | { skippedReason: string } | undefined;
  /** QUALITY-11 editorial opportunity advisory */
  editorialOpportunityAdvisory?: EditorialOpportunityAdvisory | { skippedReason: string } | undefined;
  /** QUALITY-12 editorial evidence response traces */
  editorialEvidenceResponseTraces?:
    | EditorialEvidenceResponseTrace[]
    | { skippedReason: string }
    | undefined;
  /** QUALITY-13 editorial candidate risk advisory */
  editorialCandidateRiskAdvisory?:
    | EditorialCandidateRiskAdvisory
    | { advisories: []; skippedReason: string }
    | undefined;
  /** QUALITY-14 judge evidence advisory attachment */
  judgeEvidenceAdvisoryAttachment?:
    | JudgeEvidenceAdvisoryAttachment
    | { entries: []; skippedReason: string }
    | undefined;
  /** QUALITY-10 final craft evidence envelope（finalText 的诊断证据） */
  craftEvidenceEnvelope?: CraftEvidenceEnvelope | { skippedReason: string } | undefined;
}

// ============================================================================
// 主编译函数
// ============================================================================

/**
 * 编译 QualityEvidenceRunReport。
 *
 * 汇总 QUALITY-10~14 的证据链为单次生成运行质量证据报告。
 * - 只搬运与计数，不评分，不评判。
 * - 缺某个字段时不抛错，对应部分标记为 skipped/空。
 * - humanReviewFocus 只含引用/摘要，不含改写建议，最多 10 条。
 *
 * 不调用模型，不修改 finalText，不触发 StyleShaper/candidate/judge/selection/状态提交。
 */
export function compileQualityEvidenceRunReport(
  input: CompileRunReportInput
): QualityEvidenceRunReport {
  const {
    selectedSource,
    selectedCandidateId,
    finalTextLength,
    hasEditorialCandidate,
    rawCraftEvidenceEnvelope,
    editorialOpportunityAdvisory: _advisory,
    editorialEvidenceResponseTraces,
    editorialCandidateRiskAdvisory,
    judgeEvidenceAdvisoryAttachment,
    craftEvidenceEnvelope,
  } = input;

  // ── 1. runSummary ──
  // judgeAttachmentPresent：attachment 存在且为正式结构（非 skipped set）。
  // skipped set（{ entries: [], skippedReason: "..." }）的 entries 也是数组，
  // 但有 skippedReason 字段，不算"present"。
  const judgeAttachmentPresent = isJudgeEvidenceAdvisoryAttachment(judgeEvidenceAdvisoryAttachment);

  const runSummary: RunSummary = {
    selectedSource,
    selectedCandidateId,
    finalTextLength,
    hasEditorialCandidate,
    judgeAttachmentPresent,
  };

  // ── 2. rawEvidenceSummary（从 rawCraftEvidenceEnvelope 派生）──
  const rawEvidenceSummary = buildRawEvidenceSummary(rawCraftEvidenceEnvelope);

  // ── 3. candidateResponseSummary（从 traces + advisory 派生）──
  const candidateResponseSummary = buildCandidateResponseSummary(
    editorialEvidenceResponseTraces,
    editorialCandidateRiskAdvisory
  );

  // ── 4. judgeAuditSummary（从 judgeEvidenceAdvisoryAttachment 派生）──
  const judgeAuditSummary = buildJudgeAuditSummary(judgeEvidenceAdvisoryAttachment);

  // ── 5. humanReviewFocus（优先级汇总，最多 10 条）──
  const humanReviewFocus = buildHumanReviewFocus(
    rawCraftEvidenceEnvelope,
    editorialEvidenceResponseTraces,
    editorialCandidateRiskAdvisory,
    craftEvidenceEnvelope
  );

  return {
    runSummary,
    rawEvidenceSummary,
    candidateResponseSummary,
    judgeAuditSummary,
    humanReviewFocus,
    proxyNote: PROXY_NOTE,
    meta: {
      compiledAt: Date.now(),
      source: REPORT_SOURCE,
    },
  };
}

// ============================================================================
// skipped report 构造（hardBlock 路径）
// ============================================================================

/**
 * hardBlock 路径的 skipped report。
 *
 * 不伪造成功报告；明确记录"hardBlock 故无可用证据"。
 * 所有 count=0，focus=[]，runSummary.selectedSource="blocked"。
 */
export function skippedQualityEvidenceRunReport(
  reason: string
): QualityEvidenceRunReport {
  return {
    runSummary: {
      selectedSource: "blocked",
      selectedCandidateId: "",
      finalTextLength: 0,
      hasEditorialCandidate: false,
      judgeAttachmentPresent: false,
    },
    rawEvidenceSummary: {
      riskCount: 0,
      humanReviewCount: 0,
      partialCount: 0,
      topRawFindings: [],
      envelopeSkipped: true,
    },
    candidateResponseSummary: {
      candidateCount: 0,
      addressedCount: 0,
      partialCount: 0,
      unchangedCount: 0,
      unverifiedCount: 0,
      riskAdvisoryLevels: [],
      tracesSkipped: true,
    },
    judgeAuditSummary: {
      attachmentCount: 0,
      editorialAttachmentCount: 0,
      rawAttachmentCount: 0,
      unresolvedFindingRefs: [],
      attachmentSkipped: true,
    },
    humanReviewFocus: [],
    proxyNote: PROXY_NOTE,
    meta: {
      compiledAt: Date.now(),
      source: REPORT_SOURCE,
    },
  };
}

// ============================================================================
// 不变量校验（供测试断言）
// ============================================================================

/**
 * 校验 QualityEvidenceRunReport 不变量。
 *
 * 规则：
 * - 必须包含 7 个顶层字段：runSummary / rawEvidenceSummary /
 *   candidateResponseSummary / judgeAuditSummary / humanReviewFocus / proxyNote / meta。
 * - 不得包含任何禁止字段（aggregateQualityScore / totalScore / score / grade /
 *   pass / fail / fix / recommendedAction / hardBlock / gate / weightedScore /
 *   rankedScore / satisfied）。
 * - humanReviewFocus 长度 ≤ 10。
 * - humanReviewFocus 每条只含 4 个字段（evidenceRef / dimensionId / candidateId / reason）。
 * - meta.source 必须为 "quality_evidence_run_report"。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateQualityEvidenceRunReport(
  report: QualityEvidenceRunReport
): string | null {
  // 顶层字段
  const requiredTop = [
    "runSummary",
    "rawEvidenceSummary",
    "candidateResponseSummary",
    "judgeAuditSummary",
    "humanReviewFocus",
    "proxyNote",
    "meta",
  ];
  for (const k of requiredTop) {
    if (!(k in report)) {
      return `report 缺少顶层字段：${k}`;
    }
  }

  // 禁止字段（任务书 + 防御性校验）
  const forbidden = [
    "aggregateQualityScore",
    "totalScore",
    "score",
    "grade",
    "pass",
    "fail",
    "fix",
    "recommendedAction",
    "hardBlock",
    "gate",
    "weightedScore",
    "rankedScore",
    "satisfied",
  ];
  const serialized = JSON.stringify(report);
  for (const term of forbidden) {
    const keyPattern = `"${term}"`;
    if (serialized.includes(keyPattern)) {
      return `report 含禁止字段/键：${term}`;
    }
  }

  // humanReviewFocus 长度
  if (report.humanReviewFocus.length > HUMAN_REVIEW_FOCUS_LIMIT) {
    return `humanReviewFocus 长度 ${report.humanReviewFocus.length} 超过上限 ${HUMAN_REVIEW_FOCUS_LIMIT}`;
  }

  // humanReviewFocus 字段集
  const allowedFocusFields = new Set([
    "evidenceRef",
    "dimensionId",
    "candidateId",
    "reason",
  ]);
  for (const item of report.humanReviewFocus) {
    const keys = Object.keys(item);
    for (const k of keys) {
      if (!allowedFocusFields.has(k)) {
        return `humanReviewFocus item 含非法字段：${k}（只允许 evidenceRef/dimensionId/candidateId/reason）`;
      }
    }
    // 必填字段
    if (!item.evidenceRef || !item.dimensionId || !item.candidateId || !item.reason) {
      return `humanReviewFocus item 缺少必填字段（evidenceRef/dimensionId/candidateId/reason）`;
    }
  }

  // meta.source
  if (report.meta?.source !== REPORT_SOURCE) {
    return `meta.source 非法：${report.meta?.source}（必须为 ${REPORT_SOURCE}）`;
  }

  return null;
}

// ============================================================================
// 内部工具函数：rawEvidenceSummary
// ============================================================================

/**
 * 从 rawCraftEvidenceEnvelope 派生 raw 阶段证据摘要。
 *
 * - envelope 为正式 CraftEvidenceEnvelope → 搬运 counts + topFindings。
 * - envelope 为 skipped set 或 undefined → 所有 count=0，topRawFindings=[]，envelopeSkipped=true。
 */
function buildRawEvidenceSummary(
  envelope: CompileRunReportInput["rawCraftEvidenceEnvelope"]
): RawEvidenceSummary {
  if (!envelope || !isCraftEvidenceEnvelope(envelope)) {
    return {
      riskCount: 0,
      humanReviewCount: 0,
      partialCount: 0,
      topRawFindings: [],
      envelopeSkipped: true,
    };
  }

  const topRawFindings: RawFindingSummary[] = (envelope.topFindings ?? [])
    .slice(0, TOP_RAW_FINDINGS_LIMIT)
    .map((f) => ({
      findingId: f.findingId,
      source: f.source,
      dimension: f.dimension,
      status: f.status,
      evidence: f.evidence,
    }));

  return {
    riskCount: envelope.riskCounts?.total ?? 0,
    humanReviewCount: envelope.humanReviewCount?.total ?? 0,
    partialCount: envelope.partialCount?.total ?? 0,
    topRawFindings,
    envelopeSkipped: envelope.meta?.skipped ?? false,
  };
}

// ============================================================================
// 内部工具函数：candidateResponseSummary
// ============================================================================

/**
 * 从 QUALITY-12 traces + QUALITY-13 advisory 派生候选响应摘要。
 *
 * - traces 为数组 → 统计所有 items 的 responseType。
 * - advisory 为正式结构 → 搬运 riskAdvisoryLevels。
 * - traces/advisory 为 skipped 或 undefined → 对应部分标记 skipped/空。
 */
function buildCandidateResponseSummary(
  traces: CompileRunReportInput["editorialEvidenceResponseTraces"],
  advisory: CompileRunReportInput["editorialCandidateRiskAdvisory"]
): CandidateResponseSummary {
  const tracesSkipped = !Array.isArray(traces);
  const traceArray = Array.isArray(traces) ? traces : [];

  let addressedCount = 0;
  let partialCount = 0;
  let unchangedCount = 0;
  let unverifiedCount = 0;
  for (const trace of traceArray) {
    for (const item of trace.items ?? []) {
      switch (item.responseType) {
        case "addressed":
          addressedCount++;
          break;
        case "partially_addressed":
          partialCount++;
          break;
        case "unchanged":
          unchangedCount++;
          break;
        case "unverified":
          unverifiedCount++;
          break;
        // not_applicable 不计入
      }
    }
  }

  // riskAdvisoryLevels 从 advisory 搬运
  const riskAdvisoryLevels: string[] = [];
  let candidateCount = 0;
  if (advisory && Array.isArray(advisory.advisories)) {
    candidateCount = advisory.advisories.length;
    for (const a of advisory.advisories) {
      riskAdvisoryLevels.push(a.advisoryLevel);
    }
  } else if (traceArray.length > 0) {
    // advisory 为 skipped 但 traces 存在 → candidateCount 从 traces 推断
    candidateCount = traceArray.length;
  }

  return {
    candidateCount,
    addressedCount,
    partialCount,
    unchangedCount,
    unverifiedCount,
    riskAdvisoryLevels,
    tracesSkipped,
  };
}

// ============================================================================
// 内部工具函数：judgeAuditSummary
// ============================================================================

/**
 * 从 QUALITY-14 judgeEvidenceAdvisoryAttachment 派生裁判审计摘要。
 *
 * - attachment 为正式结构 → 统计 entries + 分桶 + 汇总 unresolvedFindingRefs。
 * - attachment 为 skipped 或 undefined → 所有 count=0，refs=[]，attachmentSkipped=true。
 */
function buildJudgeAuditSummary(
  attachment: CompileRunReportInput["judgeEvidenceAdvisoryAttachment"]
): JudgeAuditSummary {
  if (!attachment || !isJudgeEvidenceAdvisoryAttachment(attachment)) {
    return {
      attachmentCount: 0,
      editorialAttachmentCount: 0,
      rawAttachmentCount: 0,
      unresolvedFindingRefs: [],
      attachmentSkipped: true,
    };
  }

  const entries = attachment.entries ?? [];
  let editorialAttachmentCount = 0;
  let rawAttachmentCount = 0;
  const refSet = new Set<string>();

  for (const e of entries) {
    if (e.candidateKind === "editorial_amplified") {
      editorialAttachmentCount++;
      for (const ref of e.unresolvedFindingRefs ?? []) {
        refSet.add(ref);
      }
    } else if (e.candidateKind === "raw") {
      rawAttachmentCount++;
    }
  }

  return {
    attachmentCount: entries.length,
    editorialAttachmentCount,
    rawAttachmentCount,
    unresolvedFindingRefs: [...refSet],
    attachmentSkipped: false,
  };
}

// ============================================================================
// 内部工具函数：humanReviewFocus
// ============================================================================

/**
 * 构建人工复核焦点列表。
 *
 * 优先级（任务书）：
 * 1. candidate risk advisoryLevel=risk
 * 2. unchanged + raw status=risk（trace item）
 * 3. unverified 结构项（trace item with source=chapterQuality）
 * 4. finalText envelope 中 risk/human_review
 *
 * 最多 10 条。只含 evidenceRef / dimensionId / candidateId / reason，不含改写建议。
 */
function buildHumanReviewFocus(
  rawCraftEvidenceEnvelope: CompileRunReportInput["rawCraftEvidenceEnvelope"],
  traces: CompileRunReportInput["editorialEvidenceResponseTraces"],
  advisory: CompileRunReportInput["editorialCandidateRiskAdvisory"],
  craftEvidenceEnvelope: CompileRunReportInput["craftEvidenceEnvelope"]
): HumanReviewFocusItem[] {
  const focus: HumanReviewFocusItem[] = [];

  // 1. candidate risk advisoryLevel=risk
  if (advisory && Array.isArray(advisory.advisories)) {
    for (const a of advisory.advisories) {
      if (a.advisoryLevel === "risk") {
        for (const ref of a.unresolvedFindingRefs ?? []) {
          focus.push({
            evidenceRef: ref,
            dimensionId: extractDimensionFromRef(ref),
            candidateId: a.candidateId,
            reason: `candidate risk advisoryLevel=risk：${a.responseSummary ?? "raw risk finding 未触及"}`,
          });
        }
      }
    }
  }

  // 2. unchanged + raw status=risk（trace item）
  const traceArray = Array.isArray(traces) ? traces : [];
  for (const trace of traceArray) {
    for (const item of trace.items ?? []) {
      if (item.responseType === "unchanged" && item.status === "risk") {
        focus.push({
          evidenceRef: item.stableFindingRef,
          dimensionId: item.dimensionId,
          candidateId: trace.candidateId,
          reason: `raw risk finding 未被 candidate 触及（unchanged）：${item.evidenceNote ?? ""}`,
        });
      }
    }
  }

  // 3. unverified 结构项（trace item with source=chapterQuality）
  for (const trace of traceArray) {
    for (const item of trace.items ?? []) {
      if (item.responseType === "unverified" && item.source === "chapterQuality") {
        focus.push({
          evidenceRef: item.stableFindingRef,
          dimensionId: item.dimensionId,
          candidateId: trace.candidateId,
          reason: `结构质量无法本地判定（unverified）：${item.evidenceNote ?? ""}`,
        });
      }
    }
  }

  // 4. finalText envelope 中 risk/human_review
  if (craftEvidenceEnvelope && isCraftEvidenceEnvelope(craftEvidenceEnvelope)) {
    for (const f of craftEvidenceEnvelope.findings ?? []) {
      if (f.status === "risk" || f.status === "human_review") {
        focus.push({
          evidenceRef: `${f.source}:${f.dimension}`,
          dimensionId: f.dimension,
          candidateId: "finalText",
          reason: `finalText ${f.status}：${f.evidence ?? ""}`,
        });
      }
    }
  }

  // 截断至 10 条
  return focus.slice(0, HUMAN_REVIEW_FOCUS_LIMIT);
}

// ============================================================================
// 内部工具函数：类型守卫
// ============================================================================

/**
 * 判断对象是否为正式 CraftEvidenceEnvelope（而非 skipped set）。
 *
 * CraftEvidenceEnvelope 必须有 findings 数组 + riskCounts 对象。
 * skipped set（如 { skippedReason: string }）不含这些字段。
 */
function isCraftEvidenceEnvelope(
  obj: unknown
): obj is CraftEvidenceEnvelope {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.findings) && typeof o.riskCounts === "object";
}

/**
 * 判断对象是否为正式 JudgeEvidenceAdvisoryAttachment（而非 skipped set）。
 *
 * Attachment 必须有 entries 数组。
 * skipped set（如 { entries: [], skippedReason: string }）的 entries 也是数组，
 * 但 skipped set 有 skippedReason 字段。我们用 "有 entries 且无 skippedReason" 来区分。
 */
function isJudgeEvidenceAdvisoryAttachment(
  obj: unknown
): obj is JudgeEvidenceAdvisoryAttachment {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.entries) && !("skippedReason" in o);
}

/**
 * 从 stableFindingRef（source:dimensionId）提取 dimensionId。
 */
function extractDimensionFromRef(ref: string): string {
  const parts = ref.split(":");
  return parts.length >= 2 ? parts.slice(1).join(":") : ref;
}
