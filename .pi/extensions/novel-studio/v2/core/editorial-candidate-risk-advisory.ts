/**
 * EditorialCandidateRiskAdvisory — 候选是否未回应关键诊断证据的风险标记（QUALITY-13 最小切片）
 *
 * 目标：基于 QUALITY-12 的 EditorialEvidenceResponseTrace，新增"editorial candidate 是否
 * 未回应关键诊断证据"的候选级风险审计 advisory。**只做 candidate-level 风险审计与提示，
 * 不直接改 winner，不做 hard gate，不做评分。**
 *
 * 核心原则（QUALITY-13 任务书）：
 * - 不新增 hard gate；advisory 只是审计标记，不是 gate。
 * - 不引入文学总分、pass/fail、grade、score、weightedScore、rankedScore。
 * - 不改 finalText；advisory 只读 trace / candidate。
 * - 不强制生成 candidate；no-op / 无 candidate 时不伪造 advisory。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则；advisory 不进入 winner 决策。
 * - 不调用真实模型；advisory 判定是纯本地 trace 字段聚合弱判断。
 * - 不恢复 Stage0-8 控制权。
 * - 不得宣称 candidate 质量好坏，只能说"是否回应诊断证据不足"。
 * - 不得生成改写建议；不得返回 satisfied。
 *
 * 判定规则（保守原则，按严重度优先级取最高）：
 * 1. 存在 responseType="unchanged" 且对应 raw status="risk" → advisoryLevel="risk"
 *    （raw 风险 finding 的 span 文本在 candidate 中原样存在，风险未触及）。
 * 2. 存在 responseType="partially_addressed" → advisoryLevel="watch"
 *    （candidate 触及了风险区域但风险信号仍存在）。
 *    存在 responseType="unchanged" 且 status ∈ {human_review, partial} → advisoryLevel="watch"
 *    （非 risk finding 未被触及，值得人工复核）。
 * 3. 无上述具体负面信号，且 items 非空、不全为 addressed/not_applicable → advisoryLevel="unverified"
 *    （存在无法本地判定的 item，整体不能确认已充分回应）。
 * 4. items 全部为 addressed / not_applicable（或 items 为空）→ advisoryLevel="none"
 *    （无未回应证据）。
 *
 * 复用资产（A-E 分类见历史任务清单，文档已删除）：
 * - A：直接复用 QUALITY-12 EditorialEvidenceResponseTrace + ResponseTraceItem 类型契约。
 * - B：无（本任务是新的 advisory 编译层，不修改已有 trace 编译模式）。
 * - C：qualitative-evidence-scanner 的"诚实原则、不带总分"范式（只读证据，不复用控制权）。
 * - D：无（不引入 legacy 概念；advisory 完全由 trace 派生）。
 * - E（退役，不得继承）：
 *   - 旧 CandidateComparator 的机械 11 维等权总分（已被 JudgeArbitrator 取代）。
 *   - 旧 DiagnosticSuite 的 pass|warning|fail 总判定 + suggestedRepair 重写命令。
 *   - Stage0-8 任何 gate/block/rewrite 控制权。
 *   - advisory 不得成为新的 hard gate、不得生成改写建议、不得用于 winner 选择。
 *
 * 确定性本地编译：零 LLM 调用，纯 trace 字段聚合。
 */

import type {
  EditorialEvidenceResponseTrace,
  ResponseTraceItem,
} from "./editorial-evidence-response-trace.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 候选风险审计级别（任务书规定四态）。
 *
 * 严禁新增 "satisfied" / "pass" / "fail" / "graded" / "scored" 等总判定状态。
 * - none：无未回应证据（全部 addressed/not_applicable 或 items 为空）。
 * - watch：存在部分回应/非 risk finding 未触及，值得人工复核。
 * - risk：存在 raw risk finding 未触及（unchanged + status=risk）。
 * - unverified：存在无法本地判定的 item，且无具体负面信号。
 */
export type CandidateRiskAdvisoryLevel =
  | "none"
  | "watch"
  | "risk"
  | "unverified";

/**
 * 单条候选风险 advisory（任务书规定字段集）。
 *
 * 不变量：
 * - 8 字段固定集，不得增减。
 * - advisoryLevel 只允许四态，不得返回 satisfied / pass / fail。
 * - unresolvedFindingRefs 只包含未充分回应的 finding 引用
 *  （responseType ∈ {unchanged, partially_addressed, unverified}）。
 * - confidence ∈ [0, 1]（本地弱判断）。
 * - proxyNote 固定声明 advisory 性质，防止下游误用为改写命令/质量评分/winner 选择依据。
 * - 不含 expectedRef / severity / recommendedAction / fix / score / grade / pass|fail
 *   等字段（任务书禁止自动改文建议与总判定）。
 */
