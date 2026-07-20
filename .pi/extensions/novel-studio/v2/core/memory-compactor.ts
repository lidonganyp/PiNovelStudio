/** MEMORY-COMPACTION-1 — append-only event log → active narrative state。 */

import type {
  NarrativeStateEntry,
  NarrativeStateStore,
  StateEntryBase,
} from "./final-state-commit.js";

export interface MemoryCompactionReport {
  eventCount: number;
  activeCount: number;
  merged: Array<{ activeId: string; mergedIds: string[]; sourceRefs: string[] }>;
  omitted: number;
  quarantined: Array<{ id: string; reason: string; sourceRef: string }>;
  conflicted: Array<{ key: string; ids: string[]; sourceRefs: string[] }>;
  superseded: Array<{ oldId: string; newId: string; effectiveTo: string }>;
}

export interface MemoryCompactionResult {
  store: NarrativeStateStore;
  report: MemoryCompactionReport;
}

export function compactNarrativeMemory(store: NarrativeStateStore): MemoryCompactionResult {
  const eventLog = [...(store.eventLog ?? legacyEvents(store))];
  const active = new Map<string, NarrativeStateEntry>();
  // Existing quarantine is durable audit state. Rebuilding active memory from
  // eventLog must not erase it or reactivate the exact provenance it rejected.
  const quarantine: NarrativeStateEntry[] = [...(store.quarantine ?? [])];
  const quarantineReasons = new Map<string, string>();
  const priorReasons = new Map(
    (store.compactionReport?.quarantined ?? []).map((item) => [item.id, item.reason])
  );
  const quarantinedProvenance = new Set<string>();
  for (const entry of quarantine) {
    const reason = (entry as NarrativeStateEntry & { _quarantineReason?: string })._quarantineReason
      ?? priorReasons.get(entry.id)
      ?? "preexisting_quarantine";
    quarantineReasons.set(entry.id, reason);
    for (const sourceRef of entry.sourceRefs ?? [entry.sourceRef]) {
      quarantinedProvenance.add(provenanceKey(entry, sourceRef));
    }
  }
  let quarantinedEventCount = 0;
  const merged: MemoryCompactionReport["merged"] = [];
  const conflicted: MemoryCompactionReport["conflicted"] = [];
  const superseded: MemoryCompactionReport["superseded"] = [];
  const sameChapterGroups = new Map<string, NarrativeStateEntry[]>();

  for (const entry of eventLog) {
    if ((entry.sourceRefs ?? [entry.sourceRef]).some(
      (sourceRef) => quarantinedProvenance.has(provenanceKey(entry, sourceRef))
    )) {
      quarantinedEventCount += 1;
      continue;
    }
    if (entry.confidence < 0.5 || entry.sourceRef.endsWith(":not-found")) {
      quarantine.push(entry);
      quarantineReasons.set(entry.id, "low_confidence_or_not_found");
      quarantinedEventCount += 1;
      continue;
    }
    const semanticKey = memoryKey(entry);
    const chapterKey = `${semanticKey}:${entry.sourceChapter}`;
    const chapterGroup = sameChapterGroups.get(chapterKey) ?? [];
    chapterGroup.push(entry);
    sameChapterGroups.set(chapterKey, chapterGroup);

    const existing = active.get(semanticKey);
    if (!existing) {
      active.set(semanticKey, withGovernance(entry, 1));
      continue;
    }
    if (equivalent(existing, entry)) {
      const existingSources = existing.sourceRefs ?? [existing.sourceRef];
      const sourceRefs = [...new Set([...existingSources, ...(entry.sourceRefs ?? [entry.sourceRef])])];
      const latest = chapterOrder(entry.sourceChapter) >= chapterOrder(existing.sourceChapter)
        ? entry
        : existing;
      const version = Math.max(existing.version ?? 1, latest === entry ? (existing.version ?? 1) + 1 : 1);
      active.set(semanticKey, {
        ...latest,
        sourceRefs,
        version,
        ...(latest === entry && existing.id !== entry.id ? { supersedes: existing.id } : {}),
      });
      let record = merged.find((item) => item.activeId === existing.id);
      if (!record) {
        record = { activeId: existing.id, mergedIds: [], sourceRefs };
        merged.push(record);
      }
      record.mergedIds.push(entry.id);
      record.sourceRefs = sourceRefs;
      continue;
    }
    if (existing.sourceChapter === entry.sourceChapter) {
      active.delete(semanticKey);
      quarantine.push(existing, entry);
      quarantineReasons.set(existing.id, "same_effective_range_conflict");
      quarantineReasons.set(entry.id, "same_effective_range_conflict");
      quarantinedEventCount += 2;
      conflicted.push({ key: semanticKey, ids: [existing.id, entry.id], sourceRefs: [...new Set([existing.sourceRef, entry.sourceRef])] });
      continue;
    }
    const previousVersion = existing.version ?? 1;
    const next = withGovernance(entry, previousVersion + 1, existing.id);
    active.set(semanticKey, next);
    superseded.push({ oldId: existing.id, newId: entry.id, effectiveTo: entry.sourceChapter });
  }

  const activeEntries = [...active.values()];
  const report: MemoryCompactionReport = {
    eventCount: eventLog.length,
    activeCount: activeEntries.length,
    merged,
    omitted: Math.max(0, eventLog.length - activeEntries.length - quarantinedEventCount),
    quarantined: quarantine.map((entry) => ({ id: entry.id, reason: quarantineReasons.get(entry.id) ?? "quarantined", sourceRef: entry.sourceRef })),
    conflicted,
    superseded,
  };
  const nextStore: NarrativeStateStore = {
    ...store,
    eventLog,
    quarantine,
    canon: activeEntries.filter((entry) => entry.kind === "canon"),
    character: activeEntries.filter((entry) => entry.kind === "character"),
    promise: activeEntries.filter((entry) => entry.kind === "promise"),
    pattern: activeEntries.filter((entry) => entry.kind === "pattern"),
    expectation: activeEntries.filter((entry) => entry.kind === "expectation"),
    compactionReport: report,
  };
  return { store: nextStore, report };
}

