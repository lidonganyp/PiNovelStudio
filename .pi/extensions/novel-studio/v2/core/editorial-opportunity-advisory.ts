/**
 * EditorialOpportunityAdvisory — 证据感知编辑机会 advisory 编译器（QUALITY-11 最小切片）
 *
 * 目标：把 QUALITY-10 的 CraftEvidenceEnvelope 从"只读汇总"推进到"影响已有 editorial
 * candidate 机会判断/候选生成的 advisory context"。这是第一步 evidence → action，
 * 不做大而全质量系统。
 *
 * 核心原则（QUALITY-11 任务书）：
 * - 不新增硬门槛；advisory 只是上下文，不是 gate。
 * - 不引入文学总分、pass/fail、grade、weightedScore、rankedScore。
 * - 不直接改 finalText；advisory 只读 envelope。
 * - 不强制生成 candidate；opportunity 返回 no-op 时仍交付 raw。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则。
 * - 不调用模型；advisory 编译是纯本地字段搬运。
 * - 不恢复 Stage0-8 控制权。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：直接复用 QUALITY-10 CraftEvidenceEnvelope 类型契约（不重造证据结构）。
 * - B：QUALITY-10 buildCraftEvidenceEnvelope 的 topFindings（已按状态优先级排序）。
 * - C：qualitative-evidence-scanner 的"诚实原则、不带总分"范式（只读证据，不复用控制权）。
 * - D：无（本任务是 advisory 编译层，不引入新的 legacy 概念）。
 * - E（退役，不得继承）：
 *   - 旧 CandidateComparator 的机械 11 维等权总分（已被 JudgeArbitrator 取代）。
 *   - 旧 DiagnosticSuite 的 pass|warning|fail 总判定 + suggestedRepair 重写命令。
 *   - 旧 DimensionScores 加权聚合 + HARD_BLOCK_PROVIDERS 配额硬门。
 *   - Stage0-8 任何 gate/block/rewrite 控制权。
 *
 * 选择策略（诚实原则：只搬运 topFindings，不评判）：
 * 1. 从 envelope.topFindings 中过滤 status ∈ {risk, human_review, partial}。
 *    topFindings 已由 QUALITY-10 按状态优先级排序（risk > human_review > partial > ...），
 *    本编译器不重新排序，只截断至 ADVISORY_MAX_ENTRIES=3。
 * 2. 每条 finding 转成 AdvisoryEntry（8 字段，任务书规定）：
 *    source / dimensionId / status / spanSummary / evidence / readerImpact / confidence / proxyNote。
 *    - dimensionId ← envelope.finding.dimension（QUALITY-10 统一字段名）
 *    - proxyNote 固定声明："诊断上下文，非改写命令，非质量评分"
 * 3. 无有效 finding（envelope skipped / topFindings 无 risk/human_review/partial）→
 *    emptyReason + promptBlock=null，不阻断流程。
 * 4. promptBlock 渲染为 compact block，注入 editorial opportunity / candidate prompt。
 *
 * 确定性本地编译：零 LLM 调用，纯字段搬运 + 截断。
 */

import type { CraftEvidenceEnvelope, EnvelopeFinding } from "./craft-evidence-envelope.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * advisory entry 的状态（只允许 risk / human_review / partial 三态）。
 *
 * 任务书："只选 topFindings 中最多 3 条 risk / human_review / partial"。
 * satisfied / contradicted / not_applicable / skipped 不进入 advisory
 *（satisfied/contradicted/not_applicable 无需编辑关注；skipped 表示 scanner 没跑）。
 */
export type AdvisoryStatus = "risk" | "human_review" | "partial";

/**
 * 单条 advisory entry（8 字段，任务书规定）。
 *
 * 不变量：
 * - 8 字段固定集，不得增减（任务书："字段只允许包含：source、dimensionId、status、
 *   spanSummary、evidence、readerImpact、confidence、proxyNote"）。
 * - proxyNote 固定声明 advisory 性质，防止下游误用为改写命令或质量评分。
 * - confidence ∈ [0, 1]（搬运 envelope finding 的 confidence）。
 * - 不含 expectedRef / severity / recommendedAction / fix / score / grade / pass|fail
 *   等字段（任务书禁止自动改文建议与总判定）。
 */
export interface AdvisoryEntry {
  /** 证据来源（chapterQuality / informationRelease / endingCraft） */
  source: "chapterQuality" | "informationRelease" | "endingCraft";
  /** 维度 id（envelope finding.dimension） */
  dimensionId: string;
  /** 证据状态（只允许 risk / human_review / partial） */
  status: AdvisoryStatus;
  /** span 范围摘要，如 "[10,25];[100,130]"；无 span 时为空串 */
  spanSummary: string;
  /** 观察到的事实（envelope finding.evidence） */
  evidence: string;
  /** 读者影响（advisory） */
  readerImpact: string;
  /** 置信度 ∈ [0, 1] */
  confidence: number;
  /** 性质声明：诊断上下文，非改写命令，非质量评分 */
  proxyNote: string;
}

