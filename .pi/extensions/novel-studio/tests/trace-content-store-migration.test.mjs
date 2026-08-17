/**
 * TRACE-CONTENT-STORE-MIGRATION — 历史明细回填验收（P7 Stage D 发布收口）
 *
 * 验证 scripts/migrate-trace-content-stores.mjs 的迁移语义：
 *   1. quality-trace.json 的 gates[] 完整 evidence → traces/{chapterId}-content.jsonl（追加写）
 *   2. trajectory.jsonl 每行 {type,timestamp,data} → trajectory-content.jsonl（原子写）
 *   3. 幂等：目标内容库已存在且非空 → 跳过（不重复追加）
 *   4. 非破坏：旧文件（quality-trace.json / trajectory.jsonl）绝不删除
 *   5. dry-run（默认）：只出报告，不落盘
 *   6. 畸形 trajectory 行跳过并计数，不影响有效行迁移
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_SCRIPT = join(EXT_DIR, "scripts", "migrate-trace-content-stores.mjs");

function makeTempWorkspace(workspaceId = "ws-migrate") {
  const projectRoot = mkdtempSync(join(tmpdir(), "migrate-"));
  const wsDir = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(join(wsDir, "traces"), { recursive: true });
  mkdirSync(join(wsDir, "novelos-sessions", "sess-1"), { recursive: true });
  return { projectRoot, wsDir };
}

function writeQualityTrace(wsDir, chapterId, gates) {
  const doc = {
    schemaVersion: 1,
    workspaceId: "ws-migrate",
    chapterId,
    createdAt: "2026-08-01T00:00:00.000Z",
    events: [],
    patches: [],
    gates,
  };
  writeFileSync(join(wsDir, "traces", `${chapterId}-quality-trace.json`), JSON.stringify(doc, null, 2), "utf-8");
}

function writeTrajectory(wsDir, sessionId, lines) {
  const raw = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(wsDir, "novelos-sessions", sessionId, "trajectory.jsonl"), raw, "utf-8");
}

function readJsonl(path) {
  return readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

function runMigration(projectRoot, workspaceId, extraArgs = []) {
  const res = spawnSync(
    process.execPath,
    [MIGRATION_SCRIPT, "--project-root", projectRoot, "--workspace", workspaceId, ...extraArgs],
    { encoding: "utf-8" },
  );
  assert.equal(res.status, 0, `迁移脚本应正常退出，stderr=${res.stderr}`);
  return JSON.parse(res.stdout);
}

test("quality-trace 迁移：gates[] 完整 evidence 回填到 content.jsonl，且不删除旧文件", () => {
  const { projectRoot, wsDir } = makeTempWorkspace();
  try {
    const gates = [
      { stage: "v2_preflight", status: "ERROR", passed: false, blocked: true, score: 0, reason: "preflight-block", issueTypes: [], revisionHints: [], evidence: { stage: "preflight", error: { message: "阻断" } } },
      { stage: "v2_final_selected", status: "PASS", passed: true, blocked: false, score: 88, reason: "ok", issueTypes: [], revisionHints: [], evidence: { candidates: [{ id: "c1", text: "候选正文" }] } },
    ];
    writeQualityTrace(wsDir, "1", gates);

    const summary = runMigration(projectRoot, "ws-migrate", ["--apply"]);

    assert.equal(summary.qualityTrace.migrated, 1, "应迁移 1 个章节的 quality-trace");
    assert.equal(summary.qualityTrace.skipped, 0, "无跳过");
    assert.equal(summary.trajectory.migrated, 0, "无 trajectory 数据时不迁移");

    const contentPath = join(wsDir, "traces", "1-content.jsonl");
    assert.equal(existsSync(contentPath), true, "content.jsonl 应已创建");
    const lines = readJsonl(contentPath);
    assert.equal(lines.length, 2, "content.jsonl 应 2 行（每 gate 一行）");
    assert.deepEqual(lines[0], { schemaVersion: 1, stage: "v2_preflight", evidence: gates[0].evidence }, "第 1 行应完整 round-trip evidence");
    assert.deepEqual(lines[1], { schemaVersion: 1, stage: "v2_final_selected", evidence: gates[1].evidence }, "第 2 行应完整 round-trip evidence");

    assert.equal(existsSync(join(wsDir, "traces", "1-quality-trace.json")), true, "旧 quality-trace.json 不得删除");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("trajectory 迁移：trajectory.jsonl 每行回填到 trajectory-content.jsonl，且不删除旧文件", () => {
  const { projectRoot, wsDir } = makeTempWorkspace();
  try {
    const entries = [
      { type: "session_start", timestamp: 1700000000000, data: { sessionId: "sess-1" } },
      { type: "message", timestamp: 1700000000001, data: { role: "assistant", content: "正文片段" } },
    ];
    writeTrajectory(wsDir, "sess-1", entries);

    const summary = runMigration(projectRoot, "ws-migrate", ["--apply"]);

    assert.equal(summary.trajectory.migrated, 1, "应迁移 1 个 session");
    assert.equal(summary.trajectory.skipped, 0, "无跳过");

    const contentPath = join(wsDir, "novelos-sessions", "sess-1", "trajectory-content.jsonl");
    assert.equal(existsSync(contentPath), true, "trajectory-content.jsonl 应已创建");
    const lines = readJsonl(contentPath);
    assert.equal(lines.length, 2, "trajectory-content.jsonl 应 2 行");
    assert.deepEqual(lines[0], { schemaVersion: 1, type: "session_start", timestamp: 1700000000000, data: { sessionId: "sess-1" } }, "第 1 行 round-trip");
    assert.deepEqual(lines[1], { schemaVersion: 1, type: "message", timestamp: 1700000000001, data: { role: "assistant", content: "正文片段" } }, "第 2 行 round-trip");

    assert.equal(existsSync(join(wsDir, "novelos-sessions", "sess-1", "trajectory.jsonl")), true, "旧 trajectory.jsonl 不得删除");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("幂等：内容库已存在且非空 → 重复 --apply 跳过（不重复追加）", () => {
  const { projectRoot, wsDir } = makeTempWorkspace();
  try {
    writeQualityTrace(wsDir, "1", [{ stage: "g1", status: "PASS", passed: true, blocked: false, score: 1, reason: "r", issueTypes: [], revisionHints: [], evidence: { a: 1 } }]);
    writeTrajectory(wsDir, "sess-1", [{ type: "message", timestamp: 1700000000000, data: { content: "x" } }]);

    runMigration(projectRoot, "ws-migrate", ["--apply"]);
    const second = runMigration(projectRoot, "ws-migrate", ["--apply"]);

    assert.equal(second.qualityTrace.migrated, 0, "第二次 quality-trace 迁移应 0");
    assert.equal(second.qualityTrace.skipped, 1, "第二次 quality-trace 应跳过");
    assert.equal(second.trajectory.migrated, 0, "第二次 trajectory 迁移应 0");
    assert.equal(second.trajectory.skipped, 1, "第二次 trajectory 应跳过");

    const traceLines = readJsonl(join(wsDir, "traces", "1-content.jsonl"));
    assert.equal(traceLines.length, 1, "content.jsonl 不得重复追加");
    const trajLines = readJsonl(join(wsDir, "novelos-sessions", "sess-1", "trajectory-content.jsonl"));
    assert.equal(trajLines.length, 1, "trajectory-content.jsonl 不得重复追加");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("dry-run（默认）：不落盘，只报 would-migrate", () => {
  const { projectRoot, wsDir } = makeTempWorkspace();
  try {
    writeQualityTrace(wsDir, "1", [{ stage: "g1", status: "PASS", passed: true, blocked: false, score: 1, reason: "r", issueTypes: [], revisionHints: [], evidence: { a: 1 } }]);
    writeTrajectory(wsDir, "sess-1", [{ type: "message", timestamp: 1700000000000, data: { content: "x" } }]);

    const summary = runMigration(projectRoot, "ws-migrate", []); // 无 --apply

    assert.equal(summary.apply, false, "dry-run 应 apply=false");
    assert.equal(summary.qualityTrace.migrated, 1, "dry-run 应报 would-migrate 计为 migrated");
    assert.equal(existsSync(join(wsDir, "traces", "1-content.jsonl")), false, "dry-run 不得创建 content.jsonl");
    assert.equal(existsSync(join(wsDir, "novelos-sessions", "sess-1", "trajectory-content.jsonl")), false, "dry-run 不得创建 trajectory-content.jsonl");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("畸形 trajectory 行：跳过并计数，有效行仍迁移", () => {
  const { projectRoot, wsDir } = makeTempWorkspace();
  try {
    // 2 行有效 + 1 行畸形 JSON + 1 行缺字段
    const raw = [
      JSON.stringify({ type: "message", timestamp: 1700000000000, data: { content: "a" } }),
      JSON.stringify({ type: "message", timestamp: 1700000000001, data: { content: "b" } }),
      "{ not valid json",
      JSON.stringify({ type: "message", data: { content: "missing-timestamp" } }),
    ].join("\n") + "\n";
    writeFileSync(join(wsDir, "novelos-sessions", "sess-1", "trajectory.jsonl"), raw, "utf-8");

    const summary = runMigration(projectRoot, "ws-migrate", ["--apply"]);

    assert.equal(summary.trajectory.migrated, 1, "有效行应触发迁移");
    assert.equal(summary.trajectory.malformedLines, 2, "2 行畸形应被计数");

    const lines = readJsonl(join(wsDir, "novelos-sessions", "sess-1", "trajectory-content.jsonl"));
    assert.equal(lines.length, 2, "仅 2 行有效 entry 迁移");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
