/**
 * CraftEvidenceEnvelope — 质量证据统一汇总（QUALITY-10 最小切片）
 *
 * 目标：把 QUALITY-3 / QUALITY-8 / QUALITY-9 三个孤立 scanner 的诊断证据统一汇总
 * 为一个可读、可回放、可后续消费的质量证据包。**只汇总，不评分，不改文，不阻断。**
 *
 * 核心不变量（QUALITY-10 任务书）：
 * - 只输出 sourceReports / findings / riskCounts / humanReviewCount / partialCount /
 *   topFindings / meta。绝不输出总分或 pass/fail 总判定。
 * - topFindings 只按"证据状态优先级 + span 存在性"排序，不能变成质量分。
 * - 不修改 finalText，不触发 StyleShaper / language patch / candidate rewrite。
 * - 不改 judge/selection，不提交长期状态，不调用模型。
 * - 不含 aggregateQualityScore / totalScore / 文学总分 / pass|fail 总判定 /
 *   自动改文建议 / hard gate 字段。
 * - 缺某个 source report 时不抛错，记录到 meta.missingSources。
 * - hardBlock 路径也要有 envelope，标记 skipped/missing reports。
 * - envelope 异常不能阻断生成，只写 skipped + warning。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：直接复用三个 source report 的类型契约（不重造证据结构）：
 *   - ChapterQualityEvidence（v2/core/chapter-quality-evidence.ts，QUALITY-3）
 *   - InformationReleaseEvidenceReport（v2/core/information-release-evidence-scanner.ts，QUALITY-8）
 *   - EndingCraftEvidenceReport（v2/core/ending-craft-evidence-scanner.ts，QUALITY-9）
 * - B：stageResults 基础设施（unified-orchestrator.ts，QUALITY-3 已建立的写入模式）。
 * - C：qualitative-evidence-scanner 的"诚实原则、不带总分"范式（只读证据，不复用控制权）。
 * - D：无（本任务是聚合层，不引入新的 legacy 概念）。
 * - E（退役，不得继承）：
 *   - 旧 CandidateComparator 的机械 11 维等权总分（已被 JudgeArbitrator 取代）。
 *   - 旧 FinalSelector 的 totalScore 选择逻辑（已被 SelectionPolicy 取代）。
 *   - 旧 DiagnosticSuite 的 pass|warning|fail 总判定 + suggestedRepair 重写建议。
 *   - 旧 DimensionScores 加权聚合 + HARD_BLOCK_PROVIDERS 配额硬门。
 *   - Stage0-8 任何 gate/block/rewrite 控制权。
 *
 * 聚合策略（诚实原则：只搬运与计数，不评判）：
 * 1. 遍历三个 source reports，对每条 evidence 转成统一的 EnvelopeFinding。
 *    - QUALITY-3 StructuralEvidence（11 字段）→ 取 id/dimension/status/sourceSpans/
 *      observation/readerImpact/recommendedOwner/confidence；expectedRef/severity/
 *      recommendedAction 不进入 EnvelopeFinding（避免越权聚合，但可在 evidence 文本里
 *      保留 observation 原文供人工审阅）。
 *    - QUALITY-8 InformationReleaseEvidence（8 字段）→ 取 dimensionId/status/findingId/
 *      sourceSpans/evidence/readerImpact/suggestedOwner/confidence。
 *    - QUALITY-9 EndingCraftEvidence（8 字段）→ 同 QUALITY-8 字段集。
 * 2. status 统一为 EnvelopeFindingStatus（QUALITY-3 多出 satisfied/contradicted 两态，
 *    保留原值；其余三态 partial/risk/human_review 与 QUALITY-8/9 一致）。
 * 3. counts 只统计 risk / human_review / partial 三态（任务书"计数正确"口径）；
 *    satisfied / contradicted / not_applicable / skipped 不计入这三个计数器。
 * 4. topFindings 排序：status 优先级（risk > human_review > partial > contradicted >
 *    satisfied > not_applicable > skipped）+ 同 status 内有 span 优先；截断至
 *    TOP_FINDINGS_LIMIT=10。**排序只为可读性，不是质量分**。
 * 5. meta.skipped = true 当且仅当所有 source 都 missing 或 skipped（无任何可用证据）。
 *
 * 确定性本地聚合：零 LLM 调用，纯字段搬运 + 计数。
 */

