/**
 * Strategy feedback trace-context loader.
 *
 * Recovers model/strategy metadata from the primary unified trace or its
 * fallback archive so public feedback calls do not need to repeat data that
 * the chapter-generation pipeline already persisted.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface StrategyTraceContext {
  modelVersion: string;
  selectedStrategyIds: string[];
  sourceChapter: string;
  opportunityType: string;
  tracePath: string;
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
        if (selection) candidates.push(selection);
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
    return {
      modelVersion,
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