/**
 * EditorialOpportunityAdvisory — 写入 stageResults.editorialOpportunityAdvisory 的结构。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / score / grade / pass / fail / fix /
 *   recommendedAction / hardBlock / gate / weightedScore / rankedScore（任务书）。
 * - 任何触发改文/重写/候选生成的字段。
 * - 任何 gate/hard_block 权限字段。
 */
export interface EditorialOpportunityAdvisory {
  /** 选中的 advisory entry（最多 ADVISORY_MAX_ENTRIES=3） */
  entries: AdvisoryEntry[];
  /**
   * compact advisory block，注入 editorial opportunity / candidate prompt。
   * 无有效 finding 时为 null（不注入）。
   */
  promptBlock: string | null;
  /** 无有效 finding 时的原因（envelope skipped / topFindings 无 risk/human_review/partial） */
  emptyReason?: string;
  meta: {
    /** 编译时间戳（ms） */
    compiledAt: number;
    /** 源 envelope 是否标记 skipped（hardBlock / scanner 异常路径） */
    sourceEnvelopeSkipped: boolean;
    /** 选中的 entry 数量 */
    findingCount: number;
  };
}

// ============================================================================
// 常量
// ============================================================================

/** advisory 最大 entry 数量（任务书："最多 3 条"） */
const ADVISORY_MAX_ENTRIES = 3;

/** advisory entry 状态白名单（只允许 risk / human_review / partial） */
const ADVISORY_ALLOWED_STATUS: ReadonlySet<string> = new Set([
  "risk",
  "human_review",
  "partial",
]);

/** proxyNote 固定声明（防止下游误用为改写命令或质量评分） */
const PROXY_NOTE = "诊断上下文，非改写命令，非质量评分";

// ============================================================================
// 构建输入
// ============================================================================

/**
 * advisory 编译输入。
 *
 * 接收 QUALITY-10 的 CraftEvidenceEnvelope，从中提取 topFindings 并编译为 advisory。
 */
export interface CompileAdvisoryInput {
  /** raw 阶段的 craft evidence envelope（由 QUALITY-10 buildCraftEvidenceEnvelope 构建） */
  envelope: CraftEvidenceEnvelope;
}

// ============================================================================
// 主编译函数
// ============================================================================

/**
 * 编译 EditorialOpportunityAdvisory。
 *
 * 从 envelope.topFindings 中过滤 risk/human_review/partial，截断至 max 3，
 * 渲染为 compact advisory block 供 editorial opportunity / candidate prompt 注入。
 *
 * - 只搬运与截断，不评分，不评判。
 * - envelope skipped 或无有效 finding → emptyReason + promptBlock=null，不阻断。
 *
 * 不调用模型，不修改 finalText，不触发 StyleShaper/candidate/judge/selection/状态提交。
 */
export function compileEditorialOpportunityAdvisory(
  input: CompileAdvisoryInput
): EditorialOpportunityAdvisory {
  const { envelope } = input;

  // 源 envelope 标记 skipped（hardBlock / scanner 异常路径）
  if (envelope.meta.skipped) {
    return {
      entries: [],
      promptBlock: null,
      emptyReason: `源 envelope skipped：${envelope.meta.skippedReason ?? "无可用证据"}`,
      meta: {
        compiledAt: Date.now(),
        sourceEnvelopeSkipped: true,
        findingCount: 0,
      },
    };
  }

  // 从 topFindings 过滤 risk/human_review/partial（topFindings 已按状态优先级排序）
  const selected = envelope.topFindings
    .filter((f) => ADVISORY_ALLOWED_STATUS.has(f.status))
    .slice(0, ADVISORY_MAX_ENTRIES);

  if (selected.length === 0) {
    return {
      entries: [],
      promptBlock: null,
      emptyReason:
        "topFindings 无 risk/human_review/partial 条目（raw 无需编辑关注的诊断证据）",
      meta: {
        compiledAt: Date.now(),
        sourceEnvelopeSkipped: false,
        findingCount: 0,
      },
    };
  }

  const entries: AdvisoryEntry[] = selected.map((f) => findingToEntry(f));

  return {
    entries,
    promptBlock: renderAdvisoryPromptBlock(entries),
    meta: {
      compiledAt: Date.now(),
      sourceEnvelopeSkipped: false,
      findingCount: entries.length,
    },
  };
}

// ============================================================================
// skipped advisory 构造（advisory 编译异常路径）
// ============================================================================

/**
 * 构造 skipped advisory（advisory 编译过程自身异常时用）。
 *
 * 与 compileEditorialOpportunityAdvisory 的 skipped 分支语义一致，
 * 但用于编译过程本身抛异常时（orchestrator 的 catch 块）。
 */
export function skippedEditorialOpportunityAdvisory(
  reason: string
): EditorialOpportunityAdvisory {
  return {
    entries: [],
    promptBlock: null,
    emptyReason: `advisory 编译跳过：${reason}`,
    meta: {
      compiledAt: Date.now(),
      sourceEnvelopeSkipped: true,
      findingCount: 0,
    },
  };
}

// ============================================================================
// 不变量校验（供测试断言）
// ============================================================================