import type { ChapterQualityEvidence } from "./chapter-quality-evidence.js";
import type { InformationReleaseEvidenceReport } from "./information-release-evidence-scanner.js";
import type { EndingCraftEvidenceReport } from "./ending-craft-evidence-scanner.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 证据来源（对应三个 source scanner）。
 *
 * - chapterQuality ← QUALITY-3 structural-evidence-scanner
 * - informationRelease ← QUALITY-8 information-release-evidence-scanner
 * - endingCraft ← QUALITY-9 ending-craft-evidence-scanner
 */
export type CraftEvidenceSource =
  | "chapterQuality"
  | "informationRelease"
  | "endingCraft";

/**
 * 统一的 envelope finding 状态。
 *
 * 合并说明：
 * - satisfied / contradicted 仅来自 QUALITY-3 StructuralEvidenceStatus（QUALITY-8/9
 *   任务书硬约束无 satisfied；contradicted 是 QUALITY-3 独有的"正文与 expectedRef
 *   明确冲突"语义）。
 * - partial / risk / human_review / not_applicable / skipped 三源共享。
 *
 * 严禁新增 "pass" / "fail" / "graded" / "scored" 等总判定状态（任务书禁止）。
 */
export type EnvelopeFindingStatus =
  | "satisfied"
  | "partial"
  | "contradicted"
  | "risk"
  | "human_review"
  | "not_applicable"
  | "skipped";

/**
 * 单条统一证据 finding（从三个 source evidence 搬运而来）。
 *
 * 不变量：
 * - source/dimension/status/findingId/evidence 必填。
 * - spanCount = sourceSpans.length（保留数值，不保留原始 span 数组——envelope 是摘要，
 *   原始 span 在 source report 里可追溯）。
 * - spanSummary 是 span 范围的字符串摘要（如 "[10,25];[100,130]"），无 span 时为空串。
 * - 不含 expectedRef / severity / recommendedAction / fix / score / grade / pass|fail
 *   等字段（任务书禁止自动改文建议与总判定）。
 * - suggestedOwner 只搬运 source 的建议 owner（advisory，不强制）。
 * - confidence ∈ [0, 1]（搬运 source 的 confidence）。
 */
export interface EnvelopeFinding {
  /** 证据来源 */
  source: CraftEvidenceSource;
  /** 维度 id（structural.dimension / infoRelease.dimensionId / endingCraft.dimensionId） */
  dimension: string;
  /** 证据状态（统一枚举） */
  status: EnvelopeFindingStatus;
  /** finding id（structural.id / infoRelease.findingId / endingCraft.findingId） */
  findingId: string;
  /** span 数量 */
  spanCount: number;
  /** span 范围摘要，如 "[10,25];[100,130]"；无 span 时为空串 */
  spanSummary: string;
  /** 观察到的事实（structural.observation / infoRelease.evidence / endingCraft.evidence） */
  evidence: string;
  /** 读者影响（advisory） */
  readerImpact: string;
  /** 建议 owner（structural.recommendedOwner / infoRelease.suggestedOwner / endingCraft.suggestedOwner） */
  suggestedOwner: string;
  /** 置信度 ∈ [0, 1] */
  confidence: number;
}

/**
 * 单个 source report 的摘要（不保留原始 evidence 数组，只保留元信息 + 计数）。
 *
 * present=false 表示 stageResults 中没有该字段（missing source）。
 * present=true + skipped=true 表示 source 自己标记为 skipped（hardBlock / scanner 异常）。
 */
