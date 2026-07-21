/**
 * Closure-state compatibility parsers for MethodologyDiagnosticState.
 *
 * Normalizes both canonical snake_case registries and existing production
 * camelCase registries without mutating either source format.
 */

import {
  encodeRefComponent,
  finiteNumber,
  recordValue,
  stringValue,
} from "./methodology-diagnostic-utils.js";
import type {
  OpenArcDiagnosticEntry,
  PendingForeshadowDiagnosticEntry,
} from "./methodology-diagnostic-state.js";

const OPEN_ARC_STATUSES = new Set([
  "idle",
  "opened",
  "open",
  "advancing",
  "climaxed",
  "in_progress",
]);

export function parseOpenArc(
  value: Record<string, unknown>,
): OpenArcDiagnosticEntry | null {
  const arcId = stringValue(value.arc_id) ?? stringValue(value.id);
  const name = stringValue(value.name);
  const status = stringValue(value.status) ?? "unknown";
  if (!arcId || !name || !OPEN_ARC_STATUSES.has(status)) return null;
  return {
    arcId,
    name,
    arcType: stringValue(value.arc_type) ?? stringValue(value.type) ?? "unknown",
    priority: stringValue(value.priority) ?? "unknown",
    status,
    coreQuestion: stringValue(value.core_question) ?? stringValue(value.coreQuestion) ?? "",
    chapterOpened: finiteNumber(value.chapter_opened) ?? finiteNumber(value.openedChapter),
    expectedClosureWindow: numericWindow(value.expected_closure_window)
      ?? singleChapterWindow(value.expectedClosureChapter),
    sourceRef: `series/arc-registry.json#arcs:${encodeRefComponent(arcId)}`,
  };
}

export function parsePendingForeshadow(
  value: Record<string, unknown>,
): PendingForeshadowDiagnosticEntry | null {
  const foreshadowId = stringValue(value.id);
  const description = stringValue(value.description);
  const recalled = value.recalled === true || stringValue(value.status) === "resolved";
  if (!foreshadowId || !description || recalled) return null;
  return {
    foreshadowId,
    description,
    level: stringValue(value.level),
    chapterPlanted: finiteNumber(value.chapter_planted)
      ?? finiteNumber(value.plantedChapter)
      ?? finiteNumber(value.openedChapter),
    expectedRecallWindow: numericWindow(value.expected_recall_window)
      ?? singleChapterWindow(value.targetChapter)
      ?? singleChapterWindow(value.expectedRecallChapter),
    sourceRef: `series/arc-registry.json#pending_foreshadows:${encodeRefComponent(foreshadowId)}`,
  };
}

function numericWindow(value: unknown): Record<string, number | null> | null {
  const record = recordValue(value);
  if (!record) return null;
  const result: Record<string, number | null> = {};
  for (const key of ["earliest", "optimal", "latest", "start", "end"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) result[key] = finiteNumber(record[key]);
  }
  if (Object.prototype.hasOwnProperty.call(record, "earliestChapter")) {
    result.earliest = finiteNumber(record.earliestChapter);
  }
  if (Object.prototype.hasOwnProperty.call(record, "latestChapter")) {
    result.latest = finiteNumber(record.latestChapter);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function singleChapterWindow(value: unknown): Record<string, number | null> | null {
  const chapter = finiteNumber(value);
  return chapter === null
    ? null
    : { earliest: chapter, optimal: chapter, latest: chapter };
}
