#!/usr/bin/env node
/**
 * NB-5 Fix-5：重建不含正文的逐 case manifest。
 *
 * 背景：
 *   - 旧 manifest 字段不足（缺候选 hash、route、代码 SHA、有效轮数）
 *   - GLM manifest 在一次 --skip-existing 空跑中被覆盖为空文件
 *   - 换机器无法完整复核 GO/HOLD 决策
 *
 * 本脚本扫描 judge-results 目录下的所有 case 子目录：
 *   1. 读 <caseId>/verdicts.json（ReferenceAwareJudgeResult）
 *   2. 读对应 generation-matrix result.json，提取候选 hash、模型、route、fallbackFrom
 *   3. 计算每个候选正文的 sha256（仅存 hash，不存正文）
 *   4. 获取当前 git HEAD SHA 作为代码 SHA
 *   5. 输出 manifest.jsonl（每行一个 case 的完整元数据）
 *
 * 用法：
 *   node scripts/novelbench/rebuild-judge-manifest.mjs --judge-dir <path>
 *   node scripts/novelbench/rebuild-judge-manifest.mjs --judge-dir data/novelbench/judge-results
 *   node scripts/novelbench/rebuild-judge-manifest.mjs --judge-dir data/novelbench/judge-results-doubao
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

const { values } = parseArgs({
  options: {
    "judge-dir": { type: "string" },
    "matrix-dir": { type: "string" },
    out: { type: "string" }, // 输出 manifest 路径（默认 <judge-dir>/manifest.jsonl）
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`NB-5 Fix-5 重建 manifest

用法：
  node scripts/novelbench/rebuild-judge-manifest.mjs --judge-dir <path>

选项：
  --judge-dir <path>   judge-results 目录（含 case 子目录）
  --matrix-dir <dir>   generation-matrix 目录（默认 data/novelbench/generation-matrix/）
  --out <path>         输出 manifest 路径（默认 <judge-dir>/manifest.jsonl）
  --help               显示帮助
`);
  process.exit(0);
}

const judgeDir = values["judge-dir"]
  ? resolve(values["judge-dir"])
  : join(PROJECT_ROOT, "data", "novelbench", "judge-results");
const matrixDir = values["matrix-dir"] || join(PROJECT_ROOT, "data", "novelbench", "generation-matrix");
const outPath = values.out || join(judgeDir, "manifest.jsonl");

if (!existsSync(judgeDir)) {
  process.stderr.write(`错误：judge-dir 不存在：${judgeDir}\n`);
  process.exit(1);
}

// 获取代码 SHA（git HEAD）
let codeSha = "unknown";
try {
  codeSha = execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
} catch {
  process.stderr.write(`⚠ 无法获取 git HEAD SHA（非 git 仓库？）\n`);
}

/** sha256（仅前 16 字符，足够唯一标识） */
function sha256Short(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

/** 计算单层的 fallbackStatus */
function computeFallbackStatus(matrixResult, pair) {
  const [l1, l2] = pair;
  const l1Fb = matrixResult.layers?.[l1]?.fallbackFrom;
  const l2Fb = matrixResult.layers?.[l2]?.fallbackFrom;
  if (l1Fb && l2Fb) return `${l1}_fallback_${l1Fb}+${l2}_fallback_${l2Fb}`;
  if (l1Fb) return `${l1}_fallback_${l1Fb}`;
  if (l2Fb) return `${l2}_fallback_${l2Fb}`;
  return "none";
}

// ── 扫描 case 目录 ─────────────────────────────────────────────────────────

const entries = readdirSync(judgeDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

process.stderr.write(`[Fix-5] 扫描 ${judgeDir}：${entries.length} 个 case 目录\n`);
process.stderr.write(`[Fix-5] matrix-dir: ${matrixDir}\n`);
process.stderr.write(`[Fix-5] code SHA: ${codeSha}\n`);
process.stderr.write(`[Fix-5] 输出: ${outPath}\n`);

const manifestLines = [];
let missingVerdicts = 0;
let missingResult = 0;

for (const caseId of entries) {
  const verdictsPath = join(judgeDir, caseId, "verdicts.json");
  if (!existsSync(verdictsPath)) {
    missingVerdicts++;
    continue;
  }

  let judgeResult;
  try {
    judgeResult = JSON.parse(readFileSync(verdictsPath, "utf-8"));
  } catch (e) {
    process.stderr.write(`  ⚠ ${caseId} verdicts.json 解析失败：${e.message}\n`);
    continue;
  }

  // 读 generation-matrix result.json（用于候选 hash + fallbackFrom + 模型/route）
  const resultPath = join(matrixDir, caseId, "result.json");
  let matrixResult = null;
  if (existsSync(resultPath)) {
    try {
      matrixResult = JSON.parse(readFileSync(resultPath, "utf-8"));
    } catch {
      // 留 null
    }
  } else {
    missingResult++;
  }

  // 候选 hash（不含正文）
  const candidateHashes = {};
  if (matrixResult?.layers) {
    for (const layer of ["B0", "B1", "B2", "B3", "B4"]) {
      const text = matrixResult.layers[layer]?.text ?? "";
      candidateHashes[layer] = sha256Short(text);
    }
  }

  // 每层元数据（不含正文）
  const layerMeta = {};
  if (matrixResult?.layers) {
    for (const layer of ["B0", "B1", "B2", "B3", "B4"]) {
      const l = matrixResult.layers[layer];
      if (!l) continue;
      layerMeta[layer] = {
        model: l.model,
        route: l.route,
        durationMs: l.durationMs,
        success: l.success,
        fallbackFrom: l.fallbackFrom ?? null,
        fallbackReason: l.fallbackReason ?? null,
        promptHash: l.promptHash ?? null,
        candidateHash: candidateHashes[layer] ?? null,
      };
    }
  }

  // judgeDecision 元数据
  const judgeDecision = matrixResult?.judgeDecision
    ? {
        winner: matrixResult.judgeDecision.winner,
        reason: matrixResult.judgeDecision.reason,
        anonymizedMapping: matrixResult.judgeDecision.anonymizedMapping,
        fallbacked: matrixResult.judgeDecision.fallbacked ?? false,
      }
    : null;

  // 每个 pair 的统计
  const pairWinners = judgeResult.pairResults?.map((pr, idx) => {
    const fbStatus = matrixResult
      ? computeFallbackStatus(matrixResult, pr.pair)
      : "unknown";
    return {
      pair: pr.pair,
      fallbackStatus: fbStatus,
      majorityWinner: pr.majorityWinner,
      needsManualReview: pr.needsManualReview,
      confidence: pr.confidence,
      consistentVerdicts: pr.consistentVerdicts?.length ?? 0,
      totalVerdicts: pr.verdicts?.length ?? 0,
      validVerdicts: pr.verdicts?.filter((v) => v.valid).length ?? 0,
      invalidVerdicts: pr.verdicts?.filter((v) => !v.valid).length ?? 0,
    };
  }) ?? [];

  const hasAnyFallback = pairWinners.some((pw) => pw.fallbackStatus !== "none" && pw.fallbackStatus !== "unknown");

  // 推断 model（从 layer route 或 judgeDecision）
  const inferredModel = layerMeta.B4?.model || layerMeta.B0?.model || "unknown";

  const entry = {
    caseId,
    codeSha,
    rebuiltAt: new Date().toISOString(),
    // 候选元数据（不含正文，仅 hash）
    layerMeta,
    candidateHashes,
    judgeDecision,
    finalSource: matrixResult?.finalSource ?? null,
    finalTextHash: matrixResult?.finalText ? sha256Short(matrixResult.finalText) : null,
    // 裁判结果元数据
    totalModelCalls: judgeResult.totalModelCalls ?? 0,
    totalDurationMs: judgeResult.totalDurationMs ?? 0,
    pairWinners,
    hasAnyFallback,
  };

  manifestLines.push(JSON.stringify(entry));
}

writeFileSync(outPath, manifestLines.join("\n") + (manifestLines.length > 0 ? "\n" : ""), "utf-8");

process.stderr.write(
  `\n[Fix-5] 完成：${manifestLines.length} 个 case 写入 ${outPath}\n` +
  (missingVerdicts > 0 ? `[Fix-5] ⚠ ${missingVerdicts} 个 case 缺 verdicts.json\n` : "") +
  (missingResult > 0 ? `[Fix-5] ⚠ ${missingResult} 个 case 缺 generation-matrix result.json\n` : ""),
);
