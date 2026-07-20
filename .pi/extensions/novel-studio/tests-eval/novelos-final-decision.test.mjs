/**
 * NovelOS 最终决策测试（P1-6）
 *
 * 测试 makeFinalDecision 的决策规则（纯函数，无需 mock）。
 *
 * 验证：
 * - GO_CANDIDATE：5 核心条件全过 + 无触发条件
 * - NEEDS_HUMAN_REVIEW：各种触发条件（llmDisagreement/positionSensitive/lowConfidence/verifierLlmConflict/isNewVersion）
 * - HOLD：机制 + pairwise 通过但其他条件未过
 * - NO_GO：pairwise 负收益或机制未过
 * - conditions 数组结构完整
 * - formatFinalDecisionAsMarkdown 含关键章节
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
// novelos/eval/* 模块是 dormant-from-prod（PROD-BUILD-BOUNDARY-1 后退出生产构建），
// 只存在于 dist-eval/novelos/eval/。生产 dist/novelos/ 不含 eval 子目录。
const DIST_ROOT = join(EXTENSION_ROOT, "dist-eval");

const finalDecisionUrl = pathToFileURL(
  join(DIST_ROOT, "novelos", "eval", "final-decision.js"),
).href;

const {
  makeFinalDecision,
  formatFinalDecisionAsMarkdown,
} = await import(finalDecisionUrl);

// ============================================================================
// 基准参数（全过）
// ============================================================================

function allPassParams() {
  return {
    mechanismEvalPassed: true,
    requiredFactsPassed: true,
    wrongRetrievalPassed: true,
    llmPairwiseNoNegative: true,
    calibrationPassed: true,
    llmDisagreement: false,
    positionSensitive: false,
    lowConfidence: false,
    verifierLlmConflict: false,
    isNewVersion: false,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS 最终决策（P1-6）", () => {
  test("5 核心条件全过 + 无触发 → GO_CANDIDATE", () => {
    const decision = makeFinalDecision(allPassParams());
    assert.equal(decision.decision, "GO_CANDIDATE");
    assert.equal(decision.conditions.length, 5);
    assert.ok(decision.conditions.every((c) => c.passed));
    assert.ok(decision.reasons.some((r) => r.includes("GO_CANDIDATE")));
    assert.ok(
      decision.reasons.some((r) => r.includes("人工抽样复核")),
      "应提示需人工抽样复核",
    );
  });

  test("llmDisagreement → NEEDS_HUMAN_REVIEW", () => {
    const params = { ...allPassParams(), llmDisagreement: true };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW");
    assert.ok(decision.reasons.some((r) => r.includes("LLM 调用分歧")));
  });

  test("positionSensitive → NEEDS_HUMAN_REVIEW", () => {
    const params = { ...allPassParams(), positionSensitive: true };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW");
    assert.ok(decision.reasons.some((r) => r.includes("顺序敏感")));
  });

  test("lowConfidence → NEEDS_HUMAN_REVIEW", () => {
    const params = { ...allPassParams(), lowConfidence: true };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW");
    assert.ok(decision.reasons.some((r) => r.includes("置信度不足")));
  });

  test("verifierLlmConflict → NEEDS_HUMAN_REVIEW", () => {
    const params = { ...allPassParams(), verifierLlmConflict: true };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW");
    assert.ok(decision.reasons.some((r) => r.includes("verifier 与 LLM 冲突")));
  });

  test("isNewVersion → NEEDS_HUMAN_REVIEW", () => {
    const params = { ...allPassParams(), isNewVersion: true };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW");
    assert.ok(decision.reasons.some((r) => r.includes("新版本")));
  });

  test("多个触发条件同时存在 → NEEDS_HUMAN_REVIEW + 全部列出", () => {
    const params = {
      ...allPassParams(),
      llmDisagreement: true,
      positionSensitive: true,
      lowConfidence: true,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW");
    assert.ok(decision.reasons.some((r) => r.includes("LLM 调用分歧")));
    assert.ok(decision.reasons.some((r) => r.includes("顺序敏感")));
    assert.ok(decision.reasons.some((r) => r.includes("置信度不足")));
  });

  test("机制 + pairwise 通过但 calibration 未过 → HOLD", () => {
    const params = {
      ...allPassParams(),
      calibrationPassed: false,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "HOLD");
    assert.ok(decision.reasons.some((r) => r.includes("calibration_passed")));
  });

  test("机制 + pairwise 通过但 requiredFacts 未过 → HOLD", () => {
    const params = {
      ...allPassParams(),
      requiredFactsPassed: false,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "HOLD");
    assert.ok(decision.reasons.some((r) => r.includes("required_facts_passed")));
  });

  test("机制 + pairwise 通过但 wrongRetrieval 未过 → HOLD", () => {
    const params = {
      ...allPassParams(),
      wrongRetrievalPassed: false,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "HOLD");
  });

  test("pairwise 负收益 → NO_GO", () => {
    const params = {
      ...allPassParams(),
      llmPairwiseNoNegative: false,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NO_GO");
    assert.ok(decision.reasons.some((r) => r.includes("负收益")));
  });

  test("机制未过 + pairwise 负收益 → NO_GO", () => {
    const params = {
      ...allPassParams(),
      mechanismEvalPassed: false,
      llmPairwiseNoNegative: false,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NO_GO");
    assert.ok(decision.reasons.some((r) => r.includes("机制评测未过")));
    assert.ok(decision.reasons.some((r) => r.includes("负收益")));
  });

  test("机制未过但 pairwise 通过 → NO_GO（机制是前置条件）", () => {
    const params = {
      ...allPassParams(),
      mechanismEvalPassed: false,
      llmPairwiseNoNegative: true,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NO_GO");
    assert.ok(decision.reasons.some((r) => r.includes("机制评测未过")));
  });

  test("触发条件优先于核心条件（即使全过也 NEEDS_HUMAN_REVIEW）", () => {
    // 即使 5 核心条件全过，只要有触发条件 → NEEDS_HUMAN_REVIEW
    const params = {
      ...allPassParams(),
      positionSensitive: true,
    };
    const decision = makeFinalDecision(params);
    assert.equal(decision.decision, "NEEDS_HUMAN_REVIEW", "触发条件优先");
    assert.ok(decision.conditions.every((c) => c.passed), "条件仍记录为全过");
  });

  test("conditions 数组包含 5 项且结构完整", () => {
    const decision = makeFinalDecision(allPassParams());
    assert.equal(decision.conditions.length, 5);
    const expectedNames = [
      "mechanism_eval_passed",
      "required_facts_passed",
      "wrong_retrieval_passed",
      "llm_pairwise_no_negative",
      "calibration_passed",
    ];
    for (let i = 0; i < expectedNames.length; i++) {
      assert.equal(decision.conditions[i].name, expectedNames[i]);
      assert.ok(typeof decision.conditions[i].passed === "boolean");
      assert.ok(typeof decision.conditions[i].detail === "string");
      assert.ok(decision.conditions[i].detail.length > 0);
    }
  });

  test("formatFinalDecisionAsMarkdown 含关键章节", () => {
    const decision = makeFinalDecision(allPassParams());
    const md = formatFinalDecisionAsMarkdown(decision);
    assert.ok(md.includes("最终决策"), "应含标题");
    assert.ok(md.includes("GO_CANDIDATE"), "应含决策类型");
    assert.ok(md.includes("理由"), "应含理由章节");
    assert.ok(md.includes("条件检查"), "应含条件检查章节");
    assert.ok(md.includes("mechanism_eval_passed"), "应含条件名");
    assert.ok(md.includes("人工抽样复核"), "应含人工抽样复核提示");
  });

  test("formatFinalDecisionAsMarkdown NEEDS_HUMAN_REVIEW 场景", () => {
    const decision = makeFinalDecision({
      ...allPassParams(),
      positionSensitive: true,
    });
    const md = formatFinalDecisionAsMarkdown(decision);
    assert.ok(md.includes("NEEDS_HUMAN_REVIEW"));
    assert.ok(md.includes("顺序敏感"));
  });
});
