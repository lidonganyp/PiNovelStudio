/**
 * Production-admission failure/recovery replay.
 *
 * Uses the registered production-generate-chapter invoker only.
 * Isolated project root. Default Gemini routing unless --stub.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(EXT_ROOT, "..", "..", "..");
const INVOKER = join(EXT_ROOT, "scripts", "production-generate-chapter.mjs");
const REAL = process.argv.includes("--real");
const OUT_DIR = resolve(
  PROJECT_ROOT,
  (process.argv.find((a) => a.startsWith("--out-dir=")) ?? "").slice("--out-dir=".length)
    || "reports/production-admission-replay",
);

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function invokeChapter(projectRoot, workspaceId, chapterId, chapterNumber, env = {}) {
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
      V2_FORCE_STUB: REAL ? "0" : "1",
      PINOVEL_DEV_MODE: "0",
      PROJECT_ROOT: projectRoot,
      PINOVEL_PROJECT_ROOT: projectRoot,
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

function chapterSaved(ws, chapterId) {
  return existsSync(join(ws, "chapters", `${chapterId}.md`));
}

function stateAdvanced(ws) {
  const path = join(ws, "narrative-state-store.json");
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(raw.lastCommittedChapter || raw.lastChapter || (raw.canon && raw.canon.length > 1));
  } catch {
    return false;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const scratch = join(OUT_DIR, "scratch");
mkdirSync(scratch, { recursive: true });
const samples = [];

function record(sample) {
  samples.push(sample);
  console.log(`[${sample.passed ? "PASS" : "FAIL"}] ${sample.id}: ${sample.detail}`);
}

const timeoutWs = scaffoldWorkspace(scratch, "padm-timeout");
const timeout = invokeChapter(scratch, "padm-timeout", "1", 1, {
  PINOVEL_MODEL_REQUEST_TIMEOUT_MS: "1",
});
record({
  id: "timeout",
  scenario: "模型 timeout",
  passed: timeout.status !== 0 && !chapterSaved(timeoutWs, "1") && !stateAdvanced(timeoutWs),
  detail: `exit=${timeout.status} saved=${chapterSaved(timeoutWs, "1")} state=${stateAdvanced(timeoutWs)}`,
  tracePath: findTrace(timeoutWs, "1"),
  layer: REAL ? "real-gemini" : "stub",
});

const factWs = scaffoldWorkspace(scratch, "padm-factguard", {
  narrativeState: {
    schemaVersion: 1,
    workspaceId: "padm-factguard",
    canon: [{
      id: "canon:dead",
      kind: "canon",
      fact: "叶尘已死，不得再出场",
      category: "entity",
      sourceChapter: "ch0",
      sourceRef: "ch0#canon:dead",
      confidence: 1,
      lastUpdated: "2026-08-01T00:00:00.000Z",
    }],
  },
});
const fact = invokeChapter(scratch, "padm-factguard", "1", 1);
record({
  id: "factguard",
  scenario: "FactGuard 阻断",
  passed: fact.status !== 0 && !chapterSaved(factWs, "1") && !stateAdvanced(factWs),
  detail: `exit=${fact.status} saved=${chapterSaved(factWs, "1")}`,
  tracePath: findTrace(factWs, "1"),
  layer: REAL ? "real-gemini" : "stub",
});

const styleWs = scaffoldWorkspace(scratch, "padm-style", {
  editorialGuidance: [],
  usagePolicy: { fullChapterOptimization: "required" },
});
const style = invokeChapter(scratch, "padm-style", "1", 1);
record({
  id: "style-fail",
  scenario: "风格优化失败",
  passed: style.status !== 0 && !chapterSaved(styleWs, "1"),
  detail: `exit=${style.status} saved=${chapterSaved(styleWs, "1")}`,
  tracePath: findTrace(styleWs, "1"),
  layer: REAL ? "real-gemini" : "stub",
});

const emptyWs = scaffoldWorkspace(scratch, "padm-empty");
const empty = invokeChapter(scratch, "padm-empty", "1", 1, {
  PINOVEL_EVAL_SYNTHETIC_FAULTS: "empty_output",
});
record({
  id: "empty",
  scenario: "空结果/模型错误",
  passed: empty.status !== 0 && !chapterSaved(emptyWs, "1"),
  detail: `exit=${empty.status} saved=${chapterSaved(emptyWs, "1")}`,
  tracePath: findTrace(emptyWs, "1"),
  layer: REAL ? "real-gemini" : "stub",
});

const report = {
  generatedAt: new Date().toISOString(),
  real: REAL,
  productionComplete: false,
  samples,
  traceRetention: samples.every((s) => Boolean(s.tracePath) && existsSync(s.tracePath)),
};
writeJson(join(OUT_DIR, "production-admission-replay.json"), report);
writeFileSync(join(OUT_DIR, "production-admission-replay.md"), [
  "# Production Admission Replay",
  "",
  `- real: ${REAL}`,
  `- productionComplete: false`,
  ...samples.map((s) => `- ${s.passed ? "PASS" : "FAIL"} ${s.id}: ${s.detail} trace=${s.tracePath ?? "none"}`),
  "",
].join("\n"), "utf8");

const failed = samples.filter((s) => !s.passed);
console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.map((s) => s.id), out: OUT_DIR }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
