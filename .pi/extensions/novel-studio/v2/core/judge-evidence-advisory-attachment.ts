/**
 * JudgeEvidenceAdvisoryAttachment — 裁判证据审计附件（QUALITY-14 最小切片）
 *
 * 目标：把 QUALITY-12/13 产生的候选响应 trace 与 candidate risk advisory，作为
 * “匿名、非决定性、只读审计附件”挂到 judge evidence / arbitration trace 中。
 * **只增强裁判证据可解释性，不改变 judge prompt，不改变 judge winner，不改变 SelectionPolicy。**
 *
 * 核心原则（QUALITY-14 任务书）：
 * - 不新增 hard gate；附件只是审计标记，不是 gate。
 * - 不引入文学总分、pass/fail、grade、score、weightedScore、rankedScore。
 * - 不改 finalText；附件只读 trace / advisory / mapping / candidate。
 * - 不强制生成 candidate；no-op / 无 candidate / 无仲裁时不伪造附件。
 * - **不改变 PairwiseJudge prompt**；附件不进入 judge prompt。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则；附件不进入 winner 决策。
 * - 不调用真实模型；附件编译是纯本地字段搬运。
 * - 不恢复 Stage0-8 控制权。
 * - 附件只能在 judge 返回后写入 stageResults / trace。
 *
 * 接入位置（unified-orchestrator Stage 5c，post-judge）：
 * - 在 `stageResults.judgeArbitration` 写入之后、Stage 6.5 最终事实复检之前。
 * - 读取 `arbitrationResults`（每个 editorial candidate vs raw 的 ArbitratorResult）、
 *   `stageResults.editorialEvidenceResponseTraces`（QUALITY-12）、
 *   `stageResults.editorialCandidateRiskAdvisory`（QUALITY-13）。
 * - 写入 `stageResults.judgeEvidenceAdvisoryAttachment`。
 *
 * 隐私/匿名要求：
 * - 附件通过 `result.firstRound.mapping` 反查每个候选的匿名 side（A/B）。
 * - 附件只在 judge 返回后写入，不破坏原有匿名裁判流程。
 * - 附件不进入 judge prompt，不影响 judge 调用。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：直接复用 QUALITY-12 EditorialEvidenceResponseTrace + QUALITY-13
 *   EditorialCandidateRiskAdvisory + judge-types AnonymousMapping 类型契约。
 * - B：无（本任务是新的附件编译层，不修改已有 prompt 注入模式）。
 * - C：qualitative-evidence-scanner 的"诚实原则、不带总分"范式（只读证据，不复用控制权）。
 * - D：无（不引入 legacy 概念；附件完全由 trace/advisory/mapping 派生）。
 * - E（退役，不得继承）：
 *   - 旧 CandidateComparator 的机械 11 维等权总分（已被 JudgeArbitrator 取代）。
 *   - 旧 DiagnosticSuite 的 pass|warning|fail 总判定 + suggestedRepair 重写命令。
 *   - Stage0-8 任何 gate/block/rewrite 控制权。
 *   - 附件不得成为新的 hard gate、不得生成改写建议、不得用于 winner 选择。
 *
 * 确定性本地编译：零 LLM 调用，纯字段搬运 + mapping 反查。
 */

