/**
 * Production-admission failure/recovery replay.
 *
 * Invokes only scripts/production-generate-chapter.mjs (registered
 * novel_generate_chapter). Does not set PINOVEL_DEV_MODE=1.
 *
 *   PINOVEL_EVAL_RELEASE_ID=rel-prod-126 PINOVEL_EVAL_ONLY=1 \
 *   PINOVEL_FINGERPRINT_ROOT=<freeze-tree> \
 *   node scripts/production-admission-replay.mjs --real --out-dir=...
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const DEFAULT_PROJECT_ROOT = resolve(EXT_ROOT, "..", "..", "..");
const INVOKER = join(EXT_ROOT, "scripts", "production-generate-chapter.mjs");
const REAL = process.argv.includes("--real");
const OUT_DIR = resolve(
  DEFAULT_PROJECT_ROOT,
  (process.argv.find((a) => a.startsWith("--out-dir=")) ?? "").slice("--out-dir=".length)
    || "reports/production-admission-replay",
);
const SOURCE_ROOT = process.env.PINOVEL_FINGERPRINT_ROOT
  ? resolve(process.env.PINOVEL_FINGERPRINT_ROOT)
  : DEFAULT_PROJECT_ROOT;
const RELEASE_ID = process.env.PINOVEL_EVAL_RELEASE_ID || "";
const EVOLUTION_ROOT = process.env.PINOVEL_EVOLUTION_ROOT
  ? resolve(process.env.PINOVEL_EVOLUTION_ROOT)
  : join(DEFAULT_PROJECT_ROOT, ".pi", "extensions", "novel-studio", "config", "evolution-release");
const TIMEOUT_BOUND_MS = 8000;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function materializeScratch(scratch) {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, ".pi", "extensions", "novel-studio"), { recursive: true });
  mkdirSync(join(scratch, "docs"), { recursive: true });
  mkdirSync(join(scratch, "config"), { recursive: true });
  mkdirSync(join(scratch, "data", "runtime"), { recursive: true });
  writeFileSync(
    join(scratch, "docs", "top-tier-chinese-novel-system-development-plan.md"),
    "# eval-scratch project marker\n",
    "utf8",
  );
  copyIfExists(join(SOURCE_ROOT, "config", "model-routing.json"), join(scratch, "config", "model-routing.json"));
  copyIfExists(join(SOURCE_ROOT, "config", "quality-gates.json"), join(scratch, "config", "quality-gates.json"));
  copyIfExists(
    join(SOURCE_ROOT, "data", "runtime", "capability-package-set.json"),
    join(scratch, "data", "runtime", "capability-package-set.json"),
  );
  copyIfExists(join(SOURCE_ROOT, ".env"), join(scratch, ".env"));
  copyIfExists(join(DEFAULT_PROJECT_ROOT, ".env"), join(scratch, ".env"));
}

function scaffoldWorkspace(root, workspaceId, extras = {}) {
  const ws = join(root, "workspaces", workspaceId);
  rmSync(ws, { recursive: true, force: true });
  for (const sub of ["chapters", "characters", "series", "styles", "worldbuilding", "traces"]) {
    mkdirSync(join(ws, sub), { recursive: true });
  }
  writeFileSync(join(ws, "config.json"), `${JSON.stringify({
    name: workspaceId,
    genre: "仙侠",
    subGenres: ["东方玄幻"],
    totalChapters: 10,
    chapterType: "standard",
    styleProfile: `${workspaceId}-author`,
    characters: [{ id: "char-1", name: "叶尘", role: "protagonist" }],
    worldKeyTerms: extras.worldKeyTerms ?? {
      factions: ["青云宗"],
      places: ["青云山"],
      currencies: ["灵石"],
      professions: ["剑修"],
      specialAbilities: ["尘心诀"],
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(ws, "characters", "yechen.md"), "# 叶尘\n外门杂役，持残破玉简。\n", "utf8");
  writeFileSync(join(ws, "styles", "profile.json"), `${JSON.stringify({
    kind: extras.styleKind ?? "fingerprint",
    author: `${workspaceId}-author`,
    usagePolicy: extras.usagePolicy ?? { fullChapterOptimization: "required" },
    editorialGuidance: extras.editorialGuidance ?? ["短句，少比喻。"],
    characterVoiceGuidance: {},
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(ws, "series", "outline.md"), "# 高层背景\n外门试炼。\n", "utf8");
  if (extras.narrativeState) {
    writeFileSync(join(ws, "narrative-state-store.json"), `${JSON.stringify(extras.narrativeState, null, 2)}\n`, "utf8");
  }
  if (extras.preChapterText) {
    writeFileSync(join(ws, "chapters", "1.md"), extras.preChapterText, "utf8");
  }
  return ws;
}

function findTrace(ws, chapterId) {
  const tracesDir = join(ws, "traces");
  if (!existsSync(tracesDir)) return null;
  const hit = readdirSync(tracesDir).find((name) =>
    name.includes(String(chapterId)) && name.endsWith("-quality-trace.json"),
  );
  return hit ? join(tracesDir, hit) : null;
}

function copyTrace(ws, chapterId, outName) {
  const src = findTrace(ws, chapterId);
  if (!src) return null;
  const dest = join(OUT_DIR, "traces", `${outName}-quality-trace.json`);
  copyIfExists(src, dest);
  return dest;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function collectModelCalls(ws, chapterId) {
  const calls = [];
  const tracePath = findTrace(ws, chapterId);
  if (tracePath) {
    const doc = readJson(tracePath);
    for (const gate of doc?.gates ?? []) {
      for (const call of gate.evidence?.modelCalls ?? []) calls.push(call);
    }
    for (const call of doc?.evidence?.modelCalls ?? []) calls.push(call);
  }
  return calls;
}

function releaseGovernance(ws, chapterId) {
  const tracePath = findTrace(ws, chapterId);
  const doc = tracePath ? readJson(tracePath) : null;
  return doc?.gates?.[0]?.evidence?.releaseGovernance
    ?? doc?.releaseGovernance
    ?? null;
}

function firstGate(ws, chapterId) {
  const tracePath = findTrace(ws, chapterId);
  const doc = tracePath ? readJson(tracePath) : null;
  return doc?.gates?.[0]?.stage ?? doc?.failureEnvelopes?.[0]?.gate ?? null;
}

function atomicSaveEvidence(ws, chapterId) {
  const tracePath = findTrace(ws, chapterId);
  const doc = tracePath ? readJson(tracePath) : null;
  return doc?.stageResults?.atomicSave
    ?? doc?.gates?.[0]?.evidence?.stageResults?.atomicSave
    ?? doc?.v2Summary?.stageResults?.atomicSave
    ?? null;
}

function hasChapterFile(ws, chapterId) {
  const path = join(ws, "chapters", `${chapterId}.md`);
  try {
    return existsSync(path) && statSync(path).isFile() && readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function stateAdvanced(ws) {
  const path = join(ws, "narrative-state-store.json");
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(raw.lastCommittedChapter || raw.lastChapter);
  } catch {
    return false;
  }
}

function invokeChapter(projectRoot, workspaceId, chapterId, chapterNumber, env = {}) {
  if (Object.hasOwn(env, "PINOVEL_DEV_MODE") && String(env.PINOVEL_DEV_MODE) === "1") {
    throw new Error("production-admission-replay refuses PINOVEL_DEV_MODE=1");
  }
  const result = spawnSync(process.execPath, [
    INVOKER,
    workspaceId,
    String(chapterId),
    String(chapterNumber),
    `--project-root=${projectRoot}`,
  ], {
    cwd: EXT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PINOVEL_DEV_MODE: "0",
      PINOVEL_EVAL_ONLY: "1",
      PROJECT_ROOT: projectRoot,
      PINOVEL_PROJECT_ROOT: projectRoot,
      PINOVEL_FINGERPRINT_ROOT: SOURCE_ROOT,
      PINOVEL_EVOLUTION_ROOT: EVOLUTION_ROOT,
      ...(RELEASE_ID ? { PINOVEL_EVAL_RELEASE_ID: RELEASE_ID } : {}),
      ...env,
    },
    timeout: REAL ? 900000 : 180000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error) : null,
  };
}

if (!REAL) {
  console.error("[production-admission-replay] refused: --real is required");
  process.exit(2);
}
if (!RELEASE_ID) {
  console.error("[production-admission-replay] refused: PINOVEL_EVAL_RELEASE_ID is required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
const scratch = join(OUT_DIR, "scratch");
materializeScratch(scratch);
const samples = [];

function record(sample) {
  samples.push(sample);
  console.log(`[${sample.passed ? "PASS" : "FAIL"}] ${sample.id}: ${sample.detail}`);
}

{
  const id = "timeout";
  const ws = scaffoldWorkspace(scratch, id);
  const result = invokeChapter(scratch, id, "1", 1, {
    PINOVEL_MODEL_REQUEST_TIMEOUT_MS: "1",
    PINOVEL_MODEL_MAX_RETRIES: "0",
  });
  const calls = collectModelCalls(ws, "1");
  const maxDuration = Math.max(0, ...calls.map((c) => Number(c.durationMs) || 0));
  const timedOut = calls.some((c) => String(c.timeout ?? "") === "1")
    || /timed out after 1ms/i.test(`${result.stdout}\n${result.stderr}`);
  const gov = releaseGovernance(ws, "1");
  record({
    id,
    scenario: "bounded model timeout",
    transport: "network",
    passed: result.status !== 0
      && !hasChapterFile(ws, "1")
      && !stateAdvanced(ws)
      && timedOut
      && maxDuration < TIMEOUT_BOUND_MS
      && gov?.devMode === false
      && gov?.releaseId === RELEASE_ID,
    detail: `exit=${result.status} maxDurationMs=${maxDuration} timedOut=${timedOut} saved=${hasChapterFile(ws, "1")} releaseId=${gov?.releaseId ?? "none"}`,
    tracePath: copyTrace(ws, "1", id),
    gate: firstGate(ws, "1"),
    maxDurationMs: maxDuration,
    releaseGovernance: gov,
  });
}

{
  const id = "retry";
  const ws = scaffoldWorkspace(scratch, id);
  const result = invokeChapter(scratch, id, "1", 1, {
    PINOVEL_MODEL_REQUEST_TIMEOUT_MS: "1",
    PINOVEL_MODEL_MAX_RETRIES: "0",
  });
  const calls = collectModelCalls(ws, "1");
  const retryIndexes = calls.map((c) => Number(c.retryIndex) || 0);
  const retried = retryIndexes.some((idx) => idx > 0);
  const gov = releaseGovernance(ws, "1");
  record({
    id,
    scenario: "automatic chapter retry",
    transport: "network",
    passed: result.status !== 0
      && retried
      && !hasChapterFile(ws, "1")
      && gov?.devMode === false
      && gov?.releaseId === RELEASE_ID,
    detail: `exit=${result.status} retryIndexes=${JSON.stringify(retryIndexes)} saved=${hasChapterFile(ws, "1")}`,
    tracePath: copyTrace(ws, "1", id),
    gate: firstGate(ws, "1"),
    retryIndexes,
    releaseGovernance: gov,
  });
}

{
  const id = "atomic-rollback";
  const ws = scaffoldWorkspace(scratch, id);
  const result = invokeChapter(scratch, id, "1", 1, {
    V2_FORCE_STUB: "1",
    PINOVEL_COMMIT_FAULT: "after_chapter_save",
  });
  const save = atomicSaveEvidence(ws, "1");
  const gov = releaseGovernance(ws, "1");
  record({
    id,
    scenario: "post-save atomic rollback",
    transport: "stub_commit_path",
    passed: result.status !== 0
      && !hasChapterFile(ws, "1")
      && !stateAdvanced(ws)
      && save?.rolledBack === true
      && gov?.devMode === false
      && gov?.releaseId === RELEASE_ID,
    detail: `exit=${result.status} saved=${hasChapterFile(ws, "1")} rolledBack=${save?.rolledBack ?? false}`,
    tracePath: copyTrace(ws, "1", id),
    gate: firstGate(ws, "1"),
    atomicSave: save,
    releaseGovernance: gov,
  });
}

{
  const id = "state-commit-fail";
  const ws = scaffoldWorkspace(scratch, id, {
    narrativeState: {
      schemaVersion: 1,
      workspaceId: id,
      lastCommittedChapter: 0,
    },
  });
  const result = invokeChapter(scratch, id, "1", 1, {
    V2_FORCE_STUB: "1",
    PINOVEL_COMMIT_FAULT: "state_commit",
  });
  const save = atomicSaveEvidence(ws, "1");
  const gov = releaseGovernance(ws, "1");
  record({
    id,
    scenario: "post-save state-commit failure",
    transport: "stub_commit_path",
    passed: result.status !== 0
      && !hasChapterFile(ws, "1")
      && !stateAdvanced(ws)
      && save?.rolledBack === true
      && gov?.devMode === false
      && gov?.releaseId === RELEASE_ID,
    detail: `exit=${result.status} saved=${hasChapterFile(ws, "1")} rolledBack=${save?.rolledBack ?? false}`,
    tracePath: copyTrace(ws, "1", id),
    gate: firstGate(ws, "1"),
    atomicSave: save,
    releaseGovernance: gov,
  });
}

const requiredIds = ["timeout", "retry", "atomic-rollback", "state-commit-fail"];
const requiredPassed = requiredIds.every((id) => samples.find((s) => s.id === id)?.passed);
const productionLike = samples
  .filter((s) => requiredIds.includes(s.id))
  .every((s) => s.releaseGovernance?.devMode === false && s.releaseGovernance?.releaseId === RELEASE_ID);
const productionComplete = requiredPassed && productionLike;

const harnessHash = sha256File(join(EXT_ROOT, "scripts", "production-admission-replay.mjs"));
const traceHashes = {};
for (const sample of samples) {
  if (sample.tracePath && existsSync(sample.tracePath)) {
    traceHashes[sample.id] = sha256File(sample.tracePath);
  }
}
const reportBody = {
  generatedAt: new Date().toISOString(),
  real: REAL,
  productionComplete,
  releaseId: RELEASE_ID,
  sourceRoot: SOURCE_ROOT,
  harnessHash,
  samples,
  traceHashes,
  traceRetention: samples.filter((s) => Boolean(s.tracePath)).length / samples.length,
};
const reportHash = createHash("sha256").update(JSON.stringify(reportBody)).digest("hex");
const report = { ...reportBody, reportHash };
writeJson(join(OUT_DIR, "production-admission-replay.json"), report);
writeFileSync(join(OUT_DIR, "production-admission-replay.md"), [
  "# Production Admission Replay",
  "",
  `- real: ${REAL}`,
  `- releaseId: ${RELEASE_ID}`,
  `- productionComplete: ${productionComplete}`,
  `- harnessHash: ${harnessHash}`,
  `- reportHash: ${reportHash}`,
  `- traceRetention: ${report.traceRetention}`,
  "",
  ...samples.map((s) => `- ${s.passed ? "PASS" : "FAIL"} ${s.id}: ${s.detail} trace=${s.tracePath ?? "none"}`),
  "",
].join("\n"), "utf8");

const failed = samples.filter((s) => !s.passed);
console.log(JSON.stringify({
  ok: failed.length === 0 && samples.every((s) => s.tracePath) && productionComplete,
  failed: failed.map((s) => s.id),
  missingTrace: samples.filter((s) => !s.tracePath).map((s) => s.id),
  productionComplete,
  reportHash,
  harnessHash,
  out: OUT_DIR,
}, null, 2));
process.exit(failed.length === 0 && samples.every((s) => s.tracePath) && productionComplete ? 0 : 1);