export interface CandidateRiskAdvisory {
  /** 候选 id */
  candidateId: string;
  /** 生成该候选的 hypothesis id（可空） */
  hypothesisId?: string;
  /** 未充分回应的 finding 引用列表（source:dimensionId） */
  unresolvedFindingRefs: string[];
  /** 响应情况摘要（本地弱判断的观察事实，非改写建议） */
  responseSummary: string;
  /** 风险审计级别（四态，不得返回 satisfied） */
  advisoryLevel: CandidateRiskAdvisoryLevel;
  /** 证据说明列表（每条未回应 finding 的简短说明） */
  evidenceNotes: string[];
  /** 置信度 ∈ [0, 1]（本地弱判断） */
  confidence: number;
  /** 性质声明：审计 advisory，非改写命令，非质量评分，非 winner 选择依据，非 hard gate */
  proxyNote: string;
}

/**
 * EditorialCandidateRiskAdvisory — 写入 stageResults.editorialCandidateRiskAdvisory 的结构。
 *
 * 每个 editorial candidate 对应一条 advisory。no-op / 无 candidate 时不伪造 advisory。
 *
 * 严格禁止：
 * - aggregateQualityScore / totalScore / score / grade / pass / fail / fix /
 *   recommendedAction / hardBlock / gate / weightedScore / rankedScore（任务书）。
 * - 任何触发改文/重写/候选生成的字段。
 * - 任何 gate/hard_block 权限字段。
 * - 任何用于 SelectionPolicy winner 决策的字段。
 */
export interface EditorialCandidateRiskAdvisory {
  /** 每个候选的风险 advisory */
  advisories: CandidateRiskAdvisory[];
  meta: {
    /** 编译时间戳（ms） */
    compiledAt: number;
    /** 候选数量 */
    candidateCount: number;
    /** 输入 trace 数量 */
    inputTraceCount: number;
  };
}

// ============================================================================
// 常量
// ============================================================================

/** proxyNote 固定声明（防止下游误用为改写命令/质量评分/winner 选择依据/hard gate） */
const PROXY_NOTE =
  "候选风险审计 advisory，非改写命令，非质量评分，非 winner 选择依据，非 hard gate";

// ============================================================================
// 构建输入
// ============================================================================

/**
 * advisory 编译输入。
 *
 * 接收 QUALITY-12 的 response traces + editorial candidates，
 * 为每个候选编译一条风险审计 advisory。
 *
 * rawCraftEvidenceEnvelope / editorialOpportunityAdvisory 为可选只读上下文，
 * 当前编译逻辑完全由 trace 派生，保留入参以备后续扩展并明确数据流向。
 */
export interface CompileRiskAdvisoryInput {
  /** QUALITY-12 编译的 response traces（每个 editorial candidate 一条） */
  traces: EditorialEvidenceResponseTrace[];
  /** editorial candidates（用于确保每个候选都有一条 advisory） */
  editorialCandidates: ReadonlyArray<{
    id: string;
    hypothesisId?: string;
  }>;
  /** raw 阶段的 craft evidence envelope（可选只读，当前未直接消费） */
  rawCraftEvidenceEnvelope?: unknown;
  /** raw 阶段的 editorial opportunity advisory（可选只读，当前未直接消费） */
  editorialOpportunityAdvisory?: unknown;
}

// ============================================================================
// 主编译函数
// ============================================================================

/**
 * 编译 EditorialCandidateRiskAdvisory。
 *
 * 为每个 editorial candidate 匹配其 response trace，并按保守规则判定 advisoryLevel。
 * - 无 trace 的候选 → advisoryLevel="unverified"（无法判定是否回应）。
 * - 有 trace 的候选 → 按 trace.items 的 responseType/status 聚合判定。
 *
 * - 不评分，不判胜负，不生成改写建议，不返回 satisfied。
 * - traces 空 / candidates 空 → 空 advisories + meta，不伪造 advisory。
 *
 * 不调用模型，不修改 finalText，不触发 StyleShaper/candidate/judge/selection/状态提交。
 */
export function compileEditorialCandidateRiskAdvisory(
  input: CompileRiskAdvisoryInput
): EditorialCandidateRiskAdvisory {
  const { traces, editorialCandidates } = input;

  const traceByCandidateId = new Map<string, EditorialEvidenceResponseTrace>();
  for (const t of traces) {
    traceByCandidateId.set(t.candidateId, t);
  }

  const advisories: CandidateRiskAdvisory[] = editorialCandidates.map((c) => {
    const trace = traceByCandidateId.get(c.id);
    if (!trace) {
      // 候选无对应 trace → 无法判定是否回应 → unverified
      return makeUnverifiedAdvisory(
        c.id,
        c.hypothesisId,
        "未找到该候选的 editorial evidence response trace，无法判定是否回应诊断证据"
      );
    }
    return compileSingleAdvisory(trace, c);
  });

  return {
    advisories,
    meta: {
      compiledAt: Date.now(),
      candidateCount: editorialCandidates.length,
      inputTraceCount: traces.length,
    },
  };
}

