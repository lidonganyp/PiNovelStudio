/**
 * 不确定性驱动检索消融实验：报告与盲测包生成（从 uncertainty-driven-ablation.ts 提取）
 *
 * 纯函数模块：从 AblationResult 生成 Markdown 对比报告和匿名盲测包。
 * 不调用模型 API，不依赖 workspace fixture。
 *
 * 授权边界：eval-only 模块，tsconfig.eval.json 注册。
 */

import type { AblationResult } from "./uncertainty-driven-ablation.js";

// ============================================================================
// 对比报告生成
// ============================================================================

/**
 * 从 AblationResult 生成 Markdown 对比报告。
 *
 * 包含：聚合指标对比表、每 case 明细、最低通过条件判定。
 */
export function generateComparisonReport(result: AblationResult): string {
  const lines: string[] = [];
  lines.push("# 不确定性驱动检索决策 A/B 对照实验报告");
  lines.push("");
  lines.push(`**Run ID**：${result.runId}`);
  lines.push(`**时间**：${result.timestamp}`);
  lines.push(`**Case 数**：${result.cases.length}`);
  lines.push("");

  // 聚合指标对比表
  lines.push("## 聚合指标对比");
  lines.push("");
  lines.push("| 指标 | A 组（强制检索） | B 组（不确定性驱动） | 差异 |");
  lines.push("|------|-------------------|----------------------|------|");
  const a = result.aggregate.armA;
  const b = result.aggregate.armB;
  lines.push(
    `| 成功率 | ${a.successCount}/${result.cases.length} | ${b.successCount}/${result.cases.length} | ${b.successCount - a.successCount >= 0 ? "+" : ""}${b.successCount - a.successCount} |`,
  );
  lines.push(
    `| 平均工具调用次数 | ${a.avgToolCalls.toFixed(2)} | ${b.avgToolCalls.toFixed(2)} | ${b.avgToolCalls - a.avgToolCalls >= 0 ? "+" : ""}${(b.avgToolCalls - a.avgToolCalls).toFixed(2)} |`,
  );
  lines.push(
    `| 平均 sourceRefs 数 | ${a.avgSourceRefs.toFixed(2)} | ${b.avgSourceRefs.toFixed(2)} | ${b.avgSourceRefs - a.avgSourceRefs >= 0 ? "+" : ""}${(b.avgSourceRefs - a.avgSourceRefs).toFixed(2)} |`,
  );
  lines.push(
    `| 平均 FactGuard 硬错误 | ${a.avgFactGuardErrors.toFixed(2)} | ${b.avgFactGuardErrors.toFixed(2)} | ${b.avgFactGuardErrors - a.avgFactGuardErrors >= 0 ? "+" : ""}${(b.avgFactGuardErrors - a.avgFactGuardErrors).toFixed(2)} |`,
  );
  lines.push(
    `| 平均生成延迟 (ms) | ${a.avgDurationMs.toFixed(0)} | ${b.avgDurationMs.toFixed(0)} | ${b.avgDurationMs - a.avgDurationMs >= 0 ? "+" : ""}${(b.avgDurationMs - a.avgDurationMs).toFixed(0)} |`,
  );
  lines.push(
    `| 完整性通过率 | ${(a.completenessPassRate * 100).toFixed(1)}% | ${(b.completenessPassRate * 100).toFixed(1)}% | |`,
  );
  lines.push(
    `| 无关证据比例（近似） | ${(a.avgIrrelevantEvidenceRatio * 100).toFixed(1)}% | ${(b.avgIrrelevantEvidenceRatio * 100).toFixed(1)}% | ${b.avgIrrelevantEvidenceRatio - a.avgIrrelevantEvidenceRatio >= 0 ? "+" : ""}${((b.avgIrrelevantEvidenceRatio - a.avgIrrelevantEvidenceRatio) * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| token 输入总量 | ${a.totalTokenIn} | ${b.totalTokenIn} | ${a.totalTokenIn === "unknown" || b.totalTokenIn === "unknown" ? "(部分 unknown)" : ""} |`,
  );
  lines.push(
    `| token 输出总量 | ${a.totalTokenOut} | ${b.totalTokenOut} | ${a.totalTokenOut === "unknown" || b.totalTokenOut === "unknown" ? "(部分 unknown)" : ""} |`,
  );
  // Step 4 新增聚合指标：gate 通过率 / 阻断率 / 重试率 / P0 召回率
  lines.push(
    `| gate 通过率（FactGuard=0 ∧ 完整性通过） | ${(a.gatePassRate * 100).toFixed(1)}% | ${(b.gatePassRate * 100).toFixed(1)}% | ${((b.gatePassRate - a.gatePassRate) * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| 阻断率（success=false） | ${(a.blockRate * 100).toFixed(1)}% | ${(b.blockRate * 100).toFixed(1)}% | ${((b.blockRate - a.blockRate) * 100).toFixed(1)}% |`,
  );
  lines.push(
    `| 平均修复轮数（repairRounds） | ${a.avgRepairRounds.toFixed(2)} | ${b.avgRepairRounds.toFixed(2)} | ${b.avgRepairRounds - a.avgRepairRounds >= 0 ? "+" : ""}${(b.avgRepairRounds - a.avgRepairRounds).toFixed(2)} |`,
  );
  lines.push(
    `| P0 召回率（高风险 case mustVerify 覆盖率，${a.highRiskCaseCount} cases） | ${(a.avgMustVerifyCoverage * 100).toFixed(1)}% | ${(b.avgMustVerifyCoverage * 100).toFixed(1)}% | ${((b.avgMustVerifyCoverage - a.avgMustVerifyCoverage) * 100).toFixed(1)}% |`,
  );
  lines.push("");

  // 每 case 明细
  lines.push("## 每 Case 明细");
  lines.push("");
  for (const c of result.cases) {
    lines.push(`### ${c.caseId}`);
    lines.push("");
    lines.push("| 指标 | A 组 | B 组 |");
    lines.push("|------|------|------|");
    lines.push(`| success | ${c.armA.metrics.success} | ${c.armB.metrics.success} |`);
    lines.push(`| textLength | ${c.armA.metrics.textLength} | ${c.armB.metrics.textLength} |`);
    lines.push(`| toolCalls | ${c.armA.metrics.toolCalls} | ${c.armB.metrics.toolCalls} |`);
    lines.push(`| repairRounds | ${c.armA.metrics.repairRounds} | ${c.armB.metrics.repairRounds} |`);
    lines.push(`| sourceRefsCount | ${c.armA.metrics.sourceRefsCount} | ${c.armB.metrics.sourceRefsCount} |`);
    lines.push(`| mustVerifyCount | ${c.armA.metrics.mustVerifyCount} | ${c.armB.metrics.mustVerifyCount} |`);
    lines.push(`| mustVerifyCoverage | ${(c.armA.metrics.mustVerifyCoverage * 100).toFixed(1)}% | ${(c.armB.metrics.mustVerifyCoverage * 100).toFixed(1)}% |`);
    lines.push(`| riskLevel | ${c.armA.metrics.riskLevel} | ${c.armB.metrics.riskLevel} |`);
    lines.push(`| factGuardErrors | ${c.armA.metrics.factGuardErrors} | ${c.armB.metrics.factGuardErrors} |`);
    lines.push(`| completenessPassed | ${c.armA.metrics.completenessPassed} | ${c.armB.metrics.completenessPassed} |`);
    lines.push(`| irrelevantEvidenceRatio | ${c.armA.metrics.irrelevantEvidenceRatio.toFixed(3)} | ${c.armB.metrics.irrelevantEvidenceRatio.toFixed(3)} |`);
    lines.push(`| durationMs | ${c.armA.metrics.durationMs} | ${c.armB.metrics.durationMs} |`);
    lines.push(`| tokenIn | ${c.armA.metrics.tokenIn} | ${c.armB.metrics.tokenIn} |`);
    lines.push(`| tokenOut | ${c.armA.metrics.tokenOut} | ${c.armB.metrics.tokenOut} |`);
    lines.push(`| selectedSource | ${c.armA.metrics.selectedSource} | ${c.armB.metrics.selectedSource} |`);
    if (c.armA.metrics.failureReason || c.armB.metrics.failureReason) {
      lines.push(`| failureReason | ${c.armA.metrics.failureReason ?? ""} | ${c.armB.metrics.failureReason ?? ""} |`);
    }
    lines.push("");
  }

  // 最低通过条件判定
  lines.push("## 最低通过条件判定");
  lines.push("");
  lines.push(`- B 组事实硬伤 ≤ A 组：${result.passCriteria.factGuardNotWorse ? "✓ PASS" : "✗ FAIL"}`);
  lines.push(`- B 组工具调用次数 < A 组：${result.passCriteria.toolCallsReduced ? "✓ PASS" : "✗ FAIL"}`);
  // Step 1：recallNotWorse 三态显示
  const recallDisplay = result.passCriteria.recallNotWorse === "pass"
    ? "✓ PASS"
    : result.passCriteria.recallNotWorse === "unmeasured"
      ? "? UNMEASURED（召回率未测量，需 Step 2 修复 fixture 后重跑）"
      : "✗ FAIL";
  lines.push(`- B 组必需事实召回率 ≥ A 组：${recallDisplay}`);
  if (result.passCriteria.recallUnmeasuredReason) {
    lines.push(`  - 原因：${result.passCriteria.recallUnmeasuredReason}`);
  }
  lines.push("");
  lines.push(`**总体判定**：${result.passCriteria.overallPassed ? "✓ PASS（可考虑更大规模 replay）" : "✗ FAIL（需调整后再实验）"}`);
  lines.push("");
  lines.push("> 注意：人工盲测的自然度和叙事完成度由用户通过 blind-pack.json 盲测后裁决。");
  lines.push("> token 成本指标存在 unknown gap（部分路径 tokenUsage 仍为 \"unknown\"），需后续修复透传。");

  return lines.join("\n");
}

