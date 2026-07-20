#!/usr/bin/env node
/**
 * evolution-cli — EVOLUTION-RELEASE-GOVERNANCE-1A CLI 入口（开发期本地工具）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4 / Phase G1-G2
 * 任务卡：EVOLUTION-RELEASE-GOVERNANCE-1A 第一批「命令入口」
 *
 * 三个子命令：
 *   npm run evolution:capture [--release-id <id>] [--parent <id>] [--rollback <id>]
 *     采集当前环境指纹，创建 draft manifest 并写入 registry。
 *   npm run evolution:status
 *     打印当前 active-development / active-production 指针与全部 release 状态摘要。
 *   npm run evolution:verify -- --release-id <id>
 *     校验指定 release 的环境指纹是否与当前环境一致（reproducible）。
 *
 * 路径默认值（可用环境变量覆盖）：
 *   PINOVEL_EVOLUTION_ROOT  — 治理数据根目录（默认 config/evolution-release）
 *     ├── releases/                   — manifest 注册表（{releaseId}/manifest.json + state-events.jsonl）
 *     ├── active-development.json     — 开发 active 指针
 *     └── active-production.json      — 生产 active 指针
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 只写 PINOVEL_EVOLUTION_ROOT，不触碰外部文件
 * - 1A 阶段 governance 模块编译到 dist-test/，CLI 从 dist-test/ import；
 *   待生产入口绑定阶段再迁移到 dist/ 并更新 import 路径。
 */
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { collectEnvironmentFingerprint, computeFingerprintHash, verifyEnvironmentFingerprint } from "../dist-test/v2/governance/environment-fingerprint.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { EVOLUTION_RELEASE_SCHEMA_ID, EVOLUTION_RELEASE_SCHEMA_VERSION, validateManifest, computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { verifyManifestBinding } from "../dist-test/v2/governance/release-proxy-approval-schema.js";
import { runStubProxyReview, runRealProxyReview } from "../dist-test/v2/governance/proxy-review-runner.js";
// G8 health 子命令依赖
import {
  aggregateReleaseHealth,
  aggregateReleaseHealthByRelease,
  aggregateReleaseCostStats,
  filterStrategyReputationsByRelease,
} from "../dist-test/v2/governance/release-health-aggregator.js";
import { evaluateReleaseHealth } from "../dist-test/v2/governance/release-health-evaluator.js";
import { executeAutoHold, generateRetiredSuggestion } from "../dist-test/v2/governance/release-health-actions.js";
import { recomputeEligibility } from "../dist-test/v2/governance/release-eligibility-recomputer.js";
import { loadProxyApprovalFeedback } from "../dist-test/v2/governance/chapter-proxy-approval-feedback-recorder.js";
import { createChapterProxyApprovalRegistry } from "../dist-test/v2/governance/chapter-proxy-approval-registry.js";
import { RETIRED_EVALUATION_WINDOW } from "../dist-test/v2/governance/release-health-thresholds.js";
// G5 P1 canary 子命令依赖
import { decideCanaryStrategy } from "../dist-test/v2/governance/canary-policy.js";
import {
  validateCanaryAuthorization,
  loadCanaryAuthorizationFromFile,
  assertCanaryAuthorizes,
} from "../dist-test/v2/governance/canary-workspace-authorization.js";
import { createCanaryTraceStore } from "../dist-test/v2/governance/canary-trace-store.js";
import { executeCanaryDecision } from "../dist-test/v2/governance/canary-actions.js";
import {
  evaluateCanaryCompletionLink,
  evaluateCanaryPromotionGate,
  verifyCanaryResultArtifacts,
} from "../dist-test/v2/governance/canary-promotion-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, ".."); // .pi/extensions/novel-studio
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", ".."); // d:\CODE\PiNovelStudio

// ============================================================================
// 路径解析
// ============================================================================

function evolutionRoot() {
  return process.env.PINOVEL_EVOLUTION_ROOT
    ? resolve(REPO_ROOT, process.env.PINOVEL_EVOLUTION_ROOT)
    : join(EXT_ROOT, "config", "evolution-release");
}

function releasesDir() {
  return join(evolutionRoot(), "releases");
}

function configDir() {
  return evolutionRoot();
}

// ============================================================================
// 环境指纹采集
// ============================================================================

/** 计算 CreativeConstitution hash（CORE-WRITING-PRINCIPLES.md + WORLDBUILDING-CANON.md）。 */
function constitutionHash() {
  const candidates = [
    join(EXT_ROOT, "CORE-WRITING-PRINCIPLES.md"),
    join(EXT_ROOT, "WORLDBUILDING-CANON.md"),
  ];
  const hashes = [];
  for (const p of candidates) {
    if (existsSync(p)) {
      hashes.push(createHash("sha256").update(readFileSync(p, "utf-8"), "utf-8").digest("hex"));
    }
  }
  return hashes.length > 0 ? createHash("sha256").update(hashes.join("\n"), "utf-8").digest("hex") : "";
}

/** 采集当前环境指纹（1A 默认配置）。 */
function captureFingerprint() {
  return collectEnvironmentFingerprint({
    projectRoot: REPO_ROOT,
    modelRoutingPath: "config/model-routing.json",
    promptBundlePaths: [],
    toolSchemaPaths: [],
    runtimeFilePaths: [
      ".pi/extensions/novel-studio/index.ts",
      ".pi/extensions/novel-studio/tsconfig.prod.json",
      ".pi/extensions/novel-studio/tsconfig.eval.json",
      ".pi/extensions/novel-studio/tsconfig.test.json",
    ],
    buildArtifactPaths: [
      ".pi/extensions/novel-studio/dist/index.js",
    ],
    activeStrategyIds: [],
    constitutionHash: constitutionHash(),
    datasetHash: "",
    evalProtocolHash: "",
    seed: 0,
    budgetMaxCalls: 10,
    timeoutMs: Number(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS ?? 300000),
    fallbackPolicy: "hard_block",
    generationModel: "gemini-3.1-pro-preview",
    judgeModel: "gpt5.6-sol",
    proxyApprovalModel: "gpt5.6-sol",
    envSwitchNames: ["V2_FORCE_STUB", "NOVEL_TEST_TOOLS", "NOVEL_DEBUG_TOOLS", "PINOVEL_UNIFIED_PIPELINE", "PINOVEL_DISABLE_FALLBACK"],
    secretEnvNames: ["GLM_API_KEY", "DEEPSEEK_API_KEY", "QWEN_API_KEY", "CLAUDE_API_KEY", "GEMINI_API_KEY", "GPT_API_KEY", "ARK_API_KEY", "ERNIE_API_KEY"],
  });
}

// ============================================================================
// 子命令：capture
// ============================================================================

