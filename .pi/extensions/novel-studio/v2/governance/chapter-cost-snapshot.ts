/**
 * ChapterCostSnapshot — 章节成本快照（per-release 隔离成本统计）
 *
 * 真相源：用户第三轮核验 P1 历史成本跨 release 污染（2026-07-17）
 * + 用户第四轮核验 simplicity-gate（release-health-aggregator.ts 920 行超限）
 *
 * 从 release-health-aggregator.ts 抽取的 cost snapshot 功能：
 * - 类型：TraceModelCall / CostStats / ChapterCostSnapshot
 * - 常量：CHAPTER_COST_SNAPSHOT_SCHEMA_ID / VERSION
 * - 函数：readChapterCostStats / computeCostStatsFromModelCalls / mergeCostStats /
 *        normalizeCostStats / zeroCostStats / writeChapterCostSnapshot /
 *        computeChapterCostSnapshotFromTrace / extractModelCallsFromTrace
 *
 * 设计原则：
 * - 纯函数 + 只读文件系统（writeChapterCostSnapshot 例外，写入快照文件）
 * - 不调用模型、不修改长期状态
 * - 容错：snapshot/trace 损坏时返回 null/zero，不抛错
 *
 * 向后兼容：release-health-aggregator.ts re-export 本模块公开符号，
 * 现有 import 路径无需修改。
 *
 * 边界（READY_LOCAL）：
 * - 闭包自包含（仅依赖 node:fs / node:path / node:crypto + governance sibling 类型）
 * - P7 Stage B-Read：新增 trace-projection-reader 读侧投影依赖（纯投影叶子模块，
 *   仅 import trace-projections + audit-event-types + node:fs/path，不拉入
 *   orchestrator 写闭包），仍可安全进入生产闭包（dist/）与 dist-test 闭包
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChapterProxyApprovalArtifact } from "./chapter-proxy-approval-types.js";
// P7 Stage B-Read：投影优先读（审计流 → legacy 读视图），旧文件回退。
// 注意：这是「读侧投影」最小依赖（纯投影叶子模块），非 orchestrator 写闭包。
import { loadQualityTraceProjection } from "../core/audit/trace-projection-reader.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * 单次模型调用遥测条目（trace 中 gates[].evidence.modelCalls 元素）。
 *
 * 仅声明聚合所需字段，与 v2/core/orchestrator-types.ts ModelCallEntry 结构兼容，
 * 但不直接 import 以避免把 v2/core 闭包拉入本模块。
 */
export interface TraceModelCall {
  route: string;
  kind: string;
  model?: string;
  durationMs: number;
  ts?: number;
  failed?: boolean;
  provider?: string;
}

/** Release 成本统计（从 trace modelCalls 聚合） */
export interface CostStats {
  /** 总模型调用次数 */
  totalCalls: number;
  /** 总耗时 ms */
  totalDurationMs: number;
  /** 平均耗时 ms（totalCalls=0 时为 0） */
  averageDurationMs: number;
  /** 失败调用次数（failed=true） */
  totalFailedCalls: number;
  /** 按 provider 分桶计数（无 provider 字段计入 "unknown"） */
  callsByProvider: Record<string, number>;
  /** 按 route 分桶计数 */
  callsByRoute: Record<string, number>;
}

// ============================================================================
// P1 修复：Chapter 成本快照（per-release 隔离成本统计）
// ============================================================================

/**
 * Chapter 成本快照（finalization 时写入）。
 *
 * P1 修复（用户第三轮核验）：避免历史成本跨 release 污染。
 * 旧 BUG：`aggregateReleaseCostStats` 直接读当前 `{chapterId}-quality-trace.json`；
 * 同一章节被新 release 重跑后 trace 被覆盖，旧 release 看到新成本。
 *
 * 快照策略：finalization 时（章节保存 + 状态提交后）写入固定成本快照到
 * `workspaces/{id}/chapter-approvals/{approvalId}-cost-snapshot.json`，
 * 与 approval artifact 同目录、同 approvalId 命名空间。
 *
 * 读取规则：`aggregateReleaseCostStats` 优先读快照；快照缺失时回退读当前 trace
 * （向后兼容；finalization 未接线时仍可工作）。
 *
 * 真相源：用户第三轮核验 P1 历史成本跨 release 污染（2026-07-17）
 */