export interface SourceReportSummary {
  source: CraftEvidenceSource;
  /** stageResults 中是否存在该 source report */
  present: boolean;
  /** source 自己的 meta.skipped（present=true 时有效） */
  skipped: boolean;
  /** source 的 skippedReason（present=true + skipped=true 时有效） */
  skippedReason?: string;
  /**
   * source 的真实（非 skipped）evidence 数量（present=true 时有效）。
   * skipped 源的占位 evidence 不计入（与 extractXxxFindings 过滤逻辑一致）。
   */
  evidenceCount: number;
  /** source 的 scannedCandidateId */
  scannedCandidateId?: string;
  /** source 的 scannedTextLength */
  scannedTextLength?: number;
  /** source 的 scannedAt（ms 时间戳） */
  scannedAt?: number;
}

/**
 * 状态计数（按 source 分桶 + total）。
 *
 * 只统计 risk / human_review / partial 三态（任务书"计数正确"口径）。
 * satisfied / contradicted / not_applicable / skipped 不计入这三个计数器，
 * 但仍保留在 findings 数组里供人工审阅。
 */
export interface StatusCount {
  bySource: Record<CraftEvidenceSource, number>;
  total: number;
}

/**
 * CraftEvidenceEnvelope — 写入 stageResults.craftEvidenceEnvelope 的结构。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / 文学总分 / pass|fail 总判定；
 * - 任何触发改文/重写/候选生成的字段（expectedRef / severity / recommendedAction / fix）；
 * - 任何 gate/hard_block 权限字段；
 * - 任何把 topFindings 排序转化为质量分的字段（如 rankedScore / weightedScore）。
 */
export interface CraftEvidenceEnvelope {
  /** 三个 source report 的摘要 */
  sourceReports: SourceReportSummary[];
  /** 全部统一 findings（按 source 顺序：chapterQuality → informationRelease → endingCraft） */
  findings: EnvelopeFinding[];
  /** status=risk 的计数（按 source + total） */
  riskCounts: StatusCount;
  /** status=human_review 的计数（按 source + total） */
  humanReviewCount: StatusCount;
  /** status=partial 的计数（按 source + total） */
  partialCount: StatusCount;
  /**
   * top findings：按 status 优先级 + span 存在性排序，截断至 TOP_FINDINGS_LIMIT。
   * **排序只为可读性，不是质量分**（任务书："topFindings 只按证据状态和 span 存在性排序，
   * 不能变成质量分"）。
   */
  topFindings: EnvelopeFinding[];
  meta: {
    /** 最终交付正文长度（用于校验所有 source 的 scannedTextLength 应一致） */
    finalTextLength: number;
    /** 最终选中的候选 id（从 input 传入，用于跨 source 对齐） */
    finalCandidateId: string;
    /** envelope 生成时间戳（ms） */
    generatedAt: number;
    /**
     * 是否跳过汇总（true = 所有 source 都 missing 或 skipped，无可用证据）。
     * hardBlock 路径会触发此标记。
     */
    skipped: boolean;
    /** 跳过原因（skipped=true 时必填） */
    skippedReason?: string;
    /** missing source 列表（stageResults 中不存在的 source） */
    missingSources: CraftEvidenceSource[];
  };
}

// ============================================================================
// 常量
// ============================================================================

/**
 * topFindings 截断上限（任务书"只按状态和 span 排序"，截断防止 trace 膨胀）。
 */
const TOP_FINDINGS_LIMIT = 10;

/**
 * status 排序优先级（数值越小越靠前）。
 *
 * 设计依据（任务书"topFindings 只按证据状态和 span 存在性排序，不能变成质量分"）：
 * - risk 最优先（最需要人工关注的潜在问题）
 * - human_review 次之（需复核但未确认风险）
 * - partial 再次（有部分证据但未达标）
 * - contradicted（QUALITY-3 独有，正文与 expectedRef 冲突，罕见但重要）
 * - satisfied（QUALITY-3 独有，明确达标，优先级低因为无需处理）
 * - not_applicable（本章不适用，无需处理）
 * - skipped（无 finalText 可扫描，最末）
 *
 * 这只是阅读顺序，不是质量分：不存在 0-100 分映射，不存在 pass/fail 阈值。
 */
