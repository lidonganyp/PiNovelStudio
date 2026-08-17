/**
 * DATA-VERSION-RELEASE-GOVERNANCE DG-2 — 生产级行为快照捕获与独立校验 (RED)
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-2
 * 任务卡：DG-2「运行环境与数据快照捕获」
 *
 * 验收点（任务卡“必须测试”）：
 * - 同环境重复 capture → 组件 hash / bundleId 一致
 * - 任一行为资产变化 → 对应组件 hash + bundleId 变化
 * - 运行时版本变化 → runtimeFingerprint + bundleId 变化
 * - capturedAt 不计入 hash（时间戳非行为）
 * - 文件缺失 → exists=false，hash 为空，不抛异常
 * - 独立 verify 能区分可复现与不可复现
 *
 * 边界（READY_LOCAL）：
 * - 使用临时目录构造行为资产文件，不触碰真实生产文件
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 不进入生产闭包（仅 dist-test/）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureBehaviorSnapshot,
  verifyBehaviorSnapshot,
} from "../dist-test/v2/governance/behavior-snapshot.js";

// ============================================================================
// Fixture helpers：在临时目录构造一组行为资产文件
// ============================================================================

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "dg2-snapshot-"));
  const files = {
    modelRouting: "model-routing.json",
    promptBundle: "prompt-registry.json",
    toolSchema: "tools.ts",
    contextCompiler: "context-compiler.ts",
    qualityPolicy: "quality-gates.json",
    recoveryPolicy: "model-routing.json",
    runtimeFile: "tsconfig.json",
    buildArtifact: "dist/index.js",
  };
  const content = (name) => `CONTENT-${name}`;

  for (const [key, rel] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content(key), "utf-8");
  }
  // 额外独立文件：lockfile（与 runtimeFile 不同）
  writeFileSync(join(root, "package-lock.json"), "LOCK", "utf-8");

  return { root, files, content };
}

function makeInput(root, overrides = {}) {
  return {
    projectRoot: root,
    modelVersion: "gemini-3.1-pro-preview",
    evalProtocolVersion: "2026-08-01",
    modelRoutingPaths: ["model-routing.json"],
    promptBundlePaths: ["prompt-registry.json"],
    toolSchemaPaths: ["tools.ts"],
    contextCompilerPaths: ["context-compiler.ts"],
    qualityPolicyPaths: ["quality-gates.json"],
    recoveryPolicyPaths: ["model-routing.json"],
    knowledgeSnapshotPaths: [],
    runtimeFilePaths: ["tsconfig.json", "package-lock.json"],
    buildArtifactPaths: ["dist/index.js"],
    mockRuntimeVersions: { node: "v25.2.1", npm: "10.9.0" },
    ...overrides,
  };
}

// ============================================================================
// 1. 确定性与敏感性
// ============================================================================

test("DG-2 snapshot: 同环境重复 capture 完全一致", () => {
  const { root } = makeProject();
  const a = captureBehaviorSnapshot(makeInput(root));
  const b = captureBehaviorSnapshot(makeInput(root));
  assert.equal(a.bundleId, b.bundleId);
  assert.equal(a.promptBundleHash, b.promptBundleHash);
  assert.equal(a.modelRoutingHash, b.modelRoutingHash);
  assert.equal(a.runtimeFingerprint, b.runtimeFingerprint);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: 任一行为资产变化 → 组件 hash + bundleId 变化", () => {
  const { root } = makeProject();
  const before = captureBehaviorSnapshot(makeInput(root));
  writeFileSync(join(root, "prompt-registry.json"), "CHANGED-PROMPT", "utf-8");
  const after = captureBehaviorSnapshot(makeInput(root));
  assert.notEqual(after.promptBundleHash, before.promptBundleHash);
  assert.notEqual(after.bundleId, before.bundleId);
  // 其它组件不受影响
  assert.equal(after.modelRoutingHash, before.modelRoutingHash);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: 模型路由变化 → modelRoutingHash + bundleId 变化", () => {
  const { root } = makeProject();
  const before = captureBehaviorSnapshot(makeInput(root));
  writeFileSync(join(root, "model-routing.json"), "CHANGED-ROUTING", "utf-8");
  const after = captureBehaviorSnapshot(makeInput(root));
  assert.notEqual(after.modelRoutingHash, before.modelRoutingHash);
  assert.notEqual(after.bundleId, before.bundleId);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: 运行时版本变化 → runtimeFingerprint + bundleId 变化", () => {
  const { root } = makeProject();
  const before = captureBehaviorSnapshot(makeInput(root));
  const after = captureBehaviorSnapshot(
    makeInput(root, { mockRuntimeVersions: { node: "v26.0.0", npm: "11.0.0" } }),
  );
  assert.notEqual(after.runtimeFingerprint, before.runtimeFingerprint);
  assert.notEqual(after.bundleId, before.bundleId);
  // 运行时版本变化不应影响非 runtime 组件
  assert.equal(after.promptBundleHash, before.promptBundleHash);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: capturedAt 不计入 hash（时间戳非行为）", () => {
  const { root } = makeProject();
  const a = captureBehaviorSnapshot(makeInput(root));
  const b = captureBehaviorSnapshot(makeInput(root));
  // capturedAt 可能不同，但 bundleId 与组件 hash 必须一致
  assert.equal(a.bundleId, b.bundleId);
  assert.equal(a.runtimeFingerprint, b.runtimeFingerprint);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: bundleId 为 64 位 hex", () => {
  const { root } = makeProject();
  const snap = captureBehaviorSnapshot(makeInput(root));
  assert.match(snap.bundleId, /^[a-f0-9]{64}$/);
  rmSync(root, { recursive: true, force: true });
});

// ============================================================================
// 2. 文件缺失容错
// ============================================================================

test("DG-2 snapshot: 文件缺失 → exists=false，不抛异常", () => {
  const { root } = makeProject();
  const snap = captureBehaviorSnapshot(
    makeInput(root, { promptBundlePaths: ["missing-file.json"] }),
  );
  const comp = snap.components.find((c) => c.name === "promptBundle");
  assert.ok(comp);
  assert.equal(comp.files[0].exists, false);
  assert.equal(comp.files[0].hash, "");
  // 缺失文件仍产生确定性 hash（空清单聚合）
  assert.equal(typeof snap.promptBundleHash, "string");
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: 空文件清单不抛异常", () => {
  const { root } = makeProject();
  const snap = captureBehaviorSnapshot(makeInput(root, { knowledgeSnapshotPaths: [] }));
  assert.equal(typeof snap.knowledgeSnapshotHash, "string");
  assert.ok(snap.knowledgeSnapshotHash.length === 64);
  rmSync(root, { recursive: true, force: true });
});

// ============================================================================
// 3. 独立 verify
// ============================================================================

test("DG-2 verify: 相同快照可复现", () => {
  const { root } = makeProject();
  const recorded = captureBehaviorSnapshot(makeInput(root));
  const actual = captureBehaviorSnapshot(makeInput(root));
  const result = verifyBehaviorSnapshot(recorded, actual);
  assert.equal(result.reproducible, true);
  assert.ok(result.checks.every((c) => c.passed));
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 verify: 组件 hash 漂移 → 不可复现", () => {
  const { root } = makeProject();
  const recorded = captureBehaviorSnapshot(makeInput(root));
  writeFileSync(join(root, "tools.ts"), "CHANGED-TOOL-SCHEMA", "utf-8");
  const actual = captureBehaviorSnapshot(makeInput(root));
  const result = verifyBehaviorSnapshot(recorded, actual);
  assert.equal(result.reproducible, false);
  assert.ok(result.checks.some((c) => c.name === "toolSchemaHash 一致" && !c.passed));
  assert.ok(result.checks.some((c) => c.name === "bundleId 一致" && !c.passed));
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 verify: 运行时版本漂移 → 不可复现", () => {
  const { root } = makeProject();
  const recorded = captureBehaviorSnapshot(makeInput(root));
  const actual = captureBehaviorSnapshot(
    makeInput(root, { mockRuntimeVersions: { node: "v27.0.0", npm: "12.0.0" } }),
  );
  const result = verifyBehaviorSnapshot(recorded, actual);
  assert.equal(result.reproducible, false);
  assert.ok(result.checks.some((c) => c.name === "runtimeVersions 一致" && !c.passed));
  rmSync(root, { recursive: true, force: true });
});

// ============================================================================
// 4. 组件完整性
// ============================================================================

test("DG-2 snapshot: 产出 9 个组件明细", () => {
  const { root } = makeProject();
  const snap = captureBehaviorSnapshot(makeInput(root));
  const names = snap.components.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "capabilityPackageSet",
    "contextCompiler",
    "knowledgeSnapshot",
    "modelRouting",
    "promptBundle",
    "qualityPolicy",
    "recoveryPolicy",
    "runtimeFingerprint",
    "toolSchema",
  ]);
  // 每个组件 hash 为 64 位 hex
  for (const c of snap.components) {
    assert.match(c.hash, /^[a-f0-9]{64}$/);
  }
  rmSync(root, { recursive: true, force: true });
});

// ============================================================================
// 5. 构建产物目录（runtimeFingerprint 完整覆盖，DG-1 缺口修复）
// ============================================================================

test("DG-2 snapshot: 构建产物目录内文件变化 → runtimeFingerprint + bundleId 变化", () => {
  const { root } = makeProject();
  // 构造 dist 子目录文件（模拟 dist/v2/core/final-state-commit.js，非 dist/index.js）
  mkdirSync(join(root, "dist", "v2", "core"), { recursive: true });
  writeFileSync(join(root, "dist", "v2", "core", "final-state-commit.js"), "FSC-V1", "utf-8");
  const input = makeInput(root, {
    buildArtifactPaths: ["dist/index.js"],
    buildArtifactDirs: ["dist"],
  });
  const before = captureBehaviorSnapshot(input);
  writeFileSync(join(root, "dist", "v2", "core", "final-state-commit.js"), "FSC-V2", "utf-8");
  const after = captureBehaviorSnapshot(input);
  assert.notEqual(after.runtimeFingerprint, before.runtimeFingerprint);
  assert.notEqual(after.bundleId, before.bundleId);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: 构建产物目录不存在 → 空清单不抛异常", () => {
  const { root } = makeProject();
  const input = makeInput(root, { buildArtifactDirs: ["dist-does-not-exist"] });
  const a = captureBehaviorSnapshot(input);
  const b = captureBehaviorSnapshot(input);
  assert.equal(a.runtimeFingerprint, b.runtimeFingerprint);
  assert.equal(a.bundleId, b.bundleId);
  rmSync(root, { recursive: true, force: true });
});

test("DG-2 snapshot: 构建产物目录确定性（重复 capture 一致）", () => {
  const { root } = makeProject();
  mkdirSync(join(root, "dist", "v2", "core"), { recursive: true });
  writeFileSync(join(root, "dist", "v2", "core", "final-state-commit.js"), "FSC", "utf-8");
  const input = makeInput(root, { buildArtifactDirs: ["dist"] });
  const a = captureBehaviorSnapshot(input);
  const b = captureBehaviorSnapshot(input);
  assert.equal(a.runtimeFingerprint, b.runtimeFingerprint);
  assert.equal(a.bundleId, b.bundleId);
  rmSync(root, { recursive: true, force: true });
});
