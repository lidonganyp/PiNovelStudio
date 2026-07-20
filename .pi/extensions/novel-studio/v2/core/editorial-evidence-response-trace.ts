/**
 * EditorialEvidenceResponseTrace — 候选是否回应了诊断证据的审计 trace（QUALITY-12 最小切片）
 *
 * 目标：在 QUALITY-11 已把 raw craft evidence 送入 editorial opportunity/candidate prompt 后，
 * 新增"候选是否回应了诊断证据"的审计 trace。**只做证据闭环，不改变胜负规则，不做本地改写，
 * 不做机械评分。**
 *
 * 核心原则（QUALITY-12 任务书）：
 * - 不新增 hard gate；trace 只是审计证据，不是 gate。
 * - 不引入文学总分、pass/fail、grade、score、weightedScore、rankedScore。
 * - 不改 finalText；trace 只读 rawText / editorialText。
 * - 不强制生成 candidate；no-op / 无 candidate 时不伪造 trace。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则；trace 不进入 winner 决策。
 * - 不调用真实模型；trace 判定是纯本地文本 span / 关键词 / 长度窗口弱判断。
 * - 不恢复 Stage0-8 控制权。
 * - 不得宣称"质量提升"；不得返回 satisfied；不得生成改写建议。
 *
 * 判定方式（保守原则）：
 * 1. rawText === editorialText → 所有 item responseType="unchanged"（未做任何编辑）。
 * 2. advisory entry 无 span → responseType="not_applicable"（无法定位风险区域）。
 * 3. raw 风险 span 文本仍在 candidate 中原样存在 → responseType="unchanged"（风险文本未触及）。
 * 4. raw 风险 span 已被修改 → 按 source/dimension 分类检查风险信号：
 *    - endingCraft/flat_summary_ending：检查 candidate 尾段是否仍含平铺总结关键词。
 *    - endingCraft/hook_or_question：检查 candidate 尾段是否已有钩子信号（问号/反常/危险）。
 *    - endingCraft/tail_pressure：检查 candidate 尾段是否已有压力关键词。
 *    - informationRelease/infodump_block：raw infodump 文本已不在 candidate 中 → addressed（弱判定）。
 *    - informationRelease/action_bearing_release：partial 状态（已有行动承载），非风险 → not_applicable。
 *    - chapterQuality/*：无法本地判定结构质量 → unverified。
 * 5. 风险信号已消除 → responseType="addressed"（confidence ≤ 0.5，弱判定）。
 * 6. 风险信号仍存在 → responseType="partially_addressed"。
 * 7. 无法本地判定 → responseType="unverified"。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：直接复用 QUALITY-10 CraftEvidenceEnvelope + QUALITY-11 EditorialOpportunityAdvisory 类型契约。
 * - B：无（本任务是新 trace 编译层，不修改已有 prompt 注入模式）。
 * - C：qualitative-evidence-scanner 的"诚实原则、不带总分"范式（只读证据，不复用控制权）。
 * - D：概念借用 ending-craft-evidence-scanner / information-release-evidence-scanner 的关键词子集
 *      （非完整复用，仅取关键子集做弱判定；trace 不是 re-scan）。
 * - E（退役，不得继承）：
 *   - 旧 CandidateComparator 的机械 11 维等权总分（已被 JudgeArbitrator 取代）。
 *   - 旧 DiagnosticSuite 的 pass|warning|fail 总判定 + suggestedRepair 重写命令。
 *   - Stage0-8 任何 gate/block/rewrite 控制权。
 *   - trace 不得成为新的 hard gate、不得生成改写建议、不得用于 winner 选择。
 *
 * 确定性本地编译：零 LLM 调用，纯文本 span / 关键词 / 长度窗口弱判断。
 */

