#!/usr/bin/env node
/**
 * NB-5 Reference-aware Judge CLI
 *
 * 读取 NB-4 Generation Matrix 产出的 B0-B4 候选，对指定层对做
 * reference-aware 匿名 pairwise + 反向复判 + 多数投票。
 *
 * 流程（evaluator 进程）：
 * 1. 扫描 <matrix-dir>/<caseId>/result.json，提取 B0-B4 候选正文
 * 2. 从 continuation-cases.jsonl 查 caseId → referenceId
 * 3. 加载 reference-registry.json，resolve(referenceId) 得到参考正文
 * 4. 调用 runReferenceAwareJudge（匿名 pairwise + 反向复判 + 多数投票）
 * 5. 落盘 verdicts.json + summary.json
 *
 * 用法：
 *   node scripts/novelbench/reference-aware-judge.mjs [options]
 *
 * 选项：
 *   --matrix-dir <DIR>  generation-matrix 输出目录（默认 data/novelbench/generation-matrix/）
 *   --cases <FILE>      continuation-cases JSONL（默认 data/novelbench/datasets/continuation-cases.jsonl）
 *   --registry <FILE>   reference-registry.json（默认 data/novelbench/datasets/reference-registry.json）
 *   --out <DIR>         输出目录（默认 data/novelbench/judge-results/）
 *   --model glm|doubao  裁判模型（默认 doubao）
 *   --pairs <LIST>      比较层对，分号分隔（默认 "B0,B4"）
 *   --rounds N          每对比较轮数（默认 3，奇数）
 *   --seed N            随机种子（默认 0）
 *   --timeout <MS>      单次模型调用超时（默认 600000）
 *   --limit N           只处理前 N 个 case（默认全部）
 *   --skip-existing     跳过已有 verdicts.json 的 case
 *   --exclude-fallback  排除任一比较层存在 fallbackFrom 的 case（用于计算纯 B4 胜率）
 *   --help              显示帮助
 *
 * 环境变量（必须）：
 *   PINOVEL_BENCHMARK_COST_PROFILE=package_screening
 *   PINOVEL_DISABLE_FALLBACK=1
 *   GLM_API_KEY / ARK_API_KEY
 *
 * 产物：
 *   <out>/<caseId>/verdicts.json   完整 ReferenceAwareJudgeResult
 *   <out>/manifest.jsonl           结果索引
 *   <out>/summary.json             聚合统计
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

const { values } = parseArgs({
  options: {
    "matrix-dir": { type: "string" },
    cases: { type: "string" },
    registry: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "doubao" },
    pairs: { type: "string", default: "B0,B4" },
    rounds: { type: "string", default: "3" },
    seed: { type: "string", default: "0" },
    timeout: { type: "string", default: "600000" },
    limit: { type: "string" },
    "skip-existing": { type: "boolean", default: false },
    "exclude-fallback": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`NB-5 Reference-aware Judge CLI

用法：node scripts/novelbench/reference-aware-judge.mjs [options]

选项：
  --matrix-dir <DIR>  generation-matrix 输出目录
  --cases <FILE>      continuation-cases JSONL
  --registry <FILE>   reference-registry.json
  --out <DIR>         输出目录
  --model glm|doubao  裁判模型
  --pairs <LIST>      比较层对（分号分隔，如 "B0,B4;B2,B3"）
  --rounds N          每对比较轮数（奇数）
  --seed N            随机种子
  --timeout <MS>      单次模型调用超时
  --limit N           只处理前 N 个 case
  --skip-existing     跳过已有 verdicts.json 的 case
  --exclude-fallback  排除任一比较层存在 fallbackFrom 的 case（用于计算纯 B4 胜率）
  --help              显示帮助

环境变量（必须）：
  PINOVEL_BENCHMARK_COST_PROFILE=package_screening
  PINOVEL_DISABLE_FALLBACK=1
  GLM_API_KEY / ARK_API_KEY
`);
  process.exit(0);
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

const model = values.model;
const matrixDir = values["matrix-dir"] || join(PROJECT_ROOT, "data", "novelbench", "generation-matrix");
const casesPath = values.cases || join(PROJECT_ROOT, "data", "novelbench", "datasets", "continuation-cases.jsonl");
const registryPath = values.registry || join(PROJECT_ROOT, "data", "novelbench", "datasets", "reference-registry.json");
const outDir = values.out || join(PROJECT_ROOT, "data", "novelbench", `judge-results-${model}`);
const pairsStr = values.pairs;
const rounds = parseInt(values.rounds, 10);
const seed = parseInt(values.seed, 10);
const timeoutMs = parseInt(values.timeout, 10);
const limit = values.limit ? parseInt(values.limit, 10) : null;
const skipExisting = values["skip-existing"];
const excludeFallback = values["exclude-fallback"];

// 路由映射
const ROUTES_BY_MODEL = {
  glm: "nb5_judge_glm",
  doubao: "nb5_judge_doubao",
};

if (!ROUTES_BY_MODEL[model]) {
  process.stderr.write(`错误：未知模型 ${model}（支持 glm | doubao）\n`);
  process.exit(1);
}
const judgeRoute = ROUTES_BY_MODEL[model];

// 解析层对
const pairs = pairsStr.split(";").map((p) => {
  const [a, b] = p.split(",").map((s) => s.trim());
  if (!a || !b) {
    process.stderr.write(`错误：无效层对 ${p}（格式 B0,B4）\n`);
    process.exit(1);
  }
  return [a, b];
});

// ── 环境守卫 ────────────────────────────────────────────────────────────────

if (process.env.PINOVEL_BENCHMARK_COST_PROFILE !== "package_screening") {
  process.stderr.write(
    `错误：必须设置 PINOVEL_BENCHMARK_COST_PROFILE=package_screening\n` +
    `（项目约束：临时/批量测试必须激活成本隔离）\n`,
  );
  process.exit(1);
}
if (process.env.PINOVEL_DISABLE_FALLBACK !== "1") {
  process.stderr.write(
    `错误：必须设置 PINOVEL_DISABLE_FALLBACK=1\n` +
    `（项目约束：临时/批量测试禁用 fallback）\n`,
  );
  process.exit(1);
}

process.stderr.write(
  `[NB-5] model=${model}，route=${judgeRoute}，pairs=${pairsStr}，rounds=${rounds}，seed=${seed}\n` +
  `[NB-5] matrix-dir=${matrixDir}\n` +
  `[NB-5] out=${outDir}\n` +
  (excludeFallback ? `[NB-5] --exclude-fallback 启用：将跳过任一比较层带 fallbackFrom 的 case（用于计算纯 B4 胜率）\n` : `[NB-5] --exclude-fallback 未启用：fallback case 将单列统计（pairOutcomesWithFallback），不混入 pairOutcomesPure\n`),
);

// ── 加载模块 ────────────────────────────────────────────────────────────────

const novelbenchUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`,
).href;
const { runReferenceAwareJudge, ReferenceRegistry } = await import(novelbenchUrl);

const adapterUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "v2", "adapters", "legacy-model-route-adapter.js").replace(/\\/g, "/")}`,
).href;
const { createLegacyModelGenerateFn } = await import(adapterUrl);

// ── 加载 reference registry ─────────────────────────────────────────────────

if (!existsSync(registryPath)) {
  process.stderr.write(`错误：reference-registry 不存在：${registryPath}\n`);
  process.exit(1);
}
const registry = new ReferenceRegistry(registryPath);
registry.load();
process.stderr.write(`[NB-5] reference-registry 加载：${registry.list().length} 条记录\n`);

// ── 加载 continuation-cases（caseId → referenceId）──────────────────────────

if (!existsSync(casesPath)) {
  process.stderr.write(`错误：cases 文件不存在：${casesPath}\n`);
  process.exit(1);
}
const caseRefMap = new Map(); // caseId → referenceId
for (const line of readFileSync(casesPath, "utf-8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.caseId && obj.referenceLocator?.referenceId) {
      caseRefMap.set(obj.caseId, obj.referenceLocator.referenceId);
    }
  } catch {
    // 跳过损坏行
  }
}
process.stderr.write(`[NB-5] continuation-cases 加载：${caseRefMap.size} 条\n`);

// ── 扫描 generation-matrix 结果 ─────────────────────────────────────────────

if (!existsSync(matrixDir)) {
  process.stderr.write(`错误：matrix-dir 不存在：${matrixDir}\n`);
  process.exit(1);
}

const caseIds = [];
for (const entry of readdirSync(matrixDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    const resultPath = join(matrixDir, entry.name, "result.json");
    if (existsSync(resultPath)) {
      caseIds.push(entry.name);
    }
  }
}
caseIds.sort();
const effectiveCaseIds = limit ? caseIds.slice(0, limit) : caseIds;
process.stderr.write(`[NB-5] 找到 ${caseIds.length} 个 generation-matrix 结果，处理 ${effectiveCaseIds.length} 个\n`);

// ── 创建模型调用函数 ────────────────────────────────────────────────────────

const modelGenerate = createLegacyModelGenerateFn();

// ── 主循环 ──────────────────────────────────────────────────────────────────

const stats = {
  total: effectiveCaseIds.length,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  noReference: 0,
  fallbackExcluded: 0,
  pairOutcomes: {}, // "B0,B4" → { winnerLayer: count }（含 fallback case，向后兼容）
  pairOutcomesPure: {}, // "B0,B4" → { winnerLayer: count }（仅 fallbackStatus="none" 的 case，纯 B4 胜率）
  pairOutcomesWithFallback: {}, // "B0,B4" → { winnerLayer: count }（任一层带 fallbackFrom 的 case）
  manualReview: 0,
  manualReviewPure: 0,
  manualReviewWithFallback: 0,
  totalModelCalls: 0,
};

const manifestPath = join(outDir, "manifest.jsonl");
mkdirSync(outDir, { recursive: true });
// 清空 manifest
writeFileSync(manifestPath, "", "utf-8");

for (let idx = 0; idx < effectiveCaseIds.length; idx++) {
  const caseId = effectiveCaseIds[idx];
  const caseOutDir = join(outDir, caseId);
  const verdictsPath = join(caseOutDir, "verdicts.json");

  if (skipExisting && existsSync(verdictsPath)) {
    stats.skipped++;
    process.stderr.write(`[NB-5] [${idx + 1}/${effectiveCaseIds.length}] ↷ ${caseId} (已存在，跳过)\n`);
    continue;
  }

  // 读 generation-matrix result
  const resultPath = join(matrixDir, caseId, "result.json");
  let matrixResult;
  try {
    matrixResult = JSON.parse(readFileSync(resultPath, "utf-8"));
  } catch (e) {
    stats.failed++;
    process.stderr.write(`[NB-5] [${idx + 1}/${effectiveCaseIds.length}] ✗ ${caseId} 读取 result.json 失败：${e.message}\n`);
    continue;
  }

  // Fix-3：检测每对比较层的 fallbackFrom 状态。
  // 任一层带 fallbackFrom（如 B4 fallback 到 B2）时，比较的实际不是声明层对，
  // 而是声明层 vs fallback 源层（如 B0 vs B2）。需单列统计，不能混入纯 B4 胜率。
  const pairFallbackStatus = pairs.map(([l1, l2]) => {
    const l1Fb = matrixResult.layers?.[l1]?.fallbackFrom;
    const l2Fb = matrixResult.layers?.[l2]?.fallbackFrom;
    if (l1Fb && l2Fb) return `${l1}_fallback_${l1Fb}+${l2}_fallback_${l2Fb}`;
    if (l1Fb) return `${l1}_fallback_${l1Fb}`;
    if (l2Fb) return `${l2}_fallback_${l2Fb}`;
    return "none";
  });
  const hasAnyFallback = pairFallbackStatus.some((s) => s !== "none");

  if (excludeFallback && hasAnyFallback) {
    stats.fallbackExcluded++;
    process.stderr.write(
      `[NB-5] [${idx + 1}/${effectiveCaseIds.length}] ⤳ ${caseId} 排除（fallback: ${pairFallbackStatus.join("|")}）\n`,
    );
    continue;
  }

  // 提取 B0-B4 候选
  const candidates = {};
  for (const layer of ["B0", "B1", "B2", "B3", "B4"]) {
    candidates[layer] = matrixResult.layers?.[layer]?.text ?? "";
  }

  // resolve reference
  const referenceId = caseRefMap.get(caseId);
  if (!referenceId) {
    stats.noReference++;
    process.stderr.write(`[NB-5] [${idx + 1}/${effectiveCaseIds.length}] ⚠ ${caseId} 无 referenceId 映射，跳过\n`);
    continue;
  }
  const referenceText = registry.resolve(referenceId);
  if (!referenceText) {
    stats.noReference++;
    process.stderr.write(`[NB-5] [${idx + 1}/${effectiveCaseIds.length}] ⚠ ${caseId} reference 解封失败（${referenceId}），跳过\n`);
    continue;
  }

  process.stderr.write(
    `[NB-5] [${idx + 1}/${effectiveCaseIds.length}] ▶ ${caseId} (ref=${referenceText.length}字)\n`,
  );

  try {
    const judgeResult = await runReferenceAwareJudge({
      caseId,
      candidates,
      referenceText,
      pairs,
      modelGenerate,
      route: judgeRoute,
      rounds,
      seed,
      timeoutMs,
    });

    // 落盘
    mkdirSync(caseOutDir, { recursive: true });
    writeFileSync(verdictsPath, JSON.stringify(judgeResult, null, 2) + "\n", "utf-8");

    // 统计（Fix-3：纯 vs fallback 单列）
    stats.succeeded++;
    stats.totalModelCalls += judgeResult.totalModelCalls;
    judgeResult.pairResults.forEach((pr, pairIdx) => {
      const pairKey = pr.pair.join(",");
      const fbStatus = pairFallbackStatus[pairIdx] ?? "none";
      const isFallback = fbStatus !== "none";

      // 向后兼容的合并桶
      if (!stats.pairOutcomes[pairKey]) stats.pairOutcomes[pairKey] = {};
      // 纯 B4 桶 vs fallback 桶
      const pureBucket = stats.pairOutcomesPure[pairKey] ?? (stats.pairOutcomesPure[pairKey] = {});
      const fbBucket = stats.pairOutcomesWithFallback[pairKey] ?? (stats.pairOutcomesWithFallback[pairKey] = {});
      const targetPureBucket = isFallback ? null : pureBucket;
      const targetFbBucket = isFallback ? fbBucket : null;

      const recordOutcome = (bucket, key) => {
        if (!bucket) return;
        bucket[key] = (bucket[key] ?? 0) + 1;
      };

      if (pr.needsManualReview) {
        stats.manualReview++;
        stats.pairOutcomes[pairKey]["MANUAL_REVIEW"] =
          (stats.pairOutcomes[pairKey]["MANUAL_REVIEW"] ?? 0) + 1;
        if (isFallback) {
          stats.manualReviewWithFallback++;
          recordOutcome(targetFbBucket, "MANUAL_REVIEW");
        } else {
          stats.manualReviewPure++;
          recordOutcome(targetPureBucket, "MANUAL_REVIEW");
        }
      } else if (pr.majorityWinner) {
        stats.pairOutcomes[pairKey][pr.majorityWinner] =
          (stats.pairOutcomes[pairKey][pr.majorityWinner] ?? 0) + 1;
        recordOutcome(isFallback ? targetFbBucket : targetPureBucket, pr.majorityWinner);
      } else {
        stats.pairOutcomes[pairKey]["TIE"] =
          (stats.pairOutcomes[pairKey]["TIE"] ?? 0) + 1;
        recordOutcome(isFallback ? targetFbBucket : targetPureBucket, "TIE");
      }
    });

    // manifest 行（Fix-3：含 fallbackStatus，便于后续按纯/fallback 重算胜率）
    appendFileSync(manifestPath, JSON.stringify({
      caseId,
      model,
      seed,
      rounds,
      pairs: pairs.map((p) => p.join(",")),
      pairFallbackStatus,
      hasAnyFallback,
      pairWinners: judgeResult.pairResults.map((pr, idx) => ({
        pair: pr.pair,
        fallbackStatus: pairFallbackStatus[idx] ?? "none",
        majorityWinner: pr.majorityWinner,
        needsManualReview: pr.needsManualReview,
        confidence: pr.confidence,
        consistentVerdicts: pr.consistentVerdicts.length,
        totalVerdicts: pr.verdicts.length,
      })),
      totalModelCalls: judgeResult.totalModelCalls,
      totalDurationMs: judgeResult.totalDurationMs,
    }) + "\n", "utf-8");

    const summary = judgeResult.pairResults.map((pr) =>
      pr.needsManualReview
        ? `${pr.pair.join(" vs ")} → 人工审查`
        : `${pr.pair.join(" vs ")} → ${pr.majorityWinner} (${pr.confidence * 100}%)`
    ).join("，");

    process.stderr.write(
      `[NB-5] ✓ ${caseId}: ${summary} calls=${judgeResult.totalModelCalls} ${judgeResult.totalDurationMs}ms\n`,
    );
  } catch (e) {
    stats.failed++;
    process.stderr.write(
      `[NB-5] ✗ ${caseId}: ${e.message}\n`,
    );
    appendFileSync(manifestPath, JSON.stringify({
      caseId,
      model,
      error: e.message,
    }) + "\n", "utf-8");
  }
}

// ── summary.json ────────────────────────────────────────────────────────────

const summary = {
  model,
  seed,
  rounds,
  pairs: pairs.map((p) => p.join(",")),
  excludeFallback,
  totalCases: stats.total,
  succeeded: stats.succeeded,
  failed: stats.failed,
  skipped: stats.skipped,
  noReference: stats.noReference,
  fallbackExcluded: stats.fallbackExcluded,
  manualReview: stats.manualReview,
  totalModelCalls: stats.totalModelCalls,
  // 向后兼容：合并桶（含 fallback case）
  pairOutcomes: stats.pairOutcomes,
  // Fix-3：纯 B4 桶（仅 fallbackStatus="none" 的 case）—— 用于计算纯 B4 胜率
  pairOutcomesPure: stats.pairOutcomesPure,
  manualReviewPure: stats.manualReviewPure,
  // Fix-3：fallback 桶（任一层带 fallbackFrom 的 case）—— 单列，不混入纯 B4 胜率
  pairOutcomesWithFallback: stats.pairOutcomesWithFallback,
  manualReviewWithFallback: stats.manualReviewWithFallback,
  generatedAt: new Date().toISOString(),
};

writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8");

process.stderr.write(
  `\n[NB-5] 完成：${stats.succeeded}/${stats.total} 成功，${stats.failed} 失败，${stats.skipped} 跳过，${stats.noReference} 无 reference，${stats.fallbackExcluded} fallback 排除\n` +
  `[NB-5] 人工审查：${stats.manualReview} 对（纯 ${stats.manualReviewPure} / fallback ${stats.manualReviewWithFallback}）\n` +
  `[NB-5] 总模型调用：${stats.totalModelCalls}\n` +
  `[NB-5] 结果目录：${outDir}\n`,
);