export interface ChapterCostSnapshot {
  schemaId: "pinovel.chapter-cost-snapshot";
  schemaVersion: 1;
  approvalId: string;
  chapterId: string;
  releaseId: string;
  /** 写入快照时 trace 文件内容的 SHA-256（用于检测 trace 后续是否被覆盖） */
  traceHash: string;
  costStats: CostStats;
  writtenAt: string;
}

/** ChapterCostSnapshot schema 常量（与接口同源） */
export const CHAPTER_COST_SNAPSHOT_SCHEMA_ID = "pinovel.chapter-cost-snapshot" as const;
export const CHAPTER_COST_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 实现
// ============================================================================

/**
 * 读取单个 chapter 的成本统计（P1 修复 helper）。
 *
 * 优先级：
 * 1. {approvalId}-cost-snapshot.json（finalization 时写入的固定快照）
 * 2. traces/{chapterId}-quality-trace.json（当前 trace，向后兼容）
 *
 * @returns CostStats 或 null（snapshot/trace 均不可读时）
 */
export function readChapterCostStats(
  workspacePath: string,
  artifact: ChapterProxyApprovalArtifact,
): CostStats | null {
  const approvalsDir = join(workspacePath, "chapter-approvals");

  // 1. 优先读快照
  const snapshotPath = join(approvalsDir, `${artifact.approvalId}-cost-snapshot.json`);
  if (existsSync(snapshotPath)) {
    try {
      const snapshotDoc = JSON.parse(readFileSync(snapshotPath, "utf-8"));
      if (
        snapshotDoc &&
        typeof snapshotDoc === "object" &&
        snapshotDoc.costStats &&
        typeof snapshotDoc.costStats === "object"
      ) {
        return normalizeCostStats(snapshotDoc.costStats);
      }
    } catch {
      // 损坏 snapshot 跳过；fall back to trace
    }
  }

  // 2. 投影优先：从审计流重建 legacy 读视图（Stage B-Read），命中则按投影计算成本
  try {
    const projection = loadQualityTraceProjection(workspacePath, artifact.chapterId);
    if (projection) {
      const modelCalls = extractModelCallsFromTrace(projection);
      if (modelCalls && modelCalls.length > 0) {
        return computeCostStatsFromModelCalls(modelCalls);
      }
    }
  } catch {
    // 投影读失败不阻断；继续回退读旧 trace 文件
  }

  // 3. 回退读 trace
  const tracePath = join(workspacePath, "traces", `${artifact.chapterId}-quality-trace.json`);
  if (!existsSync(tracePath)) return null;

  let traceDoc: unknown;
  try {
    traceDoc = JSON.parse(readFileSync(tracePath, "utf-8"));
  } catch {
    return null;
  }

  const modelCalls = extractModelCallsFromTrace(traceDoc);
  if (!modelCalls || modelCalls.length === 0) return null;

  return computeCostStatsFromModelCalls(modelCalls);
}

/**
 * 从 modelCalls 数组聚合 CostStats（提取自原 aggregateReleaseCostStats 内联逻辑）。
 */
function computeCostStatsFromModelCalls(modelCalls: TraceModelCall[]): CostStats {
  let totalDurationMs = 0;
  let totalFailedCalls = 0;
  const callsByProvider: Record<string, number> = {};
  const callsByRoute: Record<string, number> = {};

  for (const call of modelCalls) {
    totalDurationMs += call.durationMs;
    if (call.failed === true) {
      totalFailedCalls += 1;
    }
    const providerKey = call.provider ?? "unknown";
    callsByProvider[providerKey] = (callsByProvider[providerKey] ?? 0) + 1;
    const routeKey = call.route ?? "unknown";
    callsByRoute[routeKey] = (callsByRoute[routeKey] ?? 0) + 1;
  }

  const totalCalls = modelCalls.length;
  const averageDurationMs = totalCalls > 0 ? totalDurationMs / totalCalls : 0;

  return {
    totalCalls,
    totalDurationMs,
    averageDurationMs,
    totalFailedCalls,
    callsByProvider,
    callsByRoute,
  };
}

