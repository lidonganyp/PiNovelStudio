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
// 工具结果详情（统一 sourceRef + evidenceLevel）
// ============================================================================

/**
 * 所有叙事工具的 details 必须实现此接口。
 * AgentToolResult.details 字段携带此结构化数据，供 verifier / trajectory 消费。
 */
export interface NarrativeToolResultDetails {
  /** 追溯引用，如 "ch17#final.md:120-180" 或 "skeleton.json#evt-003" */
  sourceRef: string;
  /** 证据等级 */
  evidenceLevel: EvidenceLevel;
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
    { sourceRef, evidenceLevel: "inferred", reason },
  );
}
