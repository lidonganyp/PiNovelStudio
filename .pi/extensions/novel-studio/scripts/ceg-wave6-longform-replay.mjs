#!/usr/bin/env node
/**
 * CEG-7.1 / 7.2 / 7.3 — 长篇 fixture 回放 + 两个真实 workspace 的只读 snapshot 对照。
 * 不删除生产路径；不写真实 workspace。
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", "..");

const fixtureMod = await import(pathToFileURL(join(EXT_ROOT, "dist-test/v2/core/ceg-wave6-longform-fixture.js")).href);
const snapshotMod = await import(pathToFileURL(join(EXT_ROOT, "dist/v2/core/narrative-evidence-snapshot.js")).href);
const searchMod = await import(pathToFileURL(join(EXT_ROOT, "dist/novelos/agent/narrative-search-service.js")).href);
const outcomeMod = await import(pathToFileURL(join(EXT_ROOT, "dist-test/v2/core/evidence-governance-contracts.js")).href);

const outDir = join(EXT_ROOT, "eval/fixtures/ceg-wave5-6");
mkdirSync(outDir, { recursive: true });
const fixtureRoot = join(outDir, "longform");

const longform = [];
for (const chapters of [20, 50, 100]) {
  const fixture = fixtureMod.materializeCegLongformFixture({
    projectRoot: fixtureRoot,
    workspaceId: `ceg-lf-${chapters}`,
    chapters,
  });
  const snapshot = snapshotMod.buildNarrativeEvidenceSnapshot({
    workspaceId: fixture.workspaceId,
    projectRoot: fixtureRoot,
    chapterNumber: chapters + 1,
    prepareBackfill: false,
  });
  const search = new searchMod.NarrativeSearchService({
    projectRoot: fixtureRoot,
    workspaceId: fixture.workspaceId,
    sourceChapter: `ch${chapters}`,
    evidenceSnapshot: snapshot,
  });
  const farHits = search.searchChapterSpan("远章锚点-封印核心", chapters, 10);
  longform.push({
    chapters,
    snapshotId: snapshot.snapshotId,
    knowledgeSnapshotHash: snapshot.knowledgeSnapshotHash,
    farHits: farHits.length,
    futureCanon: snapshot.narrativeState.canon.filter((e) => e.sourceChapter === `ch${chapters + 1}`).length,
  });
}

const realWorkspaces = [];
for (const workspaceId of ["xinmo", "fuben"]) {
  const wsPath = join(REPO_ROOT, "workspaces", workspaceId);
  if (!existsSync(wsPath)) {
    realWorkspaces.push({ workspaceId, ok: false, reason: "missing" });
    continue;
  }
  const chapterNumber = workspaceId === "xinmo" ? 23 : 3;
  const snapshot = snapshotMod.buildNarrativeEvidenceSnapshot({
    workspaceId,
    projectRoot: REPO_ROOT,
    chapterNumber,
    prepareBackfill: false,
  });
  const search = new searchMod.NarrativeSearchService({
    projectRoot: REPO_ROOT,
    workspaceId,
    sourceChapter: `ch${chapterNumber - 1}`,
    evidenceSnapshot: snapshot,
  });
  realWorkspaces.push({
    workspaceId,
    ok: true,
    snapshotId: snapshot.snapshotId,
    knowledgeSnapshotHash: snapshot.knowledgeSnapshotHash,
    canon: snapshot.narrativeState.canon.length,
    acceptedChapters: snapshot.acceptedChapterIndex.length,
    queryCanon: search.queryCanon().length,
  });
}

const faults = {
  no_match: outcomeMod.buildRetrievalOutcome({
    queryId: "fault-empty", evidence: [], usedCalls: 1, remainingCalls: 0,
  }).status,
  retrieval_error: outcomeMod.buildRetrievalOutcome({
    queryId: "fault-timeout", evidence: [], error: "timeout", usedCalls: 1, remainingCalls: 0,
  }).status,
};

const report = {
  schemaId: "pinovel.ceg-wave6-longform-replay",
  longform,
  realWorkspaces,
  faults,
  deletedOldPaths: false,
  reason: "Wave 5 未形成真人正收益决策，禁止删除生产 renderer / 旧拼接路径",
};
writeFileSync(join(outDir, "wave6-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(
  join(outDir, "wave6-report.md"),
  [
    "# CEG Wave 6 长篇回放",
    "",
    ...longform.map((row) => `- ${row.chapters} 章：farHits=${row.farHits} futureCanon=${row.futureCanon} snapshot=${row.snapshotId}`),
    ...realWorkspaces.map((row) => `- 真实 ${row.workspaceId}: ${row.ok ? `canon=${row.canon} chapters=${row.acceptedChapters}` : row.reason}`),
    `- faults: no_match=${faults.no_match} retrieval_error=${faults.retrieval_error}`,
    "- 未删除生产旧路径",
    "",
  ].join("\n"),
  "utf8",
);
const ok = longform.every((row) => row.farHits > 0 && row.futureCanon === 0)
  && realWorkspaces.every((row) => row.ok)
  && faults.no_match === "no_match"
  && faults.retrieval_error === "retrieval_error";
console.log(JSON.stringify({ ok, longform, realWorkspaces, faults }, null, 2));
process.exit(ok ? 0 : 1);
