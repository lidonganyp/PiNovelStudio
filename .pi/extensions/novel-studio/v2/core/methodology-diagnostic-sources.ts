/**
 * methodology-diagnostic-sources — 诊断层数据源定义与读取工具
 *
 * 从 methodology-diagnostic-state.ts 拆出（P1-5 + P2-8 simplicity gate）：
 * - DiagnosticSourceId 类型（含 3 个新源：reader_feedback / return_chapter_provenance /
 *   chapter_progression_contracts）
 * - SOURCES 数组（支持 fallback 路径，优先读 -derived.json 派生缓存）
 * - readJsonSource 函数（尝试每个路径，第一个存在的文件胜出）
 *
 * P1-5 修复（2026-07-21）：诊断层之前只读取 6 个旧来源，不读取 reader-feedback.json /
 * return-chapter-provenance.json / chapter-progression-contracts.json。现在新增 3 个源 ID，
 * 由 methodology-diagnostic-advisory.ts 消费产出 advisory 信号。
 *
 * P0-1 修复（2026-07-21）：narrative_state / fatigue_state / arc_registry 三个现有源
 * 优先读 *-derived.json（派生缓存，由 narrative-state-bridge / closure-tracker-integration
 * 在 FinalStateCommit 后写入），fallback 到 legacy 路径。这样诊断层与派生缓存保持一致，
 * 不破坏 FinalStateCommit 是唯一权威状态提交点的不变量。
 *
 * 设计原则（与 methodology-diagnostic-state.ts 一致）：
 * - 只读，不写入、不归一化、不修复 workspace 文件
 * - 输出只作 advisory 证据，不进入 raw prompt
 * - 失败返回 status=missing/malformed，不抛异常
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./methodology-diagnostic-utils.js";

// ============================================================================
// 类型定义
// ============================================================================

export type DiagnosticSourceId =
  | "config"
  | "narrative_state_store"
  | "narrative_state"
  | "fatigue_state"
  | "world_items"
  | "arc_registry"
  // P1-5 新增 3 个 advisory 源（2026-07-21）
  | "reader_feedback"
  | "return_chapter_provenance"
  | "chapter_progression_contracts";

export type DiagnosticSourceStatus = "available" | "missing" | "malformed";

export interface DiagnosticSourceAvailability {
  sourceId: DiagnosticSourceId;
  /** 报告的 canonical 路径（relativePaths[0]），用于 trace 审计 */
  relativePath: string;
  sourceRef: string;
  status: DiagnosticSourceStatus;
  reason: string | null;
}

export interface ReadJsonResult {
  source: DiagnosticSourceAvailability;
  value: Record<string, unknown> | null;
}

// ============================================================================
// SOURCES 定义（支持 fallback 路径）
// ============================================================================

/**
 * 诊断层数据源列表。
 *
 * relativePaths 按顺序尝试，第一个存在的文件胜出。这允许：
 * - 优先读 -derived.json 派生缓存（P0-1：不破坏 FinalStateCommit 事务边界）
 * - fallback 到 legacy 路径（向后兼容，旧 workspace 无派生缓存时仍可读取）
 */
export const SOURCES: ReadonlyArray<{
  sourceId: DiagnosticSourceId;
  relativePaths: readonly string[];
}> = [
  { sourceId: "config", relativePaths: ["config.json"] },
  { sourceId: "narrative_state_store", relativePaths: ["narrative-state-store.json"] },
  {
    sourceId: "narrative_state",
    relativePaths: ["series/narrative-state-derived.json", "series/narrative-state.json"],
  },
  {
    sourceId: "fatigue_state",
    relativePaths: ["series/fatigue-state-derived.json", "series/fatigue-state.json"],
  },
  { sourceId: "world_items", relativePaths: ["series/world-items.json"] },
  {
    sourceId: "arc_registry",
    relativePaths: ["series/arc-registry-derived.json", "series/arc-registry.json"],
  },
  // P1-5 新增 3 个 advisory 源（2026-07-21）
  { sourceId: "reader_feedback", relativePaths: ["series/reader-feedback.json"] },
  {
    sourceId: "return_chapter_provenance",
    relativePaths: ["series/return-chapter-provenance.json"],
  },
  {
    sourceId: "chapter_progression_contracts",
    relativePaths: ["series/chapter-progression-contracts.json"],
  },
];

// ============================================================================
// 读取函数
// ============================================================================

/**
 * 读取 JSON 源，支持 fallback 路径。
 *
 * 行为：
 * - 依次尝试 relativePaths 中的每个路径，第一个存在的文件胜出
 * - 文件存在但 JSON 解析失败 → 返回 malformed（不再尝试后续 fallback 路径）
 * - 所有路径都不存在 → 返回 missing
 * - workspacePath 为空 → 返回 missing (reason=workspace_path_unavailable)
 *
 * 报告的 relativePath 始终是 relativePaths[0]（canonical 路径），即使实际读取的是
 * fallback 路径。这是为了 trace 稳定性：consumer 不需要关心实际读了哪个 fallback。
 */
export function readJsonSource(
  workspacePath: string | undefined,
  descriptor: { sourceId: DiagnosticSourceId; relativePaths: readonly string[] },
): ReadJsonResult {
  const base = {
    sourceId: descriptor.sourceId,
    relativePath: descriptor.relativePaths[0],
    sourceRef: descriptor.relativePaths[0],
  };
  if (!workspacePath?.trim()) {
    return {
      source: { ...base, status: "missing", reason: "workspace_path_unavailable" },
      value: null,
    };
  }
  for (const relativePath of descriptor.relativePaths) {
    const absolutePath = join(workspacePath, ...relativePath.split("/"));
    if (!existsSync(absolutePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        return {
          source: { ...base, status: "malformed", reason: "json_root_must_be_object" },
          value: null,
        };
      }
      return {
        source: { ...base, status: "available", reason: null },
        value: parsed,
      };
    } catch (error: unknown) {
      return {
        source: {
          ...base,
          status: "malformed",
          reason: error instanceof SyntaxError ? "invalid_json" : "read_failed",
        },
        value: null,
      };
    }
  }
  return {
    source: { ...base, status: "missing", reason: "file_not_found" },
    value: null,
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 根据源的 status 生成不可用原因字符串。
 * 用于各 build* 函数的 emptyReason 字段，提供可追溯的缺失/损坏原因。
 */
export function unavailableReason(source: ReadJsonResult, fallback: string): string {
  return source.source.status === "malformed"
    ? `${source.source.sourceId}_malformed`
    : source.source.status === "missing"
      ? `${source.source.sourceId}_missing`
      : fallback;
}
