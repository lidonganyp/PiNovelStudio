/**
 * EvidenceEligibilityGate — CEG-2.2
 *
 * 未来状态、TTL、不可解析章节、无权用途在评分前排除。
 * 复用现有 context-retrieval 资格语义，不平行发明第二套过滤器。
 */
import type { EvidenceEpistemicStatus } from "./evidence-governance-contracts.js";
import type { AuthorityClass, EpistemicStatus, LifecycleStatus } from "./memory/memory-record.js";
import { LIFECYCLE_ELIGIBILITY, MEMORY_TO_EVIDENCE_EPISTEMIC } from "./evidence-governance-contracts.js";

export type EligibilityDecision = "eligible" | "reject";

export interface EvidenceLineageBinding {
  sourceChapter?: string;
  chapterNumber?: number | null;
  runId?: string | null;
  candidateId?: string | null;
}

export interface EvidenceEligibilityInput {
  sourceChapter?: string;
  currentChapterNumber: number;
  lifecycleStatus?: LifecycleStatus;
  epistemicStatus?: EpistemicStatus;
  authorityClass?: AuthorityClass;
  sourceRef?: string;
  snapshotId?: string;
  sourceContentHash?: string;
  evidenceExcerptHash?: string;
  findingId?: string;
  lineage?: EvidenceLineageBinding;
}

export interface EvidenceEligibilityResult {
  decision: EligibilityDecision;
  reason: string;
  evidenceEpistemic?: EvidenceEpistemicStatus;
}

function parseChapterNumber(sourceChapter: string | undefined): number | null {
  if (!sourceChapter) return null;
  const match = sourceChapter.match(/(\d+)/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

export function evaluateEvidenceEligibility(
  input: EvidenceEligibilityInput,
): EvidenceEligibilityResult {
  const chapter = parseChapterNumber(input.sourceChapter);
  if (chapter !== null && chapter >= input.currentChapterNumber) {
    return { decision: "reject", reason: "future_or_current_chapter" };
  }
  if (chapter === null && input.sourceChapter) {
    return { decision: "reject", reason: "unparseable_chapter" };
  }
  if (input.lifecycleStatus) {
    const lifecycle = LIFECYCLE_ELIGIBILITY[input.lifecycleStatus];
    if (lifecycle === "reject") {
      return { decision: "reject", reason: `lifecycle_${input.lifecycleStatus}` };
    }
  }
  if (input.epistemicStatus) {
    const mapped = MEMORY_TO_EVIDENCE_EPISTEMIC[input.epistemicStatus];
    if (mapped === "not_evidence") {
      return { decision: "reject", reason: `epistemic_${input.epistemicStatus}` };
    }
  }
  if (!input.sourceRef || input.sourceRef.trim().length === 0) {
    return { decision: "reject", reason: "missing_source_ref" };
  }
  if (input.findingId && input.sourceRef.trim() === input.findingId.trim()) {
    return { decision: "reject", reason: "diagnostic_id_as_source_ref" };
  }
  if (!input.snapshotId || input.snapshotId.trim().length === 0) {
    return { decision: "reject", reason: "missing_snapshot" };
  }
  if (!input.sourceContentHash || input.sourceContentHash.trim().length === 0) {
    return { decision: "reject", reason: "missing_source_content_hash" };
  }
  if (!input.evidenceExcerptHash || input.evidenceExcerptHash.trim().length === 0) {
    return { decision: "reject", reason: "missing_excerpt_hash" };
  }
  return {
    decision: "eligible",
    reason: "eligible",
    evidenceEpistemic: input.epistemicStatus
      ? (MEMORY_TO_EVIDENCE_EPISTEMIC[input.epistemicStatus] === "not_evidence"
        ? undefined
        : MEMORY_TO_EVIDENCE_EPISTEMIC[input.epistemicStatus] as EvidenceEpistemicStatus)
      : undefined,
  };
}

/**
 * 提交 / 修复授权 / 策略学习前的完整权威绑定。
 * 资格闸只保证可回源；本函数再要求 chapter/run/candidate 血缘齐全。
 */
export function evaluateEvidenceAuthorityBinding(input: {
  sourceRef?: string;
  snapshotId?: string;
  sourceContentHash?: string;
  evidenceExcerptHash?: string;
  findingId?: string;
  lineage?: EvidenceLineageBinding;
}): EvidenceEligibilityResult {
  const eligibility = evaluateEvidenceEligibility({
    currentChapterNumber: Number.MAX_SAFE_INTEGER,
    sourceRef: input.sourceRef,
    snapshotId: input.snapshotId,
    sourceContentHash: input.sourceContentHash,
    evidenceExcerptHash: input.evidenceExcerptHash,
    findingId: input.findingId,
  });
  if (eligibility.decision === "reject") return eligibility;
  const chapterBound =
    Boolean(input.sourceRef && input.sourceRef.trim().length > 0)
    || Boolean(input.lineage?.sourceChapter && input.lineage.sourceChapter.trim().length > 0)
    || (typeof input.lineage?.chapterNumber === "number" && Number.isFinite(input.lineage.chapterNumber));
  const runBound = Boolean(input.lineage?.runId && input.lineage.runId.trim().length > 0);
  const candidateBound = Boolean(input.lineage?.candidateId && input.lineage.candidateId.trim().length > 0);
  if (!chapterBound || !runBound || !candidateBound) {
    return { decision: "reject", reason: "missing_lineage" };
  }
  return { decision: "eligible", reason: "eligible" };
}

export function authorityTier(authorityClass: AuthorityClass | undefined): number {
  switch (authorityClass) {
    case "author_declaration":
      return 4;
    case "final_text_explicit":
      return 3;
    case "committed_state":
      return 2;
    case "system_derived":
      return 1;
    default:
      return 0;
  }
}