import type { CraftEvidenceEnvelope } from "./craft-evidence-envelope.js";
import type { EditorialOpportunityAdvisory, AdvisoryEntry } from "./editorial-opportunity-advisory.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 候选对单条 advisory entry 的响应类型（任务书规定五态）。
 *
 * 严禁新增 "satisfied" / "pass" / "fail" / "graded" / "scored" 等总判定状态。
 * - addressed：raw 风险 span 已修改且 candidate 中风险信号消除（弱判定，confidence ≤ 0.5）。
 * - partially_addressed：raw 风险 span 已修改但 candidate 中仍存在风险信号。
 * - unchanged：raw 风险 span 文本在 candidate 中原样存在（风险未触及）。
 * - not_applicable：advisory entry 无 span 或维度非风险（如 action_bearing_release partial）。
 * - unverified：无法本地判定（如 chapterQuality 结构维度）。
 */
export type EvidenceResponseType =
  | "addressed"
  | "partially_addressed"
  | "unchanged"
  | "not_applicable"
  | "unverified";

/**
 * 单条响应 trace item（任务书规定字段集）。
 *
 * 不变量：
 * - 10 字段固定集，不得增减。
 * - stableFindingRef 由 source:dimensionId 构造（advisory entry 无 id 字段）。
 * - status 是 raw 阶段该 finding 的状态（risk/human_review/partial），不是响应后的状态。
 * - responseType 只允许五态，不得返回 satisfied。
 * - confidence ∈ [0, 1]（本地弱判断，通常 0.3-0.6）。
 * - proxyNote 固定声明 trace 性质，防止下游误用为改写命令或质量评分。
 * - 不含 expectedRef / severity / recommendedAction / fix / score / grade / pass|fail
 *   等字段（任务书禁止自动改文建议与总判定）。
 */
export interface ResponseTraceItem {
  /** 稳定引用：source:dimensionId（advisory entry 无 id，用 source+dimension 构造） */
  stableFindingRef: string;
  /** 证据来源（chapterQuality / informationRelease / endingCraft） */
  source: "chapterQuality" | "informationRelease" | "endingCraft";
  /** 维度 id（advisory entry.dimensionId） */
  dimensionId: string;
  /** raw 阶段该 finding 的状态（risk / human_review / partial） */
  status: "risk" | "human_review" | "partial";
  /** raw 中该 finding 的 span 摘要（如 "[10,25]"；无 span 时为空串） */
  rawSpanSummary: string;
  /** candidate 中对应区域的 span 摘要（若能定位，如尾段 span；无法定位时为 undefined） */
  candidateSpanSummary?: string;
  /** 响应类型（五态，不得返回 satisfied） */
  responseType: EvidenceResponseType;
  /** 证据说明（本地弱判断的观察事实，非改写建议） */
  evidenceNote: string;
  /** 置信度 ∈ [0, 1]（本地弱判断，通常 0.3-0.6） */
  confidence: number;
  /** 性质声明：审计 trace，非改写命令，非质量评分，非 winner 选择依据 */
  proxyNote: string;
}

/**
 * EditorialEvidenceResponseTrace — 写入 stageResults.editorialEvidenceResponseTraces 的结构。
 *
 * 每个 editorial candidate 对应一个 trace。no-op / 无 candidate 时不伪造 trace。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / score / grade / pass / fail / fix /
 *   recommendedAction / hardBlock / gate / weightedScore / rankedScore（任务书）。
 * - 任何触发改文/重写/候选生成的字段。
 * - 任何 gate/hard_block 权限字段。
 * - 任何用于 SelectionPolicy winner 决策的字段。
 */
export interface EditorialEvidenceResponseTrace {
  /** 候选 id */
  candidateId: string;
  /** 生成该候选的 hypothesis id（可空） */
  hypothesisId?: string;
  /** 每条 advisory entry 的响应 trace item */
  items: ResponseTraceItem[];
  meta: {
    /** 编译时间戳（ms） */
    compiledAt: number;
    /** 输入的 advisory entry 数量 */
    inputAdvisoryEntryCount: number;
    /** 产出的 response item 数量 */
    responseItemCount: number;
    /** raw 正文长度 */
    rawTextLength: number;
    /** candidate 正文长度 */
    editorialTextLength: number;
    /** raw 与 candidate 文本是否完全相同 */
    textIdentical: boolean;
  };
}

