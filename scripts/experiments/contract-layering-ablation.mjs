#!/usr/bin/env node
/**
 * CONTRACT-LAYERING-ABLATION-1: ChapterContract 权威层级 A/B 消融实验（第一轮最小）
 *
 * 假设 H1：明确权威层级后，模型会更少机械执行清单，同时保持事实安全和章节功能。
 *
 * 实验设计：
 *   - A 组（基线）：evalPromptProfile = "gemini_writer_v2"（平铺渲染 renderContract）
 *   - B 组（处理）：evalPromptProfile = "gemini_writer_v2_layered"（分层渲染 renderLayeredContract）
 *   - 两组共用同一 workspace / ChapterSeed / intent / context / modelGenerate / 采样参数
 *   - evalMode = "B3"（VerifiedAgenticRaw，含 agentic 检索+验证，能测工具调用减少）
 *   - 每组 N 次采样（默认 3），模型随机性由 Gemini 采样参数决定
 *
 * 六维评估：
 *   1. 事实硬伤（自动）：createFactContinuityGuard().check() errors 数量
 *   2. 故事保持率（自动）：intent.authorEventSummaries / authorMustInclude 关键词覆盖率
 *   3. 工具调用减少（自动）：stageResults.evalAgentic.toolCalls
 *   4. 中文自然度（自动）：result 中 paradigmScore（如可用）
 *   5. 叙事完成度（人工盲测）：blind-review-pack.md
 *   6. "按清单写作"僵硬感（人工盲测）：blind-review-pack.md
 *
 * 隔离保证：
 *   - evalMode 路径不写 trace、不保存策略信誉库、不提交状态（unified-entry.ts:1381）
 *   - 生产路径不使用 gemini_writer_v2_layered profile（生产 rawPromptProfile=undefined）
 *   - 不调用 GPT/Claude 文学裁判（生产不调用 opportunity judge / pairwise judge）
 *
 * 用法：
 *   node scripts/experiments/contract-layering-ablation.mjs --samples 3 --workspace xinmo
 *
 * 产物：
 *   reports/experiments/contract-layering-{timestamp}/
 *   ├── manifest.json
 *   ├── sample-1/{A.md, A-metadata.json, A-prompt.txt, B.md, B-metadata.json, B-prompt.txt}
 *   ├── sample-2/...
 *   ├── sample-3/...
 *   ├── summary.json
 *   └── blind-review-pack.md
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 参数解析 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}
const SAMPLES = parseInt(getArg("samples", "3"), 10);
const WORKSPACE_ID = getArg("workspace", "xinmo");
const CHAPTER_NUMBER = parseInt(getArg("chapter", "18"), 10);
const CHAPTER_ID = getArg("chapterId", `${CHAPTER_NUMBER}-contract-layering`);
const TIMEOUT_MS = parseInt(getArg("timeout", "600000"), 10);

// ── 路径常量 ──────────────────────────────────────────────────────────────
const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST = join(EXT_ROOT, "dist-eval");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUTPUT_DIR = join(PROJECT_ROOT, "reports", "experiments", `contract-layering-${TIMESTAMP}`);

// ── 环境变量 ──────────────────────────────────────────────────────────────
// 项目记忆硬约束：临时/批量测试只用 GLM/Doubao，必须设置 PINOVEL_DISABLE_FALLBACK=1
// + PINOVEL_BENCHMARK_COST_PROFILE=package_screening（provider allowlist 守卫）
process.env.PROJECT_ROOT = PROJECT_ROOT;
process.env.PINOVEL_DISABLE_FALLBACK = "1";
process.env.PINOVEL_BENCHMARK_COST_PROFILE = "package_screening";
process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.PINOVEL_GENERATION_MAX_TOKENS = "16384";

mkdirSync(OUTPUT_DIR, { recursive: true });

// ── import dist-eval 模块 ─────────────────────────────────────────────────
const importDist = async (relativePath) => import(pathToFileURL(join(DIST, relativePath)).href);
const { runUnifiedPipeline } = await importDist(join("v2", "core", "unified-entry.js"));
const { createContextCompiler } = await importDist(join("v2", "core", "context-compiler.js"));
const { createChapterIntentBuilder } = await importDist(join("v2", "core", "chapter-intent-builder.js"));
const { loadCreativeConstitution } = await importDist(join("v2", "core", "creative-constitution.js"));
const { loadStateStore } = await importDist(join("v2", "core", "final-state-commit.js"));
const { createLegacyModelGenerateFn } = await importDist(join("v2", "adapters", "legacy-model-route-adapter.js"));
const { createFactContinuityGuard } = await importDist(join("v2", "core", "fact-continuity-guard.js"));
const { loadModelRoutingSync } = await importDist(join("utils", "config.js"));

loadModelRoutingSync();

// ── 工具函数 ──────────────────────────────────────────────────────────────
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}
function log(message) {
  process.stderr.write(`[contract-layering] ${message}\n`);
}

// ── 构造 intent/context（复用 ceiling-abc-pilot.mjs 逻辑）─────────────────
// CONTRACT-LAYERING-ABLATION-1 修复：传入 authorChapterContract
// 理由：第17章 outline-explicit.md（含 authorEventSummaries/authorMustInclude/事件状态变化）
// 被 buildChapterSeed 自动解析为 seed.authorChapterContract。若不传入 intent input，
// ChapterIntentBuilder 无法派生 authorEventSummaries/authorMustInclude/authorStateChanges，
// 导致故事保持率关键词集合为空，B 组（分层渲染）的"章节义务层"无内容可渲染，
// 实验退化为"A vs A"，无法验证四层映射假设 H1。
function buildIntentInput(chapterSeed, chapterNumber) {
  return {
    chapterNumber,
    intentPrimary: chapterSeed.intent?.primary,
    chapterTheme: chapterSeed.intent?.chapterTheme,
    targetEmotions: chapterSeed.intent?.targetEmotions ?? [],
    characters: (chapterSeed.characters ?? []).map((character) => ({
      name: character.name,
      role: character.role,
      mentality: character.mentality,
      recentAction: character.recentAction,
      pendingTension: character.pendingTension,
    })),
    immutableFacts: [
      ...(chapterSeed.worldConstraint?.immutableFacts ?? []),
      ...(chapterSeed.highLevelDirection?.immutableFacts ?? []),
    ],
    openPromises: (chapterSeed.currentPressure?.pendingForeshadowing ?? []).map((item) => ({
      id: item.id,
      description: item.description,
    })),
    openArcs: (chapterSeed.currentPressure?.openArcs ?? []).map((item) => ({
      arcId: item.arcId,
      name: item.name,
      coreQuestion: item.coreQuestion,
    })),
    currentPressureSummary: [
      ...(chapterSeed.currentPressure?.pendingForeshadowing ?? []).map((item) => item.description),
      ...(chapterSeed.currentPressure?.openArcs ?? []).map((item) => item.name),
      ...(chapterSeed.previousChapterContinuation?.unresolvedTensions ?? []),
      ...(chapterSeed.previousChapterContinuation?.openHooks ?? []),
    ],
    prevContinuationAvailable: chapterSeed.previousChapterContinuation?.available ?? false,
    pendingCosts: chapterSeed.currentPressure?.pendingCosts ?? [],
    // 传入 authorChapterContract，让 ChapterIntentBuilder 派生
    // authorEventSummaries / authorMustInclude / authorStateChanges / foreshadowing /
    // causalRelations / focusCharacterGoals / choicesAndCosts / expectedIrreversibleChange /
    // causalEndPressure / characterMotivations / relevantCharacters 等字段。
    authorChapterContract: chapterSeed.authorChapterContract ?? undefined,
    // 透传 authorChapterContract 中的结构化字段（若存在），供 INTENT-1 派生路径使用
    choicesAndCosts: chapterSeed.authorChapterContract?.choicesAndCosts,
    expectedIrreversibleChange: chapterSeed.authorChapterContract?.expectedIrreversibleChange,
    causalEndPressure: chapterSeed.authorChapterContract?.causalEndPressure,
  };
}

function loadOriginalPrefix() {
  const chapterDir = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID, "chapters");
  const prevChapter = CHAPTER_NUMBER - 1;
  const prevPrevChapter = CHAPTER_NUMBER - 2;
  const paths = [prevPrevChapter, prevChapter].map((number) => {
    const path = join(chapterDir, `chapter-${number}.md`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }).filter(Boolean);
  return paths.join("\n\n");
}

// ── 构造共用 context/intent ───────────────────────────────────────────────
log(`workspace=${WORKSPACE_ID} chapter=${CHAPTER_NUMBER} samples=${SAMPLES}`);
log(`output=${OUTPUT_DIR}`);

const compiled = createContextCompiler().compile({
  workspaceId: WORKSPACE_ID,
  chapterId: CHAPTER_ID,
  chapterNumber: CHAPTER_NUMBER,
  projectRoot: PROJECT_ROOT,
});
const context = compiled.context;
const seed = compiled.sourceSeed;
const constitution = loadCreativeConstitution(WORKSPACE_ID, PROJECT_ROOT);
const stateStore = loadStateStore(WORKSPACE_ID, PROJECT_ROOT);
const intentInput = buildIntentInput(seed, CHAPTER_NUMBER);
const { intent, warnings: intentWarnings } = createChapterIntentBuilder().build(
  intentInput,
  constitution,
  stateStore,
);
const prefix = loadOriginalPrefix();
const characterNames = [...new Set((seed.characters ?? []).map((character) => character.name).filter(Boolean))];

// CONTRACT-LAYERING-ABLATION-1：锁定 GLM 测试路由
// 项目记忆硬约束：临时/批量测试只用 GLM/Doubao，PINOVEL_DISABLE_FALLBACK=1。
// 编排器 eval 路径硬编码 route="v2_rawstage2"（→ claude），但 package_screening
// 只授权 [glm, doubao]。通过 wrap 把实际调用路由锁定到 narrator_testing_glm
// （provider=glm, fallback=[], lab_testing=true），保证：
//   1. A/B 两组共用同一 GLM 5.2 模型，对比只看 prompt 表达层差异
//   2. 不调用 Claude/GPT/ERNIE（符合 package_screening + 项目记忆约束）
//   3. GLM 失败即 hard block（fallback=[]），不静默回退
// route 字段保持编排器传入的语义路由（v2_rawstage2），requestedRoute 记录真实锁定路由。
const baseModelGenerate = createLegacyModelGenerateFn();
const GLM_TEST_ROUTE = "narrator_testing_glm";
const modelGenerate = async (input) => {
  return baseModelGenerate({
    ...input,
    route: GLM_TEST_ROUTE,
    requestedRoute: GLM_TEST_ROUTE,
  });
};

if (intentWarnings?.length > 0) {
  log(`intent warnings: ${intentWarnings.length} (non-fatal)`);
}
log(`characterNames: ${characterNames.join(", ") || "(empty)"}`);
log(`intent.eventSummaries: ${intent.authorEventSummaries?.length ?? 0}`);
log(`intent.mustInclude: ${intent.authorMustInclude?.length ?? 0}`);

// ── FactGuard standalone ──────────────────────────────────────────────────
const factGuard = createFactContinuityGuard();

function runFactGuardCheck(text) {
  try {
    const result = factGuard.check({
      text,
      context,
      knownCharacterNames: characterNames,
    });
    return {
      ok: result.ok,
      errorCount: result.errors?.length ?? 0,
      errors: (result.errors ?? []).slice(0, 10).map((error) => ({
        type: error?.type ?? error?.kind ?? "unknown",
        message: error?.message ?? String(error),
        severity: error?.severity ?? "unknown",
      })),
    };
  } catch (error) {
    return { ok: false, errorCount: -1, errors: [{ type: "guard_exception", message: error.message, severity: "unknown" }] };
  }
}

// ── 故事保持率：关键词覆盖率（简化版）─────────────────────────────────────
function extractKeywordsFromIntent(intentObj) {
  const keywords = new Set();
  const push = (value) => {
    if (typeof value === "string" && value.trim().length >= 2) {
      // 提取 2-6 字符的中文/英文关键词片段
      const matches = value.match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z]{3,}/g);
      if (matches) matches.forEach((match) => keywords.add(match));
    }
  };
  (intentObj.authorEventSummaries ?? []).forEach(push);
  (intentObj.authorMustInclude ?? []).forEach(push);
  (intentObj.authorStateChanges ?? []).forEach(push);
  return [...keywords];
}

function computeStoryPreservation(text, keywords) {
  if (keywords.length === 0) return { coverage: 1.0, coveredCount: 0, totalCount: 0, missing: [] };
  const covered = keywords.filter((keyword) => text.includes(keyword));
  return {
    coverage: covered.length / keywords.length,
    coveredCount: covered.length,
    totalCount: keywords.length,
    missing: keywords.filter((keyword) => !text.includes(keyword)),
  };
}

const storyKeywords = extractKeywordsFromIntent(intent);

// ── A/B 实验主循环 ────────────────────────────────────────────────────────
const ARMS = [
  { id: "A", label: "平铺渲染（基线）", profile: "gemini_writer_v2" },
  { id: "B", label: "分层渲染（处理）", profile: "gemini_writer_v2_layered" },
];

const manifest = {
  experimentId: `contract-layering-${TIMESTAMP}`,
  hypothesis: "明确权威层级后，模型会更少机械执行清单，同时保持事实安全和章节功能",
  workspaceId: WORKSPACE_ID,
  chapterId: CHAPTER_ID,
  chapterNumber: CHAPTER_NUMBER,
  samples: SAMPLES,
  evalMode: "B3",
  arms: ARMS.map((arm) => ({ id: arm.id, label: arm.label, profile: arm.profile })),
  storyKeywordsCount: storyKeywords.length,
  characterNames,
  timestamp: TIMESTAMP,
  timeoutMs: TIMEOUT_MS,
  model: {
    route: GLM_TEST_ROUTE,
    provider: "glm",
    model: "glm-5.2",
    fallback: "[]",
    labTesting: true,
    note: "A/B 两组共用 GLM 5.2（narrator_testing_glm），对比只看 prompt 表达层差异",
  },
};
writeJson(join(OUTPUT_DIR, "manifest.json"), manifest);

const allSampleResults = [];

for (let sampleIndex = 1; sampleIndex <= SAMPLES; sampleIndex++) {
  const sampleDir = join(OUTPUT_DIR, `sample-${sampleIndex}`);
  mkdirSync(sampleDir, { recursive: true });
  log(`\n=== sample ${sampleIndex}/${SAMPLES} ===`);

  const sampleResult = { sampleIndex, arms: {} };

  for (const arm of ARMS) {
    const armDir = sampleDir;
    const prosePath = join(armDir, `${arm.id}.md`);
    const metadataPath = join(armDir, `${arm.id}-metadata.json`);

    log(`  arm ${arm.id} (${arm.label}): generating...`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const result = await runUnifiedPipeline({
      workspaceId: `eval-${WORKSPACE_ID}`,
      chapterId: `${CHAPTER_ID}-${arm.id}-s${sampleIndex}`,
      chapterNumber: CHAPTER_NUMBER,
      projectRoot: PROJECT_ROOT,
      candidateTimeoutMs: TIMEOUT_MS,
      evalMode: "B3",
      evalPrefix: prefix,
      evalIntent: intent,
      evalContext: context,
      evalModelGenerate: modelGenerate,
      evalPromptProfile: arm.profile,
      evalCharacterNames: characterNames,
    });

    const durationMs = Date.now() - startMs;
    const text = result.text ?? "";

    // 提前提取 evalAgentic，用于失败判定（candidateId / verifierCleared）
    const evalAgentic = result.stageResults?.evalAgentic ?? {};
    const candidateId = evalAgentic.candidateId ?? null;
    const verifierCleared = evalAgentic.verifierCleared ?? false;

    if (result.status !== "ok" || text.trim().length === 0) {
      log(`  arm ${arm.id}: FAILED status=${result.status}`);
      writeJson(join(armDir, `${arm.id}-failure.json`), {
        status: result.status,
        failureEnvelope: result.failureEnvelope,
        durationMs,
      });
      sampleResult.arms[arm.id] = {
        sampleIndex,
        arm: arm.id,
        status: "failed",
        failureEnvelope: result.failureEnvelope,
        durationMs,
      };
      continue;
    }

    // candidateId=null → 直接判失败，不接受 raw fallback
    // 理由：B3 eval 路径下 candidate=null 会回退 one_shot_raw 仍返回 status="ok"，
    // 但这不能作为有效样本——agentic 未产出候选意味着该 arm 没有实际信号。
    if (candidateId === null || candidateId === undefined) {
      log(`  arm ${arm.id}: FAILED candidateId=null（agentic 未产出候选，不接受 raw fallback）`);
      writeJson(join(armDir, `${arm.id}-failure.json`), {
        status: "failed_no_candidate",
        reason: "candidateId is null — agentic did not produce a candidate, raw fallback not accepted",
        selectedSource: result.selectedSource,
        failureEnvelope: result.failureEnvelope,
        durationMs,
      });
      sampleResult.arms[arm.id] = {
        sampleIndex,
        arm: arm.id,
        status: "failed",
        failureReason: "no_candidate",
        selectedSource: result.selectedSource,
        durationMs,
      };
      continue;
    }

    // verifierCleared=false → 直接判失败
    // 理由：B3 eval 路径不检查 verifierCleared，只要 FactGuard 通过就交付。
    // 但 verifier 未清零意味着候选有未解决的硬失败，不能作为有效信号。
    if (verifierCleared === false) {
      log(`  arm ${arm.id}: FAILED verifierCleared=false（verifier 未清零，hardFindings=${evalAgentic.hardFindingCount ?? "?"}）`);
      writeJson(join(armDir, `${arm.id}-failure.json`), {
        status: "failed_verifier_not_cleared",
        reason: "verifierCleared is false — agentic candidate has unresolved hard findings",
        candidateId,
        hardFindingCount: evalAgentic.hardFindingCount ?? null,
        failureEnvelope: result.failureEnvelope,
        durationMs,
      });
      sampleResult.arms[arm.id] = {
        sampleIndex,
        arm: arm.id,
        status: "failed",
        failureReason: "verifier_not_cleared",
        candidateId,
        hardFindingCount: evalAgentic.hardFindingCount ?? null,
        durationMs,
      };
      continue;
    }

    // CONTRACT-LAYERING-ABLATION-1 数据完整性修复：
    // 强制校验最终交付文本 == agentic candidate（长度 + SHA-256 hash）。
    // 理由：B3 eval 路径在 FactGuard 失败时会回退 one_shot_raw（unified-orchestrator.ts:1707-1714），
    // 但 evalAgentic.candidateId 仍非 null，导致 fallback 被误记为有效 agentic 样本。
    // 仅检查 candidateId/verifierCleared 不足以排除污染——必须确认最终文本确实来自 agentic candidate。
    // 用户反馈 Sample 3 A/B 最终文本与 agentic candidate 长度/标题不同，即为污染样本。
    const candidateHash = evalAgentic.candidateHash ?? null;
    const candidateLength = evalAgentic.candidateLength ?? null;
    const finalTextHash = sha256(text);
    const finalTextLength = text.length;
    const hashMatch = candidateHash !== null && candidateHash === finalTextHash;
    const lengthMatch = candidateLength !== null && candidateLength === finalTextLength;

    if (!hashMatch || !lengthMatch) {
      log(`  arm ${arm.id}: FAILED text_candidate_mismatch（最终文本 != agentic candidate，疑似 B3 FactGuard 回退 one_shot_raw）`);
      log(`    candidateLength=${candidateLength} finalTextLength=${finalTextLength} lengthMatch=${lengthMatch}`);
      log(`    candidateHash=${candidateHash?.slice(0, 12) ?? "null"}... finalTextHash=${finalTextHash.slice(0, 12)}... hashMatch=${hashMatch}`);
      log(`    selectedSource=${result.selectedSource} selectedCandidateId=${result.selectedCandidateId ?? "null"} candidateId=${candidateId}`);
      writeJson(join(armDir, `${arm.id}-failure.json`), {
        status: "failed_text_candidate_mismatch",
        reason: "最终交付文本与 agentic candidate 不匹配（长度或 hash 不一致），疑似 B3 FactGuard 回退 one_shot_raw",
        candidateId,
        selectedSource: result.selectedSource,
        selectedCandidateId: result.selectedCandidateId ?? null,
        candidateLength,
        finalTextLength,
        candidateHash,
        finalTextHash,
        lengthMatch,
        hashMatch,
        failureEnvelope: result.failureEnvelope,
        durationMs,
      });
      sampleResult.arms[arm.id] = {
        sampleIndex,
        arm: arm.id,
        status: "failed",
        failureReason: "text_candidate_mismatch",
        candidateId,
        selectedSource: result.selectedSource,
        selectedCandidateId: result.selectedCandidateId ?? null,
        candidateLength,
        finalTextLength,
        hashMatch,
        lengthMatch,
        durationMs,
      };
      continue;
    }

    // 跑 FactGuard + 故事保持率检测
    const factGuardResult = runFactGuardCheck(text);
    const storyPreservation = computeStoryPreservation(text, storyKeywords);

    // 提取工具调用次数
    const toolCalls = evalAgentic.toolCalls ?? result.stageResults?.novelos?.toolCalls ?? 0;

    // 提取 paradigmScore（如可用）
    const paradigmScore = result.diagnostics?.find((d) => d?.type === "paradigm_score") ?? null;

    const metadata = {
      sampleIndex,
      arm: arm.id,
      armLabel: arm.label,
      profile: arm.profile,
      status: result.status,
      // 显式记录 selectedSource 与 selectedCandidateId，供污染样本排查
      selectedSource: result.selectedSource,
      selectedCandidateId: result.selectedCandidateId ?? null,
      textLength: text.length,
      candidateHash: finalTextHash,
      startedAt,
      durationMs,
      factGuard: factGuardResult,
      storyPreservation,
      toolCalls,
      sourceRefs: evalAgentic.sourceRefs ?? [],
      paradigmScore,
      stageResults: {
        evalAgentic: {
          sessionId: evalAgentic.sessionId,
          trajectoryPath: evalAgentic.trajectoryPath,
          candidateId: evalAgentic.candidateId,
          candidateLength: evalAgentic.candidateLength,
          candidateHash: evalAgentic.candidateHash ?? null,
          finalTextHash,
          finalTextLength,
          hashMatch,
          lengthMatch,
          stopReason: evalAgentic.stopReason,
          toolCalls,
          verifierCleared: evalAgentic.verifierCleared,
          repairRounds: evalAgentic.repairRounds,
          hardFindingCount: evalAgentic.hardFindingCount,
        },
      },
    };

    writeFileSync(prosePath, text, "utf8");
    writeJson(metadataPath, metadata);
    log(`  arm ${arm.id}: ok len=${text.length} toolCalls=${toolCalls} factErrors=${factGuardResult.errorCount} storyCoverage=${storyPreservation.coverage.toFixed(2)} duration=${durationMs}ms`);

    sampleResult.arms[arm.id] = metadata;
  }

  allSampleResults.push(sampleResult);
}

// ── 聚合六维指标 ──────────────────────────────────────────────────────────
function aggregateMetric(samples, armId, getter) {
  const values = samples
    .map((sample) => sample.arms[armId])
    .filter((arm) => arm && arm.status !== "failed")
    .map(getter)
    .filter((value) => typeof value === "number" && !Number.isNaN(value));
  if (values.length === 0) return { count: 0, mean: null, min: null, max: null };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    mean: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

const summary = {
  experimentId: manifest.experimentId,
  hypothesis: manifest.hypothesis,
  samples: SAMPLES,
  arms: ARMS.map((arm) => arm.id),
  metrics: {},
};

for (const arm of ARMS) {
  summary.metrics[arm.id] = {
    label: arm.label,
    profile: arm.profile,
    factGuardErrors: aggregateMetric(allSampleResults, arm.id, (arm) => arm.factGuard?.errorCount ?? 0),
    storyPreservationCoverage: aggregateMetric(allSampleResults, arm.id, (arm) => arm.storyPreservation?.coverage ?? 0),
    toolCalls: aggregateMetric(allSampleResults, arm.id, (arm) => arm.toolCalls ?? 0),
    textLength: aggregateMetric(allSampleResults, arm.id, (arm) => arm.textLength ?? 0),
    durationMs: aggregateMetric(allSampleResults, arm.id, (arm) => arm.durationMs ?? 0),
  };
}

// ── 假设验证判定 ──────────────────────────────────────────────────────────
const aMetrics = summary.metrics.A;
const bMetrics = summary.metrics.B;

function meanOrNull(metrics) {
  return metrics?.mean ?? null;
}

const aFactErrors = meanOrNull(aMetrics.factGuardErrors);
const bFactErrors = meanOrNull(bMetrics.factGuardErrors);
const aStoryCov = meanOrNull(aMetrics.storyPreservationCoverage);
const bStoryCov = meanOrNull(bMetrics.storyPreservationCoverage);
const aToolCalls = meanOrNull(aMetrics.toolCalls);
const bToolCalls = meanOrNull(bMetrics.toolCalls);

const hypothesisVerdict = {
  h1: "明确权威层级后，模型会更少机械执行清单，同时保持事实安全和章节功能",
  autoMetrics: {
    factGuard: {
      aMean: aFactErrors,
      bMean: bFactErrors,
      bNotWorse: bFactErrors !== null && aFactErrors !== null ? bFactErrors <= aFactErrors : null,
    },
    storyPreservation: {
      aMean: aStoryCov,
      bMean: bStoryCov,
      bNotWorse: bStoryCov !== null && aStoryCov !== null ? bStoryCov >= aStoryCov : null,
    },
    toolCalls: {
      aMean: aToolCalls,
      bMean: bToolCalls,
      bFewer: bToolCalls !== null && aToolCalls !== null ? bToolCalls < aToolCalls : null,
    },
  },
  // 人工盲测维度（需用户填写后回填）
  blindReview: {
    narrativeCompleteness: null, // A/B 各自盲测得分
    rigidityFeeling: null, // A/B 各自僵硬感得分（越低越好）
    preference: null, // 评审偏好（A/B/tie）
  },
  // 判定逻辑：自动指标 + 人工盲测
  // H1 成立：B 组僵硬感显著优（盲测 ≥ 2/3 选 B）且 B 组事实硬伤 ≤ A 组、故事保持率 ≥ A 组
  // H1 不成立：B 组僵硬感无优势，或事实/故事保持退化
  // 模糊结果：B 组僵硬感优但事实/故事保持退化 → 需要研究分层契约的事实安全性
  verdict: "pending_blind_review",
  note: "自动指标已计算；需人工盲测 blind-review-pack.md 后填写 blindReview 字段并更新 verdict",
};

summary.hypothesisVerdict = hypothesisVerdict;
writeJson(join(OUTPUT_DIR, "summary.json"), summary);

// ── 生成盲测材料 ──────────────────────────────────────────────────────────
const blindPackLines = [
  "# ChapterContract 权威层级 A/B 消融实验 — 人工盲测材料",
  "",
  `实验 ID：${manifest.experimentId}`,
  `假设 H1：${manifest.hypothesis}`,
  "",
  "## 盲测说明",
  "",
  "下方每个 sample 包含两段正文（X 和 Y），分别来自 A/B 两组中的一组（随机编号）。",
  "请逐 sample 评估以下维度，并在末尾填写整体偏好：",
  "",
  "### 评估维度（每项 1-5 分，5 分最好）",
  "1. **叙事完成度**：情节推进是否完整、人物塑造是否立体、场景展开是否充分、情绪节拍是否到位",
  "2. **僵硬感**（越低越好）：是否有明显清单式表达、逐条执行痕迹、机械堆砌要素、AI 腔翻译腔",
  "",
  "### 整体偏好（每 sample 选一个）",
  "- X 更好 / Y 更好 / 平手",
  "",
  "### 假设判定标准",
  "- H1 成立：B 组僵硬感显著优（盲测 ≥ 2/3 sample 选 B）且 B 组事实硬伤 ≤ A 组、故事保持率 ≥ A 组",
  "- H1 不成立：B 组僵硬感无优势，或事实/故事保持退化",
  "",
  "---",
  "",
];

for (const sampleResult of allSampleResults) {
  const { sampleIndex, arms } = sampleResult;
  blindPackLines.push(`## Sample ${sampleIndex}`, "");

  // 确定性决定 X/Y 对应 A/B（用 sampleIndex 作为种子，确保与末尾映射一致）
  const aIsX = (sampleIndex % 2) === 1;
  const xArm = aIsX ? "A" : "B";
  const yArm = aIsX ? "B" : "A";
  const xText = arms[xArm]?.textLength ? readFileSync(join(OUTPUT_DIR, `sample-${sampleIndex}`, `${xArm}.md`), "utf8") : "(生成失败)";
  const yText = arms[yArm]?.textLength ? readFileSync(join(OUTPUT_DIR, `sample-${sampleIndex}`, `${yArm}.md`), "utf8") : "(生成失败)";

  blindPackLines.push("### X", "", "```markdown", xText, "```", "");
  blindPackLines.push("### Y", "", "```markdown", yText, "```", "");
  blindPackLines.push("**评估**（填写后回填到 summary.json）", "");
  blindPackLines.push("- X 叙事完成度（1-5）：");
  blindPackLines.push("- Y 叙事完成度（1-5）：");
  blindPackLines.push("- X 僵硬感（1-5，越低越好）：");
  blindPackLines.push("- Y 僵硬感（1-5，越低越好）：");
  blindPackLines.push("- 整体偏好：X 更好 / Y 更好 / 平手");
  blindPackLines.push("");
  blindPackLines.push("---", "");
}

blindPackLines.push("## 盲测映射（评审完成后查看）", "");
blindPackLines.push("评审完成后，对照此映射确定 A/B 得分：", "");
for (const sampleResult of allSampleResults) {
  const { sampleIndex } = sampleResult;
  // 重新生成相同的随机映射（用 sampleIndex 作为种子）
  const aIsX = (sampleIndex % 2) === 1;
  blindPackLines.push(`- Sample ${sampleIndex}: X=${aIsX ? "A" : "B"}, Y=${aIsX ? "B" : "A"}`);
}

writeFileSync(join(OUTPUT_DIR, "blind-review-pack.md"), blindPackLines.join("\n"), "utf8");

// ── 输出结论 ──────────────────────────────────────────────────────────────
log("\n=== 实验完成 ===");
log(`产物目录：${OUTPUT_DIR}`);
log(`summary.json：${join(OUTPUT_DIR, "summary.json")}`);
log(`blind-review-pack.md：${join(OUTPUT_DIR, "blind-review-pack.md")}`);
log("");
log("自动指标摘要：");
for (const arm of ARMS) {
  const metrics = summary.metrics[arm.id];
  log(`  ${arm.id} (${arm.label}):`);
  log(`    事实硬伤数: mean=${metrics.factGuardErrors.mean?.toFixed(2) ?? "N/A"} (min=${metrics.factGuardErrors.min ?? "N/A"}, max=${metrics.factGuardErrors.max ?? "N/A"})`);
  log(`    故事保持率: mean=${metrics.storyPreservationCoverage.mean?.toFixed(2) ?? "N/A"} (min=${metrics.storyPreservationCoverage.min ?? "N/A"}, max=${metrics.storyPreservationCoverage.max ?? "N/A"})`);
  log(`    工具调用数: mean=${metrics.toolCalls.mean?.toFixed(2) ?? "N/A"} (min=${metrics.toolCalls.min ?? "N/A"}, max=${metrics.toolCalls.max ?? "N/A"})`);
}
log("");
log("待人工盲测：请填写 blind-review-pack.md 后回填 summary.json 的 blindReview 字段");