// ============================================================================
// skipped advisory 构造（no-op / 无 candidate / 编译异常路径）
// ============================================================================

/**
 * no-op / 无 candidate 时的空 advisory 集标记。
 * orchestrator 在无 editorial candidate 时写此标记，明确"无 candidate 故无 advisory"，
 * 而非伪造 advisory。
 */
export interface SkippedRiskAdvisorySet {
  /** 空数组（无 candidate 故无 advisory） */
  advisories: [];
  /** 跳过原因 */
  skippedReason: string;
}

/**
 * 构造 no-op / 无 candidate / 编译异常路径的 skipped advisory set。
 *
 * 不伪造 advisory；明确记录"无 editorial candidate 故未编译 candidate risk advisory"
 * 或"编译异常故降级 skipped"。
 */
export function skippedEditorialCandidateRiskAdvisorySet(
  reason: string
): SkippedRiskAdvisorySet {
  return {
    advisories: [],
    skippedReason: reason,
  };
}

// ============================================================================
// 不变量校验（供测试断言）
// ============================================================================

/**
 * 校验 EditorialCandidateRiskAdvisory 不变量。
 *
 * 规则：
 * - 必须包含 2 个顶层字段：advisories / meta。
 * - 不得包含任何禁止字段（aggregateQualityScore / totalScore / score / grade /
 *   pass / fail / fix / recommendedAction / hardBlock / gate / weightedScore /
 *   rankedScore / satisfied）。
 * - 每条 advisory 必须含 8 个必填字段，且 confidence ∈ [0,1]。
 * - advisoryLevel 只允许四态，不得为 satisfied / pass / fail。
 *
 * @returns 校验通过返回 null，失败返回错误描述。
 */
export function validateEditorialCandidateRiskAdvisory(
  advisory: EditorialCandidateRiskAdvisory
): string | null {
  // 顶层字段
  const requiredTop = ["advisories", "meta"];
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
    "satisfied",
  ];
  const serialized = JSON.stringify(advisory);
  for (const term of forbidden) {
    const keyPattern = `"${term}"`;
    if (serialized.includes(keyPattern)) {
      return `advisory 含禁止字段/键：${term}`;
    }
  }

  // advisory 字段集
  const requiredAdvisory = [
    "candidateId",
    "unresolvedFindingRefs",
    "responseSummary",
    "advisoryLevel",
    "evidenceNotes",
    "confidence",
    "proxyNote",
  ];
  const allowedLevels = new Set(["none", "watch", "risk", "unverified"]);

  for (const a of advisory.advisories) {
    for (const k of requiredAdvisory) {
      if (!(k in a)) {
        return `advisory item 缺少必填字段：${k}（candidateId=${a.candidateId ?? "?"}）`;
      }
    }
    if (!allowedLevels.has(a.advisoryLevel)) {
      return `advisory item.advisoryLevel 非法：${a.advisoryLevel}（只允许 none/watch/risk/unverified，不得为 satisfied）`;
    }
    if (
      typeof a.confidence !== "number" ||
      a.confidence < 0 ||
      a.confidence > 1
    ) {
      return `advisory item.confidence 越界：${a.confidence}`;
    }
    if (!Array.isArray(a.unresolvedFindingRefs)) {
      return `advisory item.unresolvedFindingRefs 必须为数组（candidateId=${a.candidateId}）`;
    }
    if (!Array.isArray(a.evidenceNotes)) {
      return `advisory item.evidenceNotes 必须为数组（candidateId=${a.candidateId}）`;
    }
  }

  return null;
}

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 为单个候选编译风险 advisory。
 *
 * 聚合 trace.items 的 responseType/status，按保守优先级判定 advisoryLevel。
 *
 * hypothesisId 优先取 candidate.hypothesisId（candidate 是权威源），
 * 回退到 trace.hypothesisId（QUALITY-12 trace 也携带 hypothesisId）。
 */
