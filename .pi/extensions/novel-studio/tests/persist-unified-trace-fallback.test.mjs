/**
 * persistUnifiedTraceWithFallback — 主 flush 失败备用归档分支
 *
 * 覆盖：
 * 1. 主路径 flush 成功 → status=primary
 * 2. flush 两次返回空 path → status=fallback，写入 reports/traces/*-fallback-*.json
 * 3. adapter 构造即失败 → 仍尝试 fallback
 * 4. 主路径与 fallback 均失败 → status=failed，errors 非空
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { persistUnifiedTraceWithFallback } from "../dist/v2/core/unified-entry.js";

function sampleRecords() {
  return [
    {
      stage: "final_selected",
      timestamp: new Date().toISOString(),
      finalSelection: {
        selectedCandidateId: "c1",
        selectedSource: "rawStage2",
        projectGain: "neutral",
        whySelected: ["test"],
        whyRejected: [],
        acceptedRepairs: [],
        rejectedRepairs: [],
      },
      layeredBudget: { snapshot: { exhausted: false } },
      routingGovernance: { governanceVersion: "routing-governance-1.0" },
      modelCallObservability: { latency: { p50: 1, p99: 2 } },
      qualityCostAnalysis: {
        note: "analysis_only_not_production_score",
        observation: { delivered: true },
      },
      contextHash: "ctx:fallback-test",
    },
  ];
}

test("主 flush 成功 → status=primary", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "trace-primary-"));
  const workspaceId = "ws-p";
  mkdirSync(join(projectRoot, "workspaces", workspaceId), { recursive: true });
  try {
    const result = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId,
      chapterId: "ch1",
      traceRecords: sampleRecords(),
    });
    assert.equal(result.status, "primary");
    assert.ok(result.path && existsSync(result.path));
    assert.ok(result.primaryAttempts >= 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("主 flush 两次无 path → status=fallback 且备用归档含治理字段", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "trace-fallback-"));
  try {
    const result = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId: "ws-fb",
      chapterId: "ch-fb",
      traceRecords: sampleRecords(),
      adapterFactory: () => ({
        record() {},
        flush() {
          return undefined; // 模拟主路径无 path
        },
      }),
    });
    assert.equal(result.status, "fallback", JSON.stringify(result));
    assert.ok(result.path && existsSync(result.path), `fallback path: ${result.path}`);
    assert.ok(result.path.includes("quality-trace-fallback-"));
    assert.ok(result.path.includes(`${join("reports", "traces")}`) || result.path.includes("reports"));
    assert.equal(result.primaryAttempts, 2);
    assert.ok(result.errors.length >= 2);

    const doc = JSON.parse(readFileSync(result.path, "utf-8"));
    assert.equal(doc.schemaId, "pinovel-unified-trace-fallback-v1");
    assert.equal(doc.workspaceId, "ws-fb");
    assert.equal(doc.chapterId, "ch-fb");
    assert.ok(Array.isArray(doc.traceRecords));
    assert.ok(doc.traceRecords[0].routingGovernance);
    assert.ok(doc.traceRecords[0].layeredBudget);
    assert.ok(doc.traceRecords[0].modelCallObservability);
    assert.ok(doc.traceRecords[0].qualityCostAnalysis);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("主 flush 抛错两次 → fallback 归档", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "trace-fallback-throw-"));
  try {
    const result = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId: "ws-th",
      chapterId: "ch-th",
      traceRecords: sampleRecords(),
      adapterFactory: () => ({
        record() {},
        flush() {
          throw new Error("disk full");
        },
      }),
    });
    assert.equal(result.status, "fallback");
    assert.ok(result.path && existsSync(result.path));
    assert.ok(result.errors.some((e) => e.includes("disk full")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("adapter 构造失败 → 仍写 fallback", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "trace-setup-fail-"));
  try {
    const result = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId: "ws-setup",
      chapterId: "ch-setup",
      traceRecords: sampleRecords(),
      adapterFactory: () => {
        throw new Error("adapter boom");
      },
    });
    assert.equal(result.status, "fallback");
    assert.ok(result.path && existsSync(result.path));
    assert.ok(result.errors.some((e) => e.includes("adapter boom")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("主路径与 fallback 均失败 → status=failed", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "trace-all-fail-"));
  // 让 fallback 目录不可写：用文件占位 reports/traces 路径
  const reportsDir = join(projectRoot, "reports");
  mkdirSync(reportsDir, { recursive: true });
  // 在 POSIX/Windows 上：将 reports/traces 建成普通文件，atomicSave 创建目录会失败
  writeFileSync(join(reportsDir, "traces"), "not-a-dir");
  try {
    const result = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId: "ws-all",
      chapterId: "ch-all",
      traceRecords: sampleRecords(),
      adapterFactory: () => ({
        record() {},
        flush() {
          throw new Error("primary dead");
        },
      }),
    });
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.ok(result.errors.some((e) => e.includes("primary dead")));
    assert.ok(result.errors.some((e) => /fallback/i.test(e)));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