/**
 * 合并多个 per-chapter CostStats 为单个聚合 CostStats（P1 修复 helper）。
 *
 * 用于支持快照模式：每个 chapter 有自己的 CostStats（来自 snapshot 或 trace），
 * 合并后得到 release 级聚合。
 */
export function mergeCostStats(stats: CostStats[]): CostStats {
  let totalCalls = 0;
  let totalDurationMs = 0;
  let totalFailedCalls = 0;
  const callsByProvider: Record<string, number> = {};
  const callsByRoute: Record<string, number> = {};

  for (const s of stats) {
    totalCalls += s.totalCalls;
    totalDurationMs += s.totalDurationMs;
    totalFailedCalls += s.totalFailedCalls;
    if (s.callsByProvider && typeof s.callsByProvider === "object") {
      for (const [k, v] of Object.entries(s.callsByProvider)) {
        callsByProvider[k] = (callsByProvider[k] ?? 0) + v;
      }
    }
    if (s.callsByRoute && typeof s.callsByRoute === "object") {
      for (const [k, v] of Object.entries(s.callsByRoute)) {
        callsByRoute[k] = (callsByRoute[k] ?? 0) + v;
      }
    }
  }

  const averageDurationMs = totalCalls > 0 ? totalDurationMs / totalCalls : 0;

  return {
    totalCalls,
    totalDurationMs,
    averageDurationMs,
    totalFailedCalls,
    callsByProvider,
    callsByRoute,
  };
}

/**
 * 规范化外部 JSON 为 CostStats（容错读取 snapshot 用）。
 *
 * 防御性解析：snapshot 文件可能被篡改或损坏，逐字段校验 + 缺失字段填默认值。
 */
function normalizeCostStats(raw: unknown): CostStats {
  if (!raw || typeof raw !== "object") {
    return zeroCostStats();
  }
  const s = raw as Record<string, unknown>;
  const totalCalls = typeof s.totalCalls === "number" && Number.isFinite(s.totalCalls) ? s.totalCalls : 0;
  const totalDurationMs =
    typeof s.totalDurationMs === "number" && Number.isFinite(s.totalDurationMs) ? s.totalDurationMs : 0;
  const totalFailedCalls =
    typeof s.totalFailedCalls === "number" && Number.isFinite(s.totalFailedCalls) ? s.totalFailedCalls : 0;
  const callsByProvider =
    s.callsByProvider && typeof s.callsByProvider === "object"
      ? (s.callsByProvider as Record<string, number>)
      : {};
  const callsByRoute =
    s.callsByRoute && typeof s.callsByRoute === "object"
      ? (s.callsByRoute as Record<string, number>)
      : {};
  const averageDurationMs = totalCalls > 0 ? totalDurationMs / totalCalls : 0;

  return {
    totalCalls,
    totalDurationMs,
    averageDurationMs,
    totalFailedCalls,
    callsByProvider,
    callsByRoute,
  };
}

/** 全零 CostStats（容错兜底） */
function zeroCostStats(): CostStats {
  return {
    totalCalls: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    totalFailedCalls: 0,
    callsByProvider: {},
    callsByRoute: {},
  };
}

/**
 * 写入 chapter 成本快照（finalization 时调用）。
 *
 * P1 修复：在章节保存 + 状态提交成功后，将当前 trace 的成本统计写入
 * `workspaces/{id}/chapter-approvals/{approvalId}-cost-snapshot.json`，
 * 与 approval artifact 同目录、同 approvalId 命名空间。
 *
 * 后续 `aggregateReleaseCostStats` 优先读快照，避免同一 chapter 被新 release
 * 重跑后 trace 覆盖导致旧 release 看到新成本（跨 release 历史成本污染）。
 *
 * 写入失败不抛错（finalization 主流程已成功；快照缺失时聚合回退读 trace，
 * 仍可工作，只是丧失 per-release 隔离能力）。
 *
 * @param workspacePath workspace 根路径
 * @param params { approvalId, chapterId, releaseId, traceHash, costStats }
 */