import type { AnonymousMapping } from "./judge-types.js";
import type { EditorialEvidenceResponseTrace } from "./editorial-evidence-response-trace.js";
import type {
  EditorialCandidateRiskAdvisory,
  CandidateRiskAdvisory,
} from "./editorial-candidate-risk-advisory.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条裁判证据审计附件（任务书规定字段集）。
 *
 * 不变量：
 * - 11 字段固定集，不得增减。
 * - anonymousSide 只允许 "A" | "B"，由 firstRound.mapping 反查得到。
 * - candidateKind 只允许 "raw" | "editorial_amplified"。
 * - raw 候选无 responseTraceSummary / riskAdvisoryLevel（undefined），
 *   或 riskAdvisoryLevel="not_applicable"（明确声明 raw 无需 candidate risk advisory）。
 * - unresolvedFindingRefs / evidenceNotes 从 QUALITY-13 advisory 搬运，
 *   不得含改写建议（advisory 已声明 proxyNote 禁止改写命令）。
 * - proxyNote 固定声明附件性质：只读审计附件，非 judge prompt 输入，非 winner 选择依据。
 * - meta.source 固定为 "post_judge_trace_attachment"，标识附件只在 judge 返回后写入。
 * - 不含 expectedRef / severity / recommendedAction / fix / score / grade / pass|fail
 *   / hardBlock / gate / aggregateQualityScore / totalScore / weightedScore / rankedScore
 *   / satisfied 等字段（任务书禁止自动改文建议、总判定与胜负字段）。
 */
export interface JudgeEvidenceAdvisoryAttachmentEntry {
  /** 仲裁 id（用 editorial candidate id 标识，每个 editorial candidate 对 raw 一次仲裁） */
  arbitrationId: string;
  /** 轮次 id（附件关联首轮匿名映射；reverse/arbitration 轮不单独建附件） */
  roundId: "first";
  /** 候选 id（raw 或 editorial） */
  candidateId: string;
  /** 匿名 side：A 或 B（由 firstRound.mapping 反查） */
  anonymousSide: "A" | "B";
  /** 候选 kind：raw（基线）或 editorial_amplified（编辑放大候选） */
  candidateKind: "raw" | "editorial_amplified";
  /** 响应 trace 摘要（从 QUALITY-12 trace 派生；raw 候选无 trace，为 undefined） */
  responseTraceSummary?: string;
  /** 风险审计级别（从 QUALITY-13 advisory 搬运；raw 候选为 "not_applicable"） */
  riskAdvisoryLevel?:
    | "none"
    | "watch"
    | "risk"
    | "unverified"
    | "not_applicable";
  /** 未回应的 finding 引用列表（从 QUALITY-13 advisory 搬运；raw 候选为空数组） */
  unresolvedFindingRefs: string[];
  /** 证据说明列表（从 QUALITY-13 advisory 搬运，不含改写建议；raw 候选为空数组） */
  evidenceNotes: string[];
  /** 性质声明：只读审计附件，非 judge prompt 输入，非 winner 选择依据，非 hard gate */
  proxyNote: string;
  meta: {
    /** 附件写入时间戳（ms） */
    attachedAt: number;
    /** 附件来源标识（固定值，标识 post-judge 写入） */
    source: "post_judge_trace_attachment";
  };
}

/**
 * JudgeEvidenceAdvisoryAttachment — 写入 stageResults.judgeEvidenceAdvisoryAttachment 的结构。
 *
 * 每个仲裁（editorial candidate vs raw）产生 2 条 entry（raw 侧 + editorial 侧）。
 * no-op / 无 candidate / 无仲裁 / 编译异常时不伪造附件，写 skipped 标记或保持 undefined。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / score / grade / pass / fail / fix /
 *   recommendedAction / hardBlock / gate / weightedScore / rankedScore / satisfied（任务书）。
 * - 任何触发改文/重写/候选生成的字段。
 * - 任何 gate/hard_block 权限字段。
 * - 任何用于 SelectionPolicy winner 决策的字段。
 * - 任何进入 judge prompt 的字段。
 */
export interface JudgeEvidenceAdvisoryAttachment {
  /** 每个候选（raw + editorial）的审计附件条目 */
  entries: JudgeEvidenceAdvisoryAttachmentEntry[];
  meta: {
    /** 编译时间戳（ms） */
    compiledAt: number;
    /** 仲裁数量（每个 editorial candidate vs raw 一次） */
    arbitrationCount: number;
    /** 附件条目数量（= 仲裁数 × 2） */
    entryCount: number;
  };
}

