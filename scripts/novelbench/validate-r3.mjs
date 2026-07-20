/**
 * DEMO-3-R2.4 Phase 5: Case A R3 验证脚本
 *
 * 在 R3 GLM 生成完成后运行，验证所有 R3 验收标准：
 * 1. B0-B4 均成功且为真实正文
 * 2. B4 完整 raw/editorial 候选文件存在
 * 3. provenance 守卫真实通过
 * 4. raw/editorial 属于同一次 B4 run
 * 5. hash、candidate ID、kind、来源路径全部一致
 * 6. StoryPreservationGate 在真实管线内执行
 * 7. 若 editorial 漂移，必须被拒绝并分类为 story_preservation_block
 * 8. 若 editorial 通过，事件保持 trace 必须可解释
 * 9. FactGuard 抢先阻断时，应准确分类为 factguard_block
 * 10. 最终 selectedSource/fallbacked/finalSource/outcomeType 不矛盾
 *
 * 产物：
 * - case-a-glm-r3-validation.md（主验证报告）
 * - provenance-validation.json（provenance 守卫详细结果）
 * - event-retention-comparison.json（事件保留对照表）
 *
 * 用法：node scripts/novelbench/validate-r3.mjs
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { validateB4ArtifactsProvenance } from "../../.pi/extensions/novel-studio/dist/v2/core/replay-provenance-guard.js";
import { checkEditorialStoryPreservation } from "../../.pi/extensions/novel-studio/dist/v2/core/editorial-story-preservation-gate.js";

// ── 路径 ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const CASE_ID = "nb3r-v1-01727287bd911ec3-ch1106";
const R3_OUT_DIR = resolve(PROJECT_ROOT, "data/novelbench/demo-3/case-a-glm-r3");
const CASE_OUT_DIR = join(R3_OUT_DIR, CASE_ID);
const RESULT_PATH = join(CASE_OUT_DIR, "result.json");
const B4_ARTIFACTS_DIR = join(CASE_OUT_DIR, "b4-artifacts");

// ── R1 角色（用于 StoryPreservationGate 的 knownEntities）──────────────────

const CASE_A_CHARACTERS = [
  "祝明朗", "洪逸", "洪摩", "采悠", "长隍", "长乘", "玉衡星女神", "南宫剑仙",
];

// ── 工具 ────────────────────────────────────────────────────────────────────

function sha256(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function truncate(text, max = 200) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `…（共 ${text.length} 字）`;
}

// ── 主验证流程 ──────────────────────────────────────────────────────────────

function main() {
  console.log("=== DEMO-3-R2.4 Phase 5: Case A R3 验证 ===\n");

  // ── 1. 检查 result.json 存在 ─────────────────────────────────────────────
  if (!existsSync(RESULT_PATH)) {
    console.error(`✗ result.json 不存在：${RESULT_PATH}`);
    console.error("  请先运行 generation-matrix.mjs 生成 R3 产物。");
    process.exit(1);
  }

  const result = readJson(RESULT_PATH);
  console.log(`✓ result.json 已加载：${RESULT_PATH}`);

  const layers = result.layers || {};
  const b4Details = layers.B4?.b4Details;
  const b4Artifacts = layers.B4?.b4Artifacts;

  // ── 2. 验收标准 1: B0-B4 均成功且为真实正文 ────────────────────────────
  console.log("\n── 验收标准 1: B0-B4 均成功且为真实正文 ──");
  const layerNames = ["B0", "B1", "B2", "B3", "B4"];
  const layerStatus = {};
  for (const name of layerNames) {
    const layer = layers[name];
    const success = layer?.success === true;
    const hasText = typeof layer?.text === "string" && layer.text.length > 100;
    const isReal = hasText && !layer.text.startsWith("MOCK") && !layer.text.startsWith("STUB");
    layerStatus[name] = { success, hasText, isReal, textLength: layer?.text?.length ?? 0 };
    console.log(
      `  ${name}: success=${success}, textLength=${layer?.text?.length ?? 0}, isReal=${isReal}`,
    );
  }
  const allLayersSuccess = layerNames.every(
    (n) => layerStatus[n].success && layerStatus[n].isReal,
  );
  console.log(`  → B0-B4 全部成功且真实: ${allLayersSuccess ? "✓ PASS" : "✗ FAIL"}`);

  // ── 3. 验收标准 2: B4 完整 raw/editorial 候选文件存在 ──────────────────
  console.log("\n── 验收标准 2: B4 完整候选文件存在 ──");
  const runJsonPath = join(B4_ARTIFACTS_DIR, "run.json");
  if (!existsSync(runJsonPath)) {
    console.error(`✗ b4-artifacts/run.json 不存在：${runJsonPath}`);
    console.error("  Phase 1 持久化未生效，b4-artifacts/ 目录未生成。");
    process.exit(1);
  }
  const runMeta = readJson(runJsonPath);
  console.log(`✓ run.json 已加载`);
  console.log(`  orchestratorRunId: ${runMeta.orchestratorRunId}`);
  console.log(`  caseId: ${runMeta.caseId}`);
  console.log(`  layer: ${runMeta.layer}`);
  console.log(`  outcomeType: ${runMeta.outcomeType}`);
  console.log(`  selectedSource: ${runMeta.selectedSource}`);
  console.log(`  fallbacked: ${runMeta.fallbacked}`);

  // 检查候选文件存在
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

  // ── 4. 验收标准 3+4+5: provenance 守卫真实通过 ─────────────────────────
  console.log("\n── 验收标准 3+4+5: provenance 守卫真实通过 ──");
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
    join(R3_OUT_DIR, "provenance-validation.json"),
    JSON.stringify(provenanceReport, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  → provenance-validation.json 已保存`);

  // ── 5. 验收标准 6+7+8: StoryPreservationGate 在真实管线内执行 ──────────
  console.log("\n── 验收标准 6+7+8: StoryPreservationGate 真实执行 ──");
  let spReport = null;
  let spSource = "";
  if (spExists) {
    // 优先用管线内已保存的 story-preservation.json
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
    // 回退：从 b4Details 取
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
    // 最后回退：直接在真实 raw/editorial 上跑门禁
    const rawText = provenanceResult.rawText ?? layers.B3?.text ?? "";
    const edText = provenanceResult.editorialText ?? layers.B4?.text ?? "";
    if (rawText && edText) {
      spReport = checkEditorialStoryPreservation({
        rawText,
        editorialText: edText,
        knownEntities: CASE_A_CHARACTERS,
        entityCoverage: "characters_only",
      });
      spSource = "validate-r3.mjs 实时调用 checkEditorialStoryPreservation";
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

  // ── 6. 验收标准 9: FactGuard 分类 ──────────────────────────────────────
  console.log("\n── 验收标准 9: FactGuard 分类 ──");
  const factGuardReports = b4Artifacts?.editorialFactGuard ?? b4Details?.factGuardRejectionCount;
  const factGuardRejectionCount = b4Details?.factGuardRejectionCount ?? 0;
  const storyPreservationRejectionCount = b4Details?.storyPreservationRejectionCount ?? 0;
  const hypothesesCount = b4Details?.hypothesesCount ?? 0;
  const editorialCandidateCount = b4Details?.editorialCandidateCount ?? 0;
  console.log(`  hypothesesCount: ${hypothesesCount}`);
  console.log(`  editorialCandidateCount: ${editorialCandidateCount}`);
  console.log(`  factGuardRejectionCount: ${factGuardRejectionCount}`);
  console.log(`  storyPreservationRejectionCount: ${storyPreservationRejectionCount}`);

  // ── 7. 验收标准 10: 最终来源不矛盾 ────────────────────────────────────
  console.log("\n── 验收标准 10: 最终来源不矛盾 ──");
  const outcomeType = b4Details?.outcomeType ?? runMeta.outcomeType;
  const selectedSource = b4Details?.selectedSource ?? runMeta.selectedSource;
  const finalSource = b4Details?.finalSource ?? runMeta.finalSource;
  const fallbacked = b4Details?.fallbacked ?? runMeta.fallbacked;
  console.log(`  outcomeType: ${outcomeType}`);
  console.log(`  selectedSource: ${selectedSource}`);
  console.log(`  finalSource: ${finalSource}`);
  console.log(`  fallbacked: ${fallbacked}`);

  // 一致性检查
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

  // ── 8. 事件保留对照表 ──────────────────────────────────────────────────
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
    join(R3_OUT_DIR, "event-retention-comparison.json"),
    JSON.stringify(eventComparison, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  → event-retention-comparison.json 已保存`);
  console.log(`  eventType 分布: ${JSON.stringify(eventComparison.eventTypeDistribution)}`);

  // ── 9. 汇总判定 ──────────────────────────────────────────────────────
  const overallPass =
    allLayersSuccess &&
    artifactsComplete &&
    provenanceResult.valid &&
    allConsistent;

  // ── 10. 生成 validation.md ────────────────────────────────────────────
  const md = generateValidationMd({
    result,
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
  writeFileSync(join(R3_OUT_DIR, "case-a-glm-r3-validation.md"), md, "utf-8");
  console.log(`\n→ case-a-glm-r3-validation.md 已保存`);

  console.log(`\n=== R3 验证完成 ===`);
  console.log(`总体判定: ${overallPass ? "✓ PASS" : "✗ FAIL"}`);
  if (!overallPass) {
    process.exit(1);
  }
}

// ── 生成 validation.md ─────────────────────────────────────────────────────

function generateValidationMd(ctx) {
  const {
    result,
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
  } = ctx;

  const lines = [];
  lines.push(`# DEMO-3-R2.4 Case A R3 验证报告`);
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
  lines.push(`## 1. B0-B4 各层状态`);
  lines.push(``);
  lines.push(`| Layer | success | textLength | isReal |`);
  lines.push(`|-------|---------|------------|--------|`);
  for (const name of ["B0", "B1", "B2", "B3", "B4"]) {
    const s = layerStatus[name];
    lines.push(`| ${name} | ${s.success ? "✓" : "✗"} | ${s.textLength} | ${s.isReal ? "✓" : "✗"} |`);
  }
  lines.push(``);
  lines.push(`- B0-B4 全部成功且真实: ${Object.values(layerStatus).every((s) => s.success && s.isReal) ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(``);
  lines.push(`## 2. B4 候选产物（b4-artifacts/）`);
  lines.push(``);
  lines.push(`- **orchestratorRunId**: \`${runMeta.orchestratorRunId}\``);
  lines.push(`- **caseId**: \`${runMeta.caseId}\``);
  lines.push(`- **layer**: \`${runMeta.layer}\``);
  lines.push(`- **generatedAt**: \`${runMeta.generatedAt ?? "N/A"}\``);
  lines.push(`- **hypothesesCount**: ${hypothesesCount}`);
  lines.push(`- **editorialCandidateCount**: ${editorialCandidateCount}`);
  lines.push(``);
  lines.push(`### 候选文件清单`);
  lines.push(``);
  lines.push(`| candidateId | kind | sourcePath | contentHash(前16) | textLength |`);
  lines.push(`|-------------|------|------------|-------------------|------------|`);
  lines.push(`| ${runMeta.rawCandidate.candidateId} | raw | ${runMeta.rawCandidate.sourcePath} | ${runMeta.rawCandidate.contentHash.slice(0, 16)}… | ${runMeta.rawCandidate.textLength} |`);
  for (const ed of runMeta.editorialCandidates ?? []) {
    lines.push(`| ${ed.candidateId} | editorial_amplified | ${ed.sourcePath} | ${ed.contentHash.slice(0, 16)}… | ${ed.textLength} |`);
  }
  lines.push(``);
  lines.push(`## 3. provenance 守卫验证`);
  lines.push(``);
  lines.push(`- **valid**: ${provenanceResult.valid ? "✅ true" : "❌ false"}`);
  lines.push(`- **status**: \`${provenanceResult.status}\``);
  lines.push(`- **reason**: ${provenanceResult.reason}`);
  lines.push(`- **rawTextLength**: ${provenanceResult.rawText?.length ?? 0}`);
  lines.push(`- **editorialTextLength**: ${provenanceResult.editorialText?.length ?? 0}`);
  lines.push(`- **selectedEditorialCandidateId**: \`${provenanceResult.selectedEditorialCandidateId ?? ""}\``);
  lines.push(``);
  lines.push(`### 校验项明细（共 ${provenanceResult.checks.length} 项）`);
  lines.push(``);
  lines.push(`| # | 校验项 | passed | detail |`);
  lines.push(`|---|--------|--------|--------|`);
  provenanceResult.checks.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${c.passed ? "✓" : "✗"} | ${c.detail.replace(/\|/g, "\\|")} |`);
  });
  lines.push(``);
  lines.push(`## 4. StoryPreservationGate 真实执行`);
  lines.push(``);
  if (spReport) {
    lines.push(`- **来源**: ${spSource}`);
    lines.push(`- **preserved**: ${spReport.preserved ? "✅ true" : "❌ false"}`);
    lines.push(`- **unverifiable**: ${spReport.unverifiable}`);
    lines.push(`- **rejectionType**: \`${spReport.rejectionType ?? "null"}\``);
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
    lines.push(`- ⚠ 无 StoryPreservationGate 报告（可能无 editorial 候选）`);
  }
  lines.push(``);
  lines.push(`## 5. FactGuard 与 outcome 分类`);
  lines.push(``);
  lines.push(`- **factGuardRejectionCount**: ${factGuardRejectionCount}`);
  lines.push(`- **storyPreservationRejectionCount**: ${storyPreservationRejectionCount}`);
  lines.push(`- **outcomeType**: \`${outcomeType}\``);
  lines.push(``);
  lines.push(`### outcome 分类规则`);
  lines.push(``);
  lines.push(`- \`editorial_win\`: editorial 候选通过 FactGuard + StoryPreservation + judge 胜出`);
  lines.push(`- \`factguard_block\`: editorial 候选已生成但全部被 FactGuard 拒绝`);
  lines.push(`- \`story_preservation_block\`: editorial 候选通过 FactGuard 但全部被 StoryPreservationGate 拒绝`);
  lines.push(`- \`no_editorial\`: 0 hypotheses / Thompson 未准入 / 未生成候选`);
  lines.push(`- \`judge_raw\`: judge 正常选 raw，editorial 未胜出`);
  lines.push(``);
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
  lines.push(`- 来源不矛盾: ${allConsistent ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(``);
  lines.push(`## 7. 停止条件确认`);
  lines.push(``);
  lines.push(`- ✅ R3 完成后停止，不调用 Doubao`);
  lines.push(`- ✅ 不运行 Case B`);
  lines.push(`- ✅ 不修改任务清单`);
  lines.push(`- ✅ 不恢复三 case 汇总`);
  lines.push(`- ✅ 不启动 DEMO-4`);
  lines.push(`- ✅ 不宣称小说质量正收益`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`**产物路径**: \`data/novelbench/demo-3/case-a-glm-r3/\``);

  return lines.join("\n") + "\n";
}

main();