function provenanceKey(entry: NarrativeStateEntry, sourceRef: string): string {
  return `${memoryKey(entry)}\u0000${sourceRef}`;
}

function legacyEvents(store: NarrativeStateStore): NarrativeStateEntry[] {
  return [...store.canon, ...store.character, ...store.promise, ...store.pattern, ...(store.expectation ?? [])];
}

function memoryKey(entry: NarrativeStateEntry): string {
  switch (entry.kind) {
    case "canon":
      return `canon:${normalize(entry.fact)}`;
    case "character":
      return `character:${entry.characterId}:${entry.field}`;
    case "promise":
      return `promise:${entry.promiseId}`;
    case "pattern":
      return `pattern:${entry.patternType}:${normalize(entry.description)}`;
    case "expectation":
      return `expectation:${entry.expectationId}`;
  }
}

function equivalent(left: NarrativeStateEntry, right: NarrativeStateEntry): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "canon":
      return right.kind === "canon" && normalize(left.fact) === normalize(right.fact);
    case "character":
      return right.kind === "character" && left.value === right.value;
    case "promise":
      return right.kind === "promise" && left.status === right.status && normalize(left.description) === normalize(right.description);
    case "pattern":
      return right.kind === "pattern" && normalize(left.description) === normalize(right.description);
    case "expectation":
      return right.kind === "expectation" && left.status === right.status && normalize(left.description) === normalize(right.description);
  }
}

function withGovernance<T extends NarrativeStateEntry>(entry: T, version: number, supersedes?: string): T {
  return {
    ...entry,
    version,
    effectiveFrom: entry.sourceChapter,
    ...(supersedes ? { supersedes } : {}),
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。；：、,.!！?？“”"'（）()【】]/g, "");
}

function chapterOrder(value: string): number {
  const match = value.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}