// ============================================================================
// 常量
// ============================================================================

/** proxyNote 固定声明（防止下游误用为改写命令/质量评分/winner 选择依据） */
const PROXY_NOTE = "审计 trace，非改写命令，非质量评分，非 winner 选择依据";

/** 尾段扫描长度（与 ending-craft-evidence-scanner 的 TAIL_SCAN_LENGTH 一致） */
const TAIL_SCAN_LENGTH = 500;

/** 最小有效文本长度（与 scanners 的 MIN_VALID_TEXT_LENGTH 一致） */
const MIN_VALID_TEXT_LENGTH = 50;

/**
 * 平铺总结关键词子集（ending-craft-evidence-scanner FLAT_SUMMARY_STRONG_KEYWORDS 的子集）。
 * 用于检查 candidate 尾段是否仍含平铺总结风险信号。
 * 非完整 scanner 关键词表，仅取强信号子集做弱判定。
 */
const FLAT_SUMMARY_SIGNALS = [
  "总之",
  "从此",
  "至此",
  "完结",
  "落幕",
  "总而言之",
  "综上所述",
  "全剧终",
  "故事结束",
  "就这样结束",
  "到此结束",
];

/**
 * 钩子信号子集（ending-craft-evidence-scanner HOOK_QUESTION_KEYWORDS 的子集）。
 * 用于检查 candidate 尾段是否已有钩子（问号/反常/危险/未解释）。
 */
const HOOK_SIGNALS = [
  "？",
  "?",
  "突然",
  "竟然",
  "没想到",
  "原来",
  "危险",
  "秘密",
  "逼近",
  "阴影",
  "震动",
  "巨响",
  "心中一沉",
  "不妙",
  "变故",
  "倒吸",
];

/**
 * 压力关键词子集（ending-craft-evidence-scanner TAIL_PRESSURE_KEYWORDS 的子集）。
 * 用于检查 candidate 尾段是否已有未解决压力信号。
 */
const PRESSURE_SIGNALS = [
  "压力",
  "危险",
  "威胁",
  "逼近",
  "危机",
  "阴影",
  "来袭",
  "冲来",
  "包围",
  "锁定",
  "杀意",
  "震动",
  "巨响",
  "倒吸",
  "心中一沉",
  "不妙",
  "变故",
  "骤然",
  "陡然",
];

// ============================================================================
// 构建输入
// ============================================================================

/**
 * trace 编译输入。
 *
 * 接收 raw 阶段的 craft evidence envelope + advisory + raw/candidate 正文，
 * 编译为候选对诊断证据的响应 trace。
 */
export interface CompileTraceInput {
  /** raw 阶段的 craft evidence envelope（QUALITY-10） */
  rawCraftEvidenceEnvelope: CraftEvidenceEnvelope;
  /** raw 阶段的 editorial opportunity advisory（QUALITY-11） */
  editorialOpportunityAdvisory: EditorialOpportunityAdvisory;
  /** raw 候选正文 */
  rawText: string;
  /** editorial 候选正文 */
  editorialText: string;
  /** editorial 候选 id */
  candidateId: string;
  /** 生成该候选的 hypothesis id（可空） */
  hypothesisId?: string;
}

// ============================================================================
// 主编译函数
// ============================================================================

/**
 * 编译 EditorialEvidenceResponseTrace。
 *
 * 对每条 advisory entry，用本地文本 span / 关键词 / 长度窗口弱判断 candidate 是否回应了该诊断证据。
 *
 * - 保守判定：只能给 unchanged / unverified / not_applicable，除非有明确证据才能给 addressed。
 * - 不评分，不判胜负，不生成改写建议，不返回 satisfied。
 * - advisory 空 / envelope skipped → 空 items + meta，不伪造 trace。
 *
 * 不调用模型，不修改 finalText，不触发 StyleShaper/candidate/judge/selection/状态提交。
 */
