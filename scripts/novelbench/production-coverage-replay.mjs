#!/usr/bin/env node
/**
 * Minimal production-source replay for the NovelOS mustVerify coverage gate.
 *
 * This runner deliberately calls the production AgenticRawCandidateSource
 * directly (without evalMode/fullPipelinePreview and without chapter commit),
 * so the result exercises the default coverage gate while keeping the replay
 * isolated under reports/.
 */

import { parseArgs } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "scripts/novelbench/uncertainty-ablation-cases-r2.json" },
    only: { type: "string" },
    output: { type: "string" },
    route: { type: "string", default: "v2_rawstage2_gemini31" },
    timeout: { type: "string", default: "180000" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    [
      "Production mustVerify coverage replay",
      "",
      "Usage:",
      "  node scripts/novelbench/production-coverage-replay.mjs [options]",
      "",
      "Options:",
      "  --cases <path.json>  Case set (default: uncertainty-ablation-cases-r2.json)",
      "  --only <case,...>    Run only the listed case ids",
      "  --output <dir>       Output directory (default: reports/uncertainty-production-replay/<timestamp>)",
      "  --route <route>      Production writer route",
      "  --timeout <ms>       Per model-call timeout",
      "  --help               Show this help",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const casePath = resolve(PROJECT_ROOT, values.cases);
const outputDir = resolve(
  PROJECT_ROOT,
  values.output ?? join("reports", "uncertainty-production-replay", new Date().toISOString().replace(/[:.]/gu, "-")),
);
const route = values.route;
const timeoutMs = Number.parseInt(values.timeout, 10);

if (!existsSync(casePath)) throw new Error(`case set not found: ${casePath}`);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid timeout: ${values.timeout}`);

const caseDocument = JSON.parse(readFileSync(casePath, "utf8"));
const allCases = Array.isArray(caseDocument) ? caseDocument : caseDocument.cases;
if (!Array.isArray(allCases) || allCases.length === 0) throw new Error("case set has no cases");
const onlyCaseIds = typeof values.only === "string"
  ? values.only.split(",").map((value) => value.trim()).filter(Boolean)
  : [];
const cases = onlyCaseIds.length > 0
  ? allCases.filter((caseData) => onlyCaseIds.includes(caseData.caseId))
  : allCases;
if (cases.length === 0) throw new Error(`no cases matched --only: ${onlyCaseIds.join(",")}`);

mkdirSync(outputDir, { recursive: true });

const productionSourceModule = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "novelos", "agent", "agentic-raw-candidate-source.js")).href,
);
const modelAdapterModule = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "v2", "adapters", "legacy-model-route-adapter.js")).href,
);
const configModule = await import(
  pathToFileURL(join(EXT_ROOT, "dist", "utils", "config.js")).href,
);

configModule.loadModelRoutingSync();
const modelGenerate = modelAdapterModule.createLegacyModelGenerateFn();
const source = productionSourceModule.createAgenticRawCandidateSource();

function buildIntent(caseData) {
  return {
    chapterFunction: "推进核心情节，让事件有实质进展",
    readerExperience: ["悬念", "张力", "章末钩子"],
    currentPressure: ["主角面临关键挑战", "事件即将升级"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: caseData.characterNames ?? [],
    inviolableFacts: caseData.inviolableFacts ?? [],
    authorMustInclude: caseData.authorMustInclude,
    sourceRefs: [],
  };
}

function buildContext(caseData) {
  const worldRules = [
    {
      id: "replay-genre",
      description: `类型：${caseData.genre}`,
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["replay"],
    },
    ...(caseData.worldRules ?? []).map((rule) => ({
      id: rule.id,
      description: rule.description,
      type: rule.type,
      affectedCharacters: rule.affectedCharacters ?? [],
      sourceIds: ["world-canon"],
    })),
  ];
  return {
    facts: worldRules
      .filter((rule) => rule.sourceIds.includes("world-canon"))
      .map((rule) => ({ id: rule.id, content: rule.description, sourceIds: rule.sourceIds, kind: "fact" })),
    characterStates: [],
    openLoops: [],
    worldRules,
    styleReferences: [],
    sourceMap: [],
    constitution: caseData.constitution ?? null,
    longTermState: null,
    bridgeContext: {
      available: true,
      lastEventSummary: caseData.prefix?.slice(-600) ?? "",
      openHooks: caseData.authorMustInclude ?? [],
      unresolvedTensions: caseData.inviolableFacts ?? [],
      introducedCharacters: caseData.characterNames ?? [],
      sourceIds: ["replay-prefix"],
    },
  };
}

function writeFixture(projectRoot, workspaceId, fixture) {
  if (!fixture) return;
  const workspaceDir = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspaceDir, { recursive: true });
  for (const chapter of fixture.historicalChapters ?? []) {
    const chapterDir = join(workspaceDir, "chapters", `chapter-${chapter.number}`);
    mkdirSync(chapterDir, { recursive: true });
    writeFileSync(join(chapterDir, "final.md"), chapter.text, "utf8");
  }
  writeFileSync(
    join(workspaceDir, "skeleton.json"),
    JSON.stringify({
      chapterId: `ch${fixture.historicalChapters?.at(-1)?.number ?? 0}`,
      events: (fixture.canonEvents ?? []).map((event) => ({
        eventId: event.id,
        summary: event.fact,
        characters: event.characters ?? [],
        location: event.location,
      })),
    }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(workspaceDir, "narrative-state.json"),
    JSON.stringify({
      pendingCosts: [],
      characterUpdates: (fixture.characterStates ?? []).map((state) => ({
        name: state.characterId,
        field: state.field,
        value: state.value,
      })),
    }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(workspaceDir, "arc-registry.json"),
    JSON.stringify({
      arcs: [],
      foreshadowings: (fixture.promises ?? []).map((promise) => ({
        id: promise.id,
        description: promise.description,
        level: promise.level ?? "medium",
        status: promise.status ?? "open",
      })),
    }, null, 2),
    "utf8",
  );
}

function readJsonLines(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/gu)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function findLineage(projectRoot, workspaceId, sessionId) {
  const path = join(projectRoot, "workspaces", workspaceId, "novelos-sessions", sessionId, "lineage.json");
  if (!existsSync(path)) return { path, lineage: null };
  try { return { path, lineage: JSON.parse(readFileSync(path, "utf8")) }; } catch { return { path, lineage: null }; }
}

function summarize(caseData, result, trajectoryEntries, lineageInfo, durationMs) {
  const lineage = lineageInfo.lineage ?? {};
  const coverageGate = lineage.coverageGate ?? null;
  const failureEntries = trajectoryEntries.filter((entry) => entry.type === "failure");
  const coverageFailures = failureEntries.filter((entry) => entry.data?.stage === "must_verify_coverage_gate");
  const confirmedItems = coverageGate?.confirmedItems ?? [];
  const highRiskItems = coverageGate
    ? confirmedItems.length + (coverageGate.unverifiedHighRisk?.length ?? 0)
    : (caseData.authorMustInclude?.length ?? 0);
  const trajectoryConfirmed = confirmedItems.filter(
    (item) => typeof item.matchedEvidence === "string" && !item.matchedEvidence.startsWith("context:"),
  ).length;
  const observedToolExecutionCount = trajectoryEntries.filter(
    (entry) => entry.type === "tool_event" && entry.data?.type === "tool_execution_end",
  ).length;
  return {
    caseId: caseData.caseId,
    riskLevel: caseData.riskLevel ?? "low",
    mustVerifyCount: caseData.authorMustInclude?.length ?? 0,
    highRiskItems,
    candidateProduced: Boolean(result.candidate),
    stopReason: result.stopReason,
    failureKind: result.failureKind ?? null,
    failureReason: result.failureReason ?? null,
    gatePresent: Boolean(coverageGate),
    gatePassed: coverageGate ? Boolean(coverageGate.passed) : null,
    gateSkippedReason: coverageGate?.skippedReason ?? null,
    gateRetries: lineage.coverageGateRetries ?? coverageFailures.length,
    confirmedItemCount: confirmedItems.length,
    trajectoryConfirmedItemCount: trajectoryConfirmed,
    uncoveredHighRiskCount: coverageGate?.unverifiedHighRisk?.length ?? null,
    // A failed coverage run returns the loop lineage separately from the
    // source fallback envelope; use the larger observed value so retries do
    // not erase the tool-call count in the report.
    toolCalls: Math.max(result.toolCalls ?? 0, lineage.toolCalls ?? 0),
    observedToolExecutionCount,
    sourceRefs: result.sourceRefs?.length ?? lineage.sourceRefs?.length ?? 0,
    durationMs,
    tracePath: result.trajectoryPath,
    lineagePath: lineageInfo.path,
    traceRetained: existsSync(result.trajectoryPath),
  };
}

const startedAt = new Date().toISOString();
const results = [];
for (const caseData of cases) {
  const caseStarted = Date.now();
  const caseDir = join(outputDir, caseData.caseId);
  const projectRoot = join(caseDir, "project-root");
  const workspaceId = `production-replay-${caseData.caseId}`;
  mkdirSync(caseDir, { recursive: true });
  writeFixture(projectRoot, workspaceId, caseData.workspaceFixture);
  process.stderr.write(`[production-replay] ${caseData.caseId} start\n`);

  let result;
  let trajectoryEntries = [];
  let lineageInfo = { path: "", lineage: null };
  try {
    result = await source.generate({
      workspaceId,
      chapterId: `${caseData.caseId}-production`,
      chapterNumber: caseData.targetChapter,
      projectRoot,
      intent: buildIntent(caseData),
      context: buildContext(caseData),
      characterNames: caseData.characterNames ?? [],
      modelGenerate,
      route,
      timeoutMs,
    });
    trajectoryEntries = readJsonLines(result.trajectoryPath);
    lineageInfo = findLineage(projectRoot, workspaceId, result.sessionId);
  } catch (error) {
    result = {
      candidate: null,
      stopReason: "runner_error",
      failureKind: "runner_error",
      failureReason: error instanceof Error ? error.message : String(error),
      sourceRefs: [],
      toolCalls: 0,
      trajectoryPath: "",
      sessionId: "",
    };
  }

  const summary = summarize(caseData, result, trajectoryEntries, lineageInfo, Date.now() - caseStarted);
  writeFileSync(join(caseDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(join(caseDir, "trajectory-entries.json"), JSON.stringify(trajectoryEntries, null, 2), "utf8");
  writeFileSync(join(caseDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  results.push(summary);
  process.stderr.write(
    `[production-replay] ${caseData.caseId} done candidate=${summary.candidateProduced} gate=${summary.gatePassed ?? "n/a"} retries=${summary.gateRetries} toolCalls=${summary.toolCalls}\n`,
  );
}

const highRisk = results.filter((item) => item.mustVerifyCount > 0);
const aggregate = {
  caseCount: results.length,
  successCount: results.filter((item) => item.candidateProduced).length,
  gatePresentCount: results.filter((item) => item.gatePresent).length,
  gatePassCount: results.filter((item) => item.gatePassed === true).length,
  gateBlockCount: results.filter((item) => item.stopReason === "must_verify_coverage_failed").length,
  retryCaseCount: results.filter((item) => item.gateRetries > 0).length,
  traceRetainedCount: results.filter((item) => item.traceRetained).length,
  highRiskCaseCount: highRisk.length,
  highRiskGatePassCount: highRisk.filter((item) => item.gatePassed === true).length,
  highRiskTrajectoryConfirmedItems: highRisk.reduce((sum, item) => sum + item.trajectoryConfirmedItemCount, 0),
  highRiskMustVerifyItems: highRisk.reduce((sum, item) => sum + item.mustVerifyCount, 0),
  avgToolCalls: results.length ? results.reduce((sum, item) => sum + item.toolCalls, 0) / results.length : 0,
  avgDurationMs: results.length ? results.reduce((sum, item) => sum + item.durationMs, 0) / results.length : 0,
};

const report = {
  schemaVersion: 1,
  mode: "production_agentic_source",
  startedAt,
  completedAt: new Date().toISOString(),
  route,
  timeoutMs,
  casePath,
  outputDir,
  aggregate,
  cases: results,
};
writeFileSync(join(outputDir, "production-coverage-replay.json"), JSON.stringify(report, null, 2), "utf8");

const markdown = [
  "# Production mustVerify coverage replay",
  "",
  `- Route: ${route}`,
  `- Cases: ${aggregate.caseCount}`,
  `- Candidate success: ${aggregate.successCount}/${aggregate.caseCount}`,
  `- Coverage gate present: ${aggregate.gatePresentCount}/${aggregate.caseCount}`,
  `- Coverage gate pass: ${aggregate.gatePassCount}/${aggregate.caseCount}`,
  `- Coverage hard blocks: ${aggregate.gateBlockCount}`,
  `- Cases with coverage retry: ${aggregate.retryCaseCount}`,
  `- Trace retained: ${aggregate.traceRetainedCount}/${aggregate.caseCount}`,
  `- High-risk gate pass: ${aggregate.highRiskGatePassCount}/${aggregate.highRiskCaseCount}`,
  `- High-risk trajectory-confirmed items: ${aggregate.highRiskTrajectoryConfirmedItems}/${aggregate.highRiskMustVerifyItems}`,
  `- Average tool calls: ${aggregate.avgToolCalls.toFixed(2)}`,
  `- Average duration: ${(aggregate.avgDurationMs / 1000).toFixed(1)}s`,
  "",
  "| Case | Risk | Candidate | Gate | Retries | Confirmed | Trajectory confirmed | Uncovered | Tool calls | Duration |",
  "|---|---|---:|---|---:|---:|---:|---:|---:|---:|",
  ...results.map((item) =>
    `| ${item.caseId} | ${item.riskLevel} | ${item.candidateProduced ? "yes" : "no"} | ${item.gatePassed ?? "n/a"} | ${item.gateRetries} | ${item.confirmedItemCount} | ${item.trajectoryConfirmedItemCount} | ${item.uncoveredHighRiskCount ?? "n/a"} | ${item.toolCalls} | ${(item.durationMs / 1000).toFixed(1)}s |`,
  ),
  "",
  "> This replay calls the production AgenticRawCandidateSource directly. It does not run the full public chapter orchestrator and does not commit a chapter; use it as gate evidence, not as a full production-generation acceptance result.",
  "",
].join("\n");
writeFileSync(join(outputDir, "production-coverage-replay.md"), markdown, "utf8");
process.stdout.write(`${JSON.stringify({ outputDir, aggregate }, null, 2)}\n`);
