#!/usr/bin/env node
/**
 * NB-5 Fix-3 验证脚本：从现有 manifest + generation-matrix result.json 重算纯 B4 胜率。
 *
 * 背景：
 *   旧 manifest 不含 fallbackStatus 字段，导致 ch1128（B3 超时，B4 fallback 到 B2）
 *   被错误纳入 B0 vs B4 汇总。本脚本：
 *   1. 读 manifest.jsonl
 *   2. 对每个 case 读对应 result.json，检测任一比较层是否带 fallbackFrom
 *   3. 按 pure（none） vs withFallback 分桶重算胜率
 *   4. 输出对比表
 *
 * 用法：
 *   node scripts/novelbench/recompute-pure-b4-winrate.mjs --manifest <path> --matrix-dir <dir>
 *   node scripts/novelbench/recompute-pure-b4-winrate.mjs --model glm
 *   node scripts/novelbench/recompute-pure-b4-winrate.mjs --model doubao
 *   node scripts/novelbench/recompute-pure-b4-winrate.mjs --model both
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    "matrix-dir": { type: "string" },
    model: { type: "string", default: "both" }, // glm | doubao | both
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`NB-5 Fix-3 纯 B4 胜率重算

用法：
  node scripts/novelbench/recompute-pure-b4-winrate.mjs --model glm
  node scripts/novelbench/recompute-pure-b4-winrate.mjs --model doubao
  node scripts/novelbench/recompute-pure-b4-winrate.mjs --model both

选项：
  --manifest <path>   manifest.jsonl 路径（默认按 model 推断）
  --matrix-dir <dir>  generation-matrix 目录（默认 data/novelbench/generation-matrix/）
  --model <name>      glm | doubao | both（默认 both）
`);
  process.exit(0);
}

const matrixDir = values["matrix-dir"] || join(PROJECT_ROOT, "data", "novelbench", "generation-matrix");

/** 计算单个 case 在指定 pair 上的 fallbackStatus */
function computeFallbackStatus(matrixResult, pair) {
  const [l1, l2] = pair;
  const l1Fb = matrixResult.layers?.[l1]?.fallbackFrom;
  const l2Fb = matrixResult.layers?.[l2]?.fallbackFrom;
  if (l1Fb && l2Fb) return `${l1}_fallback_${l1Fb}+${l2}_fallback_${l2Fb}`;
  if (l1Fb) return `${l1}_fallback_${l1Fb}`;
  if (l2Fb) return `${l2}_fallback_${l2Fb}`;
  return "none";
}

/** 处理一个 manifest，输出 pure vs fallback 拆分 */
function analyzeManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    process.stderr.write(`⚠ manifest 不存在：${manifestPath}\n`);
    return null;
  }

  const lines = readFileSync(manifestPath, "utf-8").split("\n").filter((l) => l.trim());
  const stats = {
    total: 0,
    error: 0,
    noResult: 0,
    pairOutcomesAll: {}, // 含 fallback（向后兼容口径）
    pairOutcomesPure: {}, // 仅 fallbackStatus="none"
    pairOutcomesWithFallback: {}, // 任一层带 fallbackFrom
    fallbackCases: [], // 列出所有 fallback case 供审查
  };

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.error) {
      stats.error++;
      continue;
    }
    stats.total++;

    // 读对应 result.json 检测 fallbackFrom
    const resultPath = join(matrixDir, entry.caseId, "result.json");
    if (!existsSync(resultPath)) {
      stats.noResult++;
      continue;
    }
    let matrixResult;
    try {
      matrixResult = JSON.parse(readFileSync(resultPath, "utf-8"));
    } catch {
      stats.noResult++;
      continue;
    }

    // 优先使用 manifest 自带的 fallbackStatus（新 manifest），否则从 result.json 重算
    for (let i = 0; i < (entry.pairWinners?.length ?? 0); i++) {
      const pw = entry.pairWinners[i];
      const pair = pw.pair;
      const pairKey = pair.join(",");
      let fbStatus = pw.fallbackStatus;
      if (!fbStatus) {
        fbStatus = computeFallbackStatus(matrixResult, pair);
      }
      const isFallback = fbStatus !== "none";

      // 合并桶
      if (!stats.pairOutcomesAll[pairKey]) stats.pairOutcomesAll[pairKey] = {};
      const pureBucket = stats.pairOutcomesPure[pairKey] ?? (stats.pairOutcomesPure[pairKey] = {});
      const fbBucket = stats.pairOutcomesWithFallback[pairKey] ?? (stats.pairOutcomesWithFallback[pairKey] = {});

      const outcome = pw.needsManualReview
        ? "MANUAL_REVIEW"
        : pw.majorityWinner ?? "TIE";

      stats.pairOutcomesAll[pairKey][outcome] = (stats.pairOutcomesAll[pairKey][outcome] ?? 0) + 1;
      const targetBucket = isFallback ? fbBucket : pureBucket;
      targetBucket[outcome] = (targetBucket[outcome] ?? 0) + 1;

      if (isFallback) {
        stats.fallbackCases.push({
          caseId: entry.caseId,
          pair: pairKey,
          fallbackStatus: fbStatus,
          majorityWinner: pw.majorityWinner,
          needsManualReview: pw.needsManualReview,
        });
      }
    }
  }

  return stats;
}