// ============================================================================
// 常量
// ============================================================================

/** proxyNote 固定声明（防止下游误用为 judge prompt 输入/质量评分/winner 选择依据/hard gate） */
const PROXY_NOTE =
  "只读审计附件，非 judge prompt 输入，非 winner 选择依据，非质量评分，非 hard gate";

/** meta.source 固定值（标识附件只在 judge 返回后写入） */
const ATTACHMENT_SOURCE = "post_judge_trace_attachment" as const;

// ============================================================================
// 构建输入
// ============================================================================

/**
 * 附件编译输入。
 *
 * 接收：
 * - arbitrationResults：每个 editorial candidate vs raw 的仲裁结果（含 firstRound.mapping）。
 * - rawCandidateId：raw 候选 id（用于 mapping 反查 anonymousSide）。
 * - traces：QUALITY-12 的 response traces（每个 editorial candidate 一条）。
 * - advisory：QUALITY-13 的 candidate risk advisory（每个 editorial candidate 一条）。
 *
 * 编译为 judge evidence 审计附件，关联匿名 side 与候选级风险信号。
 */
export interface CompileAttachmentInput {
  /** 仲裁结果数组（每个 editorial candidate vs raw） */
  arbitrationResults: ReadonlyArray<{
    /** editorial candidate */
    candidate: { id: string; hypothesisId?: string };
    /** 仲裁结果（含 firstRound.mapping） */
    result: {
      firstRound: {
        mapping: AnonymousMapping;
      };
    };
  }>;
  /** raw 候选 id（用于 mapping 反查 raw 的 anonymousSide） */
  rawCandidateId: string;
  /** QUALITY-12 的 response traces（可能为 skipped set，此时 traces 不可用） */
  traces: EditorialEvidenceResponseTrace[] | { skippedReason: string } | undefined;
  /** QUALITY-13 的 candidate risk advisory（可能为 skipped set，此时 advisory 不可用） */
  advisory:
    | EditorialCandidateRiskAdvisory
    | { advisories: []; skippedReason: string }
    | undefined;
}

// ============================================================================
// 主编译函数
// ============================================================================

/**
 * 编译 JudgeEvidenceAdvisoryAttachment。
 *
 * 对每个仲裁结果，通过 firstRound.mapping 反查 raw/editorial 的匿名 side，
 * 并关联 QUALITY-12 trace 与 QUALITY-13 advisory，生成只读审计附件。
 *
 * - raw 候选：candidateKind="raw"，无 responseTraceSummary，
 *   riskAdvisoryLevel="not_applicable"，unresolvedFindingRefs/evidenceNotes 为空。
 * - editorial 候选：candidateKind="editorial_amplified"，
 *   从 trace 派生 responseTraceSummary，从 advisory 搬运 riskAdvisoryLevel /
 *   unresolvedFindingRefs / evidenceNotes。
 * - trace/advisory 为 skipped 或 undefined → editorial 侧仍建附件，
 *   但 responseTraceSummary/riskAdvisoryLevel 为 undefined（不伪造）。
 * - 不评分，不判胜负，不生成改写建议，不进入 judge prompt。
 *
 * 不调用模型，不修改 finalText，不触发 StyleShaper/candidate/judge/selection/状态提交。
 */