export function compileEditorialEvidenceResponseTrace(
  input: CompileTraceInput
): EditorialEvidenceResponseTrace {
  const {
    editorialOpportunityAdvisory: advisory,
    rawText,
    editorialText,
    candidateId,
    hypothesisId,
  } = input;

  const textIdentical = rawText === editorialText;
  const advisoryEntries = advisory.entries ?? [];

  const items: ResponseTraceItem[] = advisoryEntries.map((entry) =>
    classifyResponse(entry, rawText, editorialText, textIdentical)
  );

  return {
    candidateId,
    hypothesisId,
    items,
    meta: {
      compiledAt: Date.now(),
      inputAdvisoryEntryCount: advisoryEntries.length,
      responseItemCount: items.length,
      rawTextLength: rawText.length,
      editorialTextLength: editorialText.length,
      textIdentical,
    },
  };
}

// ============================================================================
// skipped trace 构造（trace 编译异常路径）
// ============================================================================

/**
 * 构造 skipped trace（trace 编译过程自身异常时用）。
 *
 * 用于 orchestrator 的 catch 块：trace 编译异常时不阻断流程，写空 trace + skipped 标记。
 * no-op / 无 candidate 路径不应调用此函数（不应伪造 trace）；orchestrator 直接不写 trace 字段
 * 或写空数组即可。本函数仅用于"有 candidate 但 trace 编译过程异常"的兜底。
 */
export function skippedEditorialEvidenceResponseTrace(
  candidateId: string,
  hypothesisId: string | undefined,
  reason: string
): EditorialEvidenceResponseTrace {
  return {
    candidateId,
    hypothesisId,
    items: [],
    meta: {
      compiledAt: Date.now(),
      inputAdvisoryEntryCount: 0,
      responseItemCount: 0,
      rawTextLength: 0,
      editorialTextLength: 0,
      textIdentical: false,
    },
  };
}

/**
 * no-op / 无 candidate 时的空 trace 列表标记。
 * orchestrator 在无 editorial candidate 时写此标记，明确"无 candidate 故无 trace"，
 * 而非伪造 trace。
 */
export interface SkippedTraceSet {
  /** 空数组（无 candidate 故无 trace） */
  traces: [];
  /** 跳过原因 */
  skippedReason: string;
}

/**
 * 构造 no-op / 无 candidate 路径的 skipped trace set。
 *
 * 不伪造 trace；明确记录"无 editorial candidate 故未编译 response trace"。
 */
export function skippedEditorialEvidenceResponseTraceSet(
  reason: string
): SkippedTraceSet {
  return {
    traces: [],
    skippedReason: reason,
  };
}

// ============================================================================
// 不变量校验（供测试断言）
// ============================================================================

/**
 * 校验 EditorialEvidenceResponseTrace 不变量。
 *
 * 规则：
 * - 必须包含 3 个顶层字段：candidateId / items / meta（hypothesisId 可选）。
 * - 不得包含任何禁止字段（aggregateQualityScore / totalScore / score / grade /
 *   pass / fail / fix / recommendedAction / hardBlock / gate / weightedScore / rankedScore）。
 * - 每条 item 必须含 10 个必填字段，且 confidence ∈ [0,1]。
 * - responseType 只允许五态，不得为 satisfied / pass / fail。
 * - status 只允许 risk / human_review / partial。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateEditorialEvidenceResponseTrace(
  trace: EditorialEvidenceResponseTrace
): string | null {
  // 顶层字段
  const requiredTop = ["candidateId", "items", "meta"];
  for (const k of requiredTop) {
    if (!(k in trace)) {
      return `trace 缺少顶层字段：${k}`;
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
  const serialized = JSON.stringify(trace);
  for (const term of forbidden) {
    const keyPattern = `"${term}"`;
    if (serialized.includes(keyPattern)) {
      return `trace 含禁止字段/键：${term}`;
    }
  }

  // item 字段集
  const requiredItem = [
    "stableFindingRef",
    "source",
    "dimensionId",
    "status",
    "rawSpanSummary",
    "responseType",
    "evidenceNote",
    "confidence",
    "proxyNote",
  ];
  const allowedResponseTypes = new Set([
    "addressed",
    "partially_addressed",
    "unchanged",
    "not_applicable",
    "unverified",
  ]);
  const allowedStatus = new Set(["risk", "human_review", "partial"]);

  for (const item of trace.items) {
    for (const k of requiredItem) {
      if (!(k in item)) {
        return `trace item 缺少必填字段：${k}（stableFindingRef=${item.stableFindingRef ?? "?"}）`;
      }
    }
    if (!allowedResponseTypes.has(item.responseType)) {
      return `trace item.responseType 非法：${item.responseType}（只允许五态，不得为 satisfied）`;
    }
    if (!allowedStatus.has(item.status)) {
      return `trace item.status 非法：${item.status}（只允许 risk/human_review/partial）`;
    }
    if (
      typeof item.confidence !== "number" ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      return `trace item.confidence 越界：${item.confidence}`;
    }
  }

  return null;
}

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 解析 span 摘要字符串为 span 数组。
 * 例："[10,25];[100,130]" → [{start:10,end:25},{start:100,end:130}]
 * 空串或格式异常 → 空数组。
 */
