/**
 * EVOLUTION-RELEASE-GOVERNANCE-1C CLI 测试 — proxy-review / evaluate 子命令
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4-G5 / 1C 任务卡
 *
 * 1C CLI 子命令：
 *   evolution:proxy-review --release-id <id> [--stub-verdict <v>] [--card <path>]
 *     加载 manifest → 构建 packet → 调用 provider → 落盘 artifact → 绑定 approvalRef → 记录状态事件
 *     不切换 active pointer
 *   evolution:evaluate --release-id <id>
 *     frozen → evaluated 状态迁移（1C 最小实现；真实 NovelBench 对照为后续切片）
 *
 * 验收边界：
 * - artifact 落盘到 reports/evolution-releases/{releaseId}/approvals/
 * - manifest.approvalRef 在 APPROVE_DEV 时更新
 * - 状态事件 append-only 写入 state-events.jsonl
 * - 不切换 active-development / active-production pointer
 * - 缺 releaseId / release 不存在 / 状态不合法 → 明确退出码
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";

// ============================================================================
// helpers
// ============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "evolution-cli-1c-"));
  return root;
}

function makeManifest(releaseId, status = "evaluated", changeClass = "R2") {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass,
    claims: ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    activatedAt: null,
  };
}

function writeMatchingStateEvent(registry, releaseId, status) {
  if (status === "draft") return;
  const fromByTo = {
    candidate: "draft",
    frozen: "candidate",
    evaluated: "frozen",
    approved_dev: "evaluated",
    active_dev: "approved_dev",
    candidate_prod: "active_dev",
    active_prod: "candidate_prod",
    held: "evaluated",
    rejected: "evaluated",
  };
  const fromStatus = fromByTo[status];
  if (!fromStatus) return;
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-${status}`,
    releaseId,
    fromStatus,
    toStatus: status,
    reason: `test fixture arrived at ${status}`,
    actor: "system",
    timestamp: "2026-07-16T00:00:00.000Z",
  });
}

function setupReleases(root, manifests) {
  const releasesDir = join(root, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  for (const m of manifests) {
    registry.writeManifest(m);
    writeMatchingStateEvent(registry, m.releaseId, m.status);
  }
  return registry;
}

function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const output = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: fullEnv,
      encoding: "utf-8",
      timeout: 30000,
    });
    return { code: 0, stdout: output, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

// ============================================================================
// evolution:evaluate
// ============================================================================

test("cli evaluate: frozen → evaluated 状态迁移成功", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "frozen")]);
    const result = runCli(
      ["evaluate", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /evaluated/);

    // 验证 manifest 状态已迁移
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.status, "evaluated");

    // 验证状态事件已写入
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "evaluated"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli evaluate: 非 frozen 状态拒绝迁移", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "draft")]);
    const result = runCli(
      ["evaluate", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /frozen/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli evaluate: release 不存在退出非零", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["evaluate", "--release-id", "rel-nonexistent"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli evaluate: 缺 --release-id 退出码 2", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["evaluate"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// evolution:proxy-review
// ============================================================================

test("cli proxy-review: stub APPROVE_DEV 写入 artifact + 更新 approvalRef + 不切换 pointer", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "evaluated")]);
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // artifact 落盘
    const approvalsDir = join(root, "releases", "rel-001", "approvals");
    assert.ok(existsSync(approvalsDir), "approvals 目录应存在");
    const indexFile = join(approvalsDir, "approvals-index.jsonl");
    assert.ok(existsSync(indexFile), "approvals-index.jsonl 应存在");

    // manifest.approvalRef 更新
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    const manifest = registry.loadManifest("rel-001");
    assert.ok(manifest.approvalRef, "approvalRef 应非空");
    assert.ok(manifest.approvalRef.length > 0);

    // 状态事件：evaluated → approved_dev
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "approved_dev"));

    // 不切换 pointer
    const store = createReleasePointerStore({ configDir: root });
    assert.equal(store.readActive("development"), null);
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli proxy-review: stub HOLD 记录状态事件 evaluated → held + 不切换 pointer", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "evaluated")]);
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "HOLD"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "held"));

    // approvalRef 不更新（HOLD 不批准）
    const manifest = registry.loadManifest("rel-001");
    assert.equal(manifest.approvalRef, null);

    // 不切换 pointer
    const store = createReleasePointerStore({ configDir: root });
    assert.equal(store.readActive("development"), null);
    assert.equal(store.readActive("production"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli proxy-review: stub REJECT 记录状态事件 evaluated → rejected", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "evaluated")]);
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "REJECT"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    const events = registry.loadStateEvents("rel-001");
    assert.ok(events.some((e) => e.toStatus === "rejected"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli proxy-review: 缺 --release-id 退出码 2", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["proxy-review"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli proxy-review: release 不存在退出非零", () => {
  const root = makeTempRoot();
  try {
    const result = runCli(
      ["proxy-review", "--release-id", "rel-nonexistent", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli proxy-review: 非 evaluated 状态拒绝审批", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "frozen")]);
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /evaluated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli proxy-review: artifact 含 releaseId/verdict/provenance/budget", () => {
  const root = makeTempRoot();
  try {
    setupReleases(root, [makeManifest("rel-001", "evaluated")]);
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // 读取 artifact 文件验证内容
    const approvalsDir = join(root, "releases", "rel-001", "approvals");
    const indexContent = readFileSync(join(approvalsDir, "approvals-index.jsonl"), "utf-8");
    const indexEntry = JSON.parse(indexContent.trim());
    const artifactPath = join(approvalsDir, `${indexEntry.approvalId}.json`);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));

    assert.equal(artifact.releaseId, "rel-001");
    assert.equal(artifact.finalVerdict, "APPROVE_DEV");
    assert.equal(artifact.reviewerModel, "gpt5.6-sol");
    assert.ok(artifact.reviewerModelVersion.length > 0);
    assert.ok(artifact.promptHash.length > 0);
    assert.ok(artifact.inputArtifactHash.length > 0);
    assert.equal(artifact.releaseManifestHash, computeReleasePayloadHash(makeManifest("rel-001")));
    assert.equal(artifact.budgetUsed.calls, 2);
    assert.equal(artifact.r3SelfApproval, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