/** 计算指定桶的胜率 */
function computeWinRate(bucket, pairKey, targetLayer) {
  const outcomes = bucket[pairKey] ?? {};
  const targetWins = outcomes[targetLayer] ?? 0;
  const manualReview = outcomes["MANUAL_REVIEW"] ?? 0;
  const tie = outcomes["TIE"] ?? 0;
  const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
  const definitive = total - manualReview - tie; // definitive = 总 - 人工审查 - 平票
  return {
    total,
    definitive,
    targetWins,
    manualReview,
    tie,
    winRateOfDefinitive: definitive > 0 ? targetWins / definitive : null,
    winRateOfTotal: total > 0 ? targetWins / total : null,
  };
}

function printReport(label, stats) {
  if (!stats) return;
  console.log(`\n=== ${label} ===`);
  console.log(`总 case：${stats.total}（错误 ${stats.error}，无 result ${stats.noResult}）`);

  for (const pairKey of Object.keys(stats.pairOutcomesAll)) {
    const all = computeWinRate(stats.pairOutcomesAll, pairKey, "B4");
    const pure = computeWinRate(stats.pairOutcomesPure, pairKey, "B4");
    const fb = computeWinRate(stats.pairOutcomesWithFallback, pairKey, "B4");

    console.log(`\n[${pairKey}]`);
    console.log(`  合并口径（含 fallback，旧统计）：`);
    console.log(`    definitive B4 wins: ${all.targetWins}/${all.definitive} = ${all.winRateOfDefinitive !== null ? (all.winRateOfDefinitive * 100).toFixed(1) + "%" : "N/A"}`);
    console.log(`    总样本: ${all.total}（人工审查 ${all.manualReview}，平票 ${all.tie}）`);
    console.log(`  纯 B4 桶（fallbackStatus="none"，Fix-3 新口径）：`);
    console.log(`    definitive B4 wins: ${pure.targetWins}/${pure.definitive} = ${pure.winRateOfDefinitive !== null ? (pure.winRateOfDefinitive * 100).toFixed(1) + "%" : "N/A"}`);
    console.log(`    总样本: ${pure.total}（人工审查 ${pure.manualReview}，平票 ${pure.tie}）`);
    console.log(`  fallback 桶（单列，不混入纯 B4 胜率）：`);
    console.log(`    definitive B4 wins: ${fb.targetWins}/${fb.definitive} = ${fb.winRateOfDefinitive !== null ? (fb.winRateOfDefinitive * 100).toFixed(1) + "%" : "N/A"}`);
    console.log(`    总样本: ${fb.total}（人工审查 ${fb.manualReview}，平票 ${fb.tie}）`);
  }

  if (stats.fallbackCases.length > 0) {
    console.log(`\n被单列的 fallback case（${stats.fallbackCases.length} 个）：`);
    for (const fc of stats.fallbackCases) {
      console.log(`  - ${fc.caseId} [${fc.pair}] fallback=${fc.fallbackStatus} winner=${fc.majorityWinner ?? "N/A"} mr=${fc.needsManualReview}`);
    }
  } else {
    console.log(`\n无 fallback case（所有样本均为纯 B4 比较）`);
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

const model = values.model;
const manifestGlm = values.manifest && model === "glm"
  ? values.manifest
  : join(PROJECT_ROOT, "data", "novelbench", "judge-results", "manifest.jsonl");
const manifestDoubao = values.manifest && model === "doubao"
  ? values.manifest
  : join(PROJECT_ROOT, "data", "novelbench", "judge-results-doubao", "manifest.jsonl");

if (model === "glm" || model === "both") {
  printReport(`GLM NB-5 纯 B4 胜率重算（manifest=${manifestGlm}）`, analyzeManifest(manifestGlm));
}
if (model === "doubao" || model === "both") {
  printReport(`Doubao NB-5 纯 B4 胜率重算（manifest=${manifestDoubao}）`, analyzeManifest(manifestDoubao));
}