function parseSpanSummary(spanSummary: string): Array<{ start: number; end: number }> {
  if (!spanSummary || typeof spanSummary !== "string") return [];
  const spans: Array<{ start: number; end: number }> = [];
  // 匹配 [start,end] 模式
  const re = /\[(\d+),(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spanSummary)) !== null) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      spans.push({ start, end });
    }
  }
  return spans;
}

/**
 * 提取文本尾段（最后 TAIL_SCAN_LENGTH 字符）。
 * 返回尾段文本和起始 offset（用于 span 坐标）。
 */
function extractTail(text: string): { tail: string; tailStart: number } {
  if (text.length <= TAIL_SCAN_LENGTH) {
    return { tail: text, tailStart: 0 };
  }
  const tailStart = text.length - TAIL_SCAN_LENGTH;
  return { tail: text.substring(tailStart), tailStart };
}

/**
 * 检查文本是否包含关键词列表中的任一项。
 */
function containsAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

/**
 * 对单条 advisory entry 分类 candidate 的响应类型。
 *
 * 保守判定逻辑：
 * 1. textIdentical → unchanged（未做任何编辑）
 * 2. 无 span → not_applicable
 * 3. raw slice 仍在 candidate 中 → unchanged（风险文本未触及）
 * 4. raw slice 已修改 → 按 source/dimension 检查风险信号
 */
function classifyResponse(
  entry: AdvisoryEntry,
  rawText: string,
  editorialText: string,
  textIdentical: boolean
): ResponseTraceItem {
  const stableFindingRef = `${entry.source}:${entry.dimensionId}`;

  // 基础 item 字段（所有分支共用）
  const baseItem = {
    stableFindingRef,
    source: entry.source,
    dimensionId: entry.dimensionId,
    status: entry.status,
    rawSpanSummary: entry.spanSummary,
    proxyNote: PROXY_NOTE,
  };

  // 1. 文本完全相同 → unchanged（未做任何编辑）
  if (textIdentical) {
    return {
      ...baseItem,
      responseType: "unchanged",
      evidenceNote: "raw 与 candidate 文本完全相同，未做任何编辑",
      confidence: 0.9,
    };
  }

  // 2. 解析 span
  const spans = parseSpanSummary(entry.spanSummary);
  if (spans.length === 0) {
    return {
      ...baseItem,
      responseType: "not_applicable",
      evidenceNote: "advisory entry 无 span，无法定位风险区域",
      confidence: 0.5,
    };
  }

  // 3. 提取 raw slice（取第一个 span）
  const firstSpan = spans[0];
  // 防御性：span 越界检查
  if (firstSpan.start < 0 || firstSpan.end > rawText.length) {
    return {
      ...baseItem,
      responseType: "not_applicable",
      evidenceNote: `raw span 越界 [${firstSpan.start},${firstSpan.end}]，rawText.length=${rawText.length}`,
      confidence: 0.4,
    };
  }
  const rawSlice = rawText.substring(firstSpan.start, firstSpan.end);

  // 4. raw slice 仍在 candidate 中原样存在 → unchanged（风险文本未触及）
  if (rawSlice.length > 0 && editorialText.includes(rawSlice)) {
    return {
      ...baseItem,
      responseType: "unchanged",
      evidenceNote: "raw 风险 span 文本在 candidate 中仍原样存在，风险未触及",
      confidence: 0.7,
    };
  }

  // 5. raw slice 已被修改 → 按 source/dimension 检查风险信号
  //    文本过短时无法做有意义的尾段判定
  if (editorialText.length < MIN_VALID_TEXT_LENGTH) {
    return {
      ...baseItem,
      responseType: "unverified",
      evidenceNote: `candidate 文本过短（${editorialText.length} < ${MIN_VALID_TEXT_LENGTH}），无法判定风险信号`,
      confidence: 0.3,
    };
  }

  return classifyByDimension(entry, rawText, editorialText, baseItem);
}