function cmdCapture(args) {
  const releaseId = args["release-id"] || `rel-${Date.now()}`;
  const parentReleaseId = args["parent"] || null;
  const rollbackReleaseId = args["rollback"] || null;

  if (!rollbackReleaseId) {
    console.error("[evolution:capture] 错误：必须提供 --rollback <releaseId>（freeze 前置：rollbackReleaseId 不可为空）");
    console.error("  若为首版，可创建一个占位 rollback 目标：先 capture 一个 draft rel-000，再用它作为后续 release 的 rollback 目标。");
    process.exit(2);
  }

  const fp = captureFingerprint();
  const fingerprintHash = computeFingerprintHash(fp);

  const manifest = {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status: "draft",
    parentReleaseId,
    rollbackReleaseId,
    supersedesRef: null,
    changeClass: "R1",
    claims: [],
    environmentFingerprint: fingerprintHash,
    artifactRefs: [],
    approvalRef: null,
    createdAt: new Date().toISOString(),
    activatedAt: null,
  };

  const validation = validateManifest(manifest);
  if (!validation.ok) {
    console.error(`[evolution:capture] manifest schema 校验失败：${validation.error.code} at ${validation.error.path} — ${validation.error.message}`);
    process.exit(3);
  }

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  registry.writeManifest(validation.manifest);
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-create`,
    releaseId,
    fromStatus: null,
    toStatus: "draft",
    reason: "evolution:capture 创建 draft manifest",
    actor: "system",
    timestamp: new Date().toISOString(),
  });

  console.log(`[evolution:capture] ✓ 已创建 draft manifest`);
  console.log(`  releaseId          : ${releaseId}`);
  console.log(`  fingerprintHash    : ${fingerprintHash}`);
  console.log(`  codeCommit         : ${fp.codeCommit}`);
  console.log(`  worktreeDirty      : ${fp.worktreeDirty}`);
  console.log(`  rollbackReleaseId  : ${rollbackReleaseId}`);
  console.log(`  parentReleaseId    : ${parentReleaseId ?? "(none)"}`);
  console.log(`  registry path      : ${join(releasesDir(), releaseId, "manifest.json")}`);
}

// ============================================================================
// 子命令：status
// ============================================================================

function cmdCandidate(args) {
  const releaseId = args["release-id"];
  const metadataFile = args["metadata-file"];
  if (!releaseId || !metadataFile) {
    console.error("[evolution:candidate] error: --release-id and --metadata-file are required");
    process.exit(2);
  }

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:candidate] error: releaseId ${releaseId} does not exist`);
    process.exit(3);
  }
  if (manifest.status !== "draft") {
    console.error(`[evolution:candidate] error: release status must be draft, got ${manifest.status}`);
    process.exit(4);
  }

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataFile, "utf-8"));
  } catch (error) {
    console.error(`[evolution:candidate] error: cannot read metadata: ${error.message}`);
    process.exit(5);
  }
  const validClasses = new Set(["R0", "R1", "R2", "R3"]);
  if (
    metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
    !validClasses.has(metadata.changeClass) ||
    !Array.isArray(metadata.claims) || !metadata.claims.every((value) => typeof value === "string" && value.length > 0) ||
    !Array.isArray(metadata.artifactRefs) || !metadata.artifactRefs.every((value) => typeof value === "string" && value.length > 0) ||
    (metadata.supersedesRef !== undefined && metadata.supersedesRef !== null && typeof metadata.supersedesRef !== "string")
  ) {
    console.error("[evolution:candidate] error: invalid metadata schema");
    process.exit(5);
  }

  const prepared = {
    ...manifest,
    changeClass: metadata.changeClass,
    claims: metadata.claims,
    artifactRefs: metadata.artifactRefs,
    supersedesRef: metadata.supersedesRef ?? manifest.supersedesRef,
  };
  try {
    registry.writeManifest(prepared);
  } catch (error) {
    console.error(`[evolution:candidate] error: manifest 写入失败：${error.message}`);
    process.exit(5);
  }
  try {
    registry.transitionStatus(releaseId, "candidate", { actor: "system" });
  } catch (error) {
    console.error(`[evolution:candidate] error: 状态迁移失败：${error.message}`);
    process.exit(5);
  }
  try {
    registry.recordStateEvent({
      eventId: `evt-${releaseId}-candidate-${Date.now()}`,
      releaseId,
      fromStatus: "draft",
      toStatus: "candidate",
      reason: `evolution:candidate metadata=${resolve(metadataFile)}`,
      actor: "system",
      evidenceRefs: metadata.artifactRefs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // P1 修复（第四轮）：manifest 已成功迁移，audit log 失败只 warning 不阻断
    console.warn(`[evolution:candidate] ⚠ 状态事件写入失败（manifest 已成功迁移，audit 缺失）：${error.message}`);
  }
  console.log(`[evolution:candidate] OK ${releaseId}: draft -> candidate`);
}

function cmdFreeze(args) {
  const releaseId = args["release-id"];
  const bootstrap = args.bootstrap === true;
  if (!releaseId) {
    console.error("[evolution:freeze] error: --release-id is required");
    process.exit(2);
  }

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:freeze] error: releaseId ${releaseId} does not exist`);
    process.exit(3);
  }
  if (manifest.status !== "candidate") {
    console.error(`[evolution:freeze] error: release status must be candidate, got ${manifest.status}`);
    process.exit(4);
  }

  const pointerStore = createReleasePointerStore({ configDir: configDir() });
  if (bootstrap) {
    const onlyRelease = registry.listManifests().length === 1;
    const noProductionPointer = pointerStore.readActive("production") === null;
    if (manifest.rollbackReleaseId !== releaseId || !onlyRelease || !noProductionPointer) {
      console.error(
        "[evolution:freeze] error: bootstrap requires a self rollback target, a one-release registry, and no production pointer",
      );
      process.exit(5);
    }
  } else {
    if (manifest.rollbackReleaseId === releaseId) {
      console.error("[evolution:freeze] error: self rollback is allowed only with explicit --bootstrap");
      process.exit(5);
    }
    const rollback = registry.loadManifest(manifest.rollbackReleaseId);
    if (!rollback || rollback.status !== "active_prod") {
      console.error(
        `[evolution:freeze] error: rollback target ${manifest.rollbackReleaseId} must exist with status active_prod`,
      );
      process.exit(5);
    }
  }
  if (manifest.parentReleaseId && !registry.loadManifest(manifest.parentReleaseId)) {
    console.error(`[evolution:freeze] error: parent release ${manifest.parentReleaseId} does not exist`);
    process.exit(5);
  }

  try {
    registry.transitionStatus(releaseId, "frozen", { actor: "system" });
  } catch (error) {
    console.error(`[evolution:freeze] error: 状态迁移失败：${error.message}`);
    process.exit(5);
  }
  try {
    registry.recordStateEvent({
      eventId: `evt-${releaseId}-freeze-${Date.now()}`,
      releaseId,
      fromStatus: "candidate",
      toStatus: "frozen",
      reason: bootstrap ? "evolution:freeze bootstrap baseline" : "evolution:freeze immutable release",
      actor: "system",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // P1 修复（第四轮）：manifest 已成功迁移，audit log 失败只 warning 不阻断
    console.warn(`[evolution:freeze] ⚠ 状态事件写入失败（manifest 已成功迁移，audit 缺失）：${error.message}`);
  }
  console.log(`[evolution:freeze] OK ${releaseId}: candidate -> frozen`);
}

function cmdStatus() {
  const store = createReleasePointerStore({ configDir: configDir() });
  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });

  const devPointer = store.readActive("development");
  const prodPointer = store.readActive("production");

  console.log("=== Evolution Release Status ===");
  console.log("");
  console.log("Active Pointers:");
  console.log(`  development : ${devPointer ? devPointer.releaseId : "(none)"}${devPointer ? `  [actor=${devPointer.actor}, reason=${devPointer.reason}]` : ""}`);
  console.log(`  production  : ${prodPointer ? prodPointer.releaseId : "(none)"}${prodPointer ? `  [actor=${prodPointer.actor}, reason=${prodPointer.reason}]` : ""}`);
  console.log("");

  const manifests = registry.listManifests();
  if (manifests.length === 0) {
    console.log("Releases: (none — run `npm run evolution:capture` to create one)");
    return;
  }

  console.log(`Releases (${manifests.length}):`);
  for (const m of manifests) {
    const events = registry.loadStateEvents(m.releaseId);
    const marker = devPointer?.releaseId === m.releaseId ? " ← active-dev" : "";
    console.log(`  ${m.releaseId}`);
    console.log(`    status             : ${m.status}${marker}`);
    console.log(`    changeClass        : ${m.changeClass}`);
    console.log(`    fingerprintHash    : ${m.environmentFingerprint.slice(0, 16)}…`);
    console.log(`    parentReleaseId    : ${m.parentReleaseId ?? "(none)"}`);
    console.log(`    rollbackReleaseId  : ${m.rollbackReleaseId}`);
    console.log(`    createdAt          : ${m.createdAt}`);
    console.log(`    stateEvents        : ${events.length} 条`);
    if (m.claims.length > 0) {
      console.log(`    claims             : ${m.claims.join("; ")}`);
    }
  }
}

// ============================================================================
// 子命令：verify
// ============================================================================

function cmdVerify(args) {
  const releaseId = args["release-id"];
  if (!releaseId) {
    console.error("[evolution:verify] 错误：必须提供 --release-id <id>");
    process.exit(2);
  }

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:verify] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  // manifest.environmentFingerprint 存的是 fingerprintHash 字符串
  // verifyEnvironmentFingerprint 需要完整 fingerprint 对象做对比；
  // 1A CLI 重新采集当前环境，对比 hash 是否一致
  const currentFp = captureFingerprint();
  const currentHash = computeFingerprintHash(currentFp);

  const recorded = manifest.environmentFingerprint;
  const reproducible = recorded === currentHash;

  console.log(`=== Evolution Release Verify ===`);
  console.log(`  releaseId           : ${releaseId}`);
  console.log(`  status              : ${manifest.status}`);
  console.log(`  recorded fpHash     : ${recorded}`);
  console.log(`  current  fpHash     : ${currentHash}`);
  console.log(`  codeCommit (recorded in manifest context): ${currentFp.codeCommit}`);
  console.log(`  worktreeDirty       : ${currentFp.worktreeDirty}`);
  console.log(`  reproducible        : ${reproducible ? "✓ YES" : "✗ NO"}`);

  if (!reproducible) {
    console.log("");
    console.log("  ⚠ 指纹不一致：当前环境与 release 冻结时不同。");
    console.log("    可能原因：代码变更、worktree dirty、配置改动、模型路由变更、环境开关变化。");
    console.log("    如需晋级，请重新 capture 新 release；如需复现，请 checkout 对应 commit 并恢复配置。");
    process.exit(4);
  }
}

// ============================================================================
// 子命令：drill（1A 验收本地演练）
// ============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateManifestChain } from "../dist-test/v2/governance/evolution-release-schema.js";

/**
 * 1A 验收本地演练：在临时目录中跑通两个工作流。
 *   Drill 1：candidate → freeze → verify
 *   Drill 2：active pointer → rollback
 *
 * 不触碰用户真实治理数据（使用独立临时目录）。
 */
function cmdDrill() {
  const drillRoot = mkdtempSync(join(tmpdir(), "evolution-drill-"));
  process.env.PINOVEL_EVOLUTION_ROOT = drillRoot;
  console.log(`[evolution:drill] 临时治理根目录：${drillRoot}`);
  console.log("");

  let failed = false;
  try {
    // ── 准备：创建 base release（rel-000）作为 rollback 目标 ──────────────
    // rel-000 自引用 rollbackReleaseId（首版无前序 release；schema 只要求非空）
    const fp0 = captureFingerprint();
    const baseManifest = {
      schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
      schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
      releaseId: "rel-000",
      status: "frozen",
      parentReleaseId: null,
      rollbackReleaseId: "rel-000",
      supersedesRef: null,
      changeClass: "R0",
      claims: ["base seed release for drill"],
      environmentFingerprint: computeFingerprintHash(fp0),
      artifactRefs: [],
      approvalRef: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
    };
    const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
    registry.writeManifest(baseManifest);
    console.log("[drill] 准备：base release rel-000 已创建（frozen，作为 rollback 目标）");

    // ── Drill 1：candidate → freeze → verify ─────────────────────────────
    console.log("");
    console.log("=== Drill 1：candidate → freeze → verify ===");

    // 1a. capture rel-001（draft）
    const fp1 = captureFingerprint();
    const rel001 = {
      schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
      schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
      releaseId: "rel-001",
      status: "draft",
      parentReleaseId: "rel-000",
      rollbackReleaseId: "rel-000",
      supersedesRef: null,
      changeClass: "R1",
      claims: ["drill: candidate→freeze→verify"],
      environmentFingerprint: computeFingerprintHash(fp1),
      artifactRefs: [],
      approvalRef: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
    };
    registry.writeManifest(rel001);
    registry.recordStateEvent({
      eventId: "evt-rel-001-create", releaseId: "rel-001",
      fromStatus: null, toStatus: "draft",
      reason: "drill capture", actor: "system", timestamp: new Date().toISOString(),
    });
    console.log(`  [1a] capture draft rel-001 ✓  fpHash=${rel001.environmentFingerprint.slice(0, 16)}…`);

    // 1b. draft → candidate
    const candidateManifest = { ...rel001, status: "candidate" };
    registry.writeManifest(candidateManifest);
    registry.recordStateEvent({
      eventId: "evt-rel-001-candidate", releaseId: "rel-001",
      fromStatus: "draft", toStatus: "candidate",
      reason: "drill: draft→candidate", actor: "system", timestamp: new Date().toISOString(),
    });
    console.log("  [1b] transition draft→candidate ✓");

    // 1c. candidate → frozen（freeze 前校验 chain：rollback 目标 rel-000 必须存在）
    const rollbackRef = registry.loadManifest("rel-000");
    const chainResult = validateManifestChain(candidateManifest, {
      parent: registry.loadManifest("rel-000"),
      rollback: rollbackRef,
      superseded: null,
    });
    if (!chainResult.ok) {
      throw new Error(`chain 校验失败（freeze 前置）：${chainResult.errors.map((e) => e.message).join("; ")}`);
    }
    const frozenManifest = { ...candidateManifest, status: "frozen" };
    registry.writeManifest(frozenManifest);
    registry.recordStateEvent({
      eventId: "evt-rel-001-frozen", releaseId: "rel-001",
      fromStatus: "candidate", toStatus: "frozen",
      reason: "drill: candidate→frozen（chain 校验通过）", actor: "system", timestamp: new Date().toISOString(),
    });
    console.log("  [1c] freeze candidate→frozen ✓（chain 校验通过，rollback 目标 rel-000 存在）");

    // 1d. verify rel-001（重新采集指纹对比）
    const verifyFp = captureFingerprint();
    const verifyHash = computeFingerprintHash(verifyFp);
    const reproducible = frozenManifest.environmentFingerprint === verifyHash;
    if (!reproducible) {
      throw new Error(`verify 失败：recorded=${frozenManifest.environmentFingerprint} vs current=${verifyHash}`);
    }
    console.log(`  [1d] verify rel-001 ✓  reproducible=${reproducible}（指纹一致）`);
    console.log("=== Drill 1 通过 ✓ ===");

    // ── Drill 2：active pointer → rollback ───────────────────────────────
    console.log("");
    console.log("=== Drill 2：active pointer → rollback ===");

    const store = createReleasePointerStore({ configDir: configDir() });

    // 2a. switch development pointer → rel-001
    const prev1 = store.switchActive("development", "rel-001", {
      reason: "drill: activate rel-001", actor: "system",
    });
    if (prev1 !== null) throw new Error("首次 switch 应返回 null");
    console.log("  [2a] switchActive development→rel-001 ✓（首次，prev=null）");

    // 2b. 创建 rel-002 并 switch → rel-002
    const rel002 = { ...rel001, releaseId: "rel-002", parentReleaseId: "rel-001", rollbackReleaseId: "rel-001", createdAt: new Date().toISOString() };
    registry.writeManifest(rel002);
    const prev2 = store.switchActive("development", "rel-002", {
      reason: "drill: activate rel-002", actor: "system",
    });
    if (prev2?.releaseId !== "rel-001") throw new Error(`switch 应返回旧 pointer rel-001，实际 ${prev2?.releaseId}`);
    console.log("  [2b] switchActive development→rel-002 ✓（prev=rel-001）");

    // 2c. rollback → 应恢复到 rel-001
    const rollbackResult = store.rollback("development", {
      reason: "drill: rollback to rel-001", actor: "user",
    });
    if (rollbackResult?.releaseId !== "rel-001") {
      throw new Error(`rollback 应恢复到 rel-001，实际 ${rollbackResult?.releaseId}`);
    }
    console.log("  [2c] rollback development ✓（恢复到 rel-001）");

    // 2d. 验证 active pointer 确实是 rel-001
    const activeAfter = store.readActive("development");
    if (activeAfter?.releaseId !== "rel-001") {
      throw new Error(`rollback 后 active 应为 rel-001，实际 ${activeAfter?.releaseId}`);
    }
    console.log("  [2d] readActive development ✓（确认 active=rel-001）");

    // 2e. 验证 rollback 历史是 append-only
    const rbHistory = store.loadRollbackHistory("development");
    if (rbHistory.length !== 1) {
      throw new Error(`rollback 历史应有 1 条，实际 ${rbHistory.length}`);
    }
    console.log(`  [2e] loadRollbackHistory ✓（${rbHistory.length} 条 rollback 记录，append-only）`);

    // 2f. 验证 evaluation 角色禁止修改 production pointer
    let evalBlocked = false;
    try {
      store.switchActive("production", "rel-001", { reason: "eval attempt", actor: "evaluation" });
    } catch {
      evalBlocked = true;
    }
    if (!evalBlocked) throw new Error("evaluation 角色应被禁止修改 production pointer");
    console.log("  [2f] evaluation 角色禁止修改 production pointer ✓");
    console.log("=== Drill 2 通过 ✓ ===");

    console.log("");
    console.log("[evolution:drill] ✅ 全部演练通过");
  } catch (e) {
    failed = true;
    console.error("");
    console.error(`[evolution:drill] ❌ 演练失败：${e.message}`);
    console.error(e.stack);
  } finally {
    rmSync(drillRoot, { recursive: true, force: true });
    console.log(`[evolution:drill] 已清理临时目录：${drillRoot}`);
  }

  if (failed) process.exit(5);
}

// ============================================================================
// 子命令：evaluate（1C 最小实现：frozen → evaluated 状态迁移）
// ============================================================================

/**
 * 1C evaluate 子命令：将 release 从 frozen 迁移到 evaluated。
 * 真实 NovelBench 对照为后续切片；本切片只做状态迁移 + 状态事件记录。
 */
function cmdEvaluate(args) {
  const releaseId = args["release-id"];
  if (!releaseId) {
    console.error("[evolution:evaluate] 错误：必须提供 --release-id <id>");
    process.exit(2);
  }

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:evaluate] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  if (manifest.status !== "frozen") {
    console.error(
      `[evolution:evaluate] 错误：release ${releaseId} 状态为 ${manifest.status}，必须为 frozen 才能迁移到 evaluated`,
    );
    process.exit(4);
  }

  registry.transitionStatus(releaseId, "evaluated", { actor: "system" });
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-evaluate-${Date.now()}`,
    releaseId,
    fromStatus: "frozen",
    toStatus: "evaluated",
    reason: "evolution:evaluate frozen → evaluated（1C 最小实现，NovelBench 对照为后续切片）",
    actor: "system",
    timestamp: new Date().toISOString(),
  });

  console.log(`[evolution:evaluate] ✓ ${releaseId}: frozen → evaluated`);
  console.log(`  registry path : ${join(releasesDir(), releaseId, "manifest.json")}`);
}

