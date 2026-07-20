/**
 * P1-5：历史人工校准。
 *
 * 用冻结的人工校准集校准 LLM 裁判（GPT-5.6-sol）。
 * 不允许为了提高一致率修改人工标签。
 *
 * 校准维度（计划 §8.3 门槛）：
 * - directionConsistency：与人工 winner 方向一致率（目标 ≥85%）
 * - reverseConsistency：左右反转一致率（目标 ≥90%）
 * - repeatConsistency：重复评审一致率（目标 ≥85%）
 * - hardFactMissRate：事实硬伤漏判率（目标 ≤5%）
 * - noCitationDefinitiveRate：无引用确定性结论率（目标 =0%）
 *
 * 未达门槛 → passed=false，GPT-5.6-sol 只能作为辅助评审，不能生成 go_candidate。
 *
 * 校准集格式（计划 §8.1）：
 * {
 *   "calibrationSet": [
 *     {
 *       "fixtureId": "F1-historical-fact",
 *       "pair": "B1_vs_B2",
 *       "humanWinner": "left" | "right" | "tie",
 *       "humanConfidence": "clear" | "slight" | "uncertain",
 *       "leftText": "...",
 *       "rightText": "...",
 *       "context": { "workGoal": "...", "chapterIntent": "...", "priorFacts": [...] },
 *       "expectedHardFactRisk": false
 *     }
 *   ]
 * }
 */

import type { JudgeContext } from "./pairwise-judge.js";
import { judgePairwise, validateJudgeVerdict } from "./pairwise-judge.js";
import type { JudgeModelConfig } from "./judge-model-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 校准集单条目 */
export interface CalibrationEntry {
  fixtureId: string;
  pair: string; // e.g. "B1_vs_B2"
  humanWinner: "left" | "right" | "tie";
  humanConfidence: "clear" | "slight" | "uncertain";
  leftText: string;
  rightText: string;
  context: JudgeContext;
  /** 期望的事实风险（用于 hardFactMissRate） */
  expectedHardFactRisk?: boolean;
}

/** 校准集 */
export interface CalibrationSet {
  calibrationSet: CalibrationEntry[];
}

/** 单条目校准详情 */
export interface CalibrationDetail {
  fixtureId: string;
  pair: string;
  humanWinner: string;
  llmWinner: string; // majorityWinner
  consistent: boolean; // directionConsistency
  reverseConsistent: boolean; // round 1 vs round 2 一致
  repeatConsistent: boolean; // 两次运行一致
  hardFactMissed: boolean; // expectedHardFactRisk=true 但 LLM 未检出
  noCitationDefinitive: boolean; // 确定性结论无引用
}

