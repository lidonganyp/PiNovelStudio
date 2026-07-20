/**
 * EDITORIAL-BENEFIT-2A — advisory on/off 消融预登记与本地 harness 测试
 *
 * 验收口径（docs/remaining-development-dispatch-plan-20260715.md §3 P0-E）：
 * - objective: 在不调用模型的前提下冻结单 case evidence advisory on/off 消融协议
 * - scope: task packet、同 raw/model/seed/provenance 约束、调用预算、排除规则、
 *          judge + human 决策 schema
 * - acceptance: 预登记 case、唯一变量、停止条件、最大调用数、fallback/no-candidate 排除、
 *               span response 和 regression 字段齐全
 * - negative verification: 不允许事后换 case/阈值；单裁判不算正向；
 *                          无自然人或 validated_human_proxy verdict 不得完成 2C
 * - recovery: harness 校验失败不调用模型；结果不清晰保留 raw
 * - reporting: preregistration artifact、dry-run、schema tests、授权前检查表
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不生成章节、不提交状态
 * - 预登记 artifact 一旦冻结不可变（case/阈值/预算事后不可换）
 * - dry-run harness 只校验协议完备性，不执行真实消融
 * - 单裁判不算正向；2C 必须有自然人或 validated_human_proxy verdict
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  EDITORIAL_BENEFIT_PREREG_SCHEMA_ID,
  EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION,
  validatePreregistrationArtifact,
  runEditorialBenefit2aDryRun,
  buildPreAuthorizationChecklist,
} from "../dist-eval/v2/core/editorial-benefit-2a-preregistration.js";

// ============================================================================
// Fixture builders
// ============================================================================

function makeCaseProvenance(overrides = {}) {
  return {
    caseId: "case-a",
    sourcePath: "/data/novelbench/demo-3/case-a.jsonl",
    sourceSha256: "a".repeat(64),
    sizeBytes: 1024,
    orchestratorRunId: "run-2a-frozen-001",
    workspaceId: "xinmo",
    layer: "B2",
    ...overrides,
  };
}

function makeArmConstraint(overrides = {}) {
  return {
    modelVersion: "glm-5.2",
    seed: 0,
    rawSourcePath: "/data/novelbench/demo-3/case-a-glm-r1/nb3r-v1-01727287bd911ec3-ch1106/B0.md",
    rawSha256: "b".repeat(64),
    provenance: {
      orchestratorRunId: "run-2a-frozen-001",
      caseId: "case-a",
      layer: "B2",
      workspaceId: "xinmo",
    },
    ...overrides,
  };
}

function makeExclusionRules(overrides = {}) {
  return {
    fallbackRunsExcluded: true,
    noCandidateRunsExcluded: true,
    hardBlockRunsExcluded: true,
    fallbackReason: "raw/legacy fallback 不构成 advisory 公平比较",
    noCandidateReason: "advisory_off 臂未产出 candidate 不计为任何一方正向",
    hardBlockReason: "FactGuard hard block 是安全信号，非质量信号",
    ...overrides,
  };
}

function makeStopConditions(overrides = {}) {
  return {
    bothArmsCompleteWithValidCandidate: true,
    callBudgetExhausted: true,
    modelExceptionOrTimeout: true,
    hardBlockOnBothArms: true,
    ...overrides,
  };
}

function makeCallBudget(overrides = {}) {
  return {
    maxCallsPerArm: 3,
    maxRawCallsPerArm: 1,
    maxEditorialCandidatesPerArm: 2,
    totalBudgetAcrossArms: 6,
    ...overrides,
  };
}

function makeJudgeDecisionSchema(overrides = {}) {
  return {
    requiredFields: ["preference", "winningSpans", "losingSpans", "rationale", "dimensions", "anonymousMapping"],
    preferenceEnum: ["editorial", "raw", "tie", "undecided"],
    spanResponseRequired: true,
    spanFields: ["side", "excerpt", "dimension", "explanation"],
    dimensionsRequired: 5,
    reverseReviewRequired: true,
    ...overrides,
  };
}

function makeHumanDecisionSchema(overrides = {}) {
  return {
    requiredFields: ["reviewerType", "reviewerModel", "humanEquivalent", "preference", "winningSpans", "rationale"],
    allowedReviewerTypes: ["natural_person", "validated_human_proxy"],
    validatedProxyModel: "gpt5.6-sol",
    spanResponseRequired: true,
    ...overrides,
  };
}

function makeRegressionFields(overrides = {}) {
  return {
    mustPreserveAcrossArms: [
      "modelVersion",
      "seed",
      "rawSha256",
      "caseId",
      "orchestratorRunId",
      "workspaceId",
    ],
    ...overrides,
  };
}

function makePositiveSignalCriteria(overrides = {}) {
  return {
    singleJudgeNotPositive: true,
    requiresHumanOrProxy: true,
    coSupportRequired: true,
    coSupportDefinition: "judge + (natural_person 或 validated_human_proxy) 共同支持同一臂才算正向",
    unclearRetainsRaw: true,
    ...overrides,
  };
}

function makePreregistration(overrides = {}) {
  return {
    schemaId: EDITORIAL_BENEFIT_PREREG_SCHEMA_ID,
    schemaVersion: EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION,
    taskId: "EDITORIAL-BENEFIT-2A",
    frozenAt: "2026-07-15T10:00:00Z",
    frozenBy: "EDITORIAL-BENEFIT-2A",
    mutationPolicy: "immutable-after-freeze",
    caseProvenance: makeCaseProvenance(),
    onlyVariable: "advisory_on_off",
    arms: {
      advisory_on: {
        advisoryEnabled: true,
        constraint: makeArmConstraint(),
      },
      advisory_off: {
        advisoryEnabled: false,
        constraint: makeArmConstraint(),
      },
    },
    callBudget: makeCallBudget(),
    exclusionRules: makeExclusionRules(),
    stopConditions: makeStopConditions(),
    decisionSchema: {
      judge: makeJudgeDecisionSchema(),
      human: makeHumanDecisionSchema(),
    },
    regressionFields: makeRegressionFields(),
    positiveSignalCriteria: makePositiveSignalCriteria(),
    ...overrides,
  };
}

// ============================================================================
// 0. schema 常量与导出契约
// ============================================================================

test("EDITORIAL-BENEFIT-2A: schema 常量导出", () => {
  assert.equal(EDITORIAL_BENEFIT_PREREG_SCHEMA_ID, "pinovel.editorial-benefit-preregistration");
  assert.equal(EDITORIAL_BENEFIT_PREREG_SCHEMA_VERSION, "v1");
});

test("EDITORIAL-BENEFIT-2A: validatePreregistrationArtifact 是函数", () => {
  assert.equal(typeof validatePreregistrationArtifact, "function");
});

test("EDITORIAL-BENEFIT-2A: runEditorialBenefit2aDryRun 是函数", () => {
  assert.equal(typeof runEditorialBenefit2aDryRun, "function");
});

test("EDITORIAL-BENEFIT-2A: buildPreAuthorizationChecklist 是函数", () => {
  assert.equal(typeof buildPreAuthorizationChecklist, "function");
});

// ============================================================================
// 1. 合法 artifact 通过校验
// ============================================================================

test("合法 preregistration artifact 通过校验", () => {
  const result = validatePreregistrationArtifact(makePreregistration());
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  assert.equal(result.artifact.schemaId, "pinovel.editorial-benefit-preregistration");
  assert.equal(result.artifact.schemaVersion, "v1");
});

test("artifact 必须是对象", () => {
  const result = validatePreregistrationArtifact("not-an-object");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_root");
});

test("schemaId 必须是固定值", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ schemaId: "wrong.schema" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_schema_id");
});

test("schemaVersion 必须是 v1", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ schemaVersion: "v999" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_schema_version");
  assert.equal("artifact" in result, false);
});

test("taskId 必须是 EDITORIAL-BENEFIT-2A", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ taskId: "WRONG-TASK" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "taskId");
});

test("mutationPolicy 必须是 immutable-after-freeze", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ mutationPolicy: "mutable" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "mutationPolicy");
});

// ============================================================================
// 2. case provenance 冻结（不允许事后换 case）
// ============================================================================

test("caseProvenance 必须含 caseId/sourcePath/sourceSha256/sizeBytes", () => {
  const broken = makePreregistration();
  delete broken.caseProvenance.caseId;
  const result = validatePreregistrationArtifact(broken);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "caseProvenance.caseId");
});

test("sourceSha256 必须是 64 位 hex", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      caseProvenance: makeCaseProvenance({ sourceSha256: "short-hash" }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "caseProvenance.sourceSha256");
});

test("sizeBytes 必须是正整数", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      caseProvenance: makeCaseProvenance({ sizeBytes: 0 }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "caseProvenance.sizeBytes");
});

test("layer 必须是 B0-B4 之一", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      caseProvenance: makeCaseProvenance({ layer: "B9" }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "caseProvenance.layer");
});

// ============================================================================
// 3. 唯一变量（advisory on/off）
// ============================================================================

test("onlyVariable 必须是 advisory_on_off", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ onlyVariable: "model_choice" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "onlyVariable");
});

test("arms 必须同时含 advisory_on 和 advisory_off", () => {
  const broken = makePreregistration();
  delete broken.arms.advisory_off;
  const result = validatePreregistrationArtifact(broken);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "arms.advisory_off");
});

test("advisory_on 臂必须 advisoryEnabled=true", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: { advisoryEnabled: false, constraint: makeArmConstraint() },
        advisory_off: { advisoryEnabled: false, constraint: makeArmConstraint() },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "arms.advisory_on.advisoryEnabled");
});

test("advisory_off 臂必须 advisoryEnabled=false", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: { advisoryEnabled: true, constraint: makeArmConstraint() },
        advisory_off: { advisoryEnabled: true, constraint: makeArmConstraint() },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "arms.advisory_off.advisoryEnabled");
});

test("两臂必须共享相同 modelVersion（同 raw/model/seed/provenance 约束）", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: {
          advisoryEnabled: true,
          constraint: makeArmConstraint({ modelVersion: "glm-5.2" }),
        },
        advisory_off: {
          advisoryEnabled: false,
          constraint: makeArmConstraint({ modelVersion: "doubao-2.1" }),
        },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "arm_constraint_divergence");
});

test("两臂必须共享相同 seed", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: { advisoryEnabled: true, constraint: makeArmConstraint({ seed: 0 }) },
        advisory_off: { advisoryEnabled: false, constraint: makeArmConstraint({ seed: 1 }) },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "arm_constraint_divergence");
});

test("两臂必须共享相同 rawSha256", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: {
          advisoryEnabled: true,
          constraint: makeArmConstraint({ rawSha256: "c".repeat(64) }),
        },
        advisory_off: {
          advisoryEnabled: false,
          constraint: makeArmConstraint({ rawSha256: "d".repeat(64) }),
        },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "arm_constraint_divergence");
});

test("两臂必须共享相同 provenance.orchestratorRunId", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: {
          advisoryEnabled: true,
          constraint: makeArmConstraint({
            provenance: { orchestratorRunId: "run-A", caseId: "case-a", layer: "B2", workspaceId: "xinmo" },
          }),
        },
        advisory_off: {
          advisoryEnabled: false,
          constraint: makeArmConstraint({
            provenance: { orchestratorRunId: "run-B", caseId: "case-a", layer: "B2", workspaceId: "xinmo" },
          }),
        },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "arm_constraint_divergence");
});

// ============================================================================
// 4. 调用预算
// ============================================================================

test("callBudget.maxCallsPerArm 必须是正整数", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ callBudget: makeCallBudget({ maxCallsPerArm: 0 }) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "callBudget.maxCallsPerArm");
});

test("callBudget.totalBudgetAcrossArms 必须 >= 2 * maxCallsPerArm", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      callBudget: makeCallBudget({ maxCallsPerArm: 3, totalBudgetAcrossArms: 5 }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "budget_inconsistent");
});

test("callBudget.maxEditorialCandidatesPerArm 不得超过单章 hard cap 2", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      callBudget: makeCallBudget({ maxEditorialCandidatesPerArm: 3 }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "budget_inconsistent");
});

// ============================================================================
// 5. 排除规则（fallback/no-candidate/hard-block）
// ============================================================================

test("exclusionRules 必须含 fallback/no-candidate/hard-block 三类", () => {
  const broken = makePreregistration();
  delete broken.exclusionRules.fallbackRunsExcluded;
  const result = validatePreregistrationArtifact(broken);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "exclusionRules.fallbackRunsExcluded");
});

test("exclusionRules.noCandidateRunsExcluded 必须为 true（acceptance 强制）", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      exclusionRules: makeExclusionRules({ noCandidateRunsExcluded: false }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "exclusionRules.noCandidateRunsExcluded");
});

test("exclusionRules 必须含文字理由", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      exclusionRules: makeExclusionRules({ fallbackReason: "" }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "exclusionRules.fallbackReason");
});

// ============================================================================
// 6. 停止条件
// ============================================================================

test("stopConditions 必须含四类停止条件", () => {
  const broken = makePreregistration();
  delete broken.stopConditions.callBudgetExhausted;
  const result = validatePreregistrationArtifact(broken);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "stopConditions.callBudgetExhausted");
});

test("stopConditions 至少一个为 true（否则永不停止）", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      stopConditions: {
        bothArmsCompleteWithValidCandidate: false,
        callBudgetExhausted: false,
        modelExceptionOrTimeout: false,
        hardBlockOnBothArms: false,
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "stop_conditions_empty");
});

// ============================================================================
// 7. judge + human 决策 schema（span response）
// ============================================================================

test("decisionSchema.judge.requiredFields 必须含 span response 字段", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      decisionSchema: {
        judge: makeJudgeDecisionSchema({ requiredFields: ["preference"] }),
        human: makeHumanDecisionSchema(),
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "decisionSchema.judge.requiredFields");
});

test("decisionSchema.judge.spanResponseRequired 必须为 true", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      decisionSchema: {
        judge: makeJudgeDecisionSchema({ spanResponseRequired: false }),
        human: makeHumanDecisionSchema(),
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "decisionSchema.judge.spanResponseRequired");
});

test("decisionSchema.judge.dimensionsRequired 必须 >= 5（与 pairwise judge 一致）", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      decisionSchema: {
        judge: makeJudgeDecisionSchema({ dimensionsRequired: 3 }),
        human: makeHumanDecisionSchema(),
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "decisionSchema.judge.dimensionsRequired");
});

test("decisionSchema.human.allowedReviewerTypes 必须含 natural_person 和 validated_human_proxy", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      decisionSchema: {
        judge: makeJudgeDecisionSchema(),
        human: makeHumanDecisionSchema({ allowedReviewerTypes: ["natural_person"] }),
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "decisionSchema.human.allowedReviewerTypes");
});

test("decisionSchema.human.validatedProxyModel 必须是 gpt5.6-sol", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      decisionSchema: {
        judge: makeJudgeDecisionSchema(),
        human: makeHumanDecisionSchema({ validatedProxyModel: "gpt-4" }),
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "decisionSchema.human.validatedProxyModel");
});

// ============================================================================
// 8. regression 字段
// ============================================================================

test("regressionFields.mustPreserveAcrossArms 必须非空", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ regressionFields: makeRegressionFields({ mustPreserveAcrossArms: [] }) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "regressionFields.mustPreserveAcrossArms");
});

test("regressionFields.mustPreserveAcrossArms 必须含 modelVersion/seed/rawSha256/caseId", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      regressionFields: makeRegressionFields({
        mustPreserveAcrossArms: ["modelVersion", "seed"],
      }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "regression_fields_incomplete");
});

// ============================================================================
// 9. 正向信号准则（单裁判不算正向；需 human/proxy）
// ============================================================================

test("positiveSignalCriteria.singleJudgeNotPositive 必须为 true", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      positiveSignalCriteria: makePositiveSignalCriteria({ singleJudgeNotPositive: false }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "positiveSignalCriteria.singleJudgeNotPositive");
});

test("positiveSignalCriteria.requiresHumanOrProxy 必须为 true", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      positiveSignalCriteria: makePositiveSignalCriteria({ requiresHumanOrProxy: false }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "positiveSignalCriteria.requiresHumanOrProxy");
});

test("positiveSignalCriteria.coSupportRequired 必须为 true", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      positiveSignalCriteria: makePositiveSignalCriteria({ coSupportRequired: false }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "positiveSignalCriteria.coSupportRequired");
});

test("positiveSignalCriteria.unclearRetainsRaw 必须为 true（结果不清晰保留 raw）", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      positiveSignalCriteria: makePositiveSignalCriteria({ unclearRetainsRaw: false }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "positiveSignalCriteria.unclearRetainsRaw");
});

// ============================================================================
// 10. dry-run harness（不调用模型）
// ============================================================================

test("dry-run 合法 artifact 返回 ok 并通过所有检查", () => {
  const result = runEditorialBenefit2aDryRun(makePreregistration());
  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 0);
  assert.ok(result.checks.length > 0);
  // 不调用模型标记
  assert.equal(result.modelCalled, false);
});

test("dry-run 非法 artifact 返回 not ok 并列出 gaps", () => {
  const broken = makePreregistration();
  broken.positiveSignalCriteria.singleJudgeNotPositive = false;
  const result = runEditorialBenefit2aDryRun(broken);
  assert.equal(result.ok, false);
  assert.ok(result.gaps.length > 0);
  assert.equal(result.modelCalled, false);
});

test("dry-run case provenance 文件不存在时报告 gap（不调用模型）", () => {
  const result = runEditorialBenefit2aDryRun(
    makePreregistration({
      caseProvenance: makeCaseProvenance({
        sourcePath: "/nonexistent/path/case-a.jsonl",
      }),
    }),
    { checkCaseProvenanceExists: true }
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.gaps.some((g) => /case.*provenance.*不存在|sourcePath.*not.*exist/i.test(g.message)),
    `gaps should mention missing case provenance: ${JSON.stringify(result.gaps)}`
  );
  assert.equal(result.modelCalled, false);
});

test("dry-run case provenance 文件存在且 hash 匹配时通过", () => {
  const tmp = join(tmpdir(), `eb2a-dryrun-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const casePath = join(tmp, "case-a.jsonl");
  const content = '{"caseId":"case-a"}\n';
  writeFileSync(casePath, content, "utf-8");
  try {
    const sha = createHash("sha256").update(content, "utf-8").digest("hex");
    const result = runEditorialBenefit2aDryRun(
      makePreregistration({
        caseProvenance: makeCaseProvenance({
          sourcePath: casePath,
          sourceSha256: sha,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
        }),
      }),
      { checkCaseProvenanceExists: true }
    );
    assert.equal(result.ok, true, JSON.stringify(result.gaps));
    assert.equal(result.modelCalled, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dry-run case provenance 文件存在但 hash 不匹配时报告 gap", () => {
  const tmp = join(tmpdir(), `eb2a-hash-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const casePath = join(tmp, "case-a.jsonl");
  writeFileSync(casePath, '{"caseId":"case-a"}\n', "utf-8");
  try {
    const result = runEditorialBenefit2aDryRun(
      makePreregistration({
        caseProvenance: makeCaseProvenance({
          sourcePath: casePath,
          sourceSha256: "0".repeat(64),
        }),
      }),
      { checkCaseProvenanceExists: true }
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.gaps.some((g) => /sha-?256.*(不匹配|mismatch)|hash.*(不匹配|mismatch)/i.test(g.message)),
      `gaps should mention hash mismatch: ${JSON.stringify(result.gaps)}`
    );
    assert.equal(result.modelCalled, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dry-run 默认不检查 case provenance 文件存在性（避免在冻结环境误报）", () => {
  // 不传 checkCaseProvenanceExists 时，sourcePath 指向不存在文件也应通过
  // （2A 只冻结协议，不要求 case 文件在本地可访问；2B 真实运行时再校验）
  const result = runEditorialBenefit2aDryRun(
    makePreregistration({
      caseProvenance: makeCaseProvenance({
        sourcePath: "/nonexistent/path/case-a.jsonl",
      }),
    })
  );
  assert.equal(result.ok, true, JSON.stringify(result.gaps));
  assert.equal(result.modelCalled, false);
});

// ============================================================================
// 11. 授权前检查表
// ============================================================================

test("buildPreAuthorizationChecklist 返回结构化检查表", () => {
  const checklist = buildPreAuthorizationChecklist(makePreregistration());
  assert.ok(Array.isArray(checklist.items));
  assert.ok(checklist.items.length > 0);
  assert.ok(checklist.items.every((i) => "id" in i && "label" in i && "passed" in i));
});

test("授权前检查表必须含：case 冻结、唯一变量、停止条件、调用预算、排除规则、decision schema、regression 字段、正向信号准则", () => {
  const checklist = buildPreAuthorizationChecklist(makePreregistration());
  const ids = checklist.items.map((i) => i.id);
  assert.ok(ids.includes("case_frozen"));
  assert.ok(ids.includes("only_variable"));
  assert.ok(ids.includes("stop_conditions"));
  assert.ok(ids.includes("call_budget"));
  assert.ok(ids.includes("exclusion_rules"));
  assert.ok(ids.includes("decision_schema"));
  assert.ok(ids.includes("regression_fields"));
  assert.ok(ids.includes("positive_signal_criteria"));
});

test("授权前检查表全部通过时 summary.allPassed=true", () => {
  const checklist = buildPreAuthorizationChecklist(makePreregistration());
  assert.equal(checklist.summary.allPassed, true);
  assert.equal(checklist.summary.failedCount, 0);
});

test("授权前检查表对非法 artifact 报告失败项", () => {
  const broken = makePreregistration();
  broken.positiveSignalCriteria.requiresHumanOrProxy = false;
  const checklist = buildPreAuthorizationChecklist(broken);
  assert.equal(checklist.summary.allPassed, false);
  assert.ok(checklist.summary.failedCount > 0);
  assert.ok(
    checklist.items.some((i) => i.id === "positive_signal_criteria" && i.passed === false)
  );
});

// ============================================================================
// 12. 不变量（不调用模型/不生成章节/不提交状态）
// ============================================================================

test("dry-run 不调用模型（modelCalled 恒为 false）", () => {
  // 多次调用确保始终不调用模型
  for (let i = 0; i < 5; i += 1) {
    const result = runEditorialBenefit2aDryRun(makePreregistration());
    assert.equal(result.modelCalled, false);
  }
});

test("artifact 不含 modelCall/modelGenerate/callModel 字段", () => {
  const result = validatePreregistrationArtifact(makePreregistration());
  assert.equal(result.ok, true);
  const json = JSON.stringify(result.artifact);
  assert.ok(!/modelCalled|modelGenerate|callModel|invokeModel/i.test(json));
});

test("artifact 不含 chapterSave/stateCommit/finalTextModify 字段", () => {
  const result = validatePreregistrationArtifact(makePreregistration());
  assert.equal(result.ok, true);
  const json = JSON.stringify(result.artifact);
  assert.ok(!/chapterSave|stateCommit|finalTextModify|saveChapter/i.test(json));
});

test("artifact 不含 strategyActivate/setStatus/alphaModify/betaModify 字段", () => {
  const result = validatePreregistrationArtifact(makePreregistration());
  assert.equal(result.ok, true);
  const json = JSON.stringify(result.artifact);
  assert.ok(!/strategyActivate|setStatus|alphaModify|betaModify/i.test(json));
});

// ============================================================================
// 13. 不允许事后换 case/阈值（mutationPolicy + 冻结字段）
// ============================================================================

test("frozenAt 必须是有效 ISO 时间", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ frozenAt: "not-a-date" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "frozenAt");
});

test("frozenBy 必须是 EDITORIAL-BENEFIT-2A", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({ frozenBy: "someone-else" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "frozenBy");
});

test("arms 不得含第三个臂（只允许 advisory_on + advisory_off）", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      arms: {
        advisory_on: { advisoryEnabled: true, constraint: makeArmConstraint() },
        advisory_off: { advisoryEnabled: false, constraint: makeArmConstraint() },
        advisory_maybe: { advisoryEnabled: true, constraint: makeArmConstraint() },
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "arms.advisory_maybe");
});

// ============================================================================
// 14. 反向验证：单裁判不算正向（2C 完成门槛）
// ============================================================================

test("positiveSignalCriteria 明确声明 2C 需 human 或 validated_human_proxy", () => {
  const result = validatePreregistrationArtifact(makePreregistration());
  assert.equal(result.ok, true);
  assert.ok(
    /natural_person.*validated_human_proxy|validated_human_proxy.*natural_person/i.test(
      result.artifact.positiveSignalCriteria.coSupportDefinition
    )
  );
});

test("decisionSchema.human 不允许 reviewerType=machine_judge 冒充 human", () => {
  const result = validatePreregistrationArtifact(
    makePreregistration({
      decisionSchema: {
        judge: makeJudgeDecisionSchema(),
        human: makeHumanDecisionSchema({
          allowedReviewerTypes: ["natural_person", "validated_human_proxy", "machine_judge"],
        }),
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
  assert.equal(result.error.path, "decisionSchema.human.allowedReviewerTypes");
});