/**
 * 校验 EditorialOpportunityAdvisory 不变量。
 *
 * 规则：
 * - 必须包含 4 个顶层字段：entries / promptBlock / meta（emptyReason 可选）。
 * - 不得包含任何禁止字段（aggregateQualityScore / totalScore / score / grade /
 *   pass / fail / fix / recommendedAction / hardBlock / gate / weightedScore / rankedScore）。
 * - 每条 entry 必须含 8 个必填字段，且 confidence ∈ [0,1]，status ∈ allowed。
 * - entries 长度 ≤ ADVISORY_MAX_ENTRIES=3。
 * - promptBlock=null 时 entries 必须为空（一致性）。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateEditorialOpportunityAdvisory(
  advisory: EditorialOpportunityAdvisory
): string | null {
  // 顶层字段
  const requiredTop = ["entries", "promptBlock", "meta"];
  for (const k of requiredTop) {
    if (!(k in advisory)) {
      return `advisory 缺少顶层字段：${k}`;
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
  ];
  const serialized = JSON.stringify(advisory);
  for (const term of forbidden) {
    const keyPattern = `"${term}"`;
    if (serialized.includes(keyPattern)) {
      return `advisory 含禁止字段/键：${term}`;
    }
  }

  // entry 字段集
  const requiredEntry = [
    "source",
    "dimensionId",
    "status",
    "spanSummary",
    "evidence",
    "readerImpact",
    "confidence",
    "proxyNote",
  ];
  for (const e of advisory.entries) {
    for (const k of requiredEntry) {
      if (!(k in e)) {
        return `advisory entry 缺少必填字段：${k}`;
      }
    }
    if (!ADVISORY_ALLOWED_STATUS.has(e.status)) {
      return `advisory entry.status 非法：${e.status}（只允许 risk/human_review/partial）`;
    }
    if (
      typeof e.confidence !== "number" ||
      e.confidence < 0 ||
      e.confidence > 1
    ) {
      return `advisory entry.confidence 越界：${e.confidence}`;
    }
  }

  // entries 长度
  if (advisory.entries.length > ADVISORY_MAX_ENTRIES) {
    return `advisory entries 长度 ${advisory.entries.length} 超过上限 ${ADVISORY_MAX_ENTRIES}`;
  }

  // 一致性：promptBlock=null 时 entries 必须为空
  if (advisory.promptBlock === null && advisory.entries.length > 0) {
    return `advisory.promptBlock=null 但 entries 非空（不一致）`;
  }
  if (advisory.promptBlock !== null && advisory.entries.length === 0) {
    return `advisory.promptBlock 非空但 entries 为空（不一致）`;
  }

  return null;
}

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 把 EnvelopeFinding 转成 AdvisoryEntry（8 字段）。
 *
 * 字段映射：
 * - finding.source → entry.source
 * - finding.dimension → entry.dimensionId（QUALITY-10 用 dimension，advisory 用 dimensionId）
 * - finding.status → entry.status（已由调用方过滤为 risk/human_review/partial）
 * - finding.spanSummary → entry.spanSummary
 * - finding.evidence → entry.evidence
 * - finding.readerImpact → entry.readerImpact
 * - finding.confidence → entry.confidence
 * - PROXY_NOTE → entry.proxyNote（固定声明）
 */
function findingToEntry(f: EnvelopeFinding): AdvisoryEntry {
  return {
    source: f.source,
    dimensionId: f.dimension,
    status: f.status as AdvisoryStatus,
    spanSummary: f.spanSummary,
    evidence: f.evidence,
    readerImpact: f.readerImpact,
    confidence: f.confidence,
    proxyNote: PROXY_NOTE,
  };
}

/**
 * 渲染 compact advisory block，注入 editorial opportunity / candidate prompt。
 *
 * 格式：
 * ```
 * 【raw 诊断证据摘要（advisory，非改写命令，非质量评分）】
 * - [chapterQuality/chapter_function_delivery] risk（span [10,25]）：观察事实... | 读者影响... | conf 0.55
 * - [informationRelease/infodump_block] human_review（span [100,130]）：观察事实... | 读者影响... | conf 0.50
 * ```
 *
 * 设计要点：
 * - 标题明确声明 advisory 性质，防止模型误用为改写命令。
 * - 不含对白比例/段落长度/控制清单等 control 型指令（不触发 auditPrompt control 检测）。
 * - 不含任何总分/pass/fail/grade 字段。
 */
function renderAdvisoryPromptBlock(entries: AdvisoryEntry[]): string {
  const lines: string[] = [
    "【raw 诊断证据摘要（advisory，非改写命令，非质量评分）】",
  ];
  for (const e of entries) {
    const spanPart = e.spanSummary ? `（span ${e.spanSummary}）` : "";
    const conf = e.confidence.toFixed(2);
    lines.push(
      `- [${e.source}/${e.dimensionId}] ${e.status}${spanPart}：${e.evidence} | 读者影响：${e.readerImpact} | conf ${conf}`
    );
  }
  lines.push(
    "注：以上为诊断上下文，仅供参考；是否生成编辑候选由编辑机会判断器独立决定。"
  );
  return lines.join("\n");
}