/** 校准结果 */
export interface CalibrationResult {
  directionConsistency: number;
  reverseConsistency: number;
  repeatConsistency: number;
  hardFactMissRate: number;
  noCitationDefinitiveRate: number;
  passed: boolean;
  details: CalibrationDetail[];
  thresholds: typeof CALIBRATION_THRESHOLDS;
  totalEntries: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 门槛（计划 §8.3）
// ─────────────────────────────────────────────────────────────────────────────

export const CALIBRATION_THRESHOLDS = {
  directionConsistency: 0.85,
  reverseConsistency: 0.90,
  repeatConsistency: 0.85,
  hardFactMissRate: 0.05,
  noCitationDefinitiveRate: 0.00,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 校准主函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用冻结的人工校准集校准 LLM 裁判。
 *
 * 对每个 entry：
 * 1. 运行 judgePairwise 获取 majorityWinner + positionSensitive + rounds
 * 2. 运行第二次 judgePairwise（不同 seed）测量 repeatConsistency
 * 3. 比较方向一致性
 * 4. 检查 round 1 vs round 2 一致性（reverseConsistency）
 * 5. 检查 hardFactRisk 漏判
 * 6. 检查无引用确定性结论
 *
 * 不允许修改人工标签。
 */
export async function runCalibration(
  config: JudgeModelConfig,
  calibrationSet: CalibrationEntry[],
): Promise<CalibrationResult> {
  const details: CalibrationDetail[] = [];

  for (const entry of calibrationSet) {
    // ── 第一次运行 ──────────────────────────────────────────────────
    const result1 = await judgePairwise(
      config,
      entry.context,
      "left",
      entry.leftText,
      "right",
      entry.rightText,
      hashSeed(entry.fixtureId),
    );

    // ── 第二次运行（不同 seed，测量 repeatConsistency）──────────────
    const result2 = await judgePairwise(
      config,
      entry.context,
      "left",
      entry.leftText,
      "right",
      entry.rightText,
      hashSeed(entry.fixtureId) + 7919, // 不同 seed
    );

    // ── 方向一致性 ──────────────────────────────────────────────────
    const consistent = result1.majorityWinner === entry.humanWinner;

    // ── 反转一致性：round 1 vs round 2 resolved winner 一致 ─────────
    const resolved1 = resolveRoundWinner(result1.rounds[0], "left", "right");
    const resolved2 = resolveRoundWinner(result1.rounds[1], "left", "right");
    const reverseConsistent = resolved1 === resolved2;

    // ── 重复一致性：两次 judgePairwise majorityWinner 一致 ───────────
    const repeatConsistent =
      result1.majorityWinner === result2.majorityWinner;

    // ── 事实硬伤漏判 ────────────────────────────────────────────────
    let hardFactMissed = false;
    if (entry.expectedHardFactRisk === true) {
      // 取第一次运行的 finalVerdict.hardFactRisk
      hardFactMissed = !result1.finalVerdict.hardFactRisk;
    }

    // ── 无引用确定性结论 ────────────────────────────────────────────
    let noCitationDefinitive = false;
    if (result1.finalVerdict.winner !== "tie") {
      const validation = validateJudgeVerdict(
        result1.finalVerdict,
        entry.leftText,
        entry.rightText,
      );
      noCitationDefinitive = !validation.valid;
    }

    details.push({
      fixtureId: entry.fixtureId,
      pair: entry.pair,
      humanWinner: entry.humanWinner,
      llmWinner: result1.majorityWinner,
      consistent,
      reverseConsistent,
      repeatConsistent,
      hardFactMissed,
      noCitationDefinitive,
    });
  }

  // ── 聚合指标 ──────────────────────────────────────────────────────
  const total = details.length;
  const directionConsistency = total > 0
    ? details.filter((d) => d.consistent).length / total
    : 0;
  const reverseConsistency = total > 0
    ? details.filter((d) => d.reverseConsistent).length / total
    : 0;
  const repeatConsistency = total > 0
    ? details.filter((d) => d.repeatConsistent).length / total
    : 0;

  const hardFactExpected = details.filter(
    (d) => d.hardFactMissed !== undefined,
  );
  // hardFactMissRate = 漏判数 / 期望有硬伤的 entry 数
  const hardFactMissedCount = details.filter((d) => d.hardFactMissed).length;
  const hardFactExpectedCount = calibrationSet.filter(
    (e) => e.expectedHardFactRisk === true,
  ).length;
  const hardFactMissRate = hardFactExpectedCount > 0
    ? hardFactMissedCount / hardFactExpectedCount
    : 0;

  const definitiveCount = details.filter((d) => d.noCitationDefinitive !== undefined && d.llmWinner !== "tie").length;
  const noCitationCount = details.filter((d) => d.noCitationDefinitive).length;
  const noCitationDefinitiveRate = definitiveCount > 0
    ? noCitationCount / definitiveCount
    : 0;

  // ── 门槛检查 ──────────────────────────────────────────────────────
  const passed =
    directionConsistency >= CALIBRATION_THRESHOLDS.directionConsistency &&
    reverseConsistency >= CALIBRATION_THRESHOLDS.reverseConsistency &&
    repeatConsistency >= CALIBRATION_THRESHOLDS.repeatConsistency &&
    hardFactMissRate <= CALIBRATION_THRESHOLDS.hardFactMissRate &&
    noCitationDefinitiveRate <= CALIBRATION_THRESHOLDS.noCitationDefinitiveRate;

  return {
    directionConsistency,
    reverseConsistency,
    repeatConsistency,
    hardFactMissRate,
    noCitationDefinitiveRate,
    passed,
    details,
    thresholds: CALIBRATION_THRESHOLDS,
    totalEntries: total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从一轮结果解析物理 winner。
 */
function resolveRoundWinner(
  round: { mapping: { leftLabel: "A" | "B" }; verdict: { winner: "A" | "B" | "tie" } },
  leftId: string,
  rightId: string,
): "left" | "right" | "tie" {
  if (round.verdict.winner === "tie") return "tie";
  // mapping.leftLabel === "A" → left 候选被标为 A
  // verdict.winner === "A" → A 标签胜 → left 胜
  // mapping.leftLabel === "B" → left 候选被标为 B
  // verdict.winner === "A" → A 标签胜 → right 胜（因为 right 被标为 A）
  if (round.mapping.leftLabel === "A") {
    return round.verdict.winner === "A" ? "left" : "right";
  } else {
    return round.verdict.winner === "B" ? "left" : "right";
  }
}

/**
 * 简单字符串 hash → seed（可复现）。
 */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 校准集加载
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 JSON 文件加载校准集。
 * 支持计划 §8.1 格式：{ calibrationSet: [...] }
 */
export async function loadCalibrationSet(
  filePath: string,
): Promise<CalibrationSet> {
  const { readFileSync } = await import("node:fs");
  const content = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content) as CalibrationSet;
  if (!parsed.calibrationSet || !Array.isArray(parsed.calibrationSet)) {
    throw new Error(
      `校准集格式错误：缺少 calibrationSet 数组（${filePath}）`,
    );
  }
  return parsed;
}

/**
 * 格式化校准结果为 Markdown 报告。
 */
export function formatCalibrationResultAsMarkdown(
  result: CalibrationResult,
): string {
  const lines: string[] = [];
  lines.push("# NovelOS 裁判校准结果（P1-5）");
  lines.push("");
  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | 值 | 门槛 | 通过 |");
  lines.push("|------|-----|------|------|");
  lines.push(
    `| directionConsistency | ${result.directionConsistency.toFixed(2)} | ≥${result.thresholds.directionConsistency} | ${result.directionConsistency >= result.thresholds.directionConsistency ? "✓" : "✗"} |`,
  );
  lines.push(
    `| reverseConsistency | ${result.reverseConsistency.toFixed(2)} | ≥${result.thresholds.reverseConsistency} | ${result.reverseConsistency >= result.thresholds.reverseConsistency ? "✓" : "✗"} |`,
  );
  lines.push(
    `| repeatConsistency | ${result.repeatConsistency.toFixed(2)} | ≥${result.thresholds.repeatConsistency} | ${result.repeatConsistency >= result.thresholds.repeatConsistency ? "✓" : "✗"} |`,
  );
  lines.push(
    `| hardFactMissRate | ${result.hardFactMissRate.toFixed(2)} | ≤${result.thresholds.hardFactMissRate} | ${result.hardFactMissRate <= result.thresholds.hardFactMissRate ? "✓" : "✗"} |`,
  );
  lines.push(
    `| noCitationDefinitiveRate | ${result.noCitationDefinitiveRate.toFixed(2)} | =${result.thresholds.noCitationDefinitiveRate} | ${result.noCitationDefinitiveRate <= result.thresholds.noCitationDefinitiveRate ? "✓" : "✗"} |`,
  );
  lines.push("");
  lines.push(`**总条目数**：${result.totalEntries}`);
  lines.push(`**校准结果**：${result.passed ? "✓ PASSED（可用于 go_candidate）" : "✗ FAILED（只能作为辅助评审）"}`);
  lines.push("");
  lines.push("## 各条目详情");
  lines.push("");
  lines.push("| fixtureId | pair | 人工 winner | LLM winner | 方向一致 | 反转一致 | 重复一致 | 硬伤漏判 | 无引用 |");
  lines.push("|-----------|------|------------|-----------|---------|---------|---------|---------|--------|");
  for (const d of result.details) {
    lines.push(
      `| ${d.fixtureId} | ${d.pair} | ${d.humanWinner} | ${d.llmWinner} | ${d.consistent ? "✓" : "✗"} | ${d.reverseConsistent ? "✓" : "✗"} | ${d.repeatConsistent ? "✓" : "✗"} | ${d.hardFactMissed ? "✗" : "—"} | ${d.noCitationDefinitive ? "✗" : "—"} |`,
    );
  }
  return lines.join("\n");
}