export function compileJudgeEvidenceAdvisoryAttachment(
  input: CompileAttachmentInput
): JudgeEvidenceAdvisoryAttachment {
  const { arbitrationResults, rawCandidateId, traces, advisory } = input;

  // 建立 candidateId → trace 的索引（仅当 traces 为数组时）
  const traceByCandidateId = new Map<string, EditorialEvidenceResponseTrace>();
  if (Array.isArray(traces)) {
    for (const t of traces) {
      traceByCandidateId.set(t.candidateId, t);
    }
  }

  // 建立 candidateId → CandidateRiskAdvisory 的索引（仅当 advisory 为正式结构时）
  const advisoryByCandidateId = new Map<string, CandidateRiskAdvisory>();
  if (advisory && Array.isArray(advisory.advisories)) {
    for (const a of advisory.advisories) {
      advisoryByCandidateId.set(a.candidateId, a);
    }
  }

  const entries: JudgeEvidenceAdvisoryAttachmentEntry[] = [];
  const attachedAt = Date.now();

  for (const arb of arbitrationResults) {
    const mapping = arb.result.firstRound.mapping;
    const editorialCandidateId = arb.candidate.id;

    // 反查 raw 与 editorial 的匿名 side
    const rawSide = resolveAnonymousSide(mapping, rawCandidateId);
    const editorialSide = resolveAnonymousSide(mapping, editorialCandidateId);

    // raw 侧附件（无 trace / 无 advisory / riskAdvisoryLevel=not_applicable）
    entries.push(
      buildRawEntry(
        arbitrationId(editorialCandidateId),
        rawCandidateId,
        rawSide,
        attachedAt
      )
    );

    // editorial 侧附件（关联 trace + advisory）
    const trace = traceByCandidateId.get(editorialCandidateId);
    const candAdvisory = advisoryByCandidateId.get(editorialCandidateId);
    entries.push(
      buildEditorialEntry(
        arbitrationId(editorialCandidateId),
        editorialCandidateId,
        editorialSide,
        trace,
        candAdvisory,
        attachedAt
      )
    );
  }

  return {
    entries,
    meta: {
      compiledAt: attachedAt,
      arbitrationCount: arbitrationResults.length,
      entryCount: entries.length,
    },
  };
}

// ============================================================================
// skipped attachment 构造（no-op / 无仲裁 / 编译异常路径）
// ============================================================================

/**
 * no-op / 无仲裁 / 编译异常时的空附件标记。
 * orchestrator 在无仲裁结果或编译异常时写此标记，明确"无仲裁故无附件"，
 * 而非伪造附件。
 */
export interface SkippedJudgeEvidenceAdvisoryAttachment {
  /** 空数组（无仲裁故无附件） */
  entries: [];
  /** 跳过原因 */
  skippedReason: string;
}

/**
 * 构造 no-op / 无仲裁 / 编译异常路径的 skipped attachment。
 *
 * 不伪造附件；明确记录"无仲裁故未编译 judge evidence advisory attachment"
 * 或"编译异常故降级 skipped"。
 */
export function skippedJudgeEvidenceAdvisoryAttachment(
  reason: string
): SkippedJudgeEvidenceAdvisoryAttachment {
  return {
    entries: [],
    skippedReason: reason,
  };
}

// ============================================================================
// 不变量校验（供测试断言）
// ============================================================================

