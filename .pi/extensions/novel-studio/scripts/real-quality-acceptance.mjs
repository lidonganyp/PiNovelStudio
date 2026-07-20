/**
 * Verify real quality evidence for the 2026-07-18 optimization tasks.
 *
 * Usage:
 *   node scripts/real-quality-acceptance.mjs --kind language --input evidence.json
 *   node scripts/real-quality-acceptance.mjs --kind ending --input evidence.json
 *   node scripts/real-quality-acceptance.mjs --kind benchmark --input evidence.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  verifyCleanModelBenchmark,
  verifyEndingPressureReal,
  verifyLanguageCalibrationReal,
} from "../dist-eval/v2/core/real-quality-acceptance.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    args[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.kind || !args.input) {
    throw new Error("需要 --kind language|ending|benchmark 和 --input <json>");
  }
  const inputPath = resolve(args.input);
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  let result;
  if (args.kind === "language") {
    result = verifyLanguageCalibrationReal(input.samples ?? input);
  } else if (args.kind === "ending") {
    result = verifyEndingPressureReal(input.samples ?? input);
  } else if (args.kind === "benchmark") {
    result = verifyCleanModelBenchmark(input);
  } else {
    throw new Error(`未知 kind: ${args.kind}`);
  }
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    writeFileSync(resolve(args.output), output, "utf8");
  }
  process.stdout.write(output);
  process.exitCode = result.accepted ? 0 : 2;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

