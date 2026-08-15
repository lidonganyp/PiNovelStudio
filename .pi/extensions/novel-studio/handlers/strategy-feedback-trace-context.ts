/**
 * Strategy feedback trace-context loader.
 *
 * Recovers model/strategy metadata from the primary unified trace or its
 * fallback archive so public feedback calls do not need to repeat data that
 * the chapter-generation pipeline already persisted.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// P7 Stage B-Read：投影优先读（审计流 → legacy 读视图），旧文件回退。
import { loadQualityTraceProjection } from "../v2/core/audit/trace-projection-reader.js";

export interface StrategyTraceContext {
  modelVersion: string;
  selectedStrategyIds: string[];
  sourceChapter: string;
  opportunityType: string;
  tracePath: string;
  /** USER-FEEDBACK-EVIDENCE-PIPELINE-1：完整血缘字段（可能部分缺失） */
  strategyBundleId?: string;
  orchestratorRunId?: string;
  exposureId?: string;
  promptBundleId?: string;
  candidateId?: string;
  deliveredSource?: "editorial" | "raw" | "fallback";
  /**
   * MA-5.2：从 quality-trace stageResults.agentLineageIndex 恢复的索引快照。
   * 供策略信誉写入前 isLineageCompleteForStrategyUpdate 使用。
   */
  agentLineageIndex?: Record<string, unknown> | null;
}

function isSafeTraceSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function extractStrategyTraceContext(
  document: unknown,
  tracePath: string,
): StrategyTraceContext | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const root = document as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (root.strategyContext) candidates.push(root.strategyContext);
  if (Array.isArray(root.gates)) {
    for (const gate of root.gates) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
      const evidence = (gate as Record<string, unknown>).evidence;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) continue;
      const evidenceRecord = evidence as Record<string, unknown>;
      if (evidenceRecord.strategyContext) candidates.push(evidenceRecord.strategyContext);
      const stageResults = evidenceRecord.stageResults;
      if (stageResults && typeof stageResults === "object" && !Array.isArray(stageResults)) {
        const selection = (stageResults as Record<string, unknown>).authorStyleStrategySelection;
        if (selection) {
          const enriched =
            selection && typeof selection === "object" && !Array.isArray(selection)
              ? {
                  ...(selection as Record<string, unknown>),
                  agentLineageIndex:
                    (stageResults as Record<string, unknown>).agentLineageIndex ??
                    (selection as Record<string, unknown>).agentLineageIndex,
                }
              : selection;
          candidates.push(enriched);
        } else if ((stageResults as Record<string, unknown>).agentLineageIndex) {
          candidates.push({
            modelVersion: "unknown",
            agentLineageIndex: (stageResults as Record<string, unknown>).agentLineageIndex,
          });
        }
      }
    }
  }
  for (const key of ["traceRecords", "records"] as const) {
    const records = root[key];
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const strategyContext = (record as Record<string, unknown>).strategyContext;
      if (strategyContext) candidates.push(strategyContext);
    }
  }

  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    const modelVersion = typeof value.modelVersion === "string" ? value.modelVersion.trim() : "";
    if (!modelVersion) continue;
    const selectedStrategyIds = Array.isArray(value.selectedStrategyIds)
      ? value.selectedStrategyIds.filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        )
      : [];
    const asString = (field: unknown): string | undefined =>
      typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
    const deliveredSourceRaw = value.deliveredSource;
    const deliveredSource =
      deliveredSourceRaw === "editorial" ||
      deliveredSourceRaw === "raw" ||
      deliveredSourceRaw === "fallback"
        ? deliveredSourceRaw
        : undefined;
    const lineageIndex =
      value.agentLineageIndex &&
      typeof value.agentLineageIndex === "object" &&
      !Array.isArray(value.agentLineageIndex)
        ? (value.agentLineageIndex as Record<string, unknown>)
        : null;
    // modelVersion=unknown 仅用于携带 lineage index 的兜底候选；无 index 则跳过
    if (modelVersion === "unknown" && !lineageIndex) continue;
    return {
      modelVersion: modelVersion === "unknown" ? "" : modelVersion,
      selectedStrategyIds,
      sourceChapter:
        typeof value.sourceChapter === "string" && value.sourceChapter.trim()
          ? value.sourceChapter.trim()
          : "",
      opportunityType:
        typeof value.opportunityType === "string" && value.opportunityType.trim()
          ? value.opportunityType.trim()
          : "author_style",
      tracePath,
      strategyBundleId: asString(value.strategyBundleId),
      orchestratorRunId: asString(value.orchestratorRunId),
      exposureId: asString(value.exposureId),
      promptBundleId: asString(value.promptBundleId),
      candidateId: asString(value.candidateId),
      deliveredSource,
      agentLineageIndex: lineageIndex,
    };
  }
  return null;
}

export function loadStrategyTraceContext(
  projectRoot: string,
  workspaceId: string,
  chapterId: string,
): StrategyTraceContext | null {
  if (!isSafeTraceSegment(workspaceId) || !isSafeTraceSegment(chapterId)) return null;

  // P7 Stage B-Read：投影优先读——先尝试从审计流重建 legacy 读视图，
  // 命中则直接返回；未命中（无审计流 / 无可重建数据）回退读旧文件。
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  try {
    const projection = loadQualityTraceProjection(workspacePath, chapterId);
    if (projection) {
      const projectionTracePath = join(workspacePath, "traces", `${chapterId}-quality-trace.json`);
      const context = extractStrategyTraceContext(projection, projectionTracePath);
      if (context) return context;
    }
  } catch {
    // 投影读失败不阻断；继续回退读旧文件。
  }

  const chapterIds = [...new Set([chapterId, chapterId.replace(/^ch/i, "")].filter(Boolean))];
  const candidatePaths = chapterIds.map((id) =>
    join(projectRoot, "workspaces", workspaceId, "traces", `${id}-quality-trace.json`),
  );

  const fallbackDir = join(projectRoot, "reports", "traces");
  if (existsSync(fallbackDir)) {
    try {
      const fallbackPaths = readdirSync(fallbackDir)
        .filter((name) =>
          chapterIds.some(
            (id) =>
              name.startsWith(`${workspaceId}-${id}-quality-trace-fallback-`) &&
              name.endsWith(".json"),
          ),
        )
        .map((name) => join(fallbackDir, name))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
      candidatePaths.push(...fallbackPaths);
    } catch {
      // Keep trying the primary trace when the fallback directory is unreadable.
    }
  }

  for (const tracePath of candidatePaths) {
    if (!existsSync(tracePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(tracePath, "utf8")) as unknown;
      const context = extractStrategyTraceContext(parsed, tracePath);
      if (context) return context;
    } catch {
      // A damaged trace is not trusted; continue to the next retained copy.
    }
  }
  return null;
}