// ============================================================================
// 子命令：proxy-review（1C stub 端到端代理审批）
// ============================================================================

/**
 * 默认 packetInput body（不含 releaseId / releaseManifestHash，由 runner 填充）。
 * 真实场景应通过 --eval-input 提供；本默认仅用于 CLI 演练与测试。
 */
function makeDefaultPacketInputBody(changeClass) {
  return {
    changeClass,
    uniqueVariable: "test-strategy",
    fixedCase: "case-test-ch1",
    fixedModel: "doubao-seed-2.1-pro",
    fixedSeed: 0,
    budgetMaxCalls: 6,
    timeoutMs: 300000,
    candidateText: "候选正文",
    currentApprovedText: "当前正文",
    rawBaselineText: "raw 正文",
    factGuardReport: { candidatePass: true, currentPass: true, violations: [] },
    stateConsistency: { candidateConsistent: true, currentConsistent: true },
    costProfile: { candidateTokens: 1000, currentTokens: 900, candidateLatencyMs: 1000, currentLatencyMs: 900 },
    systemJudgeConclusion: "should be anonymized",
    developerExpectation: "should be anonymized",
    candidateSpans: [{ id: "s1", text: "候选更优", side: "candidate" }],
    currentSpans: [{ id: "s2", text: "当前较弱", side: "current" }],
  };
}

/**
 * 1C proxy-review 子命令：stub 端到端代理审批。
 *
 * 流程：load manifest → 状态校验（必须 evaluated）→ runStubProxyReview →
 *      落盘 artifact（per-release approvals 目录）→ 更新 manifest.approvalRef（APPROVE_DEV）→
 *      记录状态事件（evaluated → approved_dev/held/rejected/quarantined）。
 *
 * 不切换 active pointer（approved_dev → active_dev 由独立的 switch 子命令完成）。
 *
 * 支持 --stub-verdict（forward=reverse=verdict）与 --forward-verdict/--reverse-verdict 两种入参。
 */
