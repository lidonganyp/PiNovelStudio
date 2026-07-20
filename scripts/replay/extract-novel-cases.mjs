/**
 * Extract compact replay cases from a source novel file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

const args = parseArgs(process.argv.slice(2));
const input = args.get("input");
const bookId = args.get("book-id");
const output = args.get("output") ?? resolve(projectRoot, ".pi/replay-runs/cases");
const maxCases = args.has("max-cases") ? Number(args.get("max-cases")) : undefined;

if (!input || !bookId) {
  console.error("Usage: node scripts/replay/extract-novel-cases.mjs --input <file> --book-id <id> [--output <dir>] [--max-cases 30]");
  process.exit(1);
}

const inputPath = resolve(input);
if (!existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const modulePath = resolve(projectRoot, ".pi/extensions/novel-studio/dist-eval/eval/replay-case-extractor.js");
const { decodeNovelSourceBuffer, extractReplayCasesFromText, writeReplayCases } = await import(pathToFileURL(modulePath).href);
const decoded = decodeNovelSourceBuffer(readFileSync(inputPath));
const cases = extractReplayCasesFromText(decoded.text, {
  bookId,
  sourcePath: inputPath,
  maxCases: Number.isFinite(maxCases) ? maxCases : undefined,
});
const result = writeReplayCases(cases, resolve(output));

console.log(JSON.stringify({ totalCases: cases.length, sourceEncoding: decoded.encoding, outputDir: result.outputDir, files: result.files }, null, 2));