export function writeChapterCostSnapshot(
  workspacePath: string,
  params: {
    approvalId: string;
    chapterId: string;
    releaseId: string;
    traceHash: string;
    costStats: CostStats;
  },
): void {
  const approvalsDir = join(workspacePath, "chapter-approvals");
  const snapshotPath = join(approvalsDir, `${params.approvalId}-cost-snapshot.json`);
  const snapshot: ChapterCostSnapshot = {
    schemaId: CHAPTER_COST_SNAPSHOT_SCHEMA_ID,
    schemaVersion: CHAPTER_COST_SNAPSHOT_SCHEMA_VERSION,
    approvalId: params.approvalId,
    chapterId: params.chapterId,
    releaseId: params.releaseId,
    traceHash: params.traceHash,
    costStats: params.costStats,
    writtenAt: new Date().toISOString(),
  };
  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  } catch {
    // 快照写入失败不阻断 finalization；聚合时回退读 trace
  }
}

/**
 * 从 trace 文件计算成本快照所需数据（trace hash + cost stats）。
 *
 * 供 finalization 入口在 commit 成功后调用：
 * 1. 读取 trace 文件内容
 * 2. 计算 SHA-256 hash（用于检测 trace 后续是否被覆盖）
 * 3. 提取 v2_final_selected gate.evidence.modelCalls 并聚合为 CostStats
 *
 * @returns { traceHash, costStats } 或 null（trace 不存在/损坏时）
 */
export function computeChapterCostSnapshotFromTrace(
  workspacePath: string,
  chapterId: string,
): { traceHash: string; costStats: CostStats } | null {
  const tracePath = join(workspacePath, "traces", `${chapterId}-quality-trace.json`);
  if (!existsSync(tracePath)) return null;

  let traceContent: string;
  try {
    traceContent = readFileSync(tracePath, "utf-8");
  } catch {
    return null;
  }

  const traceHash = createHash("sha256").update(traceContent, "utf-8").digest("hex");

  let traceDoc: unknown;
  try {
    traceDoc = JSON.parse(traceContent);
  } catch {
    return null;
  }

  const modelCalls = extractModelCallsFromTrace(traceDoc);
  if (!modelCalls || modelCalls.length === 0) {
    return {
      traceHash,
      costStats: zeroCostStats(),
    };
  }

  return {
    traceHash,
    costStats: computeCostStatsFromModelCalls(modelCalls),
  };
}

/**
 * 从 trace 文档中提取 v2_final_selected gate 的 evidence.modelCalls。
 *
 * trace 形状（QualityTraceDocument）：
 *   { gates: [{ stage, evidence }, ...] }
 * 找到 stage === "v2_final_selected" 的 gate，取 evidence.modelCalls。
 *
 * 找不到时返回 null；evidence.modelCalls 非数组时返回 null。
 */
function extractModelCallsFromTrace(traceDoc: unknown): TraceModelCall[] | null {
  if (!traceDoc || typeof traceDoc !== "object") return null;
  const doc = traceDoc as { gates?: unknown };
  if (!Array.isArray(doc.gates)) return null;

  for (const gate of doc.gates) {
    if (!gate || typeof gate !== "object") continue;
    const g = gate as { stage?: unknown; evidence?: unknown };
    if (g.stage !== "v2_final_selected") continue;
    if (!g.evidence || typeof g.evidence !== "object") continue;
    const evidence = g.evidence as { modelCalls?: unknown };
    if (!Array.isArray(evidence.modelCalls)) return null;
    return evidence.modelCalls as TraceModelCall[];
  }
  return null;
}