/**
 * 校验 JudgeEvidenceAdvisoryAttachment 不变量。
 *
 * 规则：
 * - 必须包含 2 个顶层字段：entries / meta。
 * - 不得包含任何禁止字段（aggregateQualityScore / totalScore / score / grade /
 *   pass / fail / fix / recommendedAction / hardBlock / gate / weightedScore /
 *   rankedScore / satisfied）。
 * - 每条 entry 必须含 11 个必填字段，且 anonymousSide 只允许 "A"|"B"，
 *   candidateKind 只允许 "raw"|"editorial_amplified"。
 * - meta.source 必须为 "post_judge_trace_attachment"。
 * - raw 侧 entry 的 unresolvedFindingRefs/evidenceNotes 必须为空数组。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateJudgeEvidenceAdvisoryAttachment(
  attachment: JudgeEvidenceAdvisoryAttachment
): string | null {
  // 顶层字段
  const requiredTop = ["entries", "meta"];
  for (const k of requiredTop) {
    if (!(k in attachment)) {
      return `attachment 缺少顶层字段：${k}`;
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
  const serialized = JSON.stringify(attachment);
  for (const term of forbidden) {
    const keyPattern = `"${term}"`;
    if (serialized.includes(keyPattern)) {
      return `attachment 含禁止字段/键：${term}`;
    }
  }

  // entry 字段集
  const requiredEntry = [
    "arbitrationId",
    "roundId",
    "candidateId",
    "anonymousSide",
    "candidateKind",
    "unresolvedFindingRefs",
    "evidenceNotes",
    "proxyNote",
    "meta",
  ];
  const allowedSides = new Set(["A", "B"]);
  const allowedKinds = new Set(["raw", "editorial_amplified"]);

  for (const e of attachment.entries) {
    for (const k of requiredEntry) {
      if (!(k in e)) {
        return `entry 缺少必填字段：${k}（candidateId=${e.candidateId ?? "?"}）`;
      }
    }
    if (!allowedSides.has(e.anonymousSide)) {
      return `entry.anonymousSide 非法：${e.anonymousSide}（只允许 A/B）`;
    }
    if (!allowedKinds.has(e.candidateKind)) {
      return `entry.candidateKind 非法：${e.candidateKind}（只允许 raw/editorial_amplified）`;
    }
    if (e.roundId !== "first") {
      return `entry.roundId 非法：${e.roundId}（只允许 first）`;
    }
    if (e.meta?.source !== ATTACHMENT_SOURCE) {
      return `entry.meta.source 非法：${e.meta?.source}（必须为 ${ATTACHMENT_SOURCE}）`;
    }
    if (!Array.isArray(e.unresolvedFindingRefs)) {
      return `entry.unresolvedFindingRefs 必须为数组（candidateId=${e.candidateId}）`;
    }
    if (!Array.isArray(e.evidenceNotes)) {
      return `entry.evidenceNotes 必须为数组（candidateId=${e.candidateId}）`;
    }
    // raw 侧 entry 的 unresolvedFindingRefs/evidenceNotes 必须为空
    if (e.candidateKind === "raw") {
      if (e.unresolvedFindingRefs.length > 0) {
        return `raw 侧 entry.unresolvedFindingRefs 必须为空（candidateId=${e.candidateId}）`;
      }
      if (e.evidenceNotes.length > 0) {
        return `raw 侧 entry.evidenceNotes 必须为空（candidateId=${e.candidateId}）`;
      }
    }
  }

  return null;
}

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 通过 mapping 反查候选的匿名 side（A/B）。
 *
 * mapping.leftCandidateId → mapping.leftLabel
 * mapping.rightCandidateId → mapping.rightLabel
 * 候选 id 不在 mapping 中 → 抛错（不应发生，调用方保证传入的 candidateId 在 mapping 中）
 */
function resolveAnonymousSide(
  mapping: AnonymousMapping,
  candidateId: string
): "A" | "B" {
  if (mapping.leftCandidateId === candidateId) {
    return mapping.leftLabel;
  }
  if (mapping.rightCandidateId === candidateId) {
    return mapping.rightLabel;
  }
  // 不应发生：候选 id 不在 mapping 中。抛错以暴露调用方 bug。
  throw new Error(
    `候选 ${candidateId} 不在 mapping 中（left=${mapping.leftCandidateId}, right=${mapping.rightCandidateId}）`
  );
}

/**
 * 构造仲裁 id（用 editorial candidate id 标识，每个 editorial candidate 对 raw 一次仲裁）。
 */
function arbitrationId(editorialCandidateId: string): string {
  return `arb:${editorialCandidateId}`;
}

/**
 * 构造 raw 侧附件条目。
 *
 * raw 候选无 response trace（trace 只为 editorial candidate 编译），
 * 无 candidate risk advisory（advisory 只为 editorial candidate 编译），
 * 故 responseTraceSummary=undefined，riskAdvisoryLevel="not_applicable"，
 * unresolvedFindingRefs/evidenceNotes 为空数组。
 */
