/**
 * NovelOS Tool Protocol（OPT-8.8）
 *
 * 统一工具协议：所有 NovelOS 叙事工具必须遵守。
 * - 每个工具结果必须包含 sourceRef（追溯原文/状态文件）和 evidenceLevel（证据等级）
 * - 工具声明 sideEffect（read-only / candidate_write / propose）
 * - 工具声明 requiredPermission（由 PermissionPolicy 校验）
 * - 工具有 timeoutMs 上限，超时可诊断可停止
 *
 * 与 pi-agent-core AgentTool 的关系：ToolProtocol 扩展 AgentTool，
 * 追加 requiredPermission / sideEffect / timeoutMs / evidenceLevel 约束元数据。
 * NarrativeToolRegistry 负责把 ToolProtocol 转成 AgentTool 供 Agent 消费。
 */

import type { AgentTool } from "../adapters/pi-agent-core-adapter.js";
import type { TSchema } from "typebox";

// ============================================================================
// 证据等级
// ============================================================================

/**
 * 证据等级（所有工具结果必须标注）：
 * - confirmed：有明确原文 span / 状态文件 entry 支持的事实（通用）
 * - confirmed_state：来自 NarrativeStateStore（canon/character/promise），已确认长期状态（M1.1 细分）
 * - exact_chapter_span：历史章节正文中的精确文本匹配（M1.1 细分）
 * - inferred：基于已有证据推导，无直接原文 span
 * - profile_only：来自风格档案/配置，无正文证据（如 voice evidence 降级）
 *
 * 排序优先级（M1.1 searchRanked）：confirmed_state > exact_chapter_span > confirmed > inferred > profile_only
 */
export type EvidenceLevel =
  | "confirmed"
  | "confirmed_state"
  | "exact_chapter_span"
  | "inferred"
  | "profile_only";

// ============================================================================
// Phase 3：统一结果类型（resultKind）
// ============================================================================

/**
 * 工具结果类型（Phase 3 统一工具结果格式）。
 * 每个叙事工具声明其结果承载的领域数据结构；空结果统一为 "no_match"。
 *
 * 映射：
 * - search_narrative_evidence → "ranked_evidence"
 * - search_chapter_span      → "chapter_spans"
 * - query_canon              → "canon_entries"
 * - query_character_state    → "character_state"
 * - query_timeline           → "timeline_events"
 * - query_character_knowledge_boundary → "character_knowledge_boundary"
 * - query_promise_ledger     → "promise_entries"
 * - query_pattern_memory     → "pattern_entries"
 * - query_voice_evidence     → "voice_evidence"
 * - 任意工具空结果           → "no_match"
 */
export type NarrativeResultKind =
  | "canon_entries"
  | "character_state"
  | "character_knowledge_boundary"
  | "timeline_events"
  | "promise_entries"
  | "pattern_entries"
  | "voice_evidence"
  | "chapter_spans"
  | "ranked_evidence"
  | "no_match";

// ============================================================================
// 工具结果详情（统一 sourceRef + evidenceLevel + Phase 3 结果格式）
// ============================================================================

/**
 * 所有叙事工具的 details 必须实现此接口。
 * AgentToolResult.details 字段携带此结构化数据，供 verifier / trajectory 消费。
 *
 * Phase 3 新增 resultKind / returnedCount / truncated / nextQueryHint：
 * - resultKind：结果类型（空结果统一 "no_match"）
 * - returnedCount：本次返回的真实条目/span 计数（空=0）
 * - truncated：结果是否被系统 limit 截断（由系统据 limit 判定，非模型声明）
 * - nextQueryHint：系统确定性生成的下一条检索建议（无则 null，不接受模型自由填写）
 */
export interface NarrativeToolResultDetails {
  /** 追溯引用，如 "ch17#final.md:120-180" 或 "skeleton.json#evt-003" */
  sourceRef: string;
  /** 证据等级 */
  evidenceLevel: EvidenceLevel;
  /** 结果类型（Phase 3） */
  resultKind: NarrativeResultKind;
  /** 本次返回的真实条目/span 数量（空结果=0） */
  returnedCount: number;
  /** 结果是否被系统 limit 截断（由系统据 limit 判定） */
  truncated: boolean;
  /** 系统确定性生成的下一条检索建议（无则 null） */
  nextQueryHint: string | null;
  /** 额外领域数据（工具特定） */
  [key: string]: unknown;
}

// ============================================================================
// 工具副作用类型
// ============================================================================

/**
 * 工具副作用声明：
 * - read_only：只读 workspace 数据，不写入任何文件
 * - candidate_write：只写入隔离的 candidate workspace 目录
 * - propose：产生 patch proposal，不直接覆盖任何文件
 *
 * final_commit 不是工具副作用——只有统一编排器在最终选择后执行 FinalStateCommit。
 */
