/**
 * EVOLUTION-RELEASE-GOVERNANCE Phase 4 C8 — 第四轮核验 5 个新阻断测试（RED）
 *
 * 真相源：用户第四轮核验（2026-07-17）5 项新生产级阻断
 * 计划：.trae/documents/phase4-c8-c9-fourth-verification-fix-plan.md
 *
 * 本测试覆盖 5 项阻断：
 * - P0: canary 章节 trace 可来自其他 release，仍能通过晋级校验
 *        （verifyCanaryResultArtifacts 未校验 chapter trace 内 releaseGovernance 绑定）
 * - P1: cmdCandidate recordStateEvent 失败后 manifest 已迁移（同 try/catch，无 warn-only）
 * - P1: cmdFreeze recordStateEvent 失败后 manifest 已迁移（同 try/catch，无 warn-only）
 * - P1: cmdProxyReview transitionStatus 失败后遗留 approval artifact（无 try/catch，无清理）
 * - P1: cmdProxyReview recordStateEvent 失败后 manifest 已迁移（无 try/catch，无 warn-only）
 *
 * RED 状态：
 * - P0: verifyCanaryResultArtifacts 不校验 releaseGovernance → 跨 release trace 通过 → 测试 fail
 * - P1 candidate: recordStateEvent 失败 → exit 5（应 warn-only exit 0）→ 测试 fail
 * - P1 freeze: recordStateEvent 失败 → exit 5（应 warn-only exit 0）→ 测试 fail
 * - P1 proxy-review transition: transitionStatus 失败 → artifact 孤立（应清理）→ 测试 fail
 * - P1 proxy-review recordEvent: recordStateEvent 失败 → exit 1（应 warn-only exit 0）→ 测试 fail
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不生成章节正文、不提交长期状态
 * - 复用 governance sibling 模块（dist-test/）
 * - 不修改 evolution-release-registry / release-proxy-approval-registry
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  verifyCanaryResultArtifacts,
} from "../dist-test/v2/governance/canary-promotion-gate.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
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
  return mkdtempSync(join(tmpdir(), "phase4-c8-"));
}

function makeManifest(releaseId, status, opts = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: opts.parentReleaseId ?? "rel-000",
    rollbackReleaseId: opts.rollbackReleaseId ?? "rel-000",
    supersedesRef: null,
    changeClass: opts.changeClass ?? "R2",
    claims: opts.claims ?? ["test-claim"],
    environmentFingerprint: opts.environmentFingerprint ?? "fp-test-hash",
    artifactRefs: [],
    approvalRef: opts.approvalRef ?? "apr-001",
    createdAt: "2026-07-17T00:00:00.000Z",
    activatedAt: null,
  };
}

function makeRegistry(root) {
  return createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
}

function setupRelease(root, releaseId, status, opts = {}) {
  const registry = makeRegistry(root);
  registry.writeManifest(makeManifest(releaseId, status, opts));
  return registry;
}

/** 运行 CLI，返回 { code, stdout, stderr }。 */
function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  // P1 修复（第四轮）：用 spawnSync 替换 execFileSync，确保 exit 0 时也能捕获 stderr。
  // execFileSync 成功时只返回 stdout，丢弃 stderr → console.warn 输出丢失。
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd: EXT_ROOT,
    env: fullEnv,
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 写入 candidate 命令所需的 metadata 文件。 */
function writeMetadataFile(root, metadata) {
  const path = join(root, "metadata.json");
  writeFileSync(path, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
  return path;
}

// ============================================================================
// RED-1: P0 跨 release chapter trace 污染
// verifyCanaryResultArtifacts 必须校验 chapter trace 内 releaseGovernance 与目标 release 绑定
// ============================================================================

test("P0: chapter trace 的 releaseGovernance 与目标 release 不匹配时必须被拒绝", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "c8-p0-xrelease-"));
  try {
    // 1. 构造 chapter trace，v2_final_selected gate evidence 含 mismatched releaseGovernance
    //    chapter trace 声称属于 rel-other/fp-other/apr-other（不是目标 release rel-001）
    const chapterId = "1";
    const artifactRef = `traces/${chapterId}-quality-trace.json`;
    const artifactPath = join(workspacePath, artifactRef);
    mkdirSync(join(workspacePath, "traces"), { recursive: true });

    const traceDoc = {
      schemaVersion: 1,
      workspaceId: "ws-test",
      chapterId,
      gates: [
        {
          stage: "v2_final_selected",
          status: "PASS",
          passed: true,
          evidence: {
            modelCalls: [
              { route: "v2_rawstage2", kind: "generation", durationMs: 1500, provider: "claude" },
              { route: "v2_amplified", kind: "generation", durationMs: 2000, provider: "claude" },
            ],
            releaseGovernance: {
              releaseId: "rel-other", // ← 不匹配目标 release rel-001
              environmentFingerprint: "fp-other",
              approvalRef: "apr-other",
              devMode: false,
              canaryEvidenceRunId: null,
            },
          },
        },
      ],
    };
    const content = JSON.stringify(traceDoc, null, 2) + "\n";
    writeFileSync(artifactPath, content, "utf-8");
    const hash = createHash("sha256").update(content, "utf-8").digest("hex");

    // 2. 构造 canary run trace，绑定目标 release rel-001
    const canaryTrace = {
      schemaId: "pinovel.canary-run-trace",
      schemaVersion: 1,
      runId: "canary-rel-001-completed",
      releaseId: "rel-001",
      previousReleaseId: "rel-000",
      workspaceId: "ws-test",
      startedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:10:00.000Z",
      strategy: "bounded_canary",
      status: "completed",
      healthSnapshot: {
        status: "healthy",
        alignmentRate: 0.8,
        sampleCount: 5,
        rollbackRate: 0,
        consecutiveNegative: 0,
      },
      evidence: {
        changeClass: "R2",
        currentStatus: "candidate_prod",
        authorizationId: "cauth-001",
        sourceRunId: "canary-rel-001-started",
        environmentFingerprint: "fp-001",
        approvalRef: "apr-001",
        verdict: "pass",
        observedChapters: 1,
        observedCalls: 2,
        resultArtifactRefs: [artifactRef],
        resultArtifactHashes: { [artifactRef]: hash },
      },
      outcome: { promoted: false, heldByAutoHold: false },
      shadowPendingRealRun: false,
    };

    // 3. 调用 verifyCanaryResultArtifacts，传入 expected（目标 release 绑定）
    //    GREEN 后：chapter trace 的 releaseGovernance 与 expected 不匹配 → ok: false
    //    RED 前：不校验 releaseGovernance（expected 参数被忽略）→ ok: true（BUG）
    const result = verifyCanaryResultArtifacts(workspacePath, canaryTrace, {
      releaseId: "rel-001",
      environmentFingerprint: "fp-001",
      approvalRef: "apr-001",
    });

    assert.equal(
      result.ok,
      false,
      `chapter trace 的 releaseGovernance（rel-other）与目标 release（rel-001）不匹配时必须拒绝，实际 result=${JSON.stringify(result)}`,
    );
    assert.equal(
      result.code,
      "CANARY_ARTIFACT_MISMATCH",
      `错误码应为 CANARY_ARTIFACT_MISMATCH，实际 code=${result.code}`,
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

// ============================================================================
// RED-2: P1 cmdCandidate recordStateEvent 失败 → warn-only（exit 0）
// 当前：transitionStatus + recordStateEvent 同 try/catch，recordStateEvent 失败 → exit 5
// 期望：recordStateEvent 失败 → warn-only → exit 0（manifest 已成功迁移）
// ============================================================================

test("P1: cmdCandidate recordStateEvent 失败 → warn-only（exit 0），manifest 已迁移到 candidate", () => {
  const root = makeTempRoot();
  try {
    // 1. 设置 release rel-001 为 draft 状态
    setupRelease(root, "rel-001", "draft");

    // 2. 使 state-events.jsonl 成为一个目录 → recordStateEvent 读时 EISDIR
    //    transitionStatus 只写 manifest.json，不受影响
    const stateEventsPath = join(root, "releases", "rel-001", "state-events.jsonl");
    mkdirSync(stateEventsPath);

    // 3. 写入 metadata 文件
    const metadataPath = writeMetadataFile(root, {
      changeClass: "R2",
      claims: ["test-claim"],
      artifactRefs: ["ref-1"],
      supersedesRef: null,
    });

    // 4. 运行 evolution:candidate
    const result = runCli(
      ["candidate", "--release-id", "rel-001", "--metadata-file", metadataPath],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    // 5. 期望：exit 0（warn-only），manifest 已迁移到 candidate
    //    RED 前：exit 5（recordStateEvent 失败，同 try/catch）
    assert.equal(
      result.code,
      0,
      `cmdCandidate recordStateEvent 失败时应 warn-only exit 0，实际 exit ${result.code}，stderr=${result.stderr}`,
    );

    // 6. manifest 状态应为 candidate（transitionStatus 已成功）
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(
      manifest.status,
      "candidate",
      `manifest 应已迁移到 candidate，实际 status=${manifest.status}`,
    );

    // 7. 输出应包含 warning（状态事件写入失败）
    const combinedOutput = result.stdout + result.stderr;
    assert.ok(
      combinedOutput.includes("状态事件写入失败") || combinedOutput.includes("warn"),
      `输出应包含状态事件写入失败 warning，实际 stdout=${result.stdout}，stderr=${result.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// RED-3: P1 cmdFreeze recordStateEvent 失败 → warn-only（exit 0）
// 当前：transitionStatus + recordStateEvent 同 try/catch，recordStateEvent 失败 → exit 5
// 期望：recordStateEvent 失败 → warn-only → exit 0（manifest 已成功迁移）
// ============================================================================

test("P1: cmdFreeze recordStateEvent 失败 → warn-only（exit 0），manifest 已迁移到 frozen", () => {
  const root = makeTempRoot();
  try {
    // 1. 设置 rollback 目标 rel-000 为 active_prod
    setupRelease(root, "rel-000", "active_prod", { rollbackReleaseId: "rel-000" });
    // 2. 设置目标 release rel-001 为 candidate，rollbackReleaseId 指向 rel-000
    setupRelease(root, "rel-001", "candidate", { rollbackReleaseId: "rel-000" });

    // 3. 使 state-events.jsonl 成为一个目录 → recordStateEvent 读时 EISDIR
    const stateEventsPath = join(root, "releases", "rel-001", "state-events.jsonl");
    mkdirSync(stateEventsPath);

    // 4. 运行 evolution:freeze
    const result = runCli(
      ["freeze", "--release-id", "rel-001"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    // 5. 期望：exit 0（warn-only），manifest 已迁移到 frozen
    //    RED 前：exit 5（recordStateEvent 失败，同 try/catch）
    assert.equal(
      result.code,
      0,
      `cmdFreeze recordStateEvent 失败时应 warn-only exit 0，实际 exit ${result.code}，stderr=${result.stderr}`,
    );

    // 6. manifest 状态应为 frozen（transitionStatus 已成功）
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(
      manifest.status,
      "frozen",
      `manifest 应已迁移到 frozen，实际 status=${manifest.status}`,
    );

    // 7. 输出应包含 warning
    const combinedOutput = result.stdout + result.stderr;
    assert.ok(
      combinedOutput.includes("状态事件写入失败") || combinedOutput.includes("warn"),
      `输出应包含状态事件写入失败 warning，实际 stdout=${result.stdout}，stderr=${result.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// RED-4: P1 cmdProxyReview transitionStatus 失败 → 清理 approval artifact
// 当前：transitionStatus 无 try/catch，失败后 artifact 孤立
// 期望：transitionStatus 失败 → unlinkSync 清理 artifact → exit 非 0
// ============================================================================

test("P1: cmdProxyReview transitionStatus 失败 → 清理孤立的 approval artifact", () => {
  const root = makeTempRoot();
  try {
    // 1. 设置 release rel-001 为 evaluated 状态
    setupRelease(root, "rel-001", "evaluated");

    // 2. 使 manifest.json.tmp 成为一个目录 → atomicWrite 的 writeFileSync 抛 EISDIR
    //    runStubProxyReview 写 artifact 到 approvals/ 子目录，不受影响
    //    transitionStatus 调用 atomicWrite(manifest.json) → writeFileSync(manifest.json.tmp) → EISDIR
    const manifestTmpPath = join(root, "releases", "rel-001", "manifest.json.tmp");
    mkdirSync(manifestTmpPath);

    // 3. 运行 evolution:proxy-review --stub-verdict APPROVE_DEV
    //    runStubProxyReview 会写 approval artifact，然后 transitionStatus 会失败
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    // 4. 期望：exit 非 0（transitionStatus 失败）
    assert.notEqual(
      result.code,
      0,
      `cmdProxyReview transitionStatus 失败时应 exit 非 0，实际 exit ${result.code}`,
    );

    // 5. 关键断言：approval artifact 应被清理（不存在）
    //    RED 前：artifact 孤立（存在）→ 断言失败
    //    GREEN 后：unlinkSync 清理 artifact → 不存在
    const approvalsDir = join(root, "releases", "rel-001", "approvals");
    let artifactExists = false;
    let artifactPath = null;
    if (existsSync(approvalsDir)) {
      // 读取 approvals-index.jsonl 找到 approvalId
      const indexPath = join(approvalsDir, "approvals-index.jsonl");
      if (existsSync(indexPath)) {
        const indexContent = readFileSync(indexPath, "utf-8");
        const lines = indexContent.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.releaseId === "rel-001") {
              artifactPath = join(approvalsDir, `${entry.approvalId}.json`);
              artifactExists = existsSync(artifactPath);
              break;
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    assert.equal(
      artifactExists,
      false,
      `transitionStatus 失败后 approval artifact 应被清理（不存在），实际 artifactPath=${artifactPath} exists=${artifactExists}`,
    );
  } finally {
    // 清理 manifest.json.tmp 目录（测试 fixture，不影响其他测试）
    try {
      rmSync(join(root, "releases", "rel-001", "manifest.json.tmp"), { recursive: true, force: true });
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// RED-5: P1 cmdProxyReview recordStateEvent 失败 → warn-only（exit 0）
// 当前：recordStateEvent 无 try/catch，失败后 CLI 崩溃（exit 1）
// 期望：recordStateEvent 失败 → warn-only → exit 0（manifest 已成功迁移）
// ============================================================================

test("P1: cmdProxyReview recordStateEvent 失败 → warn-only（exit 0），manifest 已迁移到 approved_dev", () => {
  const root = makeTempRoot();
  try {
    // 1. 设置 release rel-001 为 evaluated 状态
    setupRelease(root, "rel-001", "evaluated");

    // 2. 使 state-events.jsonl 成为一个目录 → recordStateEvent 读时 EISDIR
    //    transitionStatus 只写 manifest.json，不受影响
    const stateEventsPath = join(root, "releases", "rel-001", "state-events.jsonl");
    mkdirSync(stateEventsPath);

    // 3. 运行 evolution:proxy-review --stub-verdict APPROVE_DEV
    //    runStubProxyReview 写 artifact（成功）
    //    transitionStatus evaluated → approved_dev（成功，只写 manifest.json）
    //    recordStateEvent 失败（EISDIR）
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );

    // 4. 期望：exit 0（warn-only）
    //    RED 前：exit 1（recordStateEvent 无 try/catch，uncaught exception）
    assert.equal(
      result.code,
      0,
      `cmdProxyReview recordStateEvent 失败时应 warn-only exit 0，实际 exit ${result.code}，stderr=${result.stderr}`,
    );

    // 5. manifest 状态应为 approved_dev（transitionStatus 已成功）
    const registry = makeRegistry(root);
    const manifest = registry.loadManifest("rel-001");
    assert.equal(
      manifest.status,
      "approved_dev",
      `manifest 应已迁移到 approved_dev，实际 status=${manifest.status}`,
    );

    // 6. 输出应包含 warning
    const combinedOutput = result.stdout + result.stderr;
    assert.ok(
      combinedOutput.includes("状态事件写入失败") || combinedOutput.includes("warn"),
      `输出应包含状态事件写入失败 warning，实际 stdout=${result.stdout}，stderr=${result.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
