#!/usr/bin/env node
/**
 * TRACE-CONTENT-STORE-MIGRATION — 历史明细回填（P7 Stage D 发布收口）
 *
 * 用户方向（三方分离）发布后的历史数据收敛：Stage C-1/C-3 把写路径切到
 * projection（完整明细进独立内容库，legacy 文件降为投影缓存），但切换前已落盘
 * 的章节/轨迹仍在旧文件里承载完整明细。本脚本把那些历史完整明细回填进内容库，
 * 让内容库成为全量权威明细源，旧文件从此可安全视作可重建投影缓存。
 *
 * 迁移对象（两项，均非破坏性，绝不删除旧文件）：
 *   1. quality-trace：workspaces/{ws}/traces/{chapterId}-quality-trace.json 的
 *      gates[] 完整 evidence → traces/{chapterId}-content.jsonl（追加写，与
 *      TraceContentStore.writeGate 对齐）。
 *   2. trajectory：workspaces/{ws}/novelos-sessions/{sessionId}/trajectory.jsonl
 *      每行 {type,timestamp,data} → trajectory-content.jsonl（原子写，与
 *      TrajectoryContentStore.writeAll 对齐）。
 *
 * 幂等语义：目标内容库文件已存在且非空 → 跳过（视为已迁移 / 已被新写路径接管）。
 * 中断恢复：若 --apply 中途被中断留下部分 content.jsonl，删除该文件后重跑即可
 * （内容库为 write-only，脚本不自动删除）。
 *
 * 依赖：须先 `npm run build`（脚本 import 编译产物 dist/v2/core/audit/*）。
 *
 * Usage:
 *   node scripts/migrate-trace-content-stores.mjs [--workspace <id>] [--project-root <path>] [--apply]
 *   （不带 --apply 为 dry-run，只出报告不落盘）
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTraceContentStore } from "../dist/v2/core/audit/trace-content-store.js";
import { createTrajectoryContentStore } from "../dist/v2/core/audit/trajectory-content-store.js";

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

/** 目标内容库文件是否已存在且非空（幂等哨兵）。 */
function isPopulated(path) {
  try {
    return existsSync(path) && readFileSync(path, "utf-8").trim().length > 0;
  } catch {
    return false;
  }
}

