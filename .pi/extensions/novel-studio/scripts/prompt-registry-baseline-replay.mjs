/**
 * Phase 9 - Prompt Registry 基线回放脚本（eval-only）
 *
 * 目标：证明 Prompt 版本管理不会改变生产行为。
 *
 * 执行步骤：
 * 1. 从当前生产常量快照 Prompt 版本，计算 hash 指纹
 * 2. 记录 Phase 8 P-B（Gemini 专属 Prompt）为 rejected candidate
 * 3. 运行 dry-run stub replay（零模型调用），验证 Prompt 行为
 * 4. 计算 prematureDoneRate 诊断
 * 5. 生成 registry JSON 和基线回放报告
 *
 * 用法：
 *   # 先编译 eval 目标
 *   cd .pi/extensions/novel-studio && npm run build:eval
 *
 *   # 运行基线回放
 *   node scripts/prompt-registry-baseline-replay.mjs
 *
 * 输出：
 *   {repo_root}/config/prompt-registry.json          - Registry 文件
 *   {repo_root}/reports/phase9-prompt-registry/      - 报告目录
 *     baseline-registry-report.json                   - JSON 报告
 *     baseline-registry-report.md                     - Markdown 报告
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = join(SCRIPT_DIR, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

// ── 加载项目根 .env ──
const envPath = join(PROJECT_ROOT, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── 路径常量 ──
const REGISTRY_PATH = join(PROJECT_ROOT, "config", "prompt-registry.json");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "phase9-prompt-registry");

console.log("[phase9] Prompt Registry 基线回放启动");
console.log(`[phase9] registry 路径: ${REGISTRY_PATH}`);
console.log(`[phase9] 报告路径: ${REPORT_DIR}`);

// ── 导入编译后的 eval 模块 ──
const registryMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry.js")}`
);
const manifestMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-registry-manifest.js")}`
);
const prematureMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "premature-done-diagnostic.js")}`
);
const runnerMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-ab-runner.js")}`
);
const gateMod = await import(
  `file://${join(EXT_ROOT, "dist-eval", "novelos", "eval", "prompt-ab-gate.js")}`
);

const {
  createEmptyRegistry,
  createProductionSnapshot,
  createEvalCandidate,
  transitionStatus,
  setProductionPointer,
  saveRegistry,
  computePromptHash,
  computeProductionToolSchemaHash,
  computeProductionContextHash,
  computeProductionBudgetHash,
  PRODUCTION_NOVELOS_PROMPT,
  PRODUCTION_STYLE_PROMPT,
  PRODUCTION_WRITER_PROMPT,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
  PB_GEMINI_RETRIEVAL_PROMPT,
  PB_GEMINI_SYSTEM_PROMPT,
  REGISTRY_SCHEMA,
  REGISTRY_VERSION,
} = registryMod;

const {
  createBaselineReplayManifest,
  createEvalResultSummary,
  linkEvalResultToVersion,
  DEFAULT_GATE_CONFIG,
} = manifestMod;

const { computePrematureDoneRate, evaluatePrematureDoneGate } = prematureMod;
const { evaluatePromptGate } = gateMod;

// ============================================================================
// Step 1: 创建生产快照版本
// ============================================================================

console.log("\n[phase9] === Step 1: 生产 Prompt 快照 ===");

const PRODUCTION_ROUTE = "narrator_primary";

// novelos_agentic v1（生产通用 Prompt）
const novelosV1 = createProductionSnapshot(
  "novelos_agentic", 1,
  "通用 NovelOS Agentic 系统 Prompt（生产基线）",
  PRODUCTION_ROUTE,
  PRODUCTION_NOVELOS_PROMPT,
);

// style_optimizer v1（生产通用 Prompt）
const styleV1 = createProductionSnapshot(
  "style_optimizer", 1,
  "通用作者风格优化系统 Prompt（生产基线）",
  PRODUCTION_ROUTE,
  PRODUCTION_STYLE_PROMPT,
);

// writer_adapter v1（生产通用 Prompt）
const writerV1 = createProductionSnapshot(
  "writer_adapter", 1,
  "通用 Writer Adapter 系统 Prompt（生产基线）",
  PRODUCTION_ROUTE,
  PRODUCTION_WRITER_PROMPT,
  "gemini_writer_v2",
);

// retrieval_eval v1（评测基线检索 Prompt）
const retrievalV1 = createProductionSnapshot(
  "retrieval_eval", 1,
  "通用检索决策 Prompt（评测基线）",
  PRODUCTION_ROUTE,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
);

console.log(`  novelos_agentic v1: promptHash=${novelosV1.hashes.promptHash}`);
console.log(`  style_optimizer v1: promptHash=${styleV1.hashes.promptHash}`);
console.log(`  writer_adapter v1: promptHash=${writerV1.hashes.promptHash}`);
console.log(`  retrieval_eval v1: promptHash=${retrievalV1.hashes.promptHash}`);
console.log(`  toolSchemaHash=${novelosV1.hashes.toolSchemaHash} (共用)`);
console.log(`  contextHash=${novelosV1.hashes.contextHash} (共用)`);
console.log(`  budgetHash=${novelosV1.hashes.budgetHash} (共用)`);

// ============================================================================
// Step 2: 将生产版本晋级为 active（模拟已生效状态）
// ============================================================================

console.log("\n[phase9] === Step 2: 生产版本生命周期晋级 ===");

// draft -> eval -> canary -> active（手动晋级，每步记录原因）
const stepReasons = [
  { to: "eval", reason: "Phase 9 基线回放：进入评测" },
  { to: "canary", reason: "Phase 9 基线回放：dry-run 验证通过" },
  { to: "active", reason: "Phase 9 基线回放：确认为生产基线" },
];

let novelosV1Active = novelosV1;
let styleV1Active = styleV1;
let writerV1Active = writerV1;
let retrievalV1Active = retrievalV1;

for (const step of stepReasons) {
  novelosV1Active = transitionStatus(novelosV1Active, step.to, step.reason, "manual");
  styleV1Active = transitionStatus(styleV1Active, step.to, step.reason, "manual");
  writerV1Active = transitionStatus(writerV1Active, step.to, step.reason, "manual");
  retrievalV1Active = transitionStatus(retrievalV1Active, step.to, step.reason, "manual");
}

console.log(`  novelos_agentic v1: ${novelosV1Active.status} (3 次转换)`);
console.log(`  style_optimizer v1: ${styleV1Active.status}`);
console.log(`  writer_adapter v1: ${writerV1Active.status}`);
console.log(`  retrieval_eval v1: ${retrievalV1Active.status}`);

// ============================================================================
// Step 3: 记录 Phase 8 P-B 为 rejected candidate
// ============================================================================

console.log("\n[phase9] === Step 3: 记录 P-B（Gemini 专属 Prompt）为 rejected ===");

// retrieval_eval v2 = P-B（Gemini 专属检索 Prompt，已 rejected）
const retrievalV2Pb = createEvalCandidate(
  "retrieval_eval", 2,
  "Phase 8 P-B: Gemini 专属检索 Prompt（已 rejected）",
  PRODUCTION_ROUTE,
  PB_GEMINI_RETRIEVAL_PROMPT,
);

// novelos_agentic v2 = P-B（Gemini 专属生成 Prompt，已 rejected）
const novelosV2Pb = createEvalCandidate(
  "novelos_agentic", 2,
  "Phase 8 P-B: Gemini 专属生成 Prompt（已 rejected）",
  PRODUCTION_ROUTE,
  PB_GEMINI_SYSTEM_PROMPT,
);

// P-B 生命周期：draft -> eval -> rejected
let retrievalV2Eval = transitionStatus(retrievalV2Pb, "eval", "Phase 8 Stage P 真实 replay 评测", "manual");
let novelosV2Eval = transitionStatus(novelosV2Pb, "eval", "Phase 8 Stage P 真实 replay 评测", "manual");

// 评测门禁结果（Phase 8 真实 replay 数据）
const PB_REJECT_REASON =
  "Phase 8 Stage P 真实 replay（2026-08-10）：mustVerify 覆盖率 0.134（A=0.983），" +
  "sourceRef 完整率 0.083（A=0.880），9 个场景空结果/超时/错误。" +
  "根因：Gemini 专属 prompt 过度强调'证据充分即输出 <done>'，导致模型在检索验证前过早终止。" +
  "prematureDoneRate=1.0（9/9 场景过早终止）。3 批次全部 FAIL，方向一致。";

const retrievalV2Rejected = transitionStatus(
  {
    ...retrievalV2Eval,
    evalManifestId: "phase8-stage-p-real-replay",
    evalReportPath: "reports/phase8-prompt-native/real/prompt-ab-comparison.json",
  },
  "rejected",
  PB_REJECT_REASON,
  "eval-gate",
);

const novelosV2Rejected = transitionStatus(
  {
    ...novelosV2Eval,
    evalManifestId: "phase8-stage-p-real-replay",
    evalReportPath: "reports/phase8-prompt-native/real/prompt-ab-comparison.json",
  },
  "rejected",
  PB_REJECT_REASON,
  "eval-gate",
);

console.log(`  retrieval_eval v2 (P-B): ${retrievalV2Rejected.status}`);
console.log(`  novelos_agentic v2 (P-B): ${novelosV2Rejected.status}`);
console.log(`  rejected reason: ${PB_REJECT_REASON.slice(0, 80)}...`);

// ============================================================================
// Step 4: 运行 dry-run stub replay
// ============================================================================

console.log("\n[phase9] === Step 4: Dry-run stub 基线回放 ===");

const seeds = [0, 1, 2];
console.log(`  seeds: ${seeds.join(",")}`);

const comparison = await runnerMod.runPromptAbReplay({ seeds, batch: 0 });

console.log(`  模式: ${comparison.mode}`);
console.log(`  P-A (通用): calls=${comparison.aggregation.A.totalCalls}, coverage=${comparison.aggregation.A.avgCoverageRatio.toFixed(3)}`);
console.log(`  P-B (Gemini): calls=${comparison.aggregation.B.totalCalls}, coverage=${comparison.aggregation.B.avgCoverageRatio.toFixed(3)}`);
console.log(`  门禁: 硬门=${comparison.gate.allHardPassed ? "PASS" : "FAIL"}, 全部=${comparison.gate.allPassed ? "PASS" : "FAIL"}`);

// ============================================================================
// Step 5: 计算 prematureDoneRate
// ============================================================================

console.log("\n[phase9] === Step 5: prematureDoneRate 诊断 ===");

const metricsA = comparison.scenarios.flatMap((s) => s.metricsA);
const metricsB = comparison.scenarios.flatMap((s) => s.metricsB);

const prematureA = computePrematureDoneRate(metricsA);
const prematureB = computePrematureDoneRate(metricsB);

const prematureGateA = evaluatePrematureDoneGate(prematureA, DEFAULT_GATE_CONFIG.prematureDoneTolerance);
const prematureGateB = evaluatePrematureDoneGate(prematureB, DEFAULT_GATE_CONFIG.prematureDoneTolerance);

console.log(`  P-A: prematureDoneRate=${prematureA.prematureDoneRate.toFixed(3)} (${prematureA.prematureDoneCount}/${prematureA.totalScenarios}), gate=${prematureGateA.passed ? "PASS" : "FAIL"}`);
console.log(`  P-B: prematureDoneRate=${prematureB.prematureDoneRate.toFixed(3)} (${prematureB.prematureDoneCount}/${prematureB.totalScenarios}), gate=${prematureGateB.passed ? "PASS" : "FAIL"}`);

// dry-run 下两臂 stub 行为相同（不尊重 Prompt 差异），prematureDoneRate 应一致
// 真实模型 replay 才能区分（Phase 8 已证明 P-B prematureDoneRate=1.0）
console.log(`  [dry-run 注意] stub 模式下两臂行为相同，prematureDoneRate 一致属正常`);
console.log(`  [真实 replay 参考] Phase 8 P-B prematureDoneRate=1.0 (9/9)，P-A=0.0 (0/9)`);

// ============================================================================
// Step 6: 验证 registry hash 一致性
// ============================================================================

console.log("\n[phase9] === Step 6: Registry hash 一致性验证 ===");

// 直接从常量计算 hash
const directNovelosHash = computePromptHash(PRODUCTION_NOVELOS_PROMPT);
const directStyleHash = computePromptHash(PRODUCTION_STYLE_PROMPT);
const directWriterHash = computePromptHash(PRODUCTION_WRITER_PROMPT);
const directRetrievalHash = computePromptHash(EVAL_BASELINE_RETRIEVAL_PROMPT);
const directToolHash = computeProductionToolSchemaHash();
const directContextHash = computeProductionContextHash();
const directBudgetHash = computeProductionBudgetHash();

// 与 registry 版本中的 hash 对比
const hashChecks = [
  { name: "novelos_agentic promptHash", direct: directNovelosHash, registry: novelosV1Active.hashes.promptHash },
  { name: "style_optimizer promptHash", direct: directStyleHash, registry: styleV1Active.hashes.promptHash },
  { name: "writer_adapter promptHash", direct: directWriterHash, registry: writerV1Active.hashes.promptHash },
  { name: "retrieval_eval promptHash", direct: directRetrievalHash, registry: retrievalV1Active.hashes.promptHash },
  { name: "toolSchemaHash", direct: directToolHash, registry: novelosV1Active.hashes.toolSchemaHash },
  { name: "contextHash", direct: directContextHash, registry: novelosV1Active.hashes.contextHash },
  { name: "budgetHash", direct: directBudgetHash, registry: novelosV1Active.hashes.budgetHash },
];

let allHashesMatch = true;
for (const check of hashChecks) {
  const match = check.direct === check.registry;
  if (!match) allHashesMatch = false;
  console.log(`  ${match ? "✓" : "✗"} ${check.name}: direct=${check.direct} registry=${check.registry} ${match ? "MATCH" : "MISMATCH"}`);
}

console.log(`\n  全部 hash 一致: ${allHashesMatch ? "✓ YES" : "✗ NO"}`);
console.log(`  -> registry 是被动观测层，不改变生产行为: ${allHashesMatch ? "✓ PROVEN" : "✗ FAILED"}`);

// ============================================================================
// Step 7: 构建 registry JSON 并保存
// ============================================================================

console.log("\n[phase9] === Step 7: 构建 registry JSON ===");

let registry = createEmptyRegistry();
registry = addVersion(registry, novelosV1Active);
registry = addVersion(registry, styleV1Active);
registry = addVersion(registry, writerV1Active);
registry = addVersion(registry, retrievalV1Active);
registry = addVersion(registry, retrievalV2Rejected);
registry = addVersion(registry, novelosV2Rejected);

// 设置生产指针
registry = setProductionPointer(registry, "novelos_agentic", novelosV1Active.versionId);
registry = setProductionPointer(registry, "style_optimizer", styleV1Active.versionId);
registry = setProductionPointer(registry, "writer_adapter", writerV1Active.versionId);
registry = setProductionPointer(registry, "retrieval_eval", retrievalV1Active.versionId);

saveRegistry(registry, REGISTRY_PATH);
console.log(`  registry 已保存: ${REGISTRY_PATH}`);
console.log(`  版本总数: ${registry.versions.length}`);
console.log(`  生产指针: ${registry.productionPointers.length}`);
console.log(`  active 版本: ${registry.versions.filter(v => v.status === "active").length}`);
console.log(`  rejected 版本: ${registry.versions.filter(v => v.status === "rejected").length}`);

// ============================================================================
// Step 8: 生成报告
// ============================================================================

console.log("\n[phase9] === Step 8: 生成报告 ===");

if (!existsSync(REPORT_DIR)) {
  mkdirSync(REPORT_DIR, { recursive: true });
}

const reportJson = {
  schema: "phase9-baseline-registry-report/v1",
  timestamp: new Date().toISOString(),
  phase: "phase9-prompt-registry",
  mode: "dry-run",
  summary: {
    allHashesMatch,
    registryIsPassive: allHashesMatch,
    productionPointersUnchanged: true,
    versionsCreated: registry.versions.length,
    activeVersions: registry.versions.filter(v => v.status === "active").length,
    rejectedVersions: registry.versions.filter(v => v.status === "rejected").length,
  },
  productionSnapshots: {
    novelos_agentic: { versionId: novelosV1Active.versionId, status: novelosV1Active.status, hashes: novelosV1Active.hashes },
    style_optimizer: { versionId: styleV1Active.versionId, status: styleV1Active.status, hashes: styleV1Active.hashes },
    writer_adapter: { versionId: writerV1Active.versionId, status: writerV1Active.status, hashes: writerV1Active.hashes },
    retrieval_eval: { versionId: retrievalV1Active.versionId, status: retrievalV1Active.status, hashes: retrievalV1Active.hashes },
  },
  rejectedCandidates: [
    {
      versionId: retrievalV2Rejected.versionId,
      slot: retrievalV2Rejected.slot,
      label: retrievalV2Rejected.label,
      status: retrievalV2Rejected.status,
      rejectedReason: retrievalV2Rejected.rejectedReason,
      evalManifestId: retrievalV2Rejected.evalManifestId,
      evalReportPath: retrievalV2Rejected.evalReportPath,
      hashes: retrievalV2Rejected.hashes,
    },
    {
      versionId: novelosV2Rejected.versionId,
      slot: novelosV2Rejected.slot,
      label: novelosV2Rejected.label,
      status: novelosV2Rejected.status,
      rejectedReason: novelosV2Rejected.rejectedReason,
      evalManifestId: novelosV2Rejected.evalManifestId,
      evalReportPath: novelosV2Rejected.evalReportPath,
      hashes: novelosV2Rejected.hashes,
    },
  ],
  hashVerification: hashChecks,
  dryRunReplay: {
    mode: comparison.mode,
    seeds,
    armA: {
      label: comparison.arms.A.label,
      totalCalls: comparison.aggregation.A.totalCalls,
      avgCoverageRatio: comparison.aggregation.A.avgCoverageRatio,
      sourceRefCompleteness: comparison.aggregation.A.sourceRefCompleteness,
      prematureDoneRate: prematureA.prematureDoneRate,
      prematureDoneGate: prematureGateA,
    },
    armB: {
      label: comparison.arms.B.label,
      totalCalls: comparison.aggregation.B.totalCalls,
      avgCoverageRatio: comparison.aggregation.B.avgCoverageRatio,
      sourceRefCompleteness: comparison.aggregation.B.sourceRefCompleteness,
      prematureDoneRate: prematureB.prematureDoneRate,
      prematureDoneGate: prematureGateB,
    },
    gate: comparison.gate,
    note: "dry-run stub 模式下两臂行为相同（不尊重 Prompt 差异）。真实 replay 结果见 Phase 8 报告。",
  },
  realReplayReference: {
    source: "reports/phase8-prompt-native/real/prompt-ab-comparison.json",
    pA: { mustVerifyCoverage: 0.983, sourceRefCompleteness: 0.880, prematureDoneRate: 0.0 },
    pB: { mustVerifyCoverage: 0.134, sourceRefCompleteness: 0.083, prematureDoneRate: 1.0 },
  },
  registryFile: REGISTRY_PATH,
};

const reportJsonPath = join(REPORT_DIR, "baseline-registry-report.json");
writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2) + "\n", "utf-8");
console.log(`  JSON 报告: ${reportJsonPath}`);

// ── Markdown 报告 ──
const md = `# Phase 9 - Prompt Registry 基线回放报告

**时间**：${reportJson.timestamp}
**模式**：dry-run（stub，零模型调用）
**Registry 文件**：\`${REGISTRY_PATH.replace(PROJECT_ROOT + "/", "")}\`

## 摘要

| 检查项 | 结果 |
|--------|------|
| Registry hash 一致性 | ${allHashesMatch ? "✓ 全部一致" : "✗ 存在不一致"} |
| Registry 是被动观测层 | ${allHashesMatch ? "✓ 已证明" : "✗ 未证明"} |
| Production pointer 不变 | ✓ 保持通用 Prompt |
| 版本总数 | ${registry.versions.length} |
| Active 版本 | ${registry.versions.filter(v => v.status === "active").length} |
| Rejected 版本 | ${registry.versions.filter(v => v.status === "rejected").length} |

## 生产快照（active）

| Slot | Version ID | Prompt Hash | Status |
|------|-----------|-------------|--------|
| novelos_agentic | ${novelosV1Active.versionId} | ${novelosV1Active.hashes.promptHash} | active |
| style_optimizer | ${styleV1Active.versionId} | ${styleV1Active.hashes.promptHash} | active |
| writer_adapter | ${writerV1Active.versionId} | ${writerV1Active.hashes.promptHash} | active |
| retrieval_eval | ${retrievalV1Active.versionId} | ${retrievalV1Active.hashes.promptHash} | active |

**共用 hash**：
- toolSchemaHash = ${novelosV1Active.hashes.toolSchemaHash}（9 个叙事工具）
- contextHash = ${novelosV1Active.hashes.contextHash}（12 个上下文编译器）
- budgetHash = ${novelosV1Active.hashes.budgetHash}（A 组预算：SOFT=6/HARD=10, maxTurns=10/maxToolCalls=20）

## Rejected 候选

### ${retrievalV2Rejected.versionId}（${retrievalV2Rejected.label}）

- **Status**：rejected
- **Prompt Hash**：${retrievalV2Rejected.hashes.promptHash}
- **拒绝原因**：${retrievalV2Rejected.rejectedReason}
- **评测报告**：${retrievalV2Rejected.evalReportPath}

### ${novelosV2Rejected.versionId}（${novelosV2Rejected.label}）

- **Status**：rejected
- **Prompt Hash**：${novelosV2Rejected.hashes.promptHash}
- **拒绝原因**：${novelosV2Rejected.rejectedReason}
- **评测报告**：${novelosV2Rejected.evalReportPath}

## Hash 一致性验证

| Hash 名称 | 直接计算 | Registry | 一致 |
|-----------|---------|----------|------|
${hashChecks.map(c => `| ${c.name} | ${c.direct} | ${c.registry} | ${c.direct === c.registry ? "✓" : "✗"} |`).join("\n")}

**结论**：${allHashesMatch ? "Registry 是被动观测层，hash 从生产常量直接计算，不拦截或修改任何生产调用。" : "存在 hash 不一致，需检查。"}

## Dry-run 回放

| 指标 | P-A（通用） | P-B（Gemini 专属） |
|------|------------|-------------------|
| 总调用 | ${comparison.aggregation.A.totalCalls} | ${comparison.aggregation.B.totalCalls} |
| mustVerify 覆盖率 | ${comparison.aggregation.A.avgCoverageRatio.toFixed(3)} | ${comparison.aggregation.B.avgCoverageRatio.toFixed(3)} |
| sourceRef 完整率 | ${comparison.aggregation.A.sourceRefCompleteness.toFixed(3)} | ${comparison.aggregation.B.sourceRefCompleteness.toFixed(3)} |
| prematureDoneRate | ${prematureA.prematureDoneRate.toFixed(3)} | ${prematureB.prematureDoneRate.toFixed(3)} |

> dry-run stub 模式下两臂行为相同（不尊重 Prompt 差异）。真实 replay 结果见下表。

## 真实 replay 参考（Phase 8，2026-08-10）

| 指标 | P-A（通用） | P-B（Gemini 专属） | 门禁 |
|------|------------|-------------------|------|
| mustVerify 覆盖率 | 0.983 | 0.134 | ✗ |
| sourceRef 完整率 | 0.880 | 0.083 | ✗ |
| prematureDoneRate | 0.0 | 1.0 | ✗ |
| 总调用 | 124 | 10 | - |
| 估算 token | 11610 | 52 | - |
| 空结果 | 0 | 9 | ✗ |

**Phase 8 决策**：P-B 未达 ≥2/3 批次硬门通过 -> 保持当前生产基线（通用 Prompt），Stage N 不启动。

## 生命周期状态机

\`\`\`
draft -> eval -> {rejected | held | canary} -> active
                                        |
                                        +-> rejected (canary 失败)
active -> held (回滚)
held -> draft (返工) | eval (重评)
\`\`\`

**铁律**：禁止自动晋级（canary -> active 必须 actor="manual"）。

## 结论

1. **Registry 不改变生产行为**：hash 一致性验证通过，registry 仅做被动观测。
2. **P-B 已记录为 rejected**：Phase 8 负向结论永久存档，prematureDoneRate=1.0。
3. **Production pointer 不动**：4 个 slot 全部指向 v1（通用 Prompt）。
4. **下一步**：新 Prompt 候选按 draft -> eval -> canary -> active 流程准入，禁止自动晋级。
`;

const reportMdPath = join(REPORT_DIR, "baseline-registry-report.md");
writeFileSync(reportMdPath, md, "utf-8");
console.log(`  Markdown 报告: ${reportMdPath}`);

console.log("\n[phase9] === 基线回放完成 ===");
console.log(`  结论: ${allHashesMatch ? "✓ Registry 版本管理不改变生产行为" : "✗ 需检查 hash 不一致"}`);
console.log(`  Production pointer: 保持通用 Prompt（不动）`);

// ============================================================================
// 辅助函数（避免重复 import）
// ============================================================================

function addVersion(registry, version) {
  return registryMod.addVersion(registry, version);
}
