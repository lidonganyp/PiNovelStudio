#!/usr/bin/env node
/**
 * Real chapter feedback pipeline E2E:
 * existing quality-trace → novel_strategy_feedback → ledger → recompute
 *
 * Usage:
 *   node scripts/real-feedback-pipeline-e2e.mjs <workspaceId> <chapterNumber> [strategyId]
 */

import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");

const workspaceId = process.argv[2] || "xinmo";
const chapterNumber = parseInt(process.argv[3] || "22", 10);
const strategyIdArg = process.argv[4];

const workspaceDir = join(PROJECT_ROOT, "workspaces", workspaceId);
const tracePath = join(workspaceDir, "traces", `${chapterNumber}-quality-trace.json`);
if (!existsSync(tracePath)) {
  console.error("missing trace:", tracePath);
  process.exit(1);
}

// Load production extension for handleStrategyFeedback path consistency
const extPath = join(EXTENSION_ROOT, "dist", "index.js");
const extModule = await import(pathToFileURL(extPath).href);
const registeredTools = {};
const pi = {
  registerTool(toolDef) {
    registeredTools[toolDef.name] = toolDef;
    return toolDef;
  },
  registerCommand() {},
  on() {},
  ui: { notify() {} },
};
extModule.default(pi);

const feedbackTool = registeredTools["novel_strategy_feedback"];
if (!feedbackTool) {
  console.error("novel_strategy_feedback not registered");
  process.exit(1);
}

// Prefer strategy from trace if available, else default
let strategyId = strategyIdArg || "voice_emphasis";
const trace = JSON.parse(readFileSync(tracePath, "utf8"));
for (const gate of trace.gates || []) {
  const sc = gate?.evidence?.strategyContext;
  if (Array.isArray(sc?.selectedStrategyIds) && sc.selectedStrategyIds.length > 0) {
    strategyId = sc.selectedStrategyIds[0];
  }
}

console.log("=".repeat(70));
console.log(`Real feedback E2E — ${workspaceId} ch${chapterNumber}`);
console.log("=".repeat(70));
console.log({ workspaceId, chapterNumber, strategyId, tracePath });

const result = await feedbackTool.execute(
  `real-feedback-${workspaceId}-${chapterNumber}-${Date.now()}`,
  {
    workspaceId,
    chapterId: String(chapterNumber),
    action: "choice",
    strategyId,
    chosen: "editorial",
    note: "real e2e accept editorial for lineage audit",
  },
  undefined,
  () => {},
  { cwd: PROJECT_ROOT, ui: pi.ui },
);

const details = result.details || result;
console.log("\n[feedback result]");
console.log(JSON.stringify({
  status: details.status,
  modelVersion: details.modelVersion,
  strategyId: details.strategyId,
  recorded: details.result?.recorded,
  outcome: details.result?.outcome,
  lineageAudit: details.lineageAudit,
  isError: result.isError,
}, null, 2));

const ledgerPath = join(
  workspaceDir,
  "strategy-evidence",
  "feedback-evidence-ledger.json",
);
const policyPath = join(workspaceDir, "strategy-policy.json");

const report = {
  generatedAt: new Date().toISOString(),
  workspaceId,
  chapterNumber,
  strategyId,
  feedbackStatus: details.status,
  recorded: details.result?.recorded === true,
  outcome: details.result?.outcome ?? null,
  lineageComplete: details.lineageAudit?.complete === true,
  ledgerAppended: details.lineageAudit?.ledgerAppended ?? 0,
  ledgerExists: existsSync(ledgerPath),
  policyExists: existsSync(policyPath),
  ledgerPath,
  policyPath,
  modelVersion: details.modelVersion ?? null,
};

if (existsSync(ledgerPath)) {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  report.ledgerEvents = ledger.events?.length ?? 0;
  report.lastEvent = ledger.events?.[ledger.events.length - 1] ?? null;
}
if (existsSync(policyPath) && details.modelVersion) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  report.reputation = policy.partitions?.[details.modelVersion]?.[strategyId] ?? null;
}

const outDir = join(PROJECT_ROOT, "reports", "feedback-lineage-audit");
mkdirSync(outDir, { recursive: true });
const outPath = join(
  outDir,
  `real-feedback-e2e-${workspaceId}-ch${chapterNumber}.json`,
);
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log("\n[report]", outPath);
console.log(JSON.stringify(report, null, 2));

if (!report.recorded || !report.lineageComplete || !report.ledgerExists) {
  process.exit(2);
}