function compileSingleAdvisory(
  trace: EditorialEvidenceResponseTrace,
  candidate: { id: string; hypothesisId?: string }
): CandidateRiskAdvisory {
  const items = trace.items ?? [];

  // 统计各类信号
  let riskUnchangedCount = 0;
  let partialAddressedCount = 0;
  let unchangedNonRiskCount = 0;
  let unverifiedCount = 0;
  let addressedCount = 0;
  let notApplicableCount = 0;

  const unresolvedRefs: string[] = [];
  const evidenceNotes: string[] = [];

  for (const item of items) {
    const ref = item.stableFindingRef;
    const isUnresolved = isUnresolvedResponse(item.responseType);
    if (isUnresolved) {
      unresolvedRefs.push(ref);
    }

    if (item.responseType === "unchanged") {
      if (item.status === "risk") {
        riskUnchangedCount++;
        evidenceNotes.push(
          `${ref}：raw risk finding 的 span 文本在 candidate 中原样存在，风险未触及（unchanged）`
        );
      } else {
        // status ∈ {human_review, partial}：非 risk finding 未被触及
        unchangedNonRiskCount++;
        evidenceNotes.push(
          `${ref}：raw ${item.status} finding 未被 candidate 触及（unchanged）`
        );
      }
    } else if (item.responseType === "partially_addressed") {
      partialAddressedCount++;
      evidenceNotes.push(
        `${ref}：candidate 触及了风险区域但风险信号仍存在（partially_addressed）`
      );
    } else if (item.responseType === "unverified") {
      unverifiedCount++;
      evidenceNotes.push(
        `${ref}：无法本地判定 candidate 是否回应（unverified）`
      );
    } else if (item.responseType === "addressed") {
      addressedCount++;
    } else if (item.responseType === "not_applicable") {
      notApplicableCount++;
    }
  }

  // 按保守优先级判定 advisoryLevel
  let level: CandidateRiskAdvisoryLevel;
  let confidence: number;

  if (items.length === 0) {
    // 无 advisory entry → 候选无需回应任何诊断证据
    level = "none";
    confidence = 0.6;
  } else if (riskUnchangedCount > 0) {
    level = "risk";
    confidence = 0.7;
  } else if (partialAddressedCount > 0 || unchangedNonRiskCount > 0) {
    level = "watch";
    confidence = 0.5;
  } else if (addressedCount + notApplicableCount === items.length) {
    // 全部 addressed / not_applicable
    level = "none";
    confidence = 0.6;
  } else {
    // 无具体负面信号，但存在 unverified item，整体不能确认已充分回应
    level = "unverified";
    confidence = 0.35;
  }

  const responseSummary = buildResponseSummary(
    items.length,
    riskUnchangedCount,
    partialAddressedCount,
    unchangedNonRiskCount,
    unverifiedCount,
    addressedCount,
    notApplicableCount,
    level
  );

  return {
    candidateId: trace.candidateId,
    hypothesisId: candidate.hypothesisId ?? trace.hypothesisId,
    unresolvedFindingRefs: unresolvedRefs,
    responseSummary,
    advisoryLevel: level,
    evidenceNotes,
    confidence,
    proxyNote: PROXY_NOTE,
  };
}

/**
 * 判断 responseType 是否属于"未充分回应"。
 * unchanged / partially_addressed / unverified 视为未充分回应；
 * addressed / not_applicable 视为已充分回应或无需回应。
 */
function isUnresolvedResponse(
  responseType: ResponseTraceItem["responseType"]
): boolean {
  return (
    responseType === "unchanged" ||
    responseType === "partially_addressed" ||
    responseType === "unverified"
  );
}

/**
 * 构造响应情况摘要文本。
 */
function buildResponseSummary(
  total: number,
  riskUnchanged: number,
  partialAddressed: number,
  unchangedNonRisk: number,
  unverified: number,
  addressed: number,
  notApplicable: number,
  level: CandidateRiskAdvisoryLevel
): string {
  if (total === 0) {
    return "无诊断证据需回应（advisory entries 为空），advisoryLevel=none";
  }
  const parts: string[] = [];
  if (riskUnchanged > 0) {
    parts.push(`risk 未触及 ${riskUnchanged}`);
  }
  if (partialAddressed > 0) {
    parts.push(`部分回应 ${partialAddressed}`);
  }
  if (unchangedNonRisk > 0) {
    parts.push(`非 risk 未触及 ${unchangedNonRisk}`);
  }
  if (unverified > 0) {
    parts.push(`无法判定 ${unverified}`);
  }
  if (addressed > 0) {
    parts.push(`已回应 ${addressed}`);
  }
  if (notApplicable > 0) {
    parts.push(`无需回应 ${notApplicable}`);
  }
  const detail = parts.length > 0 ? parts.join("，") : "无信号";
  return `共 ${total} 条诊断证据：${detail}；advisoryLevel=${level}`;
}

/**
 * 构造 unverified advisory（候选无对应 trace 时用）。
 */
function makeUnverifiedAdvisory(
  candidateId: string,
  hypothesisId: string | undefined,
  note: string
): CandidateRiskAdvisory {
  return {
    candidateId,
    hypothesisId,
    unresolvedFindingRefs: [],
    responseSummary: `未找到该候选的 response trace，无法判定是否回应诊断证据；advisoryLevel=unverified`,
    advisoryLevel: "unverified",
    evidenceNotes: [note],
    confidence: 0.3,
    proxyNote: PROXY_NOTE,
  };
}