async function cmdProxyReview(args) {
  const releaseId = args["release-id"];
  const realMode = args.real === true;
  if (!releaseId) {
    console.error("[evolution:proxy-review] 错误：必须提供 --release-id <id>");
    process.exit(2);
  }
  if (realMode && (args["stub-verdict"] || args["forward-verdict"] || args["reverse-verdict"])) {
    console.error("[evolution:proxy-review] error: --real cannot be combined with stub verdict options");
    process.exit(2);
  }

  const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = evolutionRegistry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:proxy-review] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  if (manifest.status !== "evaluated") {
    console.error(
      `[evolution:proxy-review] 错误：release ${releaseId} 状态为 ${manifest.status}，必须为 evaluated 才能代理审批`,
    );
    process.exit(4);
  }

  // verdict 解析：--stub-verdict 优先（forward=reverse），否则 --forward-verdict/--reverse-verdict
  let forwardVerdict;
  let reverseVerdict;
  if (args["stub-verdict"]) {
    forwardVerdict = args["stub-verdict"];
    reverseVerdict = args["stub-verdict"];
  } else {
    forwardVerdict = args["forward-verdict"] || "APPROVE_DEV";
    reverseVerdict = args["reverse-verdict"] || "APPROVE_DEV";
  }

  if (realMode && args["change-class"] && args["change-class"] !== manifest.changeClass) {
    console.error("[evolution:proxy-review] error: real review changeClass must match the frozen manifest");
    process.exit(2);
  }
  const changeClass = realMode ? manifest.changeClass : (args["change-class"] || manifest.changeClass || "R2");
  const modelVersion = args["model-version"] || "gpt5.6-sol-2026-07";
  const promptHash = args["prompt-hash"] || "sha256:evolution-cli-proxy-review";

  // packetInput body：--eval-input 优先，否则默认
  if (realMode && !args["eval-input"]) {
    console.error("[evolution:proxy-review] error: --real requires --eval-input; placeholder evidence is forbidden");
    process.exit(2);
  }
  let packetInputBody;
  if (args["eval-input"]) {
    try {
      packetInputBody = JSON.parse(readFileSync(args["eval-input"], "utf-8"));
    } catch (e) {
      console.error(`[evolution:proxy-review] 错误：加载 --eval-input 失败（${args["eval-input"]}）：${e.message}`);
      process.exit(5);
    }
  } else {
    packetInputBody = makeDefaultPacketInputBody(changeClass);
  }

  // approvals 目录：per-release（{evolutionRoot}/releases/{releaseId}/approvals/）
  const approvalsDir = join(releasesDir(), releaseId, "approvals");
  const proxyRegistry = createProxyApprovalRegistry({ approvalsDir });

  let result;
  try {
    if (realMode) {
      if (!args.card) {
        console.error("[evolution:proxy-review] REQUIRES_AUTH: --real requires --card <path>");
        process.exit(6);
      }
      result = await runRealProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId,
        packetInput: packetInputBody,
        authorizationCardPath: args.card,
      });
    } else {
      result = await runStubProxyReview({
        proxyRegistry,
        evolutionRegistry,
        releaseId,
        packetInput: packetInputBody,
        forwardVerdict,
        reverseVerdict,
        modelVersion,
        promptHash,
        budget: { maxCalls: 2, timeoutMs: 60000 },
      });
    }
  } catch (e) {
    console.error(`[evolution:proxy-review] 失败：${e.message}`);
    process.exit(String(e.message).startsWith("REQUIRES_AUTH:") ? 6 : 5);
  }

  // 状态映射：finalVerdict → 目标 status
  // canPromote=false 的 APPROVE_DEV（R3/shopping 阻断）→ held（需用户审批）
  let targetStatus;
  if (result.canPromote) {
    targetStatus = "approved_dev";
  } else if (result.finalVerdict === "REJECT") {
    targetStatus = "rejected";
  } else if (result.finalVerdict === "QUARANTINE") {
    targetStatus = "quarantined";
  } else {
    // APPROVE_DEV 但 canPromote=false（R3/shopping）或 HOLD → held
    targetStatus = "held";
  }

  // 更新 manifest：仅 canPromote=true 时绑定 approvalRef；status 迁移
  // 使用 transitionStatus 而非 writeManifest，绕过 frozen immutability 检查
  // （状态迁移合法性已由 isStatusTransitionValid + P0 审批绑定/角色守护在 transitionStatus 内部守护）
  // actor=gpt5.6-sol-proxy：代理审批驱动 evaluated → approved_dev（approvalRef 必须非空）。
  // 非 approved_dev 目标（held/rejected/quarantined）不属于审批要求状态，approvalRef 可缺省。
  // P1 修复（第四轮）：transitionStatus 失败时清理已写入的 approval artifact，避免孤立；
  // recordStateEvent 失败时 warn-only（manifest 已成功迁移）。
  const artifactPath = join(approvalsDir, `${result.artifact.approvalId}.json`);
  try {
    evolutionRegistry.transitionStatus(releaseId, targetStatus, {
      actor: "gpt5.6-sol-proxy",
      approvalRef: result.canPromote ? result.artifact.approvalId : undefined,
    });
  } catch (e) {
    // 清理孤立的 approval artifact（artifact 已由 runStubProxyReview/runRealProxyReview 写入，但状态迁移失败）
    try {
      unlinkSync(artifactPath);
    } catch (cleanupErr) {
      console.error(`[evolution:proxy-review] ⚠ approval artifact 清理失败：${cleanupErr.message}（需人工清理 ${artifactPath}）`);
    }
    console.error(`[evolution:proxy-review] 状态迁移失败：${e.message}`);
    process.exit(5);
  }
  try {
    evolutionRegistry.recordStateEvent({
      eventId: `evt-${releaseId}-proxy-review-${Date.now()}`,
      releaseId,
      fromStatus: "evaluated",
      toStatus: targetStatus,
      reason: `evolution:proxy-review finalVerdict=${result.finalVerdict}`,
      actor: "gpt5.6-sol-proxy",
      evidenceRefs: [result.artifact.approvalId],
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    // P1 修复（第四轮）：manifest 已成功迁移，audit log 失败只 warning 不阻断
    console.warn(`[evolution:proxy-review] ⚠ 状态事件写入失败（manifest 已成功迁移，audit 缺失）：${e.message}`);
  }

  console.log(`[evolution:proxy-review] ✓ ${releaseId} evaluated → ${targetStatus}`);
  console.log(`  finalVerdict  : ${result.finalVerdict}`);
  console.log(`  canPromote    : ${result.canPromote}`);
  console.log(`  targetStatus  : ${targetStatus}`);
  if (result.blockReason) {
    console.log(`  blockReason   : ${result.blockReason}`);
  }
  console.log(`  approvalId    : ${result.artifact.approvalId}`);
  console.log(`  artifact path : ${join(approvalsDir, result.artifact.approvalId + ".json")}`);
}

// ============================================================================
// 共享：approval artifact 真实性校验（P0-2 修复）
// ============================================================================

/**
 * P0-2 修复：共享的 approval artifact 真实性校验。
 * cmdPromote（晋级时校验当前 release）与 cmdRollback（回滚时校验目标 release）共用。
 *
 * 校验四元绑定：
 * 1. artifact 存在（loadArtifact 返回非 null）
 * 2. artifact.approvalId === manifest.approvalRef
 * 3. artifact.releaseId === manifest.releaseId
 * 4. artifact.finalVerdict === "APPROVE_DEV"
 * 5. verifyManifestBinding(artifact, computeReleasePayloadHash(manifest)).ok
 *
 * 失败时 process.exit(5)，错误消息带 [evolution:<label>] 前缀。
 * 成功时返回 { proxyRegistry, artifact }，供调用方复用。
 */
function validateApprovalArtifactForRelease({
  registry,
  releasesDir,
  releaseId,
  manifest,
  label,
  requireNetwork = false,
}) {
  if (manifest.approvalRef == null || manifest.approvalRef === "") {
    console.error(`[evolution:${label}] 错误：release ${releaseId} approvalRef 为空`);
    process.exit(5);
  }
  const approvalsDir = join(releasesDir, releaseId, "approvals");
  const proxyRegistry = createProxyApprovalRegistry({ approvalsDir });
  const finalApprovalRef = manifest.approvalRef;
  let artifact;
  try {
    artifact = proxyRegistry.loadArtifact(finalApprovalRef);
  } catch (e) {
    console.error(`[evolution:${label}] 错误：approval artifact 解析失败：${finalApprovalRef} — ${e.message}`);
    process.exit(5);
  }
  if (artifact === null) {
    console.error(`[evolution:${label}] 错误：approval artifact 不存在：${finalApprovalRef}（releaseId=${releaseId}）`);
    process.exit(5);
  }
  if (artifact.approvalId !== finalApprovalRef) {
    console.error(`[evolution:${label}] 错误：artifact.approvalId=${artifact.approvalId} 与 approvalRef=${finalApprovalRef} 不匹配`);
    process.exit(5);
  }
  if (artifact.releaseId !== releaseId) {
    console.error(`[evolution:${label}] 错误：artifact.releaseId=${artifact.releaseId} 与 manifest releaseId=${releaseId} 不匹配（不得跨 release 复用）`);
    process.exit(5);
  }
  if (artifact.finalVerdict !== "APPROVE_DEV") {
    console.error(`[evolution:${label}] 错误：artifact.finalVerdict=${artifact.finalVerdict}，必须是 APPROVE_DEV`);
    process.exit(5);
  }
  if (requireNetwork && artifact.reviewTransport !== "network") {
    console.error(
      `[evolution:${label}] error: production requires reviewTransport=network, got ${artifact.reviewTransport ?? "missing"}`,
    );
    process.exit(5);
  }
  const manifestHash = computeReleasePayloadHash(manifest);
  const binding = verifyManifestBinding(artifact, manifestHash);
  if (!binding.ok) {
    console.error(`[evolution:${label}] 错误：artifact releaseManifestHash 与 manifest hash 不匹配${binding.error ? `：${binding.error}` : ""}`);
    process.exit(5);
  }
  return { proxyRegistry, artifact };
}

// ============================================================================
// 子命令：promote（G5）
// ============================================================================

/**
 * G5 promote：晋级 release 到 active_dev / candidate_prod / active_prod。
 *
 * 状态机约束（evolution-release-schema.ts TRANSITIONS）：
 *   approved_dev   → active_dev  （dev pointer 切换）
 *   active_dev     → candidate_prod（不切 pointer，候选态）
 *   candidate_prod → active_prod  （prod pointer 切换，强制 actor=user）
 *
 * 守护：
 * - APPROVAL_REQUIRED（active_dev/candidate_prod/active_prod）：approvalRef 必须非空
 * - PRODUCTION_PROMOTION（candidate_prod/active_prod）：actor 必须 user
 *
 * R2/R3 active_prod 晋级必须消费已完成且与 release 绑定的真实 canary 证据。
 */
function cmdPromote(args) {
  const releaseId = args["release-id"];
  if (!releaseId) {
    console.error("[evolution:promote] 错误：必须提供 --release-id <id>");
    process.exit(2);
  }
  // P1-2 路径穿越守护：CLI 层先校验 releaseId 字符集（早失败给清晰错误码 exit 2）
  const RELEASE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    console.error(
      `[evolution:promote] 错误：--release-id 包含非法字符（仅允许 [a-zA-Z0-9_-]）：${releaseId}`,
    );
    process.exit(2);
  }
  const target = args["target"] || "active_dev";
  const VALID_TARGETS = new Set(["active_dev", "candidate_prod", "active_prod"]);
  if (!VALID_TARGETS.has(target)) {
    console.error(`[evolution:promote] 错误：--target 必须是 active_dev | candidate_prod | active_prod，实际 ${target}`);
    process.exit(2);
  }
  const isProdPromotion = target === "candidate_prod" || target === "active_prod";
  // P0-3 修复：生产晋级必须显式 --confirm-prod，避免脚本默认/误操作触发生产路径
  if (isProdPromotion && args["confirm-prod"] !== true) {
    console.error(
      `[evolution:promote] 错误：晋级到 ${target} 必须显式 --confirm-prod（PRODUCTION_PROMOTION 守护：防止误操作/脚本默认触发生产晋级）`,
    );
    process.exit(2);
  }
  const actor = args["actor"] || (isProdPromotion ? "user" : "system");
  if (isProdPromotion && actor !== "user") {
    console.error(`[evolution:promote] 错误：晋级到 ${target} 必须由 user actor 执行（PRODUCTION_PROMOTION 守护）`);
    process.exit(2);
  }
  const reason = args["reason"] || `evolution:promote to ${target}`;

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:promote] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  // 状态机对齐：每个 target 只允许一个 from 状态（TRANSITIONS 严格映射）
  const ALLOWED_FROM_BY_TARGET = {
    active_dev: new Set(["approved_dev"]),
    candidate_prod: new Set(["active_dev"]),
    active_prod: new Set(["candidate_prod"]),
  };
  const allowedFrom = ALLOWED_FROM_BY_TARGET[target];
  if (!allowedFrom.has(manifest.status)) {
    console.error(
      `[evolution:promote] 错误：当前状态 ${manifest.status} 不允许晋级到 ${target}；合法 from=${[...allowedFrom].join("|")}`,
    );
    process.exit(4);
  }

  // APPROVAL_REQUIRED 守护：所有 target 都是 APPROVAL_REQUIRED
  if (manifest.approvalRef == null || manifest.approvalRef === "") {
    console.error(
      `[evolution:promote] 错误：晋级到 ${target} 需要 approvalRef（APPROVAL_REQUIRED）；请先运行 evolution:proxy-review 获得 APPROVE_DEV`,
    );
    process.exit(5);
  }

  // P0-2 修复：用共享 helper 校验 approval artifact（与 cmdRollback 一致）
  const { proxyRegistry } = validateApprovalArtifactForRelease({
    registry,
    releasesDir: releasesDir(),
    releaseId,
    manifest,
    label: "promote",
    requireNetwork: isProdPromotion,
  });
  const resolveApprovalArtifact = (approvalRef) => {
    return proxyRegistry.loadArtifact(approvalRef);
  };

  let canaryEvidenceRunId = null;
  let canaryEvidenceRef = null;
  if (target === "active_prod") {
    const workspacePath = args["workspace"] || process.env.PINOVEL_WORKSPACE_PATH || null;
    const canaryRunId = args["canary-run"] || null;
    let canaryTrace = null;
    if (workspacePath && canaryRunId) {
      try {
        canaryTrace = createCanaryTraceStore({
          canaryRunsDir: join(workspacePath, "canary-runs"),
        }).readCanaryTrace(canaryRunId);
      } catch (e) {
        console.error(`[evolution:promote] CANARY_EVIDENCE_REQUIRED: ${e.message}`);
        process.exit(5);
      }
    }
    const canaryGate = evaluateCanaryPromotionGate({
      releaseId,
      changeClass: manifest.changeClass,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef,
      workspaceId: workspacePath ? basename(workspacePath) : "",
      trace: canaryTrace,
    });
    if (!canaryGate.ok) {
      console.error(`[evolution:promote] ${canaryGate.code}: ${canaryGate.reason}`);
      process.exit(5);
    }
    if (canaryTrace && workspacePath) {
      let sourceTrace = null;
      try {
        sourceTrace = createCanaryTraceStore({
          canaryRunsDir: join(workspacePath, "canary-runs"),
        }).readCanaryTrace(canaryTrace.evidence.sourceRunId);
      } catch (e) {
        console.error(`[evolution:promote] CANARY_SOURCE_INVALID: ${e.message}`);
        process.exit(5);
      }
      const completionLink = evaluateCanaryCompletionLink(sourceTrace, canaryTrace);
      if (!completionLink.ok) {
        console.error(`[evolution:promote] ${completionLink.code}: ${completionLink.reason}`);
        process.exit(5);
      }
      const artifactVerification = verifyCanaryResultArtifacts(workspacePath, canaryTrace, {
        releaseId: manifest.releaseId,
        environmentFingerprint: manifest.environmentFingerprint,
        approvalRef: manifest.approvalRef,
      });
      if (!artifactVerification.ok) {
        console.error(
          `[evolution:promote] ${artifactVerification.code}: ${artifactVerification.reason}`,
        );
        process.exit(5);
      }
    }
    canaryEvidenceRunId = canaryGate.evidenceRunId;
    if (canaryEvidenceRunId && workspacePath) {
      canaryEvidenceRef = `canary:${basename(workspacePath)}/${canaryEvidenceRunId}`;
    }
  }

  const promotionEvent = {
    eventId: `evt-${releaseId}-promote-${Date.now()}`,
    releaseId,
    fromStatus: manifest.status,
    toStatus: target,
    reason,
    actor,
    ...(canaryEvidenceRef ? { evidenceRefs: [canaryEvidenceRef] } : {}),
    timestamp: new Date().toISOString(),
  };
  let promotionEventRecorded = false;
  if (target === "active_prod" && canaryEvidenceRef) {
    try {
      registry.recordStateEvent(promotionEvent);
      promotionEventRecorded = true;
    } catch (e) {
      console.error(`[evolution:promote] 状态事件写入失败，未切换 production pointer：${e.message}`);
      process.exit(5);
    }
  }

  // P0-2 修复：原子切换 — pointer 先切，失败则 manifest 未动，可安全重试
  const store = createReleasePointerStore({
    configDir: configDir(),
    resolveManifestForValidation: (rid) => {
      const m = registry.loadManifest(rid);
      return m ? { releaseId: m.releaseId, status: m.status, approvalRef: m.approvalRef } : null;
    },
  });
  let previousPointer = null;
  let pointerKindSwitched = null;
  if (target === "active_dev") {
    try {
      previousPointer = store.switchActive("development", releaseId, { actor, reason });
      pointerKindSwitched = "development";
    } catch (e) {
      console.error(`[evolution:promote] 指针切换失败（dev）：${e.message}`);
      process.exit(5); // manifest 未写入，可安全重试
    }
  } else if (target === "active_prod") {
    try {
      previousPointer = store.switchActive("production", releaseId, { actor: "user", reason });
      pointerKindSwitched = "production";
    } catch (e) {
      console.error(`[evolution:promote] 指针切换失败（prod）：${e.message}`);
      process.exit(5);
    }
  }
  // candidate_prod 不切指针（候选态）

  // 写 manifest（transitionStatus 内部会再次校验 approval artifact，因为 resolver 注入了）
  let updatedManifest;
  try {
    updatedManifest = registry.transitionStatus(releaseId, target, {
      actor,
      approvalRef: manifest.approvalRef,
      resolveApprovalArtifact,
    });
  } catch (e) {
    // P0-2 修复：manifest 写入失败时回滚 pointer（多一条 switch 历史作 audit 痕迹，可安全重试）
    if (pointerKindSwitched && previousPointer) {
      try {
        store.switchActive(pointerKindSwitched, previousPointer.releaseId, {
          actor,
          reason: `revert: promote manifest 失败 — ${e.message}`,
        });
      } catch (revertErr) {
        console.error(`[evolution:promote] ⚠ 指针回滚也失败：${revertErr.message}（需人工介入）`);
      }
    } else if (pointerKindSwitched && !previousPointer) {
      console.error(`[evolution:promote] ⚠ manifest 失败且无前序 pointer 可回滚（需人工介入）`);
    }
    console.error(`[evolution:promote] 状态迁移失败：${e.message}`);
    process.exit(5);
  }

  // 写状态事件（audit log，失败只 warning 不阻断 — pointer + manifest 已成功）
  if (!promotionEventRecorded) {
    try {
      registry.recordStateEvent(promotionEvent);
    } catch (e) {
      console.warn(`[evolution:promote] ⚠ 状态事件写入失败（pointer + manifest 已成功，audit 缺失）：${e.message}`);
    }
  }

  console.log(`[evolution:promote] ✓ 晋级成功`);
  console.log(`  releaseId       : ${releaseId}`);
  console.log(`  status          : ${manifest.status} → ${target}`);
  console.log(`  approvalRef     : ${updatedManifest.approvalRef}`);
  console.log(`  actor           : ${actor}`);
  console.log(`  reason          : ${reason}`);
  if (pointerKindSwitched) {
    console.log(`  pointer switched: ${pointerKindSwitched} → ${releaseId}（previous=${previousPointer?.releaseId ?? "(none)"}）`);
  } else {
    console.log(`  pointer switched: (none, target=${target} 不切指针)`);
  }
  if (canaryEvidenceRunId) {
    console.log(`  canary evidence : ${canaryEvidenceRunId}`);
  } else if (target === "active_prod") {
    console.log(`  canary evidence : policy direct (${manifest.changeClass})`);
  }
}

