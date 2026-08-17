/**
 * Production-admission replay for novel_generate_chapter.
 *
 * Isolated workspace only. Default invoker is scripts/production-generate-chapter.mjs.
 * --stub uses V2_FORCE_STUB (deterministic, not production-submit evidence).
 * --real uses default Gemini production routing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
    kind: "fingerprint",
    author: `${workspaceId}-author`,
    guidance: "短句，少比喻，不写内心独白口号。",
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(ws, "series", "outline.md"), "# 高层背景\n外门试炼。\n", "utf8");
  if (extras.narrativeState) {
    writeFileSync(
      join(ws, "narrative-state-store.json"),
      `${JSON.stringify(extras.narrativeState, null, 2)}\n`,
      "utf8",
    );
  }
  return ws;
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
      ...env,
    },
    timeout: REAL ? 900000 : 120000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error) : null,
  };
}

function findTrace(ws, chapterId) {
  const tracesDir = join(ws, "traces");
  if (!existsSync(tracesDir)) return null;
  const hit = readdirSync(tracesDir).find((name) =>
    name.includes(String(chapterId)) && name.endsWith("-quality-trace.json"),
  );
  return hit ? join(tracesDir, hit) : null;
}

mkdirSync(OUT_DIR, { recursive: true });
const scratch = join(OUT_DIR, "scratch");
mkdirSync(scratch, { recursive: true });

const samples = [];

function record(sample) {
  samples.push(sample);
  console.log(`[${sample.passed ? "PASS" : "FAIL"}] ${sample.id}: ${sample.detail}`);
}

const successWs = scaffoldWorkspace(scratch, "padm-success");
const success = invokeChapter(scratch, "padm-success", "1", 1);
const successTrace = findTrace(successWs, "1");
record({
  id: "success",
  scenario: "正常成功",
  passed: REAL ? success.status === 0 && Boolean(successTrace) : success.status !== 2,
  detail: `exit=${success.status} trace=${successTrace ?? "none"}`,
  tracePath: successTrace,
  layer: REAL ? "real-gemini" : "stub",
  stdoutTail: success.stdout.slice(-400),
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
  passed: fact.status !== 2 && !existsSync(join(factWs, "chapters", "1.md")),
  detail: `exit=${fact.status} chapterSaved=${existsSync(join(factWs, "chapters", "1.md"))}`,
  tracePath: findTrace(factWs, "1"),
  layer: REAL ? "real-gemini" : "stub",
});

const timeout = invokeChapter(scratch, "padm-success", "2", 2, {
  PINOVEL_MODEL_REQUEST_TIMEOUT_MS: "1",
});
record({
  id: "timeout",
  scenario: "模型 timeout",
  passed: timeout.status !== 0,
  detail: `exit=${timeout.status}`,
  layer: REAL ? "real-gemini" : "stub",
  stdoutTail: timeout.stdout.slice(-400),
});

const report = {
  generatedAt: new Date().toISOString(),
  real: REAL,
  productionComplete: false,
  note: REAL
    ? "Real Gemini production-like samples. Success is not literary approval."
    : "Stub harness only. Not production-submit evidence.",
  samples,
  traceRetention: samples.every((s) => !s.tracePath || existsSync(s.tracePath)),
};
writeJson(join(OUT_DIR, "production-admission-replay.json"), report);
writeFileSync(join(OUT_DIR, "production-admission-replay.md"), [
  "# Production Admission Replay",
  "",
  `- real: ${REAL}`,
  `- productionComplete: false`,
  ...samples.map((s) => `- ${s.passed ? "PASS" : "FAIL"} ${s.id}: ${s.detail}`),
  "",
].join("\n"), "utf8");

const failed = samples.filter((s) => !s.passed);
console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.map((s) => s.id), out: OUT_DIR }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