// ============================================================================
// 盲测包生成
// ============================================================================

export interface BlindPackEntry {
  /** 匿名 ID（A/B 随机映射，不暴露 arm 身份） */
  anonymousId: string;
  caseId: string;
  text: string;
}

export interface BlindPack {
  runId: string;
  timestamp: string;
  /** 匿名映射（仅记录映射关系，盲测时不应查看） */
  mapping: Record<string, { caseId: string; arm: "A" | "B" }>;
  entries: BlindPackEntry[];
  instructions: string;
}

/**
 * 从 AblationResult 生成匿名盲测包。
 *
 * 每 case 的 A/B 文本随机映射为 X/Y，不暴露 arm 身份。
 * mapping 记录映射关系，盲测完成后查看确认。
 */
export function generateBlindPack(result: AblationResult): BlindPack {
  const entries: BlindPackEntry[] = [];
  const mapping: Record<string, { caseId: string; arm: "A" | "B" }> = {};

  for (const c of result.cases) {
    // 随机映射 A/B → X/Y（每 case 独立随机）
    const aIsX = Math.random() < 0.5;
    const xId = `X-${c.caseId}`;
    const yId = `Y-${c.caseId}`;

    if (aIsX) {
      mapping[xId] = { caseId: c.caseId, arm: "A" };
      mapping[yId] = { caseId: c.caseId, arm: "B" };
    } else {
      mapping[xId] = { caseId: c.caseId, arm: "B" };
      mapping[yId] = { caseId: c.caseId, arm: "A" };
    }

    entries.push({
      anonymousId: xId,
      caseId: c.caseId,
      text: aIsX ? c.armA.v2Output.text ?? "" : c.armB.v2Output.text ?? "",
    });
    entries.push({
      anonymousId: yId,
      caseId: c.caseId,
      text: aIsX ? c.armB.v2Output.text ?? "" : c.armA.v2Output.text ?? "",
    });
  }

  return {
    runId: result.runId,
    timestamp: result.timestamp,
    mapping,
    entries,
    instructions: [
      "盲测说明：",
      "1. 每个 case 有两个匿名文本（X 和 Y），分别来自 A 组（强制检索）和 B 组（不确定性驱动）。",
      "2. 请逐 case 阅读两个文本，从以下维度评分（1-5 分）：",
      "   - 自然度（中文表达是否自然、无 AI 腔）",
      "   - 叙事完成度（情节是否完整、是否有明显遗漏）",
      "   - 事实准确性（是否有事实硬伤、人物状态错误）",
      "3. 对每对 X/Y 选择「更优」或「平局」。",
      "4. 评分完成后，查看 mapping 确认 X/Y 对应的 A/B 身份。",
      "5. 最低通过条件：B 组文学质量不下降（B 组胜率 ≥ 40% 或平局为主）。",
    ].join("\n"),
  };
}