function buildRawEntry(
  arbitrationId: string,
  rawCandidateId: string,
  anonymousSide: "A" | "B",
  attachedAt: number
): JudgeEvidenceAdvisoryAttachmentEntry {
  return {
    arbitrationId,
    roundId: "first",
    candidateId: rawCandidateId,
    anonymousSide,
    candidateKind: "raw",
    responseTraceSummary: undefined,
    riskAdvisoryLevel: "not_applicable",
    unresolvedFindingRefs: [],
    evidenceNotes: [],
    proxyNote: PROXY_NOTE,
    meta: {
      attachedAt,
      source: ATTACHMENT_SOURCE,
    },
  };
}

/**
 * 构造 editorial 侧附件条目。
 *
 * 关联 QUALITY-12 trace 与 QUALITY-13 advisory：
 * - trace 存在 → 从 trace.items 派生 responseTraceSummary。
 * - trace 不存在（skipped/undefined）→ responseTraceSummary=undefined（不伪造）。
 * - advisory 存在 → 搬运 riskAdvisoryLevel / unresolvedFindingRefs / evidenceNotes。
 * - advisory 不存在（skipped/undefined）→ riskAdvisoryLevel=undefined，
 *   unresolvedFindingRefs/evidenceNotes 为空数组（不伪造）。
 */
function buildEditorialEntry(
  arbitrationId: string,
  editorialCandidateId: string,
  anonymousSide: "A" | "B",
  trace: EditorialEvidenceResponseTrace | undefined,
  candAdvisory: CandidateRiskAdvisory | undefined,
  attachedAt: number
): JudgeEvidenceAdvisoryAttachmentEntry {
  const responseTraceSummary = trace
    ? summarizeResponseTrace(trace)
    : undefined;

  const riskAdvisoryLevel = candAdvisory?.advisoryLevel;
  const unresolvedFindingRefs = candAdvisory?.unresolvedFindingRefs ?? [];
  const evidenceNotes = candAdvisory?.evidenceNotes ?? [];

  return {
    arbitrationId,
    roundId: "first",
    candidateId: editorialCandidateId,
    anonymousSide,
    candidateKind: "editorial_amplified",
    responseTraceSummary,
    riskAdvisoryLevel,
    unresolvedFindingRefs,
    evidenceNotes,
    proxyNote: PROXY_NOTE,
    meta: {
      attachedAt,
      source: ATTACHMENT_SOURCE,
    },
  };
}

/**
 * 从 QUALITY-12 trace 派生响应摘要。
 *
 * 统计 items 中各 responseType 的数量，生成简短摘要。
 * 不含改写建议，不含评分，只是 trace 的只读摘要。
 */
function summarizeResponseTrace(
  trace: EditorialEvidenceResponseTrace
): string {
  const items = trace.items ?? [];
  if (items.length === 0) {
    return `无诊断证据需回应（advisory entries 为空）`;
  }
  let addressed = 0;
  let partiallyAddressed = 0;
  let unchanged = 0;
  let notApplicable = 0;
  let unverified = 0;
  for (const item of items) {
    switch (item.responseType) {
      case "addressed":
        addressed++;
        break;
      case "partially_addressed":
        partiallyAddressed++;
        break;
      case "unchanged":
        unchanged++;
        break;
      case "not_applicable":
        notApplicable++;
        break;
      case "unverified":
        unverified++;
        break;
    }
  }
  const parts: string[] = [`共 ${items.length} 条`];
  if (addressed > 0) parts.push(`已回应 ${addressed}`);
  if (partiallyAddressed > 0) parts.push(`部分回应 ${partiallyAddressed}`);
  if (unchanged > 0) parts.push(`未触及 ${unchanged}`);
  if (notApplicable > 0) parts.push(`无需回应 ${notApplicable}`);
  if (unverified > 0) parts.push(`无法判定 ${unverified}`);
  return parts.join("，");
}