// ============================================================================
// 子命令：hold（G5）
// ============================================================================

/**
 * G5 hold：暂停 release（active_dev/candidate_prod/active_prod → held）。
 *
 * 语义：hold 只改 manifest 状态，不动 pointer（保留 active 给诊断）。
 * 如需撤下 active，配合 evolution:rollback。
 */
function cmdHold(args) {
  const releaseId = args["release-id"];
  if (!releaseId) {
    console.error("[evolution:hold] 错误：必须提供 --release-id <id>");
    process.exit(2);
  }
  const actor = args["actor"] || "system";
  const reason = args["reason"] || "evolution:hold";

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:hold] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  const ALLOWED_FROM = new Set(["active_dev", "candidate_prod", "active_prod"]);
  if (!ALLOWED_FROM.has(manifest.status)) {
    console.error(
      `[evolution:hold] 错误：当前状态 ${manifest.status} 不允许 hold；仅 active_dev/candidate_prod/active_prod 可 hold`,
    );
    process.exit(4);
  }

  try {
    registry.transitionStatus(releaseId, "held", { actor, reason });
  } catch (e) {
    console.error(`[evolution:hold] 状态迁移失败：${e.message}`);
    process.exit(5);
  }

  // 状态事件（transitionStatus 不写事件，需单独记录）
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-hold-${Date.now()}`,
    releaseId,
    fromStatus: manifest.status,
    toStatus: "held",
    reason,
    actor,
    timestamp: new Date().toISOString(),
  });

  // 不切指针（hold 不撤下 active；如需撤下配合 evolution:rollback）
  const store = createReleasePointerStore({ configDir: configDir() });
  const devPointer = store.readActive("development");
  const prodPointer = store.readActive("production");

  console.log(`[evolution:hold] ✓ 已 hold`);
  console.log(`  releaseId       : ${releaseId}`);
  console.log(`  status          : ${manifest.status} → held`);
  console.log(`  actor           : ${actor}`);
  console.log(`  reason          : ${reason}`);
  console.log(
    `  ⚠ 未切换 pointer（dev=${devPointer?.releaseId ?? "(none)"}, prod=${prodPointer?.releaseId ?? "(none)"}）；如需撤下 active，请配合 evolution:rollback`,
  );
}

// ============================================================================
// 子命令：rollback（G5）
// ============================================================================

/**
 * G5 rollback：回滚 active pointer 到前序 release + 标记当前 release held。
 *
 * 底层 store.rollback 基于 rollback-history 的最近 switch 记录回滚；
 * CLI 额外把被回滚的当前 release 标记为 held（不删除失败版本和负面证据，符合 §G5）。
 *
 * 策略集合 / 状态版本回滚需 strategy-policy-store / narrative-state-store 版本化（G8 范围）。
 */
function cmdRollback(args) {
  const kind = args["kind"] || "development";
  const VALID_KINDS = new Set(["development", "production"]);
  if (!VALID_KINDS.has(kind)) {
    console.error(`[evolution:rollback] 错误：--kind 必须是 development | production，实际 ${kind}`);
    process.exit(2);
  }
  const actor = args["actor"] || "user";
  const reason = args["reason"] || "evolution:rollback";

  const store = createReleasePointerStore({ configDir: configDir() });
  const currentPointer = store.readActive(kind);
  if (!currentPointer) {
    console.error(`[evolution:rollback] 错误：当前 ${kind} 无 active pointer，无法回滚`);
    process.exit(4);
  }

  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const currentManifest = registry.loadManifest(currentPointer.releaseId);

  // P1-3 修复：用 peekRollbackTarget 预校验回滚目标
  let targetReleaseId;
  try {
    targetReleaseId = store.peekRollbackTarget(kind);
  } catch (e) {
    console.error(`[evolution:rollback] 无法确定回滚目标：${e.message}`);
    process.exit(5);
  }
  if (targetReleaseId === null) {
    console.error(`[evolution:rollback] 错误：已到初始状态，无前序可回滚`);
    process.exit(5);
  }

  // P1-3 修复：校验 manifest.rollbackReleaseId（跳过 rel-000 占位）
  if (
    currentManifest &&
    currentManifest.rollbackReleaseId &&
    currentManifest.rollbackReleaseId !== "rel-000" &&
    currentManifest.rollbackReleaseId !== targetReleaseId
  ) {
    console.error(
      `[evolution:rollback] 错误：history 目标 ${targetReleaseId} 与 manifest.rollbackReleaseId ${currentManifest.rollbackReleaseId} 不匹配`,
    );
    process.exit(5);
  }

  // P1-3 修复：校验目标 manifest 存在 + 状态可接受
  const targetManifest = registry.loadManifest(targetReleaseId);
  if (!targetManifest) {
    console.error(`[evolution:rollback] 错误：目标 release ${targetReleaseId} 不存在`);
    process.exit(5);
  }
  const ACCEPTABLE_TARGET_STATUS = new Set([
    "active_dev", "candidate_prod", "active_prod", "approved_dev", "frozen", "evaluated",
  ]);
  if (!ACCEPTABLE_TARGET_STATUS.has(targetManifest.status)) {
    console.error(
      `[evolution:rollback] 错误：目标 ${targetReleaseId} 状态 ${targetManifest.status} 不可作为回滚目标` +
        `（draft/held/rejected/quarantined 不可回滚到）`,
    );
    process.exit(5);
  }

  // P0-2 修复：production 回滚时必须验证目标 release 的 approval artifact 真实性
  // （不能只查 approvalRef 非空 — 伪造或不存在的审批引用不得通过）
  if (kind === "production") {
    validateApprovalArtifactForRelease({
      registry,
      releasesDir: releasesDir(),
      releaseId: targetReleaseId,
      manifest: targetManifest,
      label: "rollback",
      requireNetwork: true,
    });
  }

  // 执行 rollback
  let newPointer;
  try {
    newPointer = store.rollback(kind, { reason, actor });
  } catch (e) {
    console.error(`[evolution:rollback] 指针回滚失败：${e.message}`);
    process.exit(5);
  }

  // 标记当前 release 为 held（不删除失败版本和负面证据，符合 §G5）
  if (currentManifest) {
    try {
      registry.transitionStatus(currentPointer.releaseId, "held", { actor, reason });
      // 状态事件（transitionStatus 不写事件，需单独记录）
      registry.recordStateEvent({
        eventId: `evt-${currentPointer.releaseId}-rollback-${Date.now()}`,
        releaseId: currentPointer.releaseId,
        fromStatus: currentManifest.status,
        toStatus: "held",
        reason: `rollback ${kind} pointer: ${reason}`,
        actor,
        timestamp: new Date().toISOString(),
      });
      console.log(`[evolution:rollback] 当前 release ${currentPointer.releaseId} 已标记 held（不删除）`);
    } catch (e) {
      console.warn(
        `[evolution:rollback] ⚠ 标记 ${currentPointer.releaseId} 为 held 失败（指针已回滚）：${e.message}`,
      );
    }
  }

  const rbHistory = store.loadRollbackHistory(kind);

  console.log(`[evolution:rollback] ✓ 回滚成功`);
  console.log(`  kind            : ${kind}`);
  console.log(`  from            : ${currentPointer.releaseId}`);
  console.log(`  to              : ${newPointer?.releaseId ?? "(none)"}`);
  console.log(`  actor           : ${actor}`);
  console.log(`  reason          : ${reason}`);
  console.log(`  rollback history: ${rbHistory.length} 条（append-only）`);
}

// ============================================================================
// 子命令：health（G8 健康监控与退役）
// ============================================================================

/**
 * 计算 release 的长期 alignmentRate（最近 RETIRED_EVALUATION_WINDOW 条 feedback）。
 *
 * 与 aggregateReleaseHealthByRelease 的区别：只取最近 N 条记录计算 alignmentRate，
 * 用于 retired_suggestion 判定，避免短期波动误触发退役建议。
 */
function computeLongTermAlignmentRate(workspacePath, releaseId) {
  const registry = createChapterProxyApprovalRegistry({
    approvalsDir: join(workspacePath, "chapter-approvals"),
  });
  const artifacts = registry.listArtifactsByRelease(releaseId);
  const approvalIdSet = new Set(artifacts.map((a) => a.approvalId));
  const allRecords = loadProxyApprovalFeedback(workspacePath);
  const filteredRecords =
    approvalIdSet.size > 0
      ? allRecords.filter((r) => approvalIdSet.has(r.approvalId))
      : [];
  const windowRecords = filteredRecords.slice(-RETIRED_EVALUATION_WINDOW);
  let aligned = 0;
  let misaligned = 0;
  for (const r of windowRecords) {
    if (r.action === "inspect") continue;
    if (r.proxyJudgmentBias?.aligned) {
      aligned += 1;
    } else {
      misaligned += 1;
    }
  }
  const total = aligned + misaligned;
  return total > 0 ? aligned / total : 0;
}

/**
 * 打印单个 release 的健康报告。
 */
function printHealthReport(
  releaseId,
  evaluation,
  costStats,
  eligibilityResult,
  autoHoldResult,
  retiredSuggestion,
) {
  console.log(`=== Release Health: ${releaseId} ===`);
  console.log(`  status             : ${evaluation.status}`);
  console.log(`  sampleCount        : ${evaluation.evidence.sampleCount}`);
  console.log(`  alignmentRate      : ${evaluation.evidence.alignmentRate.toFixed(2)}`);
  console.log(`  rollbackRate       : ${evaluation.evidence.rollbackRate.toFixed(2)}`);
  console.log(
    `  factGuardPassRate  : ${evaluation.evidence.factGuardPassRate === null ? "null" : evaluation.evidence.factGuardPassRate.toFixed(2)}`,
  );
  console.log(`  consecutiveNegative: ${evaluation.evidence.consecutiveNegative}`);
  console.log(`  longTermAlignment  : ${evaluation.evidence.longTermAlignmentRate.toFixed(2)}`);
  console.log(`  currentStatus      : ${evaluation.decision.currentStatus}`);
  console.log(`  alreadyHeld        : ${evaluation.decision.alreadyHeld}`);
  console.log("");

  console.log("  Decision:");
  console.log(`    shouldAutoHold      : ${evaluation.decision.shouldAutoHold}`);
  console.log(`    shouldSuggestRetired: ${evaluation.decision.shouldSuggestRetired}`);
  console.log(`    recoveryAlignmentRate: ${evaluation.decision.recoveryAlignmentRate}`);
  console.log("");

  console.log("  Cost Stats:");
  console.log(`    totalCalls       : ${costStats.totalCalls}`);
  console.log(`    totalFailedCalls : ${costStats.totalFailedCalls}`);
  console.log(`    totalDurationMs  : ${costStats.totalDurationMs}`);
  console.log(`    averageDurationMs: ${costStats.averageDurationMs.toFixed(0)}`);
  console.log("");

  if (eligibilityResult) {
    console.log("  Eligibility:");
    console.log(`    eligibility      : ${eligibilityResult.eligibility}`);
    console.log(`    revokedStrategies: ${eligibilityResult.revokedStrategies.length}`);
    if (eligibilityResult.reason) {
      console.log(`    reason           : ${eligibilityResult.reason}`);
    }
    if (eligibilityResult.suggestedAction) {
      console.log(`    suggestedAction  : ${eligibilityResult.suggestedAction}`);
    }
    console.log("");
  }

  if (autoHoldResult) {
    console.log("  Auto-Hold:");
    console.log(`    held         : ${autoHoldResult.held}`);
    if (autoHoldResult.skippedReason) {
      console.log(`    skippedReason: ${autoHoldResult.skippedReason}`);
    }
    if (autoHoldResult.eventId) {
      console.log(`    eventId      : ${autoHoldResult.eventId}`);
    }
    console.log("");
  }

  console.log("  Suggestions:");
  if (evaluation.decision.shouldAutoHold && !autoHoldResult) {
    console.log("    ⚠ Auto-hold recommended. Run with --apply to execute.");
    console.log(`    Recovery requires alignmentRate >= ${evaluation.decision.recoveryAlignmentRate} (hysteresis).`);
  }
  if (retiredSuggestion) {
    console.log("    Retired suggestion (does not auto-execute):");
    console.log(`      ${retiredSuggestion.manualCommand}`);
  }
  if (evaluation.overrideHint) {
    console.log("  Override Hint:");
    console.log(`    ${evaluation.overrideHint}`);
  }
  if (
    !evaluation.decision.shouldAutoHold &&
    !retiredSuggestion &&
    !evaluation.overrideHint
  ) {
    console.log("    (none)");
  }
  console.log("");
}

/**
 * 处理单个 release 的健康报告。
 */
function cmdHealthSingle(releaseId, workspacePath, options) {
  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:health] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  // 1. 聚合 per-release 健康报告（feedback 按 releaseId 过滤）
  const workspaceId = basename(workspacePath);
  const projectRoot = dirname(dirname(workspacePath));
  const perReleaseReport = aggregateReleaseHealthByRelease(workspacePath, releaseId, {
    workspaceId,
  });

  // 2. 从全量 workspace 报告中获取策略信誉快照（strategy-policy 是 workspace 级）
  // P1-4 修复：按 release 关联的 chapter 集合过滤策略信誉，避免 workspace 全局
  // 策略信誉污染 per-release 连续负收益 / eligibility 判定
  const fullReport = aggregateReleaseHealth(workspacePath, { workspaceId, projectRoot });
  perReleaseReport.strategyReputations = filterStrategyReputationsByRelease(
    fullReport.strategyReputations,
    workspacePath,
    releaseId,
  );

  // 3. 计算长期 alignmentRate（最近 RETIRED_EVALUATION_WINDOW 条 feedback）
  const longTermAlignmentRate = computeLongTermAlignmentRate(workspacePath, releaseId);

  // 4. 健康判定（纯函数）
  const evaluation = evaluateReleaseHealth({
    releaseId,
    currentStatus: manifest.status,
    healthReport: perReleaseReport,
    longTermAlignmentRate,
  });

  // 5. 成本统计（从 trace 聚合 modelCalls）
  const costStats = aggregateReleaseCostStats(workspacePath, releaseId);

  // 6. eligibility 重算（可选）
  let eligibilityResult = null;
  if (options.recomputeEligibilityFlag) {
    eligibilityResult = recomputeEligibility({
      strategyReputations: perReleaseReport.strategyReputations,
      releaseId,
      approvalRef: manifest.approvalRef,
      alignmentRate: perReleaseReport.alignmentStats.alignmentRate,
      longTermAlignmentRate,
    });
  }

  // 7. auto-hold 执行（可选，带副作用）
  // P1-3 修复：传入 pointerStore，让 executeAutoHold 清理指向 held release 的 active pointer
  // dev pointer 自动 rollback（system 有权限）；production pointer 悬挂 warning（system 无权 rollback）
  let autoHoldResult = null;
  if (options.apply) {
    const pointerStore = createReleasePointerStore({ configDir: configDir() });
    autoHoldResult = executeAutoHold(registry, evaluation, {
      actor: "system",
      pointerStore,
    });
  }

  // 8. retired 建议生成（纯函数，不自动执行）
  const retiredSuggestion = generateRetiredSuggestion(evaluation);

  // 9. 打印报告
  printHealthReport(
    releaseId,
    evaluation,
    costStats,
    eligibilityResult,
    autoHoldResult,
    retiredSuggestion,
  );
}

/**
 * 处理所有 active release 的健康报告。
 */
function cmdHealthAll(workspacePath, options) {
  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifests = registry.listManifests();
  // active = 非 draft / held / retired
  const activeStatuses = new Set([
    "candidate",
    "frozen",
    "evaluated",
    "approved_dev",
    "active_dev",
    "candidate_prod",
    "active_prod",
  ]);
  const activeManifests = manifests.filter((m) => activeStatuses.has(m.status));
  if (activeManifests.length === 0) {
    console.log("=== Release Health: (no active releases) ===");
    return;
  }
  for (const m of activeManifests) {
    cmdHealthSingle(m.releaseId, workspacePath, {
      apply: false,
      recomputeEligibilityFlag: options.recomputeEligibilityFlag,
    });
  }
}

/**
 * health 子命令入口。
 *
 * 用法：
 *   evolution:health --release-id <id> --workspace <path> [--apply] [--recompute-eligibility]
 *   evolution:health --all --workspace <path> [--recompute-eligibility]
 */
function cmdHealth(args) {
  const releaseId = args["release-id"];
  const all = args["all"] === true;
  const apply = args["apply"] === true;
  const recomputeEligibilityFlag = args["recompute-eligibility"] === true;
  const workspacePath = args["workspace"] || process.env.PINOVEL_WORKSPACE_PATH;

  // 1. 参数校验：必须提供 --release-id 或 --all
  if (!releaseId && !all) {
    console.error("[evolution:health] 错误：必须提供 --release-id <id> 或 --all");
    process.exit(2);
  }

  // 2. workspace 路径解析
  if (!workspacePath) {
    console.error(
      "[evolution:health] 错误：必须提供 --workspace <path> 或设置 PINOVEL_WORKSPACE_PATH 环境变量",
    );
    process.exit(2);
  }

  // 3. 分发
  if (releaseId) {
    cmdHealthSingle(releaseId, workspacePath, { apply, recomputeEligibilityFlag });
  } else {
    cmdHealthAll(workspacePath, { recomputeEligibilityFlag });
  }
}

// ============================================================================
// canary 子命令（G5 P1 bounded canary）
// ============================================================================

/**
 * canary 子命令入口（G5 P1 bounded canary）。
 *
 * 用法：
 *   evolution:canary --release-id <id> --workspace <path>
 *     打印 canary 决策（evaluate，默认模式）
 *   evolution:canary --release-id <id> --workspace <path> --apply
 *     执行决策（写 trace + 可选 G8 auto-hold）
 *   evolution:canary --release-id <id> --workspace <path> --status
 *     查看 release 的 canary 运行历史
 *   evolution:canary --release-id <id> --workspace <path> --authorize --auth-file <path> | --auth-json '<json>'
 *     写入 workspace 级 canary 授权
 *   evolution:canary --release-id <id> --workspace <path> --complete --run-id <id> --result-file <path>
 *     校验并追加真实 canary 完成证据（不调用模型）
 *
 * 退出码：0 成功 / 2 参数错误 / 3 release 不存在 / 4 状态不合法 / 5 操作失败 / 6 未授权
 */
function cmdCanary(args) {
  const releaseId = args["release-id"];
  const workspacePath = args["workspace"] || process.env.PINOVEL_WORKSPACE_PATH;
  const apply = args["apply"] === true;
  const statusFlag = args["status"] === true;
  const authorize = args["authorize"] === true;
  const complete = args["complete"] === true;
  const authFile = args["auth-file"];
  const authJson = args["auth-json"];

  // 1. 参数校验
  if (!releaseId) {
    console.error("[evolution:canary] 错误：必须提供 --release-id <id>");
    process.exit(2);
  }
  if (!workspacePath) {
    console.error(
      "[evolution:canary] 错误：必须提供 --workspace <path> 或设置 PINOVEL_WORKSPACE_PATH 环境变量",
    );
    process.exit(2);
  }

  // 2. authorize 模式：不需要 release 存在 / 状态校验，只写授权文件
  if (authorize) {
    cmdCanaryAuthorize(releaseId, workspacePath, authFile, authJson);
    return;
  }

  // 3. 加载 manifest
  const registry = createEvolutionReleaseRegistry({ releasesDir: releasesDir() });
  const manifest = registry.loadManifest(releaseId);
  if (!manifest) {
    console.error(`[evolution:canary] 错误：releaseId ${releaseId} 不存在`);
    process.exit(3);
  }

  // 4. 状态校验：参与 canary 的 active 状态集合
  const PARTICIPATING_STATUSES = new Set(["evaluated", "active_dev", "candidate_prod", "active_prod"]);
  if (!PARTICIPATING_STATUSES.has(manifest.status)) {
    console.error(
      `[evolution:canary] 错误：release 状态 ${manifest.status} 非 active（仅 active_dev/candidate_prod/active_prod 参与 canary）`,
    );
    process.exit(4);
  }

  // 5. status 模式：打印 canary 运行历史
  if (statusFlag) {
    cmdCanaryStatus(releaseId, workspacePath);
    return;
  }

  if (complete) {
    cmdCanaryComplete(releaseId, workspacePath, manifest, {
      sourceRunId: args["run-id"],
      resultFile: args["result-file"],
    });
    return;
  }

  // 6. evaluate / apply 模式：聚合健康报告 + 决策
  const workspaceId = basename(workspacePath);
  const projectRoot = dirname(dirname(workspacePath));
  const perReleaseReport = aggregateReleaseHealthByRelease(workspacePath, releaseId, { workspaceId });
  const fullReport = aggregateReleaseHealth(workspacePath, { workspaceId, projectRoot });
  // P1 修复（与 cmdHealthSingle 一致）：按 release 关联的 chapter 集合过滤策略信誉，
  // 避免 workspace 全局策略信誉污染 per-release 连续负收益 / eligibility 判定。
  // 旧 BUG：直接赋值 fullReport.strategyReputations 导致同一 release 在 health 中
  // 为 healthy、在 canary 中却因其他 release 的损失变成 auto_hold_eligible。
  perReleaseReport.strategyReputations = filterStrategyReputationsByRelease(
    fullReport.strategyReputations,
    workspacePath,
    releaseId,
  );
  const longTermAlignmentRate = computeLongTermAlignmentRate(workspacePath, releaseId);

  const evaluation = evaluateReleaseHealth({
    releaseId,
    currentStatus: manifest.status,
    healthReport: perReleaseReport,
    longTermAlignmentRate,
  });

  const decision = decideCanaryStrategy({
    changeClass: manifest.changeClass,
    healthStatus: evaluation.status,
    currentStatus: manifest.status,
  });

  // 7. evaluate 模式（默认）：打印决策
  if (!apply) {
    console.log(`=== Canary Decision: ${releaseId} ===`);
    console.log(`  changeClass    : ${manifest.changeClass}`);
    console.log(`  healthStatus   : ${evaluation.status}`);
    console.log(`  currentStatus  : ${manifest.status}`);
    console.log(`  alignmentRate  : ${evaluation.evidence.alignmentRate.toFixed(2)}`);
    console.log(`  sampleCount    : ${evaluation.evidence.sampleCount}`);
    console.log(`  strategy       : ${decision.strategy}`);
    if (decision.blockedReason) {
      console.log(`  blockedReason  : ${decision.blockedReason}`);
    }
    if (decision.strategy === "bounded_canary") {
      console.log("  提示：apply 模式需要 workspace 级 canary 授权（--auth-file 或先 --authorize）");
    }
    return;
  }

  // 8. apply 模式：执行决策
  const traceStore = createCanaryTraceStore({
    canaryRunsDir: join(workspacePath, "canary-runs"),
  });

  // 加载 workspace 级授权（若存在）
  let authorization;
  const authPath = join(workspacePath, "canary-authorization.json");
  if (existsSync(authPath)) {
    try {
      authorization = loadCanaryAuthorizationFromFile(authPath);
    } catch (e) {
      console.error(`[evolution:canary] 授权文件加载失败：${e?.message ?? String(e)}`);
      process.exit(6);
    }
  }

  const result = executeCanaryDecision({
    decision,
    evaluation,
    releaseId,
    previousReleaseId: manifest.parentReleaseId ?? null,
    workspaceId,
    changeClass: manifest.changeClass,
    currentStatus: manifest.status,
    authorization,
    registry,
    traceStore,
    actor: "user",
  });

  if (result.blocked) {
    if (result.blockedExitCode === 6) {
      console.error(`[evolution:canary] 未授权：${result.errorReason ?? "REQUIRES_AUTH"}`);
      process.exit(6);
    }
    // blockedExitCode === 5：操作失败（含 auto-hold 触发）
    console.log(`=== Canary Blocked: ${releaseId} ===`);
    console.log(`  strategy         : ${result.strategy}`);
    console.log(`  autoHoldTriggered: ${result.autoHoldTriggered}`);
    if (result.errorReason) {
      console.log(`  errorReason      : ${result.errorReason}`);
    }
    process.exit(5);
  }

  // 成功：打印 trace 摘要
  console.log(`=== Canary ${result.strategy}: ${releaseId} ===`);
  if (result.trace) {
    console.log(`  runId              : ${result.trace.runId}`);
    console.log(`  status             : ${result.trace.status}`);
    console.log(`  shadowPendingRealRun: ${result.trace.shadowPendingRealRun ?? false}`);
    console.log(`  tracePath          : ${join(workspacePath, "canary-runs", `${result.trace.runId}.json`)}`);
  }
}

function cmdCanaryComplete(releaseId, workspacePath, manifest, options) {
  if (!options.sourceRunId || !options.resultFile) {
    console.error(
      "[evolution:canary] 错误：--complete 必须提供 --run-id <started-run-id> 和 --result-file <path>",
    );
    process.exit(2);
  }

  const traceStore = createCanaryTraceStore({
    canaryRunsDir: join(workspacePath, "canary-runs"),
  });
  let sourceTrace;
  try {
    sourceTrace = traceStore.readCanaryTrace(options.sourceRunId);
  } catch (e) {
    console.error(`[evolution:canary] CANARY_SOURCE_INVALID: ${e.message}`);
    process.exit(5);
  }
  if (!sourceTrace) {
    console.error(`[evolution:canary] CANARY_SOURCE_INVALID: source trace 不存在`);
    process.exit(5);
  }

  const authPath = join(workspacePath, "canary-authorization.json");
  if (!existsSync(authPath)) {
    console.error("[evolution:canary] 未授权：REQUIRES_AUTH: workspace authorization required");
    process.exit(6);
  }
  let authorization;
  try {
    authorization = loadCanaryAuthorizationFromFile(authPath);
  } catch (e) {
    console.error(`[evolution:canary] 未授权：${e.message}`);
    process.exit(6);
  }

  let completionTrace;
  try {
    completionTrace = JSON.parse(readFileSync(options.resultFile, "utf-8"));
  } catch (e) {
    console.error(`[evolution:canary] 结果文件读取/解析失败：${e.message}`);
    process.exit(5);
  }

  try {
    if (
      completionTrace.schemaId !== "pinovel.canary-run-trace" ||
      completionTrace.schemaVersion !== 1
    ) {
      throw new Error("completed trace schema 不匹配");
    }
    const completionLink = evaluateCanaryCompletionLink(sourceTrace, completionTrace);
    if (!completionLink.ok) {
      throw new Error(`${completionLink.code}: ${completionLink.reason}`);
    }
    if (
      authorization.authorizationId !== completionTrace.evidence.authorizationId ||
      authorization.workspaceId !== basename(workspacePath)
    ) {
      console.error("[evolution:canary] 未授权：REQUIRES_AUTH: authorization binding mismatch");
      process.exit(6);
    }
    assertCanaryAuthorizes(authorization, releaseId, {
      requiredChapters: completionTrace.evidence.observedChapters,
      requiredCalls: completionTrace.evidence.observedCalls,
    });
    const promotionGate = evaluateCanaryPromotionGate({
      releaseId,
      changeClass: manifest.changeClass,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef,
      workspaceId: basename(workspacePath),
      trace: completionTrace,
    });
    if (!promotionGate.ok) {
      throw new Error(`${promotionGate.code}: ${promotionGate.reason}`);
    }
    const artifactVerification = verifyCanaryResultArtifacts(workspacePath, completionTrace, {
      releaseId: manifest.releaseId,
      environmentFingerprint: manifest.environmentFingerprint,
      approvalRef: manifest.approvalRef,
    });
    if (!artifactVerification.ok) {
      throw new Error(`${artifactVerification.code}: ${artifactVerification.reason}`);
    }
    traceStore.writeCanaryTrace(completionTrace);
  } catch (e) {
    if (String(e.message).startsWith("REQUIRES_AUTH:")) {
      console.error(`[evolution:canary] 未授权：${e.message}`);
      process.exit(6);
    }
    console.error(`[evolution:canary] 完成证据校验失败：${e.message}`);
    process.exit(5);
  }

  console.log(`=== Canary completed: ${releaseId} ===`);
  console.log(`  sourceRunId : ${sourceTrace.runId}`);
  console.log(`  runId       : ${completionTrace.runId}`);
  console.log(`  resultFile  : ${options.resultFile}`);
}

/**
 * canary status 子模式：打印 release 的 canary 运行历史。
 */
function cmdCanaryStatus(releaseId, workspacePath) {
  const traceStore = createCanaryTraceStore({
    canaryRunsDir: join(workspacePath, "canary-runs"),
  });
  const traces = traceStore.listCanaryTracesByRelease(releaseId);
  console.log(`=== Canary History: ${releaseId} (${traces.length} runs) ===`);
  for (const t of traces) {
    console.log(`  ${t.runId} | ${t.strategy} | ${t.status} | ${t.startedAt}`);
    console.log(`    health: ${t.healthSnapshot.status} (align=${t.healthSnapshot.alignmentRate.toFixed(2)}, n=${t.healthSnapshot.sampleCount})`);
    if (t.outcome.heldByAutoHold) {
      console.log(`    autoHold: triggered (eventId=${t.outcome.autoHoldEventId ?? "n/a"})`);
    }
    if (t.shadowPendingRealRun) {
      console.log(`    shadowPendingRealRun: true（P1 声明性 trace，真实双生成推迟 P2）`);
    }
  }
}

/**
 * canary authorize 子模式：从 --auth-file 或 --auth-json 写入 workspace 级授权。
 */
function cmdCanaryAuthorize(releaseId, workspacePath, authFile, authJson) {
  if (!authFile && !authJson) {
    console.error("[evolution:canary] 错误：--authorize 模式必须提供 --auth-file <path> 或 --auth-json '<json>'");
    process.exit(2);
  }
  let authorization;
  if (authFile) {
    try {
      authorization = loadCanaryAuthorizationFromFile(authFile);
    } catch (e) {
      console.error(`[evolution:canary] 授权文件加载失败：${e?.message ?? String(e)}`);
      process.exit(5);
    }
  } else {
    let parsed;
    try {
      parsed = JSON.parse(authJson);
    } catch (e) {
      console.error(`[evolution:canary] --auth-json JSON 解析失败：${e?.message ?? String(e)}`);
      process.exit(2);
    }
    const validation = validateCanaryAuthorization(parsed);
    if (!validation.ok) {
      console.error(`[evolution:canary] 授权校验失败：${validation.error.code} at ${validation.error.path} — ${validation.error.message}`);
      process.exit(2);
    }
    authorization = validation.authorization;
  }
  // 写入 workspace/canary-authorization.json（原子写入）
  const authPath = join(workspacePath, "canary-authorization.json");
  const tmpPath = authPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(authorization, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, authPath);
  console.log(`=== Canary Authorization Written ===`);
  console.log(`  authorizationId   : ${authorization.authorizationId}`);
  console.log(`  workspaceId       : ${authorization.workspaceId}`);
  console.log(`  allowedReleaseIds : ${authorization.allowedReleaseIds.join(", ")}`);
  console.log(`  budget            : maxChapters=${authorization.budget.maxChapters}, maxCalls=${authorization.budget.maxCalls}`);
  console.log(`  expiresAt         : ${authorization.expiresAt}`);
  console.log(`  path              : ${authPath}`);
}

// ============================================================================
// 参数解析 + 入口
// ============================================================================

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`PiNovelStudio evolution-cli — EVOLUTION-RELEASE-GOVERNANCE-1A/1C

