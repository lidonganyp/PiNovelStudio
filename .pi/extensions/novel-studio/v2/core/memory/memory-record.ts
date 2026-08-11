/**
 * MEMORY-2 统一记忆记录协议（MEMORY-RECORD-1）
 *
 * 长期记忆层基础协议。目标（任务文档 §二/§五/§七）：
 * - 分类明确：不同性质记忆用不同 MemoryType + payload schema
 * - 权威可判定：authorityClass / epistemicStatus / lifecycleStatus 三分类
 * - 可回源：sourceChapter / sourceRef / textHash / sourceFinalTextHash
 * - 计划与诊断不得晋升为正式事实
 * - 结构化事实不能只保存自由文本摘要
 *
 * 与现有 NarrativeStateStore（final-state-commit.ts）的关系：
 * 本协议是长期状态条目的**权威元数据信封**。每条正式状态 entry 可附带一个
 * optional `memory: MemoryRecord` 字段（旧 reader 忽略该字段，向后兼容）。
 * 本模块是纯类型 + 纯校验，无副作用，可安全纳入生产闭包。
 */

// ============================================================================
// 记忆分类（任务文档 §四）
// ============================================================================

export type MemoryType =
  | "working" // WorkingMemory：会话级
  | "chapter_fact" // ChapterFact：本章明确发生的结构化事实
  | "canon" // CanonState：世界观/规则/不可违背事实
  | "character" // CharacterState：人物状态（结构化版本化）
  | "promise" // PromiseLedger：伏笔/承诺/期待生命周期
  | "pattern" // PatternMemory：重复模式/写作策略（允许高度抽象）
  | "chapter_summary" // ChapterSummary：场景经过/情绪概览（必须保留引用）
  | "source_text" // SourceText：最终正文/原始片段（不覆盖）
  | "plan" // PlanMemory：ChapterSeed/意图/模型计划（不得进入正式事实检索）
  | "diagnostic"; // DiagnosticMemory：风险/扫描/猜测（TTL 衰减）

// ============================================================================
// 权威等级（任务文档 §5.1）
// ============================================================================

export type AuthorityClass =
  | "author_declaration" // 作者/作品宪法声明
  | "final_text_explicit" // 最终正文明确写出
  | "committed_state" // 已提交的长期状态（二次提交/重锚定）
  | "system_derived" // 系统推断（须带原文证据）
  | "model_planned" // 模型计划/待写事件
  | "diagnostic_hypothesis"; // 诊断猜测

// ============================================================================
// 认识状态（任务文档 §5.2）
// ============================================================================

export type EpistemicStatus =
  | "declared" // 作者声明（约束/世界观）
  | "confirmed" // 已确认事实（最终正文明确 + 复检通过）
  | "derived" // 系统派生（带证据链）
  | "planned" // 计划中（未发生）
  | "hypothesis" // 猜测（未证实）
  | "disputed" // 存在冲突
  | "superseded"; // 已被新版本取代

// ============================================================================
// 生命周期状态（任务文档 §5.3 / §九）
// ============================================================================

export type LifecycleStatus =
  | "active" // 生效，参与默认检索
  | "expired" // 已过期（TTL 到期）
  | "superseded" // 已被新版本取代（保留历史）
  | "conflicted" // 存在未解决冲突
  | "archived"; // 归档层（不参与默认检索，可回源）

// ============================================================================
// 分类型 payload schema（任务文档 §七：独立 payload schema）
// ============================================================================

/** 结构化事实 payload：禁止只保存自由文本摘要（§6.1） */
export interface StructuredFactPayload {
  /** 结构化事实主体字段（如 canon.fact / character.value） */
  value: string;
  /** 结构化分类字段（如 canon.category / character.field），保证结构化而非纯自由文本 */
  category: string;
  /** 结构化键（用于冲突检测与版本化），如 "character:叶尘:realm" */
  key: string;
  /** 可选的辅助摘要：只能作为阅读辅助，不能成为唯一真相源 */
  auxiliarySummary?: string;
}

export interface PromiseLedgerPayload {
  promiseId: string;
  description: string;
  status: "open" | "advancing" | "fulfilled" | "broken";
  currentHeat: number;
  /** 生命周期与兑现条件不得压缩（§6.1） */
  payoffWindow?: string;
}

