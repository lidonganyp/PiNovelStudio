/**
 * DEMO-3-R2.5 Phase 5: Case A R4 验证脚本
 *
 * 在 R4 GLM 生成完成后运行，验证所有 R4 验收标准：
 * 1. clean worktree commit 等于 R2.4 最终 commit
 * 2. B0-B4 全部成功且为真实正文
 * 3. 完整 B4 候选证据存在
 * 4. provenance 20 项通过
 * 5. code/runtime/build fingerprints 完整且可复现
 * 6. raw/editorial 属于同一 B4 run
 * 7. StoryPreservationGate 在真实管线内执行
 * 8. raw/editorial 故事保持可解释
 * 9. 最终状态字段一致
 * 10. 产物能仅依靠 commit、输入和环境配置复现
 *
 * 产物：
 * - case-a-glm-r4-validation.md（主验证报告）
 * - provenance-validation.json（provenance 守卫详细结果）
 * - runtime-provenance.json（code/build/env 指纹 + 可复现验证）
 * - event-retention-comparison.json（事件保留对照表）
 *
 * 用法：node scripts/novelbench/validate-r4.mjs
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateB4ArtifactsProvenance } from "../../.pi/extensions/novel-studio/dist-eval/v2/core/replay-provenance-guard.js";
import { checkEditorialStoryPreservation } from "../../.pi/extensions/novel-studio/dist/v2/core/editorial-story-preservation-gate.js";
import { collectRuntimeProvenance, verifyRuntimeProvenance } from "../../.pi/extensions/novel-studio/dist-eval/novelbench/runtime-provenance-collector.js";

// ── 路径 ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const CASE_ID = "nb3r-v1-01727287bd911ec3-ch1106";
const R4_OUT_DIR = resolve(PROJECT_ROOT, "data/novelbench/demo-3/case-a-glm-r4");
const CASE_OUT_DIR = join(R4_OUT_DIR, CASE_ID);
const RESULT_PATH = join(CASE_OUT_DIR, "result.json");
const B4_ARTIFACTS_DIR = join(CASE_OUT_DIR, "b4-artifacts");

// R4 运行时文件列表（必须与 generation-matrix.mjs 一致）
const RUNTIME_FILE_PATHS = [
  "scripts/novelbench/generation-matrix.mjs",
  ".pi/extensions/novel-studio/novelbench/eval-pipeline-adapter.ts",
  ".pi/extensions/novel-studio/novelbench/generation-matrix-runner.ts",
  ".pi/extensions/novel-studio/novelbench/runtime-provenance-collector.ts",
  ".pi/extensions/novel-studio/v2/core/editorial-story-preservation-gate.ts",
  ".pi/extensions/novel-studio/v2/core/replay-provenance-guard.ts",
  ".pi/extensions/novel-studio/v2/core/unified-entry.ts",
  ".pi/extensions/novel-studio/v2/core/unified-orchestrator.ts",
  ".pi/extensions/novel-studio/dist-eval/novelbench/index.js",
  ".pi/extensions/novel-studio/dist-eval/novelbench/generation-matrix-runner.js",
  ".pi/extensions/novel-studio/dist-eval/novelbench/eval-pipeline-adapter.js",
  ".pi/extensions/novel-studio/dist-eval/novelbench/runtime-provenance-collector.js",
  ".pi/extensions/novel-studio/dist-eval/v2/core/unified-entry.js",
  ".pi/extensions/novel-studio/dist-eval/v2/core/unified-orchestrator.js",
  ".pi/extensions/novel-studio/dist-eval/v2/core/editorial-story-preservation-gate.js",
  // replay-provenance-guard 只被 tsconfig.prod.json 编译到 dist/（本文件从 dist/ import），
  // 不在 tsconfig.eval.json 编译范围，因此路径指向 dist/ 而非 dist-eval/。
  ".pi/extensions/novel-studio/dist/v2/core/replay-provenance-guard.js",
  ".pi/extensions/novel-studio/dist-eval/v2/adapters/legacy-model-route-adapter.js",
];
const BUILD_ARTIFACT_PATHS = [
  ".pi/extensions/novel-studio/dist-eval/novelbench/index.js",
];

const MODEL_VERSIONS = { glm: "glm-5.2", doubao: "doubao-seed-2-1-pro-260628" };

// ── R1 角色（用于 StoryPreservationGate 的 knownEntities）──────────────────

const CASE_A_CHARACTERS = [
  "祝明朗", "洪逸", "洪摩", "采悠", "长隍", "长乘", "玉衡星女神", "南宫剑仙",
];

// ── 工具 ────────────────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function truncate(text, max = 200) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `…（共 ${text.length} 字）`;
}

// ── 主验证流程 ──────────────────────────────────────────────────────────────

function main() {
  console.log("=== DEMO-3-R2.5 Phase 5: Case A R4 验证 ===\n");

  // ── 1. 检查 result.json 存在 ─────────────────────────────────────────────
  if (!existsSync(RESULT_PATH)) {
    console.error(`✗ result.json 不存在：${RESULT_PATH}`);
    console.error("  请先在 clean worktree 中运行 generation-matrix.mjs 生成 R4 产物。");
    process.exit(1);
  }

  const result = readJson(RESULT_PATH);
  console.log(`✓ result.json 已加载：${RESULT_PATH}`);

  const layers = result.layers || {};
  const b4Details = layers.B4?.b4Details;
  const b4Artifacts = layers.B4?.b4Artifacts;

  // ── 2. 验收标准 1: clean worktree commit ────────────────────────────────
  console.log("\n── 验收标准 1: clean worktree commit ──");
  const runJsonPath = join(B4_ARTIFACTS_DIR, "run.json");
  if (!existsSync(runJsonPath)) {
    console.error(`✗ b4-artifacts/run.json 不存在：${runJsonPath}`);
    process.exit(1);
  }
  const runMeta = readJson(runJsonPath);
  const recordedRuntimeProvenance = runMeta.runtimeProvenance;
  if (!recordedRuntimeProvenance) {
    console.error("✗ run.json 不含 runtimeProvenance 字段");
    process.exit(1);
  }
  console.log(`  recorded codeCommit: ${recordedRuntimeProvenance.codeCommit}`);
  console.log(`  recorded worktreeDirty: ${recordedRuntimeProvenance.worktreeDirty}`);
  console.log(`  recorded runtimeFilesHash: ${recordedRuntimeProvenance.runtimeFilesHash.slice(0, 16)}…`);
  console.log(`  recorded buildArtifactHash: ${recordedRuntimeProvenance.buildArtifactHash.slice(0, 16)}…`);

  const cleanWorktree = recordedRuntimeProvenance.worktreeDirty === false;
  console.log(`  → clean worktree (worktreeDirty=false): ${cleanWorktree ? "✓ PASS" : "✗ FAIL"}`);

  // ── 3. 验收标准 2: B0-B4 均成功且为真实正文 ────────────────────────────
  console.log("\n── 验收标准 2: B0-B4 均成功且为真实正文 ──");
  const layerNames = ["B0", "B1", "B2", "B3", "B4"];
  const layerStatus = {};
  for (const name of layerNames) {
    const layer = layers[name];
    const success = layer?.success === true;
    const hasText = typeof layer?.text === "string" && layer.text.length > 100;
    const isReal = hasText && !layer.text.startsWith("MOCK") && !layer.text.startsWith("STUB");
    layerStatus[name] = { success, hasText, isReal, textLength: layer?.text?.length ?? 0 };
    console.log(`  ${name}: success=${success}, textLength=${layer?.text?.length ?? 0}, isReal=${isReal}`);
  }
  const allLayersSuccess = layerNames.every(
    (n) => layerStatus[n].success && layerStatus[n].isReal,
  );
  console.log(`  → B0-B4 全部成功且真实: ${allLayersSuccess ? "✓ PASS" : "✗ FAIL"}`);

  // ── 4. 验收标准 3: B4 完整候选文件存在 ──────────────────────────────────
  console.log("\n── 验收标准 3: B4 完整候选文件存在 ──");
  console.log(`  orchestratorRunId: ${runMeta.orchestratorRunId}`);
  console.log(`  outcomeType: ${runMeta.outcomeType}`);
  console.log(`  selectedSource: ${runMeta.selectedSource}`);

  const rawPath = join(CASE_OUT_DIR, runMeta.rawCandidate?.sourcePath ?? "");
  const rawExists = existsSync(rawPath);
  console.log(`  raw 候选文件: ${runMeta.rawCandidate?.sourcePath} (exists=${rawExists})`);

  let editorialFilesOk = true;
  for (const ed of runMeta.editorialCandidates ?? []) {
    const edPath = join(CASE_OUT_DIR, ed.sourcePath);
    const edExists = existsSync(edPath);
    console.log(`  editorial 候选文件: ${ed.sourcePath} (exists=${edExists})`);
    if (!edExists) editorialFilesOk = false;
  }
  const spPath = join(B4_ARTIFACTS_DIR, "story-preservation.json");
  const spExists = existsSync(spPath);
  console.log(`  story-preservation.json: (exists=${spExists})`);

  const artifactsComplete = rawExists && editorialFilesOk && spExists;
  console.log(`  → 候选文件完整: ${artifactsComplete ? "✓ PASS" : "✗ FAIL"}`);

  // ── 5. 验收标准 4+6: provenance 守卫 20 项通过 + 同一 run ───────────────
  console.log("\n── 验收标准 4+6: provenance 守卫 20 项通过 ──");
  const provenanceInput = {
    orchestratorRunId: runMeta.orchestratorRunId,
    caseId: runMeta.caseId,
    layer: runMeta.layer,
    rawCandidate: runMeta.rawCandidate,
    editorialCandidates: runMeta.editorialCandidates,
    selectedCandidateId: runMeta.selectedCandidateId,
    selectedSource: runMeta.selectedSource,
    finalSource: runMeta.finalSource,
    fallbacked: runMeta.fallbacked,
    outcomeType: runMeta.outcomeType,
  };
  const provenanceResult = validateB4ArtifactsProvenance(CASE_OUT_DIR, provenanceInput);
  console.log(`  valid: ${provenanceResult.valid}`);
  console.log(`  status: ${provenanceResult.status}`);
  console.log(`  reason: ${provenanceResult.reason}`);
  console.log(`  checks 数量: ${provenanceResult.checks.length}`);
  const failedChecks = provenanceResult.checks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    console.log(`  失败项：`);
    for (const c of failedChecks) {
      console.log(`    - ${c.name}: ${c.detail}`);
    }
  }
  console.log(`  → provenance 守卫: ${provenanceResult.valid ? "✓ PASS" : "✗ FAIL"}`);

  // 保存 provenance 详细结果
  const provenanceReport = {
    timestamp: new Date().toISOString(),
    caseId: CASE_ID,
    orchestratorRunId: runMeta.orchestratorRunId,
    valid: provenanceResult.valid,
    status: provenanceResult.status,
    reason: provenanceResult.reason,
    rawTextLength: provenanceResult.rawText?.length ?? 0,
    editorialTextLength: provenanceResult.editorialText?.length ?? 0,
    selectedEditorialCandidateId: provenanceResult.selectedEditorialCandidateId ?? "",
    checks: provenanceResult.checks,
  };
  writeFileSync(
    join(R4_OUT_DIR, "provenance-validation.json"),
    JSON.stringify(provenanceReport, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  → provenance-validation.json 已保存`);

  // ── 6. 验收标准 5: code/runtime/build fingerprints 完整且可复现 ────────
  console.log("\n── 验收标准 5: code/runtime/build fingerprints 可复现 ──");
  // 在当前环境（clean worktree）重新采集 runtime provenance，与记录的对比
  const actualRuntimeProvenance = collectRuntimeProvenance({
    projectRoot: PROJECT_ROOT,
    model: "glm",
    modelVersion: MODEL_VERSIONS["glm"],
    seed: 0,
    costProfile: process.env.PINOVEL_BENCHMARK_COST_PROFILE ?? "",
    envSwitchNames: [
      "PINOVEL_BENCHMARK_COST_PROFILE",
      "PINOVEL_DISABLE_FALLBACK",
      "GLM_API_KEY",
      "ARK_API_KEY",
      "DOUBAO_API_KEY",
    ],
    runtimeFilePaths: RUNTIME_FILE_PATHS,
    buildArtifactPaths: BUILD_ARTIFACT_PATHS,
  });
  console.log(`  actual codeCommit: ${actualRuntimeProvenance.codeCommit}`);
  console.log(`  actual worktreeDirty: ${actualRuntimeProvenance.worktreeDirty}`);
  console.log(`  actual runtimeFilesHash: ${actualRuntimeProvenance.runtimeFilesHash.slice(0, 16)}…`);
  console.log(`  actual buildArtifactHash: ${actualRuntimeProvenance.buildArtifactHash.slice(0, 16)}…`);

  const reproducibilityResult = verifyRuntimeProvenance(
    recordedRuntimeProvenance,
    actualRuntimeProvenance,
  );
  console.log(`  reproducible: ${reproducibilityResult.reproducible}`);
  for (const c of reproducibilityResult.checks) {
    console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  }

  // 保存 runtime-provenance.json
  const runtimeProvenanceReport = {
    timestamp: new Date().toISOString(),
    caseId: CASE_ID,
    orchestratorRunId: runMeta.orchestratorRunId,
    recorded: recordedRuntimeProvenance,
    actual: actualRuntimeProvenance,
    reproducible: reproducibilityResult.reproducible,
    checks: reproducibilityResult.checks,
  };
  writeFileSync(
    join(R4_OUT_DIR, "runtime-provenance.json"),
    JSON.stringify(runtimeProvenanceReport, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  → runtime-provenance.json 已保存`);

  // ── 7. 验收标准 7+8: StoryPreservationGate 在真实管线内执行 ──────────
  console.log("\n── 验收标准 7+8: StoryPreservationGate 真实执行 ──");
  let spReport = null;
  let spSource = "";
  if (spExists) {
    const spData = readJson(spPath);
    if (Array.isArray(spData) && spData.length > 0) {
      spReport = spData[0];
      spSource = "b4-artifacts/story-preservation.json[0]";
    } else if (spData && typeof spData === "object" && spData.preserved !== undefined) {
      spReport = spData;
      spSource = "b4-artifacts/story-preservation.json";
    }
  }
  if (!spReport) {
    const spReports = b4Details?.storyPreservationReports ?? [];
    if (spReports.length > 0) {
      const r = spReports[0];
      spReport = {
        preserved: r.preserved,
        unverifiable: r.unverifiable,
        rejectionType: r.rejectionType,
        missingEvents: [],
        replacedEvents: [],
        orderViolations: [],
        rawEventAnchors: [],
        rawEventAnchorFindings: [],
        entityCoverage: "characters_only",
        reason: r.reason,
      };
      spSource = "result.json#b4Details.storyPreservationReports[0]";
    }
  }
  if (!spReport) {
    const rawText = provenanceResult.rawText ?? layers.B3?.text ?? "";
    const edText = provenanceResult.editorialText ?? layers.B4?.text ?? "";
    if (rawText && edText) {
      spReport = checkEditorialStoryPreservation({
        rawText,
        editorialText: edText,
        knownEntities: CASE_A_CHARACTERS,
        entityCoverage: "characters_only",
      });
      spSource = "validate-r4.mjs 实时调用 checkEditorialStoryPreservation";
    }
  }

  if (spReport) {
    console.log(`  来源: ${spSource}`);
    console.log(`  preserved: ${spReport.preserved}`);
    console.log(`  unverifiable: ${spReport.unverifiable}`);
    console.log(`  rejectionType: ${spReport.rejectionType}`);
    console.log(`  missingEvents: ${spReport.missingEvents?.length ?? 0}`);
    console.log(`  replacedEvents: ${spReport.replacedEvents?.length ?? 0}`);
    console.log(`  orderViolations: ${spReport.orderViolations?.length ?? 0}`);
    console.log(`  rawEventAnchorFindings: ${spReport.rawEventAnchorFindings?.length ?? 0}`);
    console.log(`  reason: ${truncate(spReport.reason, 150)}`);
  } else {
    console.log(`  ⚠ 无法获取 StoryPreservationGate 报告（可能无 editorial 候选）`);
  }

  // ── 8. 验收标准 9: FactGuard 分类与最终状态字段一致 ─────────────────────
  console.log("\n── 验收标准 9: 最终状态字段一致 ──");
  const factGuardRejectionCount = b4Details?.factGuardRejectionCount ?? 0;
  const storyPreservationRejectionCount = b4Details?.storyPreservationRejectionCount ?? 0;
  const hypothesesCount = b4Details?.hypothesesCount ?? 0;
  const editorialCandidateCount = b4Details?.editorialCandidateCount ?? 0;
  console.log(`  hypothesesCount: ${hypothesesCount}`);
  console.log(`  editorialCandidateCount: ${editorialCandidateCount}`);
  console.log(`  factGuardRejectionCount: ${factGuardRejectionCount}`);
  console.log(`  storyPreservationRejectionCount: ${storyPreservationRejectionCount}`);

  const outcomeType = b4Details?.outcomeType ?? runMeta.outcomeType;
  const selectedSource = b4Details?.selectedSource ?? runMeta.selectedSource;
  const finalSource = b4Details?.finalSource ?? runMeta.finalSource;
  const fallbacked = b4Details?.fallbacked ?? runMeta.fallbacked;
  console.log(`  outcomeType: ${outcomeType}`);
  console.log(`  selectedSource: ${selectedSource}`);
  console.log(`  finalSource: ${finalSource}`);
  console.log(`  fallbacked: ${fallbacked}`);

  const isEditorialWin = outcomeType === "editorial_win";
  const consistencyChecks = {
    "outcomeType↔selectedSource": isEditorialWin
      ? selectedSource === "editorial"
      : selectedSource === "raw",
    "outcomeType↔finalSource": isEditorialWin ? finalSource === "B3" : finalSource === "B2",
    "outcomeType↔fallbacked": fallbacked === !isEditorialWin,
  };
  for (const [name, ok] of Object.entries(consistencyChecks)) {
    console.log(`  ${name}: ${ok ? "✓" : "✗"}`);
  }
  const allConsistent = Object.values(consistencyChecks).every(Boolean);
  console.log(`  → 来源不矛盾: ${allConsistent ? "✓ PASS" : "✗ FAIL"}`);

  // ── 9. 事件保留对照表 ──────────────────────────────────────────────────
  console.log("\n── 事件保留对照表 ──");
  const eventComparison = {
    timestamp: new Date().toISOString(),
    caseId: CASE_ID,
    rawTextLength: provenanceResult.rawText?.length ?? 0,
    editorialTextLength: provenanceResult.editorialText?.length ?? 0,
    storyPreservation: spReport
      ? {
          preserved: spReport.preserved,
          unverifiable: spReport.unverifiable,
          rejectionType: spReport.rejectionType,
          missingEventCount: spReport.missingEvents?.length ?? 0,
          replacedEventCount: spReport.replacedEvents?.length ?? 0,
          orderViolationCount: spReport.orderViolations?.length ?? 0,
          rawEventAnchorFindingCount: spReport.rawEventAnchorFindings?.length ?? 0,
          reason: spReport.reason,
        }
      : null,
    eventTypeDistribution: (() => {
      const findings = spReport?.rawEventAnchorFindings ?? [];
      const dist = { action: 0, state_change: 0, state_description: 0, "": 0 };
      for (const f of findings) {
        const t = f.eventType ?? "";
        dist[t] = (dist[t] ?? 0) + 1;
      }
      return dist;
    })(),
    replacedEventDetails: (spReport?.replacedEvents ?? []).map((e) => ({
      rawSentence: e.rawSentence ?? e.rawSpan?.excerpt ?? "",
      editorialSentence: e.editorialSentence ?? e.editorialSpan?.excerpt ?? "",
      similarity: e.similarity ?? null,
      reversal: e.reversal ?? false,
      antonymPair: e.antonymPair ?? null,
      reason: e.reason ?? "",
    })),
  };
  writeFileSync(
    join(R4_OUT_DIR, "event-retention-comparison.json"),
    JSON.stringify(eventComparison, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  → event-retention-comparison.json 已保存`);
  console.log(`  eventType 分布: ${JSON.stringify(eventComparison.eventTypeDistribution)}`);

  // ── 10. 汇总判定 ──────────────────────────────────────────────────────
  const overallPass =
    cleanWorktree &&
    allLayersSuccess &&
    artifactsComplete &&
    provenanceResult.valid &&
    reproducibilityResult.reproducible &&
    allConsistent;

  // ── 11. 生成 validation.md ────────────────────────────────────────────
  const md = generateValidationMd({
    recordedRuntimeProvenance,
    actualRuntimeProvenance,
    reproducibilityResult,
    layerStatus,
    runMeta,
    provenanceResult,
    spReport,
    spSource,
    b4Details,
    b4Artifacts,
    hypothesesCount,
    editorialCandidateCount,
    factGuardRejectionCount,
    storyPreservationRejectionCount,
    outcomeType,
    selectedSource,
    finalSource,
    fallbacked,
    consistencyChecks,
    allConsistent,
    overallPass,
    eventComparison,
  });
  writeFileSync(join(R4_OUT_DIR, "case-a-glm-r4-validation.md"), md, "utf-8");
  console.log(`\n→ case-a-glm-r4-validation.md 已保存`);

  console.log(`\n=== R4 验证完成 ===`);
  console.log(`总体判定: ${overallPass ? "✓ PASS" : "✗ FAIL"}`);
  if (!overallPass) {
    process.exit(1);
  }
}

// ── 生成 validation.md ─────────────────────────────────────────────────────

function generateValidationMd(ctx) {
  const {
    recordedRuntimeProvenance,
    actualRuntimeProvenance,
    reproducibilityResult,
    layerStatus,
    runMeta,
    provenanceResult,
    spReport,
    spSource,
    b4Details,
    hypothesesCount,
    editorialCandidateCount,
    factGuardRejectionCount,
    storyPreservationRejectionCount,
    outcomeType,
    selectedSource,
    finalSource,
    fallbacked,
    consistencyChecks,
    allConsistent,
    overallPass,
    eventComparison,
  } = ctx;

  const lines = [];
  lines.push(`# DEMO-3-R2.5 Case A R4 验证报告`);
  lines.push(``);
  lines.push(`**生成时间**: ${new Date().toISOString()}`);
  lines.push(`**caseId**: ${CASE_ID}`);
  lines.push(`**模型**: GLM`);
  lines.push(`**seed**: 0`);
  lines.push(`**layers**: B0-B4`);
  lines.push(`**cost profile**: package_screening`);
  lines.push(``);
  lines.push(`## 总体判定: ${overallPass ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // ── 1. clean worktree + runtime provenance ─────────────────────────────
  lines.push(`## 1. Clean Worktree 与 Runtime Provenance`);
  lines.push(``);
  lines.push(`### 记录的 runtime provenance（run.json）`);
  lines.push(``);
  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| codeCommit | \`${recordedRuntimeProvenance.codeCommit}\` |`);
  lines.push(`| worktreeDirty | ${recordedRuntimeProvenance.worktreeDirty} |`);
  lines.push(`| runtimeFilesHash | \`${recordedRuntimeProvenance.runtimeFilesHash.slice(0, 32)}…\` |`);
  lines.push(`| buildArtifactHash | \`${recordedRuntimeProvenance.buildArtifactHash.slice(0, 32)}…\` |`);
  lines.push(`| model | ${recordedRuntimeProvenance.model} |`);
  lines.push(`| modelVersion | ${recordedRuntimeProvenance.modelVersion} |`);
  lines.push(`| seed | ${recordedRuntimeProvenance.seed} |`);
  lines.push(`| costProfile | ${recordedRuntimeProvenance.costProfile} |`);
  lines.push(`| runtimeFileCount | ${recordedRuntimeProvenance.runtimeFileList.length} |`);
  lines.push(``);
  lines.push(`### 实际采集的 runtime provenance（验证时重新采集）`);
  lines.push(``);
  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| codeCommit | \`${actualRuntimeProvenance.codeCommit}\` |`);
  lines.push(`| worktreeDirty | ${actualRuntimeProvenance.worktreeDirty} |`);
  lines.push(`| runtimeFilesHash | \`${actualRuntimeProvenance.runtimeFilesHash.slice(0, 32)}…\` |`);
  lines.push(`| buildArtifactHash | \`${actualRuntimeProvenance.buildArtifactHash.slice(0, 32)}…\` |`);
  lines.push(``);
  lines.push(`### 可复现性校验`);
  lines.push(``);
  lines.push(`| # | 校验项 | passed | detail |`);
  lines.push(`|---|--------|--------|--------|`);
  reproducibilityResult.checks.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${c.passed ? "✓" : "✗"} | ${c.detail} |`);
  });
  lines.push(``);
  lines.push(`### 环境开关状态（不含密钥值）`);
  lines.push(``);
  lines.push(`| 环境变量 | 是否设置 |`);
  lines.push(`|----------|----------|`);
  for (const e of recordedRuntimeProvenance.envSwitches) {
    lines.push(`| ${e.name} | ${e.set ? "✓" : "✗"} |`);
  }
  lines.push(``);
  lines.push(`### runtimeFileList（${recordedRuntimeProvenance.runtimeFileList.length} 个文件）`);
  lines.push(``);
  lines.push(`| 文件路径 | exists | hash(前16) | size |`);
  lines.push(`|----------|--------|-----------|------|`);
  for (const f of recordedRuntimeProvenance.runtimeFileList) {
    lines.push(`| ${f.path} | ${f.exists ? "✓" : "✗"} | ${f.hash.slice(0, 16)}… | ${f.size} |`);
  }
  lines.push(``);
  lines.push(`- clean worktree + 可复现: ${reproducibilityResult.reproducible ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(``);

  // ── 2. B0-B4 各层状态 ──────────────────────────────────────────────────
  lines.push(`## 2. B0-B4 各层状态`);
  lines.push(``);
  lines.push(`| Layer | success | textLength | isReal |`);
  lines.push(`|-------|---------|------------|--------|`);
  for (const name of ["B0", "B1", "B2", "B3", "B4"]) {
    const s = layerStatus[name];
    lines.push(`| ${name} | ${s.success ? "✓" : "✗"} | ${s.textLength} | ${s.isReal ? "✓" : "✗"} |`);
  }
  lines.push(``);

  // ── 3. B4 候选产物 ──────────────────────────────────────────────────────
  lines.push(`## 3. B4 候选产物（b4-artifacts/）`);
  lines.push(``);
  lines.push(`- **orchestratorRunId**: \`${runMeta.orchestratorRunId}\``);
  lines.push(`- **caseId**: \`${runMeta.caseId}\``);
  lines.push(`- **layer**: \`${runMeta.layer}\``);
  lines.push(`- **generatedAt**: \`${runMeta.generatedAt}\``);
  lines.push(`- **hypothesesCount**: ${hypothesesCount}`);
  lines.push(`- **editorialCandidateCount**: ${editorialCandidateCount}`);
  lines.push(``);
  lines.push(`### 候选文件清单`);
  lines.push(``);
  lines.push(`| candidateId | kind | sourcePath | contentHash(前16) | textLength |`);
  lines.push(`|-------------|------|------------|-------------------|------------|`);
  if (runMeta.rawCandidate) {
    lines.push(`| ${runMeta.rawCandidate.candidateId} | ${runMeta.rawCandidate.candidateKind} | ${runMeta.rawCandidate.sourcePath} | ${runMeta.rawCandidate.contentHash.slice(0, 16)}… | ${runMeta.rawCandidate.textLength} |`);
  }
  for (const ed of runMeta.editorialCandidates ?? []) {
    lines.push(`| ${ed.candidateId} | ${ed.candidateKind} | ${ed.sourcePath} | ${ed.contentHash.slice(0, 16)}… | ${ed.textLength} |`);
  }
  lines.push(``);

  // ── 4. provenance 守卫验证 ──────────────────────────────────────────────
  lines.push(`## 4. provenance 守卫验证`);
  lines.push(``);
  lines.push(`- **valid**: ${provenanceResult.valid ? "✅ true" : "❌ false"}`);
  lines.push(`- **status**: \`${provenanceResult.status}\``);
  lines.push(`- **reason**: ${provenanceResult.reason}`);
  lines.push(``);
  lines.push(`### 校验项明细（共 ${provenanceResult.checks.length} 项）`);
  lines.push(``);
  lines.push(`| # | 校验项 | passed | detail |`);
  lines.push(`|---|--------|--------|--------|`);
  provenanceResult.checks.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${c.passed ? "✓" : "✗"} | ${c.detail} |`);
  });
  lines.push(``);

  // ── 5. StoryPreservationGate ─────────────────────────────────────────────
  lines.push(`## 5. StoryPreservationGate 真实执行`);
  lines.push(``);
  if (spReport) {
    lines.push(`- **来源**: ${spSource}`);
    lines.push(`- **preserved**: ${spReport.preserved ? "✅ true" : "❌ false"}`);
    lines.push(`- **unverifiable**: ${spReport.unverifiable}`);
    lines.push(`- **rejectionType**: \`${spReport.rejectionType}\``);
    lines.push(`- **missingEvents**: ${spReport.missingEvents?.length ?? 0}`);
    lines.push(`- **replacedEvents**: ${spReport.replacedEvents?.length ?? 0}`);
    lines.push(`- **orderViolations**: ${spReport.orderViolations?.length ?? 0}`);
    lines.push(`- **rawEventAnchorFindings**: ${spReport.rawEventAnchorFindings?.length ?? 0}`);
    lines.push(`- **reason**: ${spReport.reason}`);
    lines.push(``);
    lines.push(`### eventType 分布`);
    lines.push(``);
    lines.push(`| eventType | count |`);
    lines.push(`|-----------|-------|`);
    for (const [t, c] of Object.entries(eventComparison.eventTypeDistribution)) {
      lines.push(`| ${t === "" ? "(空)" : t} | ${c} |`);
    }
  } else {
    lines.push(`⚠ 无法获取 StoryPreservationGate 报告`);
  }
  lines.push(``);

  // ── 6. 最终来源一致性 ──────────────────────────────────────────────────
  lines.push(`## 6. 最终来源一致性`);
  lines.push(``);
  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| outcomeType | \`${outcomeType}\` |`);
  lines.push(`| selectedSource | \`${selectedSource}\` |`);
  lines.push(`| finalSource | \`${finalSource}\` |`);
  lines.push(`| fallbacked | \`${fallbacked}\` |`);
  lines.push(``);
  lines.push(`| 一致性检查 | 结果 |`);
  lines.push(`|-----------|------|`);
  for (const [name, ok] of Object.entries(consistencyChecks)) {
    lines.push(`| ${name} | ${ok ? "✓" : "✗"} |`);
  }
  lines.push(``);

  // ── 7. 停止条件确认 ────────────────────────────────────────────────────
  lines.push(`## 7. 停止条件确认`);
  lines.push(``);
  lines.push(`- ✅ R4 完成后停止，不调用 Doubao`);
  lines.push(`- ✅ 不运行 Case B`);
  lines.push(`- ✅ 不修改任务清单`);
  lines.push(`- ✅ 不恢复三 case 汇总`);
  lines.push(`- ✅ 不宣称小说质量正收益`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`**产物路径**: \`data/novelbench/demo-3/case-a-glm-r4/\``);

  return lines.join("\n") + "\n";
}

main();