/** 加载 quality-trace.json；结构不合法 / 非 schemaVersion 1 返回 null。 */
function loadQualityTraceDocument(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 解析 trajectory.jsonl 行 → {type,timestamp,data}[]；跳过畸形行并计数。
 * 返回 { entries, malformed }。
 */
function parseTrajectoryLines(path) {
  const raw = readFileSync(path, "utf-8");
  const entries = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.type === "string" && typeof o.timestamp === "number") {
        entries.push({ type: o.type, timestamp: o.timestamp, data: o.data });
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

/** 迁移单个 workspace 的 quality-trace 明细。 */
function migrateQualityTrace(projectRoot, workspaceId, apply) {
  const workspaceRoot = join(projectRoot, "workspaces", workspaceId);
  const tracesDir = join(workspaceRoot, "traces");
  const result = { scannedFiles: 0, migrated: 0, skipped: 0, errors: 0, chapters: [] };
  if (!existsSync(tracesDir)) return result;

  const files = readdirSync(tracesDir).filter((f) => /-quality-trace\.json$/.test(f));
  result.scannedFiles = files.length;

  for (const file of files) {
    const chapterId = file.replace(/-quality-trace\.json$/, "");
    const contentPath = join(tracesDir, `${chapterId}-content.jsonl`);
    const doc = loadQualityTraceDocument(join(tracesDir, file));
    if (!doc) {
      result.skipped++;
      result.chapters.push({ chapterId, action: "skip-invalid-doc" });
      continue;
    }
    const gates = Array.isArray(doc.gates) ? doc.gates : [];
    if (isPopulated(contentPath)) {
      result.skipped++;
      result.chapters.push({ chapterId, action: "skip-existing", gates: gates.length });
      continue;
    }
    if (gates.length === 0) {
      result.skipped++;
      result.chapters.push({ chapterId, action: "skip-no-gates" });
      continue;
    }
    if (!apply) {
      result.migrated++;
      result.chapters.push({ chapterId, action: "would-migrate", gates: gates.length });
      continue;
    }
    const store = createTraceContentStore({
      // workspacePath 为 workspace 父目录（与 QualityTraceRecorder.workspacePath 一致），
      // 内容库输出路径 = workspacePath/{workspaceId}/traces/{chapterId}-content.jsonl。
      workspacePath: join(projectRoot, "workspaces"),
      workspaceId,
      chapterId,
    });
    let wrote = 0;
    for (const gate of gates) {
      if (gate && typeof gate.stage === "string") {
        if (store.writeGate(gate.stage, gate.evidence)) wrote++;
      }
    }
    if (wrote > 0) {
      result.migrated++;
      result.chapters.push({ chapterId, action: "migrated", gates: wrote });
    } else {
      result.errors++;
      result.chapters.push({
        chapterId,
        action: "error",
        error: store.getLastWriteError()?.message ?? "no gates written",
      });
    }
  }
  return result;
}

/** 迁移单个 workspace 的 trajectory 明细。 */
function migrateTrajectory(projectRoot, workspaceId, apply) {
  const sessionsDir = join(projectRoot, "workspaces", workspaceId, "novelos-sessions");
  const result = {
    scannedSessions: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    malformedLines: 0,
    sessions: [],
  };
  if (!existsSync(sessionsDir)) return result;

  const sessionIds = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  result.scannedSessions = sessionIds.length;

  for (const sessionId of sessionIds) {
    const trajPath = join(sessionsDir, sessionId, "trajectory.jsonl");
    const contentPath = join(sessionsDir, sessionId, "trajectory-content.jsonl");
    if (!existsSync(trajPath)) {
      result.skipped++;
      result.sessions.push({ sessionId, action: "skip-no-trajectory" });
      continue;
    }
    if (isPopulated(contentPath)) {
      result.skipped++;
      result.sessions.push({ sessionId, action: "skip-existing" });
      continue;
    }
    const { entries, malformed } = parseTrajectoryLines(trajPath);
    result.malformedLines += malformed;
    if (entries.length === 0) {
      result.skipped++;
      result.sessions.push({ sessionId, action: "skip-no-entries", malformed });
      continue;
    }
    if (!apply) {
      result.migrated++;
      result.sessions.push({ sessionId, action: "would-migrate", entries: entries.length });
      continue;
    }
    const store = createTrajectoryContentStore({ projectRoot, workspaceId, sessionId });
    if (store.writeAll(entries)) {
      result.migrated++;
      result.sessions.push({ sessionId, action: "migrated", entries: entries.length });
    } else {
      result.errors++;
      result.sessions.push({
        sessionId,
        action: "error",
        error: store.getLastWriteError()?.message ?? "write failed",
      });
    }
  }
  return result;
}

function migrateWorkspace(projectRoot, workspaceId, apply) {
  return {
    workspaceId,
    apply,
    qualityTrace: migrateQualityTrace(projectRoot, workspaceId, apply),
    trajectory: migrateTrajectory(projectRoot, workspaceId, apply),
  };
}

function main() {
  const args = parseArgs(process.argv);

  const ids = args.workspace
    ? [args.workspace]
    : (existsSync(join(args.projectRoot, "workspaces"))
        ? readdirSync(join(args.projectRoot, "workspaces"), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : []);

  if (ids.length === 0) {
    console.error("no workspaces found under:", join(args.projectRoot, "workspaces"));
    process.exit(1);
  }

  const reports = ids.map((id) => migrateWorkspace(args.projectRoot, id, args.apply));

  const sum = (key, subkey) => reports.reduce((s, r) => s + (r[key][subkey] ?? 0), 0);
  const summary = {
    apply: args.apply,
    workspaceCount: reports.length,
    qualityTrace: {
      scannedFiles: sum("qualityTrace", "scannedFiles"),
      migrated: sum("qualityTrace", "migrated"),
      skipped: sum("qualityTrace", "skipped"),
      errors: sum("qualityTrace", "errors"),
    },
    trajectory: {
      scannedSessions: sum("trajectory", "scannedSessions"),
      migrated: sum("trajectory", "migrated"),
      skipped: sum("trajectory", "skipped"),
      errors: sum("trajectory", "errors"),
      malformedLines: sum("trajectory", "malformedLines"),
    },
    reports,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