const STATUS_PRIORITY: Record<EnvelopeFindingStatus, number> = {
  risk: 0,
  human_review: 1,
  partial: 2,
  contradicted: 3,
  satisfied: 4,
  not_applicable: 5,
  skipped: 6,
};

/**
 * 三个 source 的固定遍历顺序（用于 sourceReports + findings 的稳定排序）。
 */
const SOURCE_ORDER: CraftEvidenceSource[] = [
  "chapterQuality",
  "informationRelease",
  "endingCraft",
];

// ============================================================================
// 构建输入
// ============================================================================

/**
 * envelope 构建输入。
 *
 * 三个 source report 都是可选的：缺某个 report 时不抛错，记录到 meta.missingSources。
 * orchestrator 调用时从 stageResults 读取并传入。
 */
export interface BuildCraftEvidenceEnvelopeInput {
  /** 最终交付正文（仅用于记录 finalTextLength，不读取内容，不修改） */
  finalText: string;
  /** 最终选中的候选 id */
  finalCandidateId: string;
  /** QUALITY-3 章节质量证据（可空） */
  chapterQualityEvidence?: ChapterQualityEvidence | null;
  /** QUALITY-8 信息释放证据报告（可空） */
  informationReleaseEvidence?: InformationReleaseEvidenceReport | null;
  /** QUALITY-9 章末收束证据报告（可空） */
  endingCraftEvidence?: EndingCraftEvidenceReport | null;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 把 span 数组转成摘要字符串。
 * 例：[{start:10,end:25},{start:100,end:130}] → "[10,25];[100,130]"
 * 无 span 时返回空串。
 *
 * 摘要而非原始 span 数组：envelope 是汇总层，原始 span 在 source report 里可追溯，
 * 保留摘要足够人工定位证据位置，避免 envelope 体积膨胀。
 */
function summarizeSpans(
  spans: ReadonlyArray<{ start: number; end: number }>
): string {
  if (!spans || spans.length === 0) return "";
  return spans.map((s) => `[${s.start},${s.end}]`).join(";");
}

/**
 * 初始化空计数器（所有 source 计数为 0）。
 */
function emptyStatusCount(): StatusCount {
  return {
    bySource: {
      chapterQuality: 0,
      informationRelease: 0,
      endingCraft: 0,
    },
    total: 0,
  };
}

// ============================================================================
// source → findings 转换
// ============================================================================

/**
 * 从 ChapterQualityEvidence（QUALITY-3）提取 EnvelopeFinding 列表。
 *
 * 字段映射：
 * - structural.id → findingId
 * - structural.dimension → dimension
 * - structural.status → status（保留 satisfied/contradicted）
 * - structural.sourceSpans → spanCount + spanSummary
 * - structural.observation → evidence
 * - structural.readerImpact → readerImpact
 * - structural.recommendedOwner → suggestedOwner
 * - structural.confidence → confidence
 *
 * 不搬运 expectedRef / severity / recommendedAction（避免越权聚合 + 任务书禁止改文建议字段）。
 * 原始 StructuralEvidence 在 source report 里仍可追溯。
 *
 * 注：QUALITY-3 的 skipped 路径（skippedChapterQualityEvidence）直接产出空
 * structuralEvidence 数组（无占位条目），因此本函数无需过滤 status="skipped"。
 * 这与 QUALITY-8/9 不同（后者 skipped 路径会产出 N 条占位 evidence）。
 */
function extractChapterQualityFindings(
  report: ChapterQualityEvidence
): EnvelopeFinding[] {
  return report.structuralEvidence.map((e) => ({
    source: "chapterQuality" as const,
    dimension: e.dimension,
    status: e.status as EnvelopeFindingStatus,
    findingId: e.id,
    spanCount: e.sourceSpans.length,
    spanSummary: summarizeSpans(e.sourceSpans),
    evidence: e.observation,
    readerImpact: e.readerImpact,
    suggestedOwner: e.recommendedOwner,
    confidence: e.confidence,
  }));
}

/**
 * 从 InformationReleaseEvidenceReport（QUALITY-8）提取 EnvelopeFinding 列表。
 *
 * 字段映射：8 字段直接对应 EnvelopeFinding 的 8 个证据字段。
 *
 * 过滤 status="skipped" 的占位 evidence（同 extractChapterQualityFindings）。
 */
function extractInformationReleaseFindings(
  report: InformationReleaseEvidenceReport
): EnvelopeFinding[] {
  return report.evidence
    .filter((e) => e.status !== "skipped")
    .map((e) => ({
      source: "informationRelease" as const,
      dimension: e.dimensionId,
      status: e.status as EnvelopeFindingStatus,
      findingId: e.findingId,
      spanCount: e.sourceSpans.length,
      spanSummary: summarizeSpans(e.sourceSpans),
      evidence: e.evidence,
      readerImpact: e.readerImpact,
      suggestedOwner: e.suggestedOwner,
      confidence: e.confidence,
    }));
}

/**
 * 从 EndingCraftEvidenceReport（QUALITY-9）提取 EnvelopeFinding 列表。
 *
 * 字段映射：与 QUALITY-8 相同的 8 字段集。
 *
 * 过滤 status="skipped" 的占位 evidence（同 extractChapterQualityFindings）。
 */
function extractEndingCraftFindings(
  report: EndingCraftEvidenceReport
): EnvelopeFinding[] {
  return report.evidence
    .filter((e) => e.status !== "skipped")
    .map((e) => ({
      source: "endingCraft" as const,
      dimension: e.dimensionId,
      status: e.status as EnvelopeFindingStatus,
      findingId: e.findingId,
      spanCount: e.sourceSpans.length,
      spanSummary: summarizeSpans(e.sourceSpans),
      evidence: e.evidence,
      readerImpact: e.readerImpact,
      suggestedOwner: e.suggestedOwner,
      confidence: e.confidence,
    }));
}

// ============================================================================
// source report 摘要
// ============================================================================

/**
 * 构造单个 source 的摘要（统一处理 present / skipped / missing 三种情况）。
 *
 * evidenceCount 语义：真实（非 skipped）evidence 数量。
 * - skipped 源的占位 evidence（status="skipped"）不计入 evidenceCount
 *   （与 extractXxxFindings 的过滤逻辑一致：skipped = scanner 没跑 = 0 真实 finding）。
 * - skipped 事实由 sourceReports[].skipped + skippedReason 承载，不靠 evidenceCount 表达。
 */
function summarizeSource(
  source: CraftEvidenceSource,
  report: ChapterQualityEvidence | InformationReleaseEvidenceReport | EndingCraftEvidenceReport | null | undefined
): SourceReportSummary {
  if (!report) {
    return {
      source,
      present: false,
      skipped: false,
      evidenceCount: 0,
    };
  }
  // 三个 source report 都有 meta 字段（QUALITY-3 是 structuralEvidenceMeta，QUALITY-8/9 是 meta）
  // 用 duck-typing 统一读取
  const meta =
    source === "chapterQuality"
      ? (report as ChapterQualityEvidence).structuralEvidenceMeta
      : (report as InformationReleaseEvidenceReport | EndingCraftEvidenceReport).meta;
  const evidence =
    source === "chapterQuality"
      ? (report as ChapterQualityEvidence).structuralEvidence
      : (report as InformationReleaseEvidenceReport | EndingCraftEvidenceReport).evidence;

  // 真实 evidence = 非 skipped（与 extractXxxFindings 过滤逻辑一致）
  const realEvidenceCount = evidence.filter((e) => e.status !== "skipped").length;

  return {
    source,
    present: true,
    skipped: meta.skipped,
    skippedReason: meta.skippedReason,
    evidenceCount: realEvidenceCount,
    scannedCandidateId: meta.scannedCandidateId,
    scannedTextLength: meta.scannedTextLength,
    scannedAt: meta.scannedAt,
  };
}

// ============================================================================
// 计数
// ============================================================================

/**
 * 计算指定 status 的计数（按 source + total）。
 * 调用方传入 status="risk" / "human_review" / "partial" 之一。
 *
 * 只统计 risk / human_review / partial 三态（任务书"计数正确"口径）。
 * 其他状态（satisfied/contradicted/not_applicable/skipped）不计入这三个计数器，
 * 但仍保留在 findings 数组里供人工审阅。
 */
function computeStatusCount(
  findings: EnvelopeFinding[],
  status: "risk" | "human_review" | "partial"
): StatusCount {
  const count = emptyStatusCount();
  for (const f of findings) {
    if (f.status === status) {
      count.bySource[f.source]++;
      count.total++;
    }
  }
  return count;
}

// ============================================================================
// topFindings 排序
// ============================================================================

/**
 * topFindings 排序比较器。
 *
 * 排序规则（任务书："topFindings 只按证据状态和 span 存在性排序，不能变成质量分"）：
 * 1. status 优先级（risk > human_review > partial > contradicted > satisfied >
 *    not_applicable > skipped），数值越小越靠前。
 * 2. 同 status 内，有 span（spanCount > 0）优先于无 span。
 * 3. 同 status + 同 span 存在性，按 source 顺序（chapterQuality → informationRelease → endingCraft）。
 * 4. 同 source，按 findingId 字典序（稳定排序）。
 *
 * 不引入任何 weighted score / aggregateQualityScore / pass|fail 阈值。
 */
function compareFindingsForTop(
  a: EnvelopeFinding,
  b: EnvelopeFinding
): number {
  // 1. status 优先级
  const pa = STATUS_PRIORITY[a.status];
  const pb = STATUS_PRIORITY[b.status];
  if (pa !== pb) return pa - pb;
  // 2. span 存在性（有 span 优先）
  const aHasSpan = a.spanCount > 0 ? 0 : 1;
  const bHasSpan = b.spanCount > 0 ? 0 : 1;
  if (aHasSpan !== bHasSpan) return aHasSpan - bHasSpan;
  // 3. source 顺序
  const sa = SOURCE_ORDER.indexOf(a.source);
  const sb = SOURCE_ORDER.indexOf(b.source);
  if (sa !== sb) return sa - sb;
  // 4. findingId 字典序（稳定排序）
  if (a.findingId < b.findingId) return -1;
  if (a.findingId > b.findingId) return 1;
  return 0;
}

// ============================================================================
// 主构建函数
// ============================================================================

/**
 * 构建 CraftEvidenceEnvelope。
 *
 * 聚合三个 source report 的诊断证据为一个统一证据包。
 * - 只搬运与计数，不评分，不评判。
 * - 缺某个 source report 时不抛错，记录到 meta.missingSources。
 * - 所有 source 都 missing 或 skipped 时，meta.skipped = true。
 *
 * 不调用模型，不修改 finalText，不触发 StyleShaper/candidate/judge/selection/状态提交。
 */
export function buildCraftEvidenceEnvelope(
  input: BuildCraftEvidenceEnvelopeInput
): CraftEvidenceEnvelope {
  const {
    finalText,
    finalCandidateId,
    chapterQualityEvidence,
    informationReleaseEvidence,
    endingCraftEvidence,
  } = input;

  // ── 1. source reports 摘要 ──
  const sourceReports: SourceReportSummary[] = SOURCE_ORDER.map((src) => {
    if (src === "chapterQuality") {
      return summarizeSource(src, chapterQualityEvidence ?? null);
    }
    if (src === "informationRelease") {
      return summarizeSource(src, informationReleaseEvidence ?? null);
    }
    return summarizeSource(src, endingCraftEvidence ?? null);
  });

  // ── 2. findings 提取（按 source 顺序）──
  const findings: EnvelopeFinding[] = [];
  if (chapterQualityEvidence) {
    findings.push(...extractChapterQualityFindings(chapterQualityEvidence));
  }
  if (informationReleaseEvidence) {
    findings.push(...extractInformationReleaseFindings(informationReleaseEvidence));
  }
  if (endingCraftEvidence) {
    findings.push(...extractEndingCraftFindings(endingCraftEvidence));
  }

  // ── 3. 计数（只统计 risk / human_review / partial）──
  const riskCounts = computeStatusCount(findings, "risk");
  const humanReviewCount = computeStatusCount(findings, "human_review");
  const partialCount = computeStatusCount(findings, "partial");

  // ── 4. topFindings 排序 + 截断 ──
  const topFindings = [...findings]
    .sort(compareFindingsForTop)
    .slice(0, TOP_FINDINGS_LIMIT);

  // ── 5. meta ──
  const missingSources: CraftEvidenceSource[] = sourceReports
    .filter((s) => !s.present)
    .map((s) => s.source);

  // 所有 source 都 missing 或 skipped → envelope 标记 skipped
  const presentSources = sourceReports.filter((s) => s.present);
  const allMissingOrSkipped =
    presentSources.length === 0 ||
    presentSources.every((s) => s.skipped);

  let skipped = false;
  let skippedReason: string | undefined;
  if (allMissingOrSkipped) {
    skipped = true;
    if (missingSources.length === SOURCE_ORDER.length) {
      // 全部 missing
      skippedReason = `所有 source report 均缺失（missing: ${missingSources.join(", ")}）`;
    } else {
      // 部分 missing + 其余 skipped（如 hardBlock：3 个 source 都 present 但都 skipped）
      const skippedReasons = presentSources
        .filter((s) => s.skipped)
        .map((s) => s.skippedReason)
        .filter(Boolean) as string[];
      const missingPart =
        missingSources.length > 0
          ? `missing: ${missingSources.join(", ")}；`
          : "";
      const skippedPart =
        skippedReasons.length > 0
          ? `skipped: ${skippedReasons[0]}`
          : "skipped（无可用证据）";
      skippedReason = `${missingPart}${skippedPart}`;
    }
  }

  return {
    sourceReports,
    findings,
    riskCounts,
    humanReviewCount,
    partialCount,
    topFindings,
    meta: {
      finalTextLength: finalText.length,
      finalCandidateId,
      generatedAt: Date.now(),
      skipped,
      skippedReason,
      missingSources,
    },
  };
}

// ============================================================================
// skipped envelope 构造（envelope 异常路径）
// ============================================================================

/**
 * 构造 skipped envelope（envelope 自身异常 / hardBlock 路径无 finalText 时用）。
 *
 * 与 buildCraftEvidenceEnvelope 的 allMissingOrSkipped 分支语义一致，
 * 但用于 envelope 构建过程本身抛异常时（orchestrator 的 catch 块）。
 *
 * 注意：hardBlock 路径下，三个 source report 都已由 orchestrator 写为 skipped 版本，
 * 因此走正常 buildCraftEvidenceEnvelope 即可识别为 skipped envelope。本函数仅用于
 * envelope 构建过程自身异常的兜底。
 */
export function skippedCraftEvidenceEnvelope(
  finalCandidateId: string,
  reason: string
): CraftEvidenceEnvelope {
  const sourceReports: SourceReportSummary[] = SOURCE_ORDER.map((source) => ({
    source,
    present: false,
    skipped: false,
    evidenceCount: 0,
  }));
  return {
    sourceReports,
    findings: [],
    riskCounts: emptyStatusCount(),
    humanReviewCount: emptyStatusCount(),
    partialCount: emptyStatusCount(),
    topFindings: [],
    meta: {
      finalTextLength: 0,
      finalCandidateId,
      generatedAt: Date.now(),
      skipped: true,
      skippedReason: `envelope 构建跳过：${reason}`,
      missingSources: [...SOURCE_ORDER],
    },
  };
}

// ============================================================================
// 不变量校验（供测试断言）
// ============================================================================

/**
 * 校验 CraftEvidenceEnvelope 不变量。
 *
 * 规则：
 * - 必须包含 7 个顶层字段：sourceReports / findings / riskCounts /
 *   humanReviewCount / partialCount / topFindings / meta。
 * - 不得包含任何禁止字段（aggregateQualityScore / totalScore / 文学总分 /
 *   pass / fail / score / grade / fix / recommendedAction / expectedRef / severity /
 *   hardBlock / gate）。
 * - 每条 finding 必须含 10 个必填字段，且 confidence ∈ [0,1]。
 * - counts.total 必须等于 findings 中对应 status 的数量。
 * - topFindings 长度 ≤ TOP_FINDINGS_LIMIT。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateCraftEvidenceEnvelope(
  env: CraftEvidenceEnvelope
): string | null {
  // 顶层字段
  const requiredTop = [
    "sourceReports",
    "findings",
    "riskCounts",
    "humanReviewCount",
    "partialCount",
    "topFindings",
    "meta",
  ];
  for (const k of requiredTop) {
    if (!(k in env)) {
      return `envelope 缺少顶层字段：${k}`;
    }
  }

  // 禁止字段（任务书 + 防御性校验）
  const forbidden = [
    "aggregateQualityScore",
    "totalScore",
    "文学总分",
    "pass",
    "fail",
    "score",
    "grade",
    "fix",
    "recommendedAction",
    "expectedRef",
    "severity",
    "hardBlock",
    "gate",
    "weightedScore",
    "rankedScore",
  ];
  const serialized = JSON.stringify(env);
  for (const term of forbidden) {
    // 用 "term" 作为 key 出现才报错（避免误判 evidence 文本里偶然出现"pass"等词）
    const keyPattern = `"${term}"`;
    if (serialized.includes(keyPattern)) {
      return `envelope 含禁止字段/键：${term}`;
    }
  }

  // finding 字段集
  const requiredFinding = [
    "source",
    "dimension",
    "status",
    "findingId",
    "spanCount",
    "spanSummary",
    "evidence",
    "readerImpact",
    "suggestedOwner",
    "confidence",
  ];
  for (const f of env.findings) {
    for (const k of requiredFinding) {
      if (!(k in f)) {
        return `finding 缺少必填字段：${k}（findingId=${f.findingId}）`;
      }
    }
    if (
      typeof f.confidence !== "number" ||
      f.confidence < 0 ||
      f.confidence > 1
    ) {
      return `finding.confidence 越界：${f.confidence}（findingId=${f.findingId}）`;
    }
    if (typeof f.spanCount !== "number" || f.spanCount < 0) {
      return `finding.spanCount 非法：${f.spanCount}（findingId=${f.findingId}）`;
    }
  }

  // counts 校验
  const expectedRisk = env.findings.filter((f) => f.status === "risk").length;
  if (env.riskCounts.total !== expectedRisk) {
    return `riskCounts.total=${env.riskCounts.total} 与 findings 中 risk 数量=${expectedRisk} 不一致`;
  }
  const expectedHumanReview = env.findings.filter(
    (f) => f.status === "human_review"
  ).length;
  if (env.humanReviewCount.total !== expectedHumanReview) {
    return `humanReviewCount.total=${env.humanReviewCount.total} 与 findings 中 human_review 数量=${expectedHumanReview} 不一致`;
  }
  const expectedPartial = env.findings.filter(
    (f) => f.status === "partial"
  ).length;
  if (env.partialCount.total !== expectedPartial) {
    return `partialCount.total=${env.partialCount.total} 与 findings 中 partial 数量=${expectedPartial} 不一致`;
  }

  // topFindings 长度
  if (env.topFindings.length > TOP_FINDINGS_LIMIT) {
    return `topFindings 长度 ${env.topFindings.length} 超过上限 ${TOP_FINDINGS_LIMIT}`;
  }

  return null;
}