export type ToolSideEffect = "read_only" | "candidate_write" | "propose";

// ============================================================================
// 权限标识（与 permission-policy.ts 对齐）
// ============================================================================

export type ToolPermission =
  | "workspace_read"
  | "candidate_write"
  | "project_propose"
  | "final_commit";

// ============================================================================
// ToolProtocol — 扩展 AgentTool 的元数据接口
// ============================================================================

/**
 * NovelOS 叙事工具协议。
 *
 * 实现者需提供 AgentTool 的全部字段（name/description/label/parameters/execute），
 * 并追加 requiredPermission / sideEffect / timeoutMs 元数据。
 *
 * NarrativeToolRegistry 在注册时校验：
 * - requiredPermission 不能是 "final_commit"（agent 不可最终提交）
 * - sideEffect="read_only" 的工具 requiredPermission 应为 "workspace_read"
 * - sideEffect="candidate_write" 的工具 requiredPermission 应为 "candidate_write"
 */
export interface ToolProtocol<TParameters extends TSchema = TSchema>
  extends AgentTool<TParameters, NarrativeToolResultDetails> {
  /** 调用此工具所需的权限 */
  requiredPermission: ToolPermission;
  /** 副作用类型 */
  sideEffect: ToolSideEffect;
  /** 执行超时 ms（默认 30000） */
  timeoutMs?: number;
}

// ============================================================================
// 工具执行辅助：构造 NarrativeToolResult
// ============================================================================

/**
 * 构造一个标准的 NarrativeToolResult（content + details）。
 * 工具 execute 函数返回此结构。
 */