export interface PatternPayload {
  patternType: string;
  description: string;
  occurrenceCount: number;
}

export interface ChapterSummaryPayload {
  sceneFlow: string;
  emotionChange: string;
  stageOverview?: string;
  /** 摘要必须保留原文引用（sourceRef/textHash 在信封层，此处可附加 excerpt） */
  sourceExcerpts: string[];
}

export interface SourceTextPayload {
  excerpt: string;
  byteStart: number;
  byteEnd: number;
}

export interface PlanPayload {
  planKind: string;
  content: string;
  /** 计划来源：chapter_seed / chapter_intent / model_plan */
  source: "chapter_seed" | "chapter_intent" | "model_plan";
}

export interface DiagnosticPayload {
  kind: string;
  detail: string;
  /** 诊断必须带 TTL（§6.4） */
  ttlSeconds: number;
}

export type MemoryPayload =
  | { memoryType: "chapter_fact"; data: StructuredFactPayload }
  | { memoryType: "canon"; data: StructuredFactPayload }
  | { memoryType: "character"; data: StructuredFactPayload }
  | { memoryType: "promise"; data: PromiseLedgerPayload }
  | { memoryType: "pattern"; data: PatternPayload }
  | { memoryType: "chapter_summary"; data: ChapterSummaryPayload }
  | { memoryType: "source_text"; data: SourceTextPayload }
  | { memoryType: "plan"; data: PlanPayload }
  | { memoryType: "diagnostic"; data: DiagnosticPayload }
  | { memoryType: "working"; data: { note: string } };

// ============================================================================
// MemoryRecord 基础协议（任务文档 §七）
// ============================================================================

export interface MemoryRecord {
  memoryId: string;
  memoryType: MemoryType;
  authorityClass: AuthorityClass;
  epistemicStatus: EpistemicStatus;
  lifecycleStatus: LifecycleStatus;
  /** 来源章节号（null 表示非章节来源，如作者声明/世界观） */
  sourceChapter: number | null;
  sourceRef: string[];
  textHash: string[];
  sourceRunId: string;
  sourceFinalTextHash: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  confidence: number | null;
  derivedFromMemoryIds: string[];
  supersedesMemoryIds: string[];
  payload: MemoryPayload;
}

// ============================================================================
// 校验
// ============================================================================

export interface MemoryValidationResult {
  ok: boolean;
  errors: string[];
}

const MEMORY_TYPES: readonly MemoryType[] = [
  "working", "chapter_fact", "canon", "character", "promise",
  "pattern", "chapter_summary", "source_text", "plan", "diagnostic",
];

const AUTHORITY_CLASSES: readonly AuthorityClass[] = [
  "author_declaration", "final_text_explicit", "committed_state",
  "system_derived", "model_planned", "diagnostic_hypothesis",
];

const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = [
  "declared", "confirmed", "derived", "planned", "hypothesis",
  "disputed", "superseded",
];

const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  "active", "expired", "superseded", "conflicted", "archived",
];

/** 正式长期事实类型（进入权威检索） */
const FORMAL_MEMORY_TYPES: readonly MemoryType[] = [
  "chapter_fact", "canon", "character", "promise",
];

/** 正式事实所允许的 authorityClass */
const FORMAL_AUTHORITY_CLASSES: readonly AuthorityClass[] = [
  "author_declaration", "final_text_explicit", "committed_state",
];

/**
 * 校验 MemoryRecord。
 *
 * MEMORY-2 验收：
 * - 非法枚举被拒绝
 * - 正式记忆缺少来源（sourceChapter/sourceRef/textHash）被拒绝
 * - 结构化事实不能只保存自由文本摘要（chapter_fact/canon 必须含 category）
 */