用法:
  npm run evolution:capture [--release-id <id>] --rollback <id> [--parent <id>]
  npm run evolution:candidate -- --release-id <id> --metadata-file <path>
  npm run evolution:freeze -- --release-id <id> [--bootstrap]
  npm run evolution:status
  npm run evolution:verify -- --release-id <id>
  npm run evolution:drill
  npm run evolution:evaluate -- --release-id <id>
  npm run evolution:proxy-review -- --release-id <id> [options]
    real mode: --real --card <path> --eval-input <path>
  npm run evolution:promote -- --release-id <id> [--target <t>] [--actor <a>] [--reason <r>] [--confirm-prod]
  npm run evolution:hold -- --release-id <id> [--actor <a>] [--reason <r>]
  npm run evolution:rollback -- [--kind development|production] [--actor <a>] [--reason <r>]
  npm run evolution:health -- --release-id <id> | --all [options]
  npm run evolution:canary -- --release-id <id> --workspace <path> [--apply | --status | --authorize ... | --complete ...]

子命令:
  capture       采集当前环境指纹，创建 draft manifest 写入 registry
  status        打印 active 指针与全部 release 状态摘要
  verify        校验指定 release 的环境指纹是否与当前环境一致
  drill         1A 验收本地演练（candidate→freeze→verify + rollback）
  evaluate      1C：frozen → evaluated 状态迁移
  proxy-review  1C：代理审批端到端（artifact 落盘 + approvalRef + 状态事件，不切 pointer）
  promote       G5：晋级 release（approved_dev→active_dev / active_dev→candidate_prod / candidate_prod→active_prod）
  hold          G5：暂停 release（active_dev/candidate_prod/active_prod → held，不切 pointer）
  rollback      G5：回滚 active pointer 到前序 release + 标记当前 release held
  health        G8：打印 release 健康报告（insufficient_data/auto_hold_eligible/retired_suggestion/warning/healthy）；
                可选 --apply 自动执行 auto-hold（幂等），可选 --recompute-eligibility 重算策略资格
  canary        G5：bounded canary 决策与证据登记（命令本身不调模型）；
                默认模式打印决策；--apply 执行（bounded_canary 需授权）；
                --status 查看历史；--authorize 写入 workspace 级授权；
                --complete 校验并追加真实 canary 完成证据

