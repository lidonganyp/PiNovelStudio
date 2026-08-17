/**
 * EvidenceRecord adapter — CEG-2.1
 *
 * Canon / Character / Promise / Pattern / 正文 span → 单向 EvidenceRecord。
 */
import type { EvidenceRecord } from "./evidence-governance-contracts.js";
import { MEMORY_TO_EVIDENCE_EPISTEMIC } from "./evidence-governance-contracts.js";
import type {
  CanonEntry,
  CharacterStateEntry,
  PatternEntry,
  PromiseEntry,
} from "./final-state-commit.js";
import { evaluateEvidenceEligibility } from "./evidence-eligibility-gate.js";
import type { EpistemicStatus, LifecycleStatus } from "./memory/memory-record.js";
import { createHash } from "node:crypto";

/** 稳定内容 hash（完整 sha256 hex），供修订准入校验源内容与证据摘录未变。 */
function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapEpistemic(entry: { memory?: { epistemicStatus?: string } }): EvidenceRecord["epistemicStatus"] {
  const raw = entry.memory?.epistemicStatus;
  if (
    raw === "declared" ||
    raw === "confirmed" ||
    raw === "derived" ||
    raw === "hypothesis" ||
    raw === "disputed" ||
    raw === "planned" ||
    raw === "superseded"
  ) {
    const mapped = MEMORY_TO_EVIDENCE_EPISTEMIC[raw];
    if (mapped === "confirmed" || mapped === "derived" || mapped === "advisory" || mapped === "conflicted") {
      return mapped;
    }
  }
  return "derived";
}

function parseChapterNumber(sourceChapter: string | undefined): number | null {
  if (!sourceChapter) return null;
  const match = sourceChapter.match(/(\d+)/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function adaptRecord(input: {
  evidenceId: string;
  statement: string;
  entry: {
    memory?: {
      authorityClass?: EvidenceRecord["authorityClass"];
      epistemicStatus?: EpistemicStatus;
      lifecycleStatus?: LifecycleStatus;
    };
    sourceRef: string;
    sourceChapter: string;
  };
  snapshotId: string;
  currentChapterNumber: number;
  matchedBecause: string[];
  retrievalQueryId?: string | null;
}): EvidenceRecord | null {
  const contentHash = hashContent(input.statement);
  const eligibility = evaluateEvidenceEligibility({
    sourceChapter: input.entry.sourceChapter,
    currentChapterNumber: input.currentChapterNumber,
    lifecycleStatus: input.entry.memory?.lifecycleStatus,
    epistemicStatus: input.entry.memory?.epistemicStatus,
    authorityClass: input.entry.memory?.authorityClass,
    sourceRef: input.entry.sourceRef,
    snapshotId: input.snapshotId,
    sourceContentHash: contentHash,
    evidenceExcerptHash: contentHash,
  });
  if (eligibility.decision === "reject") return null;
  return {
    evidenceId: input.evidenceId,
    statement: input.statement,
    authorityClass: input.entry.memory?.authorityClass ?? "committed_state",
    epistemicStatus: mapEpistemic(input.entry),
    sourceRef: input.entry.sourceRef,
    sourceContentHash: contentHash,
    evidenceExcerptHash: contentHash,
    validFrom: null,
    validUntil: null,
    matchedBecause: input.matchedBecause,
    retrievalQueryId: input.retrievalQueryId ?? null,
    snapshotId: input.snapshotId,
    traceable: Boolean(input.entry.sourceRef),
    lineage: {
      sourceChapter: input.entry.sourceChapter,
      chapterNumber: parseChapterNumber(input.entry.sourceChapter),
      runId: input.retrievalQueryId ?? null,
      candidateId: null,
    },
  };
}

export function canonToEvidenceRecord(
  entry: CanonEntry,
  snapshotId: string,
  currentChapterNumber: number,
): EvidenceRecord | null {
  return adaptRecord({
    evidenceId: entry.id,
    statement: entry.fact,
    entry,
    snapshotId,
    currentChapterNumber,
    matchedBecause: ["canon_entry"],
  });
}

export function characterToEvidenceRecord(
  entry: CharacterStateEntry,
  snapshotId: string,
  currentChapterNumber: number,
): EvidenceRecord | null {
  return adaptRecord({
    evidenceId: entry.id,
    statement: `${entry.characterId}:${entry.field}=${entry.value}`,
    entry,
    snapshotId,
    currentChapterNumber,
    matchedBecause: ["character_state"],
  });
}

export function promiseToEvidenceRecord(
  entry: PromiseEntry,
  snapshotId: string,
  currentChapterNumber: number,
): EvidenceRecord | null {
  return adaptRecord({
    evidenceId: entry.id,
    statement: entry.description,
    entry,
    snapshotId,
    currentChapterNumber,
    matchedBecause: ["promise_ledger"],
  });
}

export function patternToEvidenceRecord(
  entry: PatternEntry,
  snapshotId: string,
  currentChapterNumber: number,
): EvidenceRecord | null {
  return adaptRecord({
    evidenceId: entry.id,
    statement: entry.description,
    entry,
    snapshotId,
    currentChapterNumber,
    matchedBecause: ["pattern_memory"],
  });
}