export function makeNarrativeToolResult(
  text: string,
  details: NarrativeToolResultDetails,
): {
  content: [{ type: "text"; text: string }];
  details: NarrativeToolResultDetails;
} {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/**
 * 构造一个工具执行错误结果（isError 由 AgentToolResult.terminate 或抛异常表达）。
 * NovelOS 约定：工具执行失败时抛异常（pi-agent-core 会捕获并生成 error tool result），
 * 而不是返回错误 content。此函数仅供需要返回「无结果但非错误」的空结果使用。
 */
export function makeEmptyToolResult(
  sourceRef: string,
  reason: string,
): {
  content: [{ type: "text"; text: string }];
  details: NarrativeToolResultDetails;
} {
  return makeNarrativeToolResult(
    `（无结果）${reason}`,
    {
      sourceRef,
      evidenceLevel: "inferred",
      resultKind: "no_match",
      returnedCount: 0,
      truncated: false,
      nextQueryHint: null,
      reason,
    },
  );
}

// ============================================================================
// 紧凑结果 envelope（Phase 4/5 工具粒度收口，渲染层纯函数）
// ============================================================================

/** 证据强度排序（最强在前），envelope 渲染据此取"最强前 N 条" */
export const EVIDENCE_STRENGTH_ORDER: EvidenceLevel[] = [
  "confirmed_state",
  "exact_chapter_span",
  "confirmed",
  "inferred",
  "profile_only",
];

/** envelope 渲染时最多展示的 ref 数（取最强前 N 条） */
export const ENVELOPE_MAX_REFS = 3;

/** envelope 摘要最大字符数 */
export const ENVELOPE_SUMMARY_MAX_CHARS = 120;

/** envelope 每条 ref 行的内容摘要最大字符数（Phase 5.3.1） */
export const ENVELOPE_CONTENT_MAX_CHARS = 50;

/** 取某条证据对象的 sourceRef（兼容 rankedEvidences / spans / entries 结构） */
function refOf(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const ref = (item as { sourceRef?: unknown }).sourceRef;
  return typeof ref === "string" ? ref : undefined;
}

/** 取某条证据对象的 evidenceLevel（无则按回调回退） */
function levelOf(item: unknown, fallback: EvidenceLevel | undefined): EvidenceLevel | undefined {
  if (!item || typeof item !== "object") return fallback;
  const lv = (item as { evidenceLevel?: unknown }).evidenceLevel;
  return typeof lv === "string" && (EVIDENCE_STRENGTH_ORDER as string[]).includes(lv)
    ? (lv as EvidenceLevel)
    : fallback;
}

/** 取某条证据对象的内容文本（兼容 excerpt / fact / value 字段名） */
function contentOf(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  if (typeof obj.excerpt === "string" && obj.excerpt.trim()) return obj.excerpt.trim();
  if (typeof obj.fact === "string" && obj.fact.trim()) return obj.fact.trim();
  if (typeof obj.value === "string" && obj.value.trim()) {
    const field = typeof obj.field === "string" ? obj.field : undefined;
    return field ? `${field}: ${obj.value}` : obj.value;
  }
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
  return undefined;
}

/** 从 details 中提取证据条目列表（兼容各类 resultKind 的字段名） */
function collectEvidenceItems(details: Record<string, unknown>): Array<{
  sourceRef: string;
  evidenceLevel?: EvidenceLevel;
  content?: string;
}> {
  const rawList = (details.rankedEvidences ??
    details.spans ??
    details.entries) as unknown;
  if (!Array.isArray(rawList)) return [];
  const items: Array<{ sourceRef: string; evidenceLevel?: EvidenceLevel; content?: string }> = [];
  for (const item of rawList) {
    const ref = refOf(item);
    if (!ref) continue;
    items.push({
      sourceRef: ref,
      evidenceLevel: levelOf(item, details.evidenceLevel as EvidenceLevel | undefined),
      content: contentOf(item),
    });
  }
  return items;
}

/**
 * 把 details 渲染为紧凑 envelope 文本（只剪裁"模型可见文本"，不改详情）。
 *
 * 边界（见 docs/phase4-tool-ab-test-design.md §10）：
 * - 摘要：一行 ≤ ENVELOPE_SUMMARY_MAX_CHARS，说明命中数/最高等级/最强 ref。
 * - 来源 + 证据等级 + 内容摘要：只输出最强前 ENVELOPE_MAX_REFS 条的 `[等级] ref - 内容摘要`，
 *   内容摘要截取前 ENVELOPE_CONTENT_MAX_CHARS 字符（不贴全文 excerpt），使模型能判断
 *   证据是否匹配 mustVerify 项（Phase 5.3.1 修复：真实模型 replay 中内容缺失导致
 *   stopRate=0%、duplicateQueries 激增）。
 * - 继续查询提示：仅 truncated=true 时透传系统生成的 nextQueryHint。
 *
 * 纯函数：不读文件、不检索、不排序重判（等级判定权在底层工具），只做呈现。
 */
export function renderCompactEnvelope(details: NarrativeToolResultDetails): string {
  const items = collectEvidenceItems(details as unknown as Record<string, unknown>);
  const returnedCount = typeof details.returnedCount === "number" ? details.returnedCount : items.length;
  const truncated = details.truncated === true;
  const hint = truncated && details.nextQueryHint ? `\n提示：${details.nextQueryHint}` : "";

  // 空结果摘要：以 returnedCount 为权威（>0 即"有命中"）。
  // 守护（Phase 5.2）：returnedCount>0 但条目数组缺失（resultKind 的数组字段不在
  // rankedEvidences/spans/entries 已知集内，或数据畸形）时，绝不得误报「无匹配/无结果」——
  // 只出摘要，不出伪造的 ref 行。
  if (returnedCount === 0) {
    return "无匹配/无结果" + hint;
  }

  // 有命中但无可提取条目：只出摘要（命中数 + 顶层 evidenceLevel），不伪造 ref。
  if (items.length === 0) {
    const fallback = `命中 ${returnedCount} 条${details.evidenceLevel ? `（${details.evidenceLevel}）` : ""}`;
    return fallback + hint;
  }

  // 按强度排序（details 已按 searchRanked 排序，此处兜底但不重判等级）
  const sorted = [...items].sort(
    (a, b) =>
      (a.evidenceLevel ? EVIDENCE_STRENGTH_ORDER.indexOf(a.evidenceLevel) : EVIDENCE_STRENGTH_ORDER.length) -
      (b.evidenceLevel ? EVIDENCE_STRENGTH_ORDER.indexOf(b.evidenceLevel) : EVIDENCE_STRENGTH_ORDER.length),
  );
  const top = sorted.slice(0, Math.min(ENVELOPE_MAX_REFS, returnedCount));
  const strongestLevel = top[0].evidenceLevel ?? details.evidenceLevel;

  // 摘要（一行，≤ 120 字符）
  const summary = `命中 ${returnedCount} 条${strongestLevel ? `（${strongestLevel}）` : ""}，最强 ref=${top[0].sourceRef}`;
  const summaryText = summary.length > ENVELOPE_SUMMARY_MAX_CHARS
    ? summary.slice(0, ENVELOPE_SUMMARY_MAX_CHARS)
    : summary;

  // 来源 + 证据等级 + 内容摘要（每项一行，只列最强前 N 条 ref）
  // Phase 5.3.1：附上内容摘要使模型能判断证据匹配性，防止 stopRate=0% 和重复查询
  const refLines = top.map((item) => {
    const base = `[${item.evidenceLevel ?? "unknown"}] ${item.sourceRef}`;
    if (!item.content) return base;
    const snippet = item.content.replace(/\n/g, " ").slice(0, ENVELOPE_CONTENT_MAX_CHARS);
    return `${base} - ${snippet}`;
  });

  const parts = [summaryText, ...refLines];
  if (truncated && details.nextQueryHint) {
    parts.push(`提示：${details.nextQueryHint}`);
  }
  return parts.join("\n");
}