health 选项:
  --release-id <id>            指定 release ID（与 --all 互斥）
  --all                        打印所有 active release（跳过 draft/held/retired）的健康报告
  --workspace <path>           workspace 路径（或设置 PINOVEL_WORKSPACE_PATH 环境变量）
  --apply                      当 status=auto_hold_eligible 且未 held 时，执行状态迁移到 held（幂等）
  --recompute-eligibility      重算 retired 策略导致的 release 资格（needs_requalify / unchanged）

canary 选项:
  --release-id <id>            必填，目标 release ID
  --workspace <path>           workspace 路径（或设置 PINOVEL_WORKSPACE_PATH 环境变量）
  --apply                      执行决策（写 trace + 可选 G8 auto-hold；bounded_canary 需授权）
  --status                     查看 release 的 canary 运行历史
  --authorize                  写入 workspace 级 canary 授权（需配合 --auth-file 或 --auth-json）
  --auth-file <path>           从文件加载授权 JSON
  --auth-json '<json>'         从 inline JSON 加载授权
  --complete                   导入真实 canary 完成证据（不调用模型）
  --run-id <id>                --complete 对应的 started trace ID
  --result-file <path>         --complete 的 completed trace JSON

promote 生产选项:
  --confirm-prod               candidate_prod/active_prod 必须显式确认
  --workspace <path>           R2/R3 active_prod 的 canary workspace 路径
  --canary-run <id>            R2/R3 active_prod 的 completed canary trace ID

