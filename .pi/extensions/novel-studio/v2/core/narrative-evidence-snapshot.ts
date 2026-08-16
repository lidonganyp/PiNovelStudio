/**
 * NarrativeEvidenceSnapshotBuilder — CEG-1.1 / CEG-1.2 / CEG-1.5
 *
 * Preflight 之后、ContextCompiler 之前创建冻结快照。
 * 写时 backfill 只允许在 freeze 之前执行；冻结后所有读取路径只读。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCreativeConstitution } from "./creative-constitution.js";
import type {
  AcceptedChapterEvidenceRef,
  NarrativeEvidenceSnapshot,
} from "./evidence-governance-contracts.js";
import { CEG_CONTRACT_SCHEMA_VERSION } from "./evidence-governance-contracts.js";
import {
  computeNarrativeStateRevision,
  loadStateStore,
  type NarrativeStateStore,
} from "./final-state-commit.js";
import { backfillAcceptedChapterState, listAcceptedChapterFiles } from "./historical-state-backfill.js";

export interface FrozenChapterText {
  chapterNumber: number;
  chapterId: string;
  contentHash: string;
  locator: string;
  text: string;
}

export interface NarrativeEvidenceSnapshotRuntime extends NarrativeEvidenceSnapshot {
  frozenChapterTexts: readonly FrozenChapterText[];
}

export interface BuildNarrativeEvidenceSnapshotInput {
  workspaceId: string;
  projectRoot: string;
  chapterNumber: number;
  releaseId?: string | null;
  /** 冻结前显式准备；默认 true。读取路径不得再调用 backfill。 */
  prepareBackfill?: boolean;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function computeKnowledgeSnapshotHash(input: {
  narrativeState: Readonly<NarrativeStateStore>;
  acceptedChapterIndex: readonly AcceptedChapterEvidenceRef[];
  sourceHashes: Readonly<Record<string, string>>;
  workspaceRevision: string;
}): string {
  return sha256Text(
    canonicalJson({
      workspaceRevision: input.workspaceRevision,
      narrativeState: input.narrativeState,
      acceptedChapterIndex: input.acceptedChapterIndex,
      sourceHashes: input.sourceHashes,
    }),
  );
}

function collectLiveChapterTexts(
  projectRoot: string,
  workspaceId: string,
): FrozenChapterText[] {
  const chaptersDir = join(projectRoot, "workspaces", workspaceId, "chapters");
  if (!existsSync(chaptersDir)) return [];
  const collected: FrozenChapterText[] = [];
  for (const entry of readdirSync(chaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("chapter-")) continue;
    const num = Number.parseInt(entry.name.replace("chapter-", ""), 10);
    if (!Number.isFinite(num) || num < 1) continue;
    const candidates = [
      join(chaptersDir, entry.name, "final.md"),
      join(chaptersDir, `chapter-${String(num).padStart(2, "0")}`, "final.md"),
    ];
    for (const locator of candidates) {
      if (!existsSync(locator)) continue;
      const text = readFileSync(locator, "utf-8");
      collected.push({
        chapterNumber: num,
        chapterId: `ch${num}`,
        contentHash: sha256Text(text),
        locator,
        text,
      });
      break;
    }
  }
  return collected.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

/**
 * 冻结前准备 + 构建只读快照。backfill 在此之后不得再被读取路径调用。
 */
export function buildNarrativeEvidenceSnapshot(
  input: BuildNarrativeEvidenceSnapshotInput,
): NarrativeEvidenceSnapshotRuntime {
  if (input.prepareBackfill !== false) {
    backfillAcceptedChapterState({
      workspaceId: input.workspaceId,
      projectRoot: input.projectRoot,
      beforeChapterNumber: input.chapterNumber,
    });
  }

  const narrativeState = loadStateStore(input.workspaceId, input.projectRoot);
  const workspaceRevision = computeNarrativeStateRevision(input.workspaceId, input.projectRoot);
  const constitution = loadCreativeConstitution(input.workspaceId, input.projectRoot);

  const acceptedFiles = listAcceptedChapterFiles({
    workspaceId: input.workspaceId,
    projectRoot: input.projectRoot,
    beforeChapterNumber: input.chapterNumber,
  });
  const liveChapters = collectLiveChapterTexts(input.projectRoot, input.workspaceId);
  const byNumber = new Map<number, FrozenChapterText>();
  for (const file of acceptedFiles) {
    byNumber.set(file.chapterNumber, {
      chapterNumber: file.chapterNumber,
      chapterId: `ch${file.chapterNumber}`,
      contentHash: sha256Text(file.text),
      locator: file.relativePath,
      text: file.text,
    });
  }
  for (const live of liveChapters) {
    if (!byNumber.has(live.chapterNumber)) {
      byNumber.set(live.chapterNumber, live);
    }
  }
  const frozenChapterTexts = [...byNumber.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
  const acceptedChapterIndex: AcceptedChapterEvidenceRef[] = frozenChapterTexts.map((chapter) => ({
    chapterId: chapter.chapterId,
    chapterNumber: chapter.chapterNumber,
    contentHash: chapter.contentHash,
    locator: chapter.locator,
  }));

  const storePath = join(
    input.projectRoot,
    "workspaces",
    input.workspaceId,
    "narrative-state-store.json",
  );
  const sourceHashes: Record<string, string> = {
    "narrative-state-store.json": existsSync(storePath)
      ? sha256Text(readFileSync(storePath, "utf-8"))
      : sha256Text(""),
  };
  for (const chapter of frozenChapterTexts) {
    sourceHashes[chapter.locator] = chapter.contentHash;
  }

  const knowledgeSnapshotHash = computeKnowledgeSnapshotHash({
    narrativeState,
    acceptedChapterIndex,
    sourceHashes,
    workspaceRevision,
  });

  const snapshot: NarrativeEvidenceSnapshotRuntime = {
    schemaVersion: CEG_CONTRACT_SCHEMA_VERSION,
    snapshotId: `snap:${knowledgeSnapshotHash.slice(0, 24)}`,
    workspaceId: input.workspaceId,
    workspaceRevision,
    lastCommittedChapter: narrativeState.lastCommittedChapter ?? null,
    releaseId: input.releaseId ?? "unbound",
    createdAt: new Date().toISOString(),
    knowledgeSnapshotHash,
    creativeConstitution: constitution,
    narrativeState,
    acceptedChapterIndex,
    sourceHashes,
    frozenChapterTexts,
  };
  return snapshot;
}

export function readFrozenChapterText(
  snapshot: NarrativeEvidenceSnapshotRuntime,
  chapterNumber: number,
): string | null {
  const found = snapshot.frozenChapterTexts.find((chapter) => chapter.chapterNumber === chapterNumber);
  if (!found) return null;
  const actualHash = sha256Text(found.text);
  if (actualHash !== found.contentHash) {
    throw new Error(
      `snapshot_hash_mismatch: chapter ${chapterNumber} frozen hash ${found.contentHash} != ${actualHash}`,
    );
  }
  return found.text;
}
