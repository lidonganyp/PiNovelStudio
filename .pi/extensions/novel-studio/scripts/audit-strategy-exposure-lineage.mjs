#!/usr/bin/env node
/**
 * Audit StrategyExposure lineage on real workspace quality traces.
 *
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1:
 * Scans workspaces/{id}/traces/{chapter}-quality-trace.json and reports whether
 * strategyContext carries complete canonical lineage fields required
 * by public feedback ingestion.
 *
 * Usage:
 *   node scripts/audit-strategy-exposure-lineage.mjs [--project-root <path>] [--workspace <id>]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> novel-studio -> extensions -> .pi -> repo root (PiNovelStudio)
const DEFAULT_ROOT = join(__dirname, "..", "..", "..", "..");

const REQUIRED = [
  "modelVersion",
  "orchestratorRunId",
  "candidateId",
  "strategyBundleId",
  "exposureId",
  "promptBundleId",
  "sourceChapter",
];

function parseArgs(argv) {
  const out = { projectRoot: DEFAULT_ROOT, workspace: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project-root") out.projectRoot = argv[++i];
    else if (argv[i] === "--workspace") out.workspace = argv[++i];
  }
  return out;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function collectStrategyContexts(doc) {
  const found = [];
  if (!doc || typeof doc !== "object") return found;
  const root = doc;
  if (root.strategyContext) found.push(root.strategyContext);
  if (Array.isArray(root.records)) {
    for (const r of root.records) {
      if (r && typeof r === "object" && r.strategyContext) found.push(r.strategyContext);
    }
  }
  if (Array.isArray(root.traceRecords)) {
    for (const r of root.traceRecords) {
      if (r && typeof r === "object" && r.strategyContext) found.push(r.strategyContext);
    }
  }
  if (Array.isArray(root.gates)) {
    for (const g of root.gates) {
      const evidence = g?.evidence;
      if (evidence?.strategyContext) found.push(evidence.strategyContext);
      const selection = evidence?.stageResults?.authorStyleStrategySelection;
      if (selection) found.push(selection);
    }
  }
  return found;
}

function scoreContext(ctx) {
  const missing = REQUIRED.filter((k) => !isNonEmptyString(ctx?.[k]));
  const selectedStrategyIds = Array.isArray(ctx?.selectedStrategyIds)
    ? ctx.selectedStrategyIds.filter((x) => isNonEmptyString(x))
    : [];
  return {
    complete: missing.length === 0,
    missing,
    modelVersion: ctx?.modelVersion ?? null,
    selectedStrategyIds,
    strategyBundleId: ctx?.strategyBundleId ?? null,
    orchestratorRunId: ctx?.orchestratorRunId ?? null,
    exposureId: ctx?.exposureId ?? null,
  };
}

function listTraceFiles(projectRoot, workspaceFilter) {
  const wsRoot = join(projectRoot, "workspaces");
  if (!existsSync(wsRoot)) return [];
  const workspaces = readdirSync(wsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => !workspaceFilter || id === workspaceFilter);

  const files = [];
  for (const id of workspaces) {
    const tracesDir = join(wsRoot, id, "traces");
    if (!existsSync(tracesDir)) continue;
    for (const name of readdirSync(tracesDir)) {
      if (!name.endsWith("-quality-trace.json")) continue;
      const full = join(tracesDir, name);
      if (!statSync(full).isFile()) continue;
      files.push({ workspaceId: id, path: full, name });
    }
  }
  return files;
}

function main() {
  const args = parseArgs(process.argv);
  const traces = listTraceFiles(args.projectRoot, args.workspace);
  const results = [];

  for (const t of traces) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(t.path, "utf8"));
    } catch (e) {
      results.push({
        workspaceId: t.workspaceId,
        trace: t.name,
        path: t.path,
        ok: false,
        error: `parse_failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const contexts = collectStrategyContexts(parsed);
    if (contexts.length === 0) {
      results.push({
        workspaceId: t.workspaceId,
        trace: t.name,
        path: t.path,
        ok: false,
        error: "no_strategy_context",
        contexts: 0,
      });
      continue;
    }

    // Use the last context (most final)
    const scored = scoreContext(contexts[contexts.length - 1]);
    results.push({
      workspaceId: t.workspaceId,
      trace: t.name,
      path: t.path,
      ok: scored.complete,
      contexts: contexts.length,
      ...scored,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    projectRoot: args.projectRoot,
    workspaceFilter: args.workspace,
    totalTraces: results.length,
    completeLineage: results.filter((r) => r.ok).length,
    incompleteLineage: results.filter((r) => !r.ok).length,
    completeRate:
      results.length === 0
        ? null
        : results.filter((r) => r.ok).length / results.length,
    results,
  };

  const outDir = join(args.projectRoot, "reports", "feedback-lineage-audit");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `strategy-exposure-audit-${args.workspace ?? "all"}.json`,
  );
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  summary.reportPath = outPath;
  console.log(JSON.stringify(summary, null, 2));
}

main();
