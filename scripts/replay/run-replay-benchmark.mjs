/**
 * Run replay cases through novel_generate_chapter.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "../..");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1]?.startsWith("--") ? "true" : argv[index + 1] ?? "true";
    args.set(key.slice(2), value);
    if (value !== "true") index += 1;
  }
  return args;
}

function collectCaseFiles(casesPath) {
  const resolved = resolve(casesPath);
  if (!existsSync(resolved)) {
    throw new Error(`Cases path not found: ${resolved}`);
  }
  if (extname(resolved).toLowerCase() === ".json") {
    return [resolved];
  }
  return readdirSync(resolved)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(resolved, name));
}

const args = parseArgs(process.argv.slice(2));
const casesPath = args.get("cases");
const runId = args.get("run-id");
const runRoot = args.get("run-root");
const mockAgent = args.has("mock");
const invokeTimeoutMs = parseOptionalPositiveInteger(args.get("invoke-timeout-ms"), "invoke-timeout-ms");

if (!casesPath) {
  console.error("Usage: node scripts/replay/run-replay-benchmark.mjs --cases <case-file-or-dir> [--run-id id] [--run-root dir] [--invoke-timeout-ms ms] [--mock]");
  console.error("Replay invoke timeout defaults to 600000ms; override with --invoke-timeout-ms or PINOVEL_REPLAY_INVOKE_TIMEOUT_MS.");
  process.exit(1);
}

function parseOptionalPositiveInteger(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid --${name}: expected a positive integer number of milliseconds.`);
    process.exit(1);
  }
  return Math.floor(parsed);
}

const modulePath = resolve(projectRoot, ".pi/extensions/novel-studio/dist-eval/eval/replay-runner.js");
const { runReplayCases } = await import(pathToFileURL(modulePath).href);

try {
  const summary = await runReplayCases({
    projectRoot,
    cases: collectCaseFiles(casesPath),
    runId,
    runRoot: runRoot ? resolve(runRoot) : undefined,
    mockAgent,
    invokeTimeoutMs,
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