proxy-review 选项:
  --release-id <id>        必填，被审批的 release ID
  --stub-verdict <v>       stub 模式 verdict（APPROVE_DEV | HOLD | REJECT | QUARANTINE）
                           设置时 forward=reverse=verdict；与 --forward-verdict/--reverse-verdict 互斥
  --forward-verdict <v>    stub forward verdict（默认 APPROVE_DEV）
  --reverse-verdict <v>    stub reverse verdict（默认 APPROVE_DEV）
  --change-class <c>       覆盖 manifest.changeClass（R1|R2|R3，默认取 manifest）
  --model-version <m>      覆盖 proxy judge 模型版本（默认 gpt5.6-sol-2026-07）
  --prompt-hash <h>        覆盖 prompt hash（默认 sha256:evolution-cli-proxy-review）
  --eval-input <path>      JSON 文件路径，提供完整 packetInput body（默认占位）

环境变量:
  PINOVEL_EVOLUTION_ROOT  治理数据根目录（默认 config/evolution-release）
`);
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (subcommand) {
    case "capture":
      cmdCapture(args);
      break;
    case "candidate":
      cmdCandidate(args);
      break;
    case "freeze":
      cmdFreeze(args);
      break;
    case "status":
      cmdStatus();
      break;
    case "verify":
      cmdVerify(args);
      break;
    case "drill":
      cmdDrill();
      break;
    case "evaluate":
      cmdEvaluate(args);
      break;
    case "proxy-review":
      await cmdProxyReview(args);
      break;
    case "promote":
      cmdPromote(args);
      break;
    case "hold":
      cmdHold(args);
      break;
    case "rollback":
      cmdRollback(args);
      break;
    case "health":
      cmdHealth(args);
      break;
    case "canary":
      cmdCanary(args);
      break;
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`未知子命令：${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
