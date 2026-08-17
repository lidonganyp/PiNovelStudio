/**
 * Production acceptance invoker for novel_generate_chapter.
 *
 * Captures only the registered public tool. Rejects mock, preview, eval,
 * qualityExperiment, and modelTestRoute. Does not inject GLM.
 *
 * Usage:
 *   node scripts/production-generate-chapter.mjs <workspaceId> <chapterId> <chapterNumber>
 *        [--writer-model=gemini31|claude] [--project-root=<isolatedRoot>]
 *
 * V2_FORCE_STUB=1 is allowed for isolated deterministic runs. It is not
 * production submit evidence.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = resolve(__dirname, "..");
const DEFAULT_PROJECT_ROOT = resolve(EXTENSION_ROOT, "..", "..", "..");

const FORBIDDEN_FLAGS = [
  "modelTestRoute", // rejected: modelTestRoute is forbidden
  "fullPipelinePreview", // rejected: fullPipelinePreview is forbidden
  "previewOnly", // rejected: previewOnly is forbidden
  "qualityExperiment", // rejected: qualityExperiment is forbidden
  "mockAgent", // rejected: mockAgent is forbidden
  "evalMode", // rejected: evalMode is forbidden
  "boundedBestOf3", // rejected: boundedBestOf3 is forbidden
  "generationMode",
  "stopAfterV2Stage",
  "styleShaperRoute",
  "chineseNaturalizerRoute",
];

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) flags[arg.slice(2)] = "true";
      else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function reject(message) {
  console.error(`[production-generate-chapter] rejected: ${message}`);
  process.exit(2);
}

const { positional, flags } = parseArgs(process.argv.slice(2));

for (const flag of FORBIDDEN_FLAGS) {
  const kebab = flag.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
  if (flags[flag] !== undefined || flags[kebab] !== undefined) {
    reject(`${flag} is forbidden on the production acceptance invoker`);
  }
}

if (flags.mock === "true" || flags.mock === "mock") {
  reject("mockAgent is forbidden on the production acceptance invoker");
}

if (positional.includes("mock") || positional.includes("true")) {
  reject("mock positional argument is not allowed");
}

const writerModel = flags["writer-model"] ?? flags.writerModel;
if (writerModel && writerModel !== "gemini31" && writerModel !== "claude") {
  reject(`writerModel=${writerModel} is not allowed; use omitted/gemini31/claude`);
}

const workspaceId = positional[0];
const chapterId = positional[1];
const chapterNumber = Number(positional[2]);
if (!workspaceId || !chapterId || !Number.isFinite(chapterNumber) || chapterNumber < 1) {
  reject("usage: node production-generate-chapter.mjs <workspaceId> <chapterId> <chapterNumber> [--writer-model=gemini31|claude] [--project-root=<path>]");
}

const projectRoot = flags["project-root"]
  ? resolve(flags["project-root"])
  : DEFAULT_PROJECT_ROOT;
process.env.PROJECT_ROOT = projectRoot;

const extPath = resolve(EXTENSION_ROOT, "dist", "index.js");
if (!existsSync(extPath)) {
  reject(`production build missing: ${extPath}`);
}

const extModule = await import(pathToFileURL(extPath).href);
const tools = [];
extModule.default({
  registerTool: (tool) => tools.push(tool),
  registerCommand: () => {},
  on: () => {},
});

if (tools.length !== 6) {
  reject(`expected exactly 6 public tools, got ${tools.length}: ${tools.map((tool) => tool.name).join(", ")}`);
}

const generateChapterTool = tools.find((tool) => tool.name === "novel_generate_chapter");
if (!generateChapterTool) {
  reject("novel_generate_chapter is not registered");
}

const params = {
  workspaceId,
  chapterId: String(chapterId),
  chapterNumber,
};
if (writerModel === "claude" || writerModel === "gemini31") {
  params.writerModel = writerModel;
}

console.log(
  `[production-generate-chapter] workspace=${workspaceId} chapter=${chapterId} writerModel=${writerModel ?? "default-gemini31"} projectRoot=${projectRoot}`,
);

const result = await generateChapterTool.execute(
  `production-generate-${chapterId}-${Date.now()}`,
  params,
  undefined,
  undefined,
  { cwd: projectRoot },
);

const details = result?.details ?? result;
console.log(JSON.stringify(details, null, 2));

if (details?.status === "ok") {
  process.exit(0);
}
process.exit(1);