/**
 * 按 source/dimension 分类检查风险信号是否仍存在。
 *
 * - endingCraft：检查 candidate 尾段是否仍有/已消除对应风险信号。
 * - informationRelease/infodump_block：raw infodump 文本已不在 candidate 中 → addressed（弱判定）。
 * - informationRelease/action_bearing_release：partial 状态非风险 → not_applicable。
 * - chapterQuality/*：无法本地判定结构质量 → unverified。
 */
function classifyByDimension(
  entry: AdvisoryEntry,
  rawText: string,
  editorialText: string,
  baseItem: Omit<ResponseTraceItem, "responseType" | "evidenceNote" | "confidence" | "candidateSpanSummary">
): ResponseTraceItem {
  const { source, dimensionId } = entry;
  const editorialTail = extractTail(editorialText);
  const candidateSpanSummary = `[${editorialTail.tailStart},${editorialText.length}]`;

  // ── endingCraft 维度 ──
  if (source === "endingCraft") {
    return classifyEndingCraft(
      entry,
      editorialText,
      editorialTail.tail,
      candidateSpanSummary,
      baseItem
    );
  }

  // ── informationRelease 维度 ──
  if (source === "informationRelease") {
    return classifyInformationRelease(entry, baseItem);
  }

  // ── chapterQuality 维度 ──
  // 结构维度（protagonist_active / state_delta / causal_chain 等）无法本地判定，
  // raw slice 已修改但结构质量是否改善需 LLM 判断。
  return {
    ...baseItem,
    responseType: "unverified",
    evidenceNote:
      "raw 风险 span 已修改，但 chapterQuality 结构维度无法本地判定风险信号是否消除",
    confidence: 0.3,
  };
}

/**
 * endingCraft 维度的风险信号检查。
 *
 * - flat_summary_ending：raw 有平铺总结关键词。candidate 尾段仍有 → partially_addressed；已消除 → addressed。
 * - hook_or_question：raw 无钩子。candidate 尾段已有钩子信号 → addressed；仍无 → partially_addressed。
 * - tail_pressure：raw 无压力信号。candidate 尾段已有压力关键词 → addressed；仍无 → partially_addressed。
 * - 其他 endingCraft 维度 → unverified。
 */
