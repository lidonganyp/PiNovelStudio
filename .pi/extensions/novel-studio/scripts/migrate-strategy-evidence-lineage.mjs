#!/usr/bin/env node
/**
 * Historical strategy-evidence migration / quarantine report.
 *
 * USER-FEEDBACK-EVIDENCE-PIPELINE-1 Phase 8:
 * - Do NOT silently invent missing lineage fields
 * - Records without complete lineage go to quarantine report
 * - Optional dry-run by default
 *
 * Usage:
 *   node scripts/migrate-strategy-evidence-lineage.mjs --workspace <id> [--project-root <path>] [--apply]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> novel-studio -> extensions -> .pi -> repo root
const DEFAULT_PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");

function parseArgs(argv) {
  const out = { apply: false, projectRoot: DEFAULT_PROJECT_ROOT, workspace: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--workspace") out.workspace = argv[++i];
    else if (a === "--project-root") out.projectRoot = argv[++i];
  }
  return out;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function hasCompleteLineage(record) {
  return (
    isNonEmptyString(record.orchestratorRunId) &&
    isNonEmptyString(record.strategyId) &&
    isNonEmptyString(record.modelVersion) &&
    isNonEmptyString(record.sourceChapter) &&
    isNonEmptyString(record.evidenceId) &&
    // extended lineage fields (new pipeline)
    isNonEmptyString(record.candidateId) &&
    isNonEmptyString(record.strategyBundleId) &&
    isNonEmptyString(record.exposureId) &&
    isNonEmptyString(record.promptBundleId)
  );
}

function loadArtifact(path) {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.records)) return null;
  return raw;
}

function migrateWorkspace(projectRoot, workspaceId, apply) {
  const wsDir = join(projectRoot, "workspaces", workspaceId);
  const candidates = [
    join(wsDir, "strategy-evidence", "evidence.json"),
    join(wsDir, "strategy-evidence.json"),
  ];

  const report = {
    workspaceId,
    scannedFiles: [],
    totalRecords: 0,
    completeLineage: 0,
    quarantined: [],
    migrated: [],
    apply,
    generatedAt: new Date().toISOString(),
  };

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    report.scannedFiles.push(filePath);
    const artifact = loadArtifact(filePath);
    if (!artifact) continue;

    const nextRecords = [];
    for (const record of artifact.records) {
      report.totalRecords += 1;
      if (hasCompleteLineage(record) && !record.quarantined && !record.revoked) {
        report.completeLineage += 1;
        nextRecords.push(record);
        continue;
      }

      // incomplete lineage => quarantine (do not invent fields)
      const quarantined = {
        ...record,
        quarantined: true,
        quarantineReason:
          record.quarantineReason ??
          "historical evidence missing complete StrategyExposure lineage; isolated pending manual backfill",
      };
      report.quarantined.push({
        evidenceId: record.evidenceId,
        strategyId: record.strategyId,
        modelVersion: record.modelVersion,
        sourceFile: filePath,
      });
      nextRecords.push(quarantined);
      report.migrated.push(record.evidenceId);
    }

    if (apply) {
      const outPath = filePath;
      const tmp = outPath + ".tmp";
      writeFileSync(
        tmp,
        JSON.stringify({ ...artifact, records: nextRecords }, null, 2),
        "utf-8",
      );
      // atomic-ish on win: write then rename via copy overwrite
      writeFileSync(outPath, readFileSync(tmp, "utf-8"), "utf-8");
    }
  }

  const reportDir = join(wsDir, "strategy-evidence");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(
    reportDir,
    `lineage-migration-report-${apply ? "apply" : "dryrun"}.json`,
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  report.reportPath = reportPath;
  return report;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.workspace) {
    // scan all workspaces
    const workspacesRoot = join(args.projectRoot, "workspaces");
    if (!existsSync(workspacesRoot)) {
      console.error("no workspaces dir:", workspacesRoot);
      process.exit(1);
    }
    const ids = readdirSync(workspacesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const reports = ids.map((id) => migrateWorkspace(args.projectRoot, id, args.apply));
    const summary = {
      apply: args.apply,
      workspaceCount: reports.length,
      totalRecords: reports.reduce((s, r) => s + r.totalRecords, 0),
      completeLineage: reports.reduce((s, r) => s + r.completeLineage, 0),
      quarantined: reports.reduce((s, r) => s + r.quarantined.length, 0),
      reports: reports.map((r) => r.reportPath),
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const report = migrateWorkspace(args.projectRoot, args.workspace, args.apply);
  console.log(JSON.stringify(report, null, 2));
}

main();
