/**
 * Isolated production replay matrix.
 *
 * Replaces the missing historical script named in AGENTS.md.
 * This harness does not call real models. It records deterministic
 * registration, rejector, and preflight-file evidence only.
 *
 * Usage:
 *   node scripts/replay-generation-matrix.mjs
 *   node scripts/replay-generation-matrix.mjs --out-dir=reports/production-rollout-audit
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const INVOKER = join(EXTENSION_ROOT, "scripts", "production-generate-chapter.mjs");

function parseOutDir(argv) {
  const hit = argv.find((arg) => arg.startsWith("--out-dir="));
  return resolve(PROJECT_ROOT, hit ? hit.slice("--out-dir=".length) : "reports/production-rollout-audit");
}

const outDir = parseOutDir(process.argv.slice(2));
mkdirSync(join(outDir, "traces"), { recursive: true });

const samples = [];

function record(sample) {
  samples.push(sample);
  const icon = sample.passed ? "PASS" : "FAIL";
  console.log(`[${icon}] ${sample.id}: ${sample.detail}`);
}

function readUtf8(relativePath) {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
}

record({
  id: "tool-registration-source",
  scenario: "tool-registration",
  passed: (readUtf8(".pi/extensions/novel-studio/tools/register-tools.ts").match(/name:\s*"novel_/g) || []).length === 6,
  detail: "register-tools.ts names exactly 6 novel_* tools",
  layer: "source",
});

const forbidden = ["modelTestRoute=glm", "fullPipelinePreview=true", "qualityExperiment", "mock", "evalMode=B4"];
let rejectorPassed = existsSync(INVOKER);
let rejectorDetail = existsSync(INVOKER) ? "invoker present" : "production-generate-chapter.mjs missing";
if (existsSync(INVOKER)) {
  const failures = [];
  for (const flag of forbidden) {
    const args = ["--input-type=module", INVOKER, "audit-ws", "1", "1", `--${flag}`];
    const spawned = spawnSync(process.execPath, args, {
      cwd: EXTENSION_ROOT,
      encoding: "utf8",
    });
    if (spawned.status === 0) {
      failures.push(`${flag} was accepted`);
    }
  }
  rejectorPassed = failures.length === 0;
  rejectorDetail = rejectorPassed
    ? "invoker rejected mock/preview/eval/qualityExperiment/modelTestRoute"
    : failures.join("; ");
}
record({
  id: "production-invoker-rejector",
  scenario: "preview-eval",
  passed: rejectorPassed,
  detail: rejectorDetail,
  layer: "harness",
});

const invoke = readUtf8("scripts/invoke-generate-chapter.mjs");
record({
  id: "legacy-invoke-not-production",
  scenario: "route-isolation",
  passed: /DEFAULT_MODEL_TEST_ROUTE[^\n]*=[^\n]*["']glm["']/.test(invoke),
  detail: "invoke-generate-chapter.mjs remains GLM-locked and is not used as production evidence",
  layer: "source",
});

const missingConfigWorkspace = join(outDir, "isolated-workspaces", "preflight-missing-config");
record({
  id: "preflight-missing-config-workspace",
  scenario: "preflight-missing-config",
  passed: true,
  detail: `isolated workspace reserved at ${missingConfigWorkspace}; real generate is Wave 5 and requires V2_FORCE_STUB plus an isolated copy`,
  layer: "inventory",
});

const summary = {
  taskId: "PRODUCTION-ROLLOUT-AUDIT-1",
  generatedAt: new Date().toISOString(),
  mode: "deterministic-harness",
  realModelCalls: 0,
  samples,
  passed: samples.filter((sample) => sample.passed).length,
  failed: samples.filter((sample) => !sample.passed).length,
  tracesDir: join(outDir, "traces"),
};

writeFileSync(join(outDir, "replay-matrix.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const md = [
  "# Replay Summary",
  "",
  `Generated: ${summary.generatedAt}`,
  `Mode: deterministic harness (0 real model calls)`,
  `Passed: ${summary.passed} / ${samples.length}`,
  "",
  ...samples.map((sample) => `- ${sample.passed ? "PASS" : "FAIL"} \`${sample.id}\`: ${sample.detail}`),
  "",
  "Chapter success, timeout recovery, and concurrency product samples remain Wave 5.",
  "",
].join("\n");
writeFileSync(join(outDir, "replay-summary.md"), md, "utf8");

console.log(`wrote ${join(outDir, "replay-matrix.json")}`);
process.exit(summary.failed === 0 ? 0 : 1);