function classifyEndingCraft(
  entry: AdvisoryEntry,
  editorialText: string,
  editorialTail: string,
  candidateSpanSummary: string,
  baseItem: Omit<ResponseTraceItem, "responseType" | "evidenceNote" | "confidence" | "candidateSpanSummary">
): ResponseTraceItem {
  const { dimensionId, status } = entry;

  if (dimensionId === "flat_summary_ending") {
    // raw 有平铺总结关键词（risk），candidate 尾段是否仍含
    const stillHasFlat = containsAnyKeyword(editorialTail, FLAT_SUMMARY_SIGNALS);
    if (stillHasFlat) {
      return {
        ...baseItem,
        candidateSpanSummary,
        responseType: "partially_addressed",
        evidenceNote: "raw 风险 span 已修改，但 candidate 尾段仍含平铺总结关键词",
        confidence: 0.45,
      };
    }
    return {
      ...baseItem,
      candidateSpanSummary,
      responseType: "addressed",
      evidenceNote: "raw 风险 span 已修改且 candidate 尾段不再含平铺总结关键词",
      confidence: 0.5,
    };
  }

  if (dimensionId === "hook_or_question") {
    // raw 无钩子（human_review），candidate 尾段是否已有钩子信号
    const hasHook = containsAnyKeyword(editorialTail, HOOK_SIGNALS);
    if (hasHook) {
      return {
        ...baseItem,
        candidateSpanSummary,
        responseType: "addressed",
        evidenceNote: "raw 风险 span 已修改且 candidate 尾段已出现钩子信号（问号/反常/危险）",
        confidence: 0.5,
      };
    }
    return {
      ...baseItem,
      candidateSpanSummary,
      responseType: "partially_addressed",
      evidenceNote: "raw 风险 span 已修改但 candidate 尾段仍无钩子信号",
      confidence: 0.4,
    };
  }

  if (dimensionId === "tail_pressure") {
    // raw 无压力信号（risk/human_review），candidate 尾段是否已有压力关键词
    const hasPressure = containsAnyKeyword(editorialTail, PRESSURE_SIGNALS);
    if (hasPressure) {
      return {
        ...baseItem,
        candidateSpanSummary,
        responseType: "addressed",
        evidenceNote: "raw 风险 span 已修改且 candidate 尾段已出现压力关键词",
        confidence: 0.5,
      };
    }
    return {
      ...baseItem,
      candidateSpanSummary,
      responseType: "partially_addressed",
      evidenceNote: "raw 风险 span 已修改但 candidate 尾段仍无压力关键词",
      confidence: 0.4,
    };
  }

  // 其他 endingCraft 维度（未来扩展）→ unverified
  return {
    ...baseItem,
    candidateSpanSummary,
    responseType: "unverified",
    evidenceNote: `raw 风险 span 已修改，但 endingCraft/${dimensionId} 维度无本地判定规则`,
    confidence: 0.3,
  };
}

/**
 * informationRelease 维度的风险信号检查。
 *
 * - infodump_block：raw 有信息灌输块。raw slice 已不在 candidate 中 → addressed（弱判定，可能被改写或移除）。
 * - action_bearing_release：partial 状态（已有行动承载信息释放），非风险 → not_applicable。
 * - 其他 informationRelease 维度 → unverified。
 */
function classifyInformationRelease(
  entry: AdvisoryEntry,
  baseItem: Omit<ResponseTraceItem, "responseType" | "evidenceNote" | "confidence" | "candidateSpanSummary">
): ResponseTraceItem {
  const { dimensionId, status } = entry;

  if (dimensionId === "infodump_block") {
    // raw infodump 文本已不在 candidate 中（rawSlice 已被修改）
    // 弱判定：信息灌输块可能被改写为行动承载或删除，风险信号消除
    return {
      ...baseItem,
      responseType: "addressed",
      evidenceNote:
        "raw infodump 风险 span 已修改（文本已不在 candidate 中），信息灌输块可能被改写或移除",
      confidence: 0.4,
    };
  }

  if (dimensionId === "action_bearing_release") {
    // partial 状态：raw 已有行动承载信息释放，非风险，无需编辑回应
    return {
      ...baseItem,
      responseType: "not_applicable",
      evidenceNote:
        "action_bearing_release 为 partial 状态（raw 已有行动承载），非风险，无需编辑回应",
      confidence: 0.5,
    };
  }

  // 其他 informationRelease 维度 → unverified
  return {
    ...baseItem,
    responseType: "unverified",
    evidenceNote: `raw 风险 span 已修改，但 informationRelease/${dimensionId} 维度无本地判定规则`,
    confidence: 0.3,
  };
}