export function validateMemoryRecord(record: MemoryRecord): MemoryValidationResult {
  const errors: string[] = [];

  if (!record.memoryId || record.memoryId.length === 0) {
    errors.push("memoryId 不能为空");
  }
  if (!MEMORY_TYPES.includes(record.memoryType)) {
    errors.push(`memoryType 非法：${record.memoryType}`);
  }
  if (!AUTHORITY_CLASSES.includes(record.authorityClass)) {
    errors.push(`authorityClass 非法：${record.authorityClass}`);
  }
  if (!EPISTEMIC_STATUSES.includes(record.epistemicStatus)) {
    errors.push(`epistemicStatus 非法：${record.epistemicStatus}`);
  }
  if (!LIFECYCLE_STATUSES.includes(record.lifecycleStatus)) {
    errors.push(`lifecycleStatus 非法：${record.lifecycleStatus}`);
  }

  const isFormal = FORMAL_MEMORY_TYPES.includes(record.memoryType);
  if (isFormal) {
    // 正式记忆必须可回源
    if (record.sourceChapter == null) {
      errors.push(`${record.memoryType} 正式记忆必须有 sourceChapter`);
    }
    if (!record.sourceRef || record.sourceRef.length === 0) {
      errors.push(`${record.memoryType} 正式记忆必须有 sourceRef`);
    }
    // 正式记忆必须绑定最终正文 hash（sourceFinalTextHash 或 textHash 非空）
    const hasHash =
      (record.sourceFinalTextHash && record.sourceFinalTextHash.length > 0) ||
      (record.textHash && record.textHash.length > 0);
    if (!hasHash) {
      errors.push(`${record.memoryType} 正式记忆必须绑定最终正文 textHash`);
    }
    // 正式记忆必须来自正式权威，不能是 plan/diagnostic 权威
    if (!FORMAL_AUTHORITY_CLASSES.includes(record.authorityClass)) {
      errors.push(
        `${record.memoryType} 正式记忆 authorityClass 非法：${record.authorityClass}（正式事实只允许 ${FORMAL_AUTHORITY_CLASSES.join("/")}）`
      );
    }
    if (record.confidence == null || record.confidence < 0 || record.confidence > 1) {
      errors.push(`${record.memoryType} 正式记忆 confidence 必须为 [0,1]`);
    }
  }

  // 结构化事实不能只保存自由文本摘要（§3.1 / §6.1）
  if (record.memoryType === "chapter_fact" || record.memoryType === "canon") {
    const data = (record.payload as { data?: StructuredFactPayload }).data;
    if (!data) {
      errors.push(`${record.memoryType} 必须使用 StructuredFactPayload（禁止纯自由文本摘要）`);
    } else if (!data.key || !data.category) {
      errors.push(`${record.memoryType} 结构化事实必须包含 category 与 key（不能只保存自由文本摘要）`);
    }
  }
  if (record.memoryType === "character") {
    const data = (record.payload as { data?: StructuredFactPayload }).data;
    if (!data || !data.key || !data.category) {
      errors.push("character 记忆必须包含结构化 key 与 category");
    }
  }
  if (record.memoryType === "promise") {
    const data = (record.payload as { data?: PromiseLedgerPayload }).data;
    if (!data || !data.promiseId || !data.description || !data.status) {
      errors.push("promise 记忆必须包含 promiseId/description/status");
    }
  }
  if (record.memoryType === "diagnostic") {
    const data = (record.payload as { data?: DiagnosticPayload }).data;
    if (!data || !data.ttlSeconds || data.ttlSeconds <= 0) {
      errors.push("diagnostic 记忆必须包含正的 ttlSeconds（§6.4 衰减）");
    }
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================================
// 晋升规则（任务文档 §5.3）
// ============================================================================

/**
 * 判断 epistemicStatus 是否允许晋升为目标状态。
 *
 * 硬约束（§5.3）：
 * - model_planned 永远不能自动转为 confirmed
 * - diagnostic_hypothesis 不得进入正式事实
 * - system_derived 必须带原文证据，不能无证据晋升为 confirmed
 *
 * 返回是否允许 + 原因。
 */
export function canPromoteEpistemicStatus(
  current: EpistemicStatus,
  authorityClass: AuthorityClass,
  target: EpistemicStatus
): { allowed: boolean; reason: string } {
  if (target === "confirmed") {
    if (authorityClass === "model_planned") {
      return { allowed: false, reason: "model_planned 永远不能自动转为 confirmed（§5.3）" };
    }
    if (authorityClass === "diagnostic_hypothesis") {
      return { allowed: false, reason: "diagnostic_hypothesis 不得进入正式事实（§5.3）" };
    }
    if (authorityClass === "system_derived") {
      return {
        allowed: false,
        reason: "system_derived 必须带原文证据，不能无证据晋升为 confirmed（§5.3）",
      };
    }
    // 只有 author_declaration / final_text_explicit / committed_state 可晋升为 confirmed
    if (
      authorityClass !== "author_declaration" &&
      authorityClass !== "final_text_explicit" &&
      authorityClass !== "committed_state"
    ) {
      return { allowed: false, reason: `authorityClass=${authorityClass} 不能晋升为 confirmed` };
    }
    if (current === "planned" || current === "hypothesis") {
      return {
        allowed: false,
        reason: `当前 epistemicStatus=${current} 不能直接晋升为 confirmed（须经最终正文复检）`,
      };
    }
    return { allowed: true, reason: "符合晋升条件" };
  }
  return { allowed: true, reason: "非 confirmed 晋升无额外限制" };
}

/**
 * 校验某个 MemoryRecord 是否可作为**正式事实**被检索/消费。
 *
 * MEMORY-6 验收：planned/hypothesis 默认不可作为事实证据。
 */
export function isFormalFactEvidence(record: MemoryRecord): {
  usable: boolean;
  reason?: string;
} {
  if (!FORMAL_MEMORY_TYPES.includes(record.memoryType)) {
    return { usable: false, reason: `memoryType=${record.memoryType} 非正式事实类型` };
  }
  if (record.epistemicStatus === "planned" || record.epistemicStatus === "hypothesis") {
    return { usable: false, reason: `epistemicStatus=${record.epistemicStatus} 不得作为事实证据` };
  }
  if (record.authorityClass === "model_planned" || record.authorityClass === "diagnostic_hypothesis") {
    return { usable: false, reason: `authorityClass=${record.authorityClass} 不得作为事实证据` };
  }
  if (record.lifecycleStatus === "expired" || record.lifecycleStatus === "archived") {
    return { usable: false, reason: `lifecycleStatus=${record.lifecycleStatus} 不参与默认事实检索` };
  }
  // MEMORY-6：冲突状态不作为正式事实证据——冲突被明确标识，模型不得静默选边（§十验收）。
  if (record.lifecycleStatus === "conflicted") {
    return { usable: false, reason: "lifecycleStatus=conflicted 存在未解决冲突，不得作为事实证据" };
  }
  return { usable: true };
}

/**
 * 生产检索可检索性判定（PEA-1：事实检索与 advisory 检索分层）。
 *
 * MEMORY-6 检索层接入时，正式事实类型（chapter_fact/canon/character/promise）必须
 * 通过 isFormalFactEvidence 严格把关；而 PatternMemory 等"允许高度抽象"的
 * advisory 类型虽然不是硬事实，仍应作为低权重 advisory 上下文注入，不应被整体排除。
 *
 * 返回：
 * - usable=false：不可进入工作集（生命周期/认识/权威被阻断），reason 说明原因。
 * - usable=true + advisory=false：正式事实类型，作为权威上下文。
 * - usable=true + advisory=true：非正式 advisory 类型（如 pattern），作为低权重上下文。
 */
export function isMemoryRetrievable(record: MemoryRecord): {
  usable: boolean;
  reason?: string;
  advisory?: boolean;
} {
  const advisory = !FORMAL_MEMORY_TYPES.includes(record.memoryType);
  if (advisory) {
    // 非正式 advisory 类型（pattern/chapter_summary 等）：允许低权重注入，
    // 仅当生命周期/认识/权威阻断检索时才排除。
    const blocked =
      record.lifecycleStatus === "expired" ||
      record.lifecycleStatus === "archived" ||
      record.lifecycleStatus === "conflicted" ||
      record.epistemicStatus === "planned" ||
      record.epistemicStatus === "hypothesis" ||
      record.authorityClass === "model_planned" ||
      record.authorityClass === "diagnostic_hypothesis";
    if (blocked) {
      return {
        usable: false,
        advisory: true,
        reason: `advisory 记忆不可检索（lifecycle=${record.lifecycleStatus}, epistemic=${record.epistemicStatus}, authority=${record.authorityClass}）`,
      };
    }
    return { usable: true, advisory: true };
  }
  // 正式事实类型：严格走 isFormalFactEvidence（lifecycle/epistemic/authority 均把关）。
  const factCheck = isFormalFactEvidence(record);
  if (!factCheck.usable) {
    return { usable: false, advisory: false, reason: "memory_not_formal_fact" };
  }
  return { usable: true, advisory: false };
}
