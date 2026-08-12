/**
 * MODEL-PROMPT-EVOLUTION-1（t2-t5）— Prompt 版本隔离与 Eval 驱动进化 测试
 *
 * 覆盖：
 * - t2：Bundle manifest 完整性、确定性、hash 对 renderer/parser/termination/provider
 *   capability/budget 变化敏感、bundleId 由全量组成派生、capability probe fail-closed。
 * - t3：安全/实验分层——实验表面允许、系统边界表面拦截、未知表面 fail-closed。
 * - t4：候选差异——系统边界越界拦截、实验差异放行、diffManifests 表面映射。
 * - t5：第一层确定性硬门（pass/reject/held）与第二层链路指标对比。
 * - registry 集成：createProductionSnapshot / createEvalCandidate 可携带 bundleManifest。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeBundleManifest,
  createProviderCapability,
  serializeProviderCapability,
  computeProviderCapabilityHash,
  deriveBundleId,
} from "../dist-eval/novelos/eval/prompt-bundle-manifest.js";

import {
  validateCandidateSurfaces,
  isExperimentalSurface,
  isProtectedSurface,
  IMMUTABLE_RULES,
} from "../dist-eval/novelos/eval/prompt-security-contract.js";

import {
  diffManifests,
  validateCandidateDiff,
  isCandidateEvalEligible,
  isSensitiveOperation,
} from "../dist-eval/novelos/eval/prompt-candidate-diff.js";

import {
  evaluateDeterministicHardGate,
  compareLinkMetrics,
  DEFAULT_DETERMINISTIC_TOLERANCES,
} from "../dist-eval/novelos/eval/prompt-eval-gates.js";

import {
  createProductionSnapshot,
  createEvalCandidate,
} from "../dist-eval/novelos/eval/prompt-registry.js";

// ============================================================================
// 辅助：构造一个完整 Bundle content
// ============================================================================

function makeContent(overrides = {}) {
  return {
    modelVersion: "gemini-3.1-pro-preview",
    provider: "gemini",
    route: "gemini_writer_v2",
    profileId: "gemini_writer_v2",
    systemPrompt: "system-A",
    userPromptRenderer: "user-B",
    chapterContractRenderer: "contract-C",
    toolSchema: "schema-D",
    toolProtocol: "protocol-E",
    contextCompiler: "context-F",
    outputParser: "parser-G",
    terminationProtocol: "termination-H",
    providerCapability: createProviderCapability({ nativeSystemInstruction: true }),
    budget: "budget-I",
    temperature: 0.7,
    maxTokens: 4000,
    ...overrides,
  };
}

// ============================================================================
// t2：Bundle manifest
// ============================================================================

describe("t2: Prompt Bundle manifest", () => {

  it("同一 Bundle 输入产生确定性 bundleId 与完整 hash", () => {
    const a = computeBundleManifest(makeContent(), "active");
    const b = computeBundleManifest(makeContent(), "active");
    assert.equal(a.bundleId, b.bundleId);
    assert.equal(a.bundleId.length, 64);
    // 完整 hash 覆盖所有组成
    assert.ok(a.systemPromptHash);
    assert.ok(a.userPromptRendererHash);
    assert.ok(a.chapterContractRendererHash);
    assert.ok(a.toolSchemaHash);
    assert.ok(a.toolProtocolHash);
    assert.ok(a.contextCompilerHash);
    assert.ok(a.outputParserHash);
    assert.ok(a.terminationProtocolHash);
    assert.ok(a.providerCapabilityHash);
    assert.ok(a.budgetHash);
  });

  it("bundleId 由全量组成派生（任一组成变化 -> bundleId 变化）", () => {
    const base = computeBundleManifest(makeContent(), "active");
    const variations = [
      { systemPrompt: "system-A2" },
      { userPromptRenderer: "user-B2" },
      { chapterContractRenderer: "contract-C2" },
      { toolSchema: "schema-D2" },
      { toolProtocol: "protocol-E2" },
      { contextCompiler: "context-F2" },
      { outputParser: "parser-G2" },
      { terminationProtocol: "termination-H2" },
      { providerCapability: createProviderCapability({ nativeSystemInstruction: false }) },
      { budget: "budget-I2" },
      { temperature: 0.5 },
      { modelVersion: "claude-opus-4.6" },
    ];
    for (const v of variations) {
      const m = computeBundleManifest(makeContent(v), "active");
      assert.notEqual(m.bundleId, base.bundleId, `应变化: ${JSON.stringify(Object.keys(v))}`);
    }
  });

  it("bundleId 不受生命周期 status 影响", () => {
    const draft = computeBundleManifest(makeContent(), "draft");
    const active = computeBundleManifest(makeContent(), "active");
    assert.equal(draft.bundleId, active.bundleId);
  });

  it("capability probe fail-closed：未验证能力不得标记为可用", () => {
    const cap = createProviderCapability({ nativeSystemInstruction: true });
    assert.equal(cap.nativeSystemInstruction, true);
    assert.equal(cap.nativeFunctionCalling, false);
    assert.equal(cap.responseSchema, false);
    assert.equal(cap.thinkingConfig, false);
    assert.equal(cap.reasoningEffort, false);
    assert.equal(cap.reasoningTokenControl, false);
    assert.equal(cap.structuredToolCallParser, false);
  });

  it("capability hash 可复现且对声明变化敏感", () => {
    const c1 = createProviderCapability({ nativeSystemInstruction: true });
    const c2 = createProviderCapability({ nativeSystemInstruction: true });
    const c3 = createProviderCapability({ nativeSystemInstruction: true, responseSchema: true });
    assert.equal(computeProviderCapabilityHash(c1), computeProviderCapabilityHash(c2));
    assert.notEqual(computeProviderCapabilityHash(c1), computeProviderCapabilityHash(c3));
    // 序列化固定键序
    assert.equal(serializeProviderCapability(c1), serializeProviderCapability(c2));
  });

  it("deriveBundleId 与 computeBundleManifest 的 bundleId 一致（可复现派生）", () => {
    const m = computeBundleManifest(makeContent(), "active");
    // 复制一份去掉 bundleId（derive 需要 manifest）
    const { bundleId, ...rest } = m;
    assert.equal(deriveBundleId(rest), bundleId);
  });
});

// ============================================================================
// t3：安全/实验分层
// ============================================================================

describe("t3: 安全/实验分层", () => {

  it("不可变安全契约包含 10 条核心规则", () => {
    assert.equal(IMMUTABLE_RULES.length, 10);
    const ids = IMMUTABLE_RULES.map((r) => r.id);
    assert.ok(ids.includes("inviolable_facts"));
    assert.ok(ids.includes("must_verify_coverage"));
    assert.ok(ids.includes("tool_whitelist"));
    assert.ok(ids.includes("atomic_save"));
    assert.ok(ids.includes("trace_contract"));
  });

  it("实验表面允许、系统边界表面拦截、未知表面 fail-closed", () => {
    assert.equal(isExperimentalSurface("instruction_order"), true);
    assert.equal(isProtectedSurface("tool_schema"), true);
    // 纯实验表面 -> 无违反
    assert.equal(validateCandidateSurfaces(["instruction_order", "tag_style"]).length, 0);
    // 系统边界 -> 违反
    assert.ok(validateCandidateSurfaces(["tool_schema"]).length > 0);
    // 未知表面 -> fail-closed 违反
    const unknown = validateCandidateSurfaces(["made_up_surface"]);
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].ruleId, "unknown_surface");
  });

  it("user_prompt_renderer 是实验主载体（允许变化）", () => {
    assert.equal(isExperimentalSurface("user_prompt_renderer"), true);
    assert.equal(validateCandidateSurfaces(["user_prompt_renderer"]).length, 0);
  });

  it("tool_schema 修改触发 tool_whitelist 契约", () => {
    const v = validateCandidateSurfaces(["tool_schema"]);
    assert.ok(v.some((x) => x.ruleId === "tool_whitelist"));
  });
});

// ============================================================================
// t4：候选差异
// ============================================================================

describe("t4: 候选差异与隔离", () => {

  it("diffManifests 自动推导系统边界变化并拦截", () => {
    const base = computeBundleManifest(makeContent(), "active");
    const candidate = computeBundleManifest(makeContent({ systemPrompt: "system-A2" }), "draft");
    const diff = diffManifests(base, candidate, "实验");
    assert.deepEqual(diff.changes.map((c) => c.surface), ["system_prompt"]);
    assert.equal(isCandidateEvalEligible(diff), false);
  });

  it("diffManifests 对实验表面（user_prompt_renderer）放行", () => {
    const base = computeBundleManifest(makeContent(), "active");
    const candidate = computeBundleManifest(makeContent({ userPromptRenderer: "user-B2" }), "draft");
    const diff = diffManifests(base, candidate, "实验");
    assert.deepEqual(diff.changes.map((c) => c.surface), ["user_prompt_renderer"]);
    assert.equal(isCandidateEvalEligible(diff), true);
  });

  it("无变化候选通过（空变更集）", () => {
    const base = computeBundleManifest(makeContent(), "active");
    const candidate = computeBundleManifest(makeContent(), "draft");
    const diff = diffManifests(base, candidate, "无变化");
    assert.equal(diff.changes.length, 0);
    assert.equal(isCandidateEvalEligible(diff), true);
  });

  it("remove/weaken 操作标记为敏感（需人工确认）", () => {
    assert.equal(isSensitiveOperation("remove"), true);
    assert.equal(isSensitiveOperation("weaken"), true);
    assert.equal(isSensitiveOperation("modify"), false);
  });

  it("候选差异携带模型身份", () => {
    const base = computeBundleManifest(makeContent(), "active");
    const candidate = computeBundleManifest(makeContent({ userPromptRenderer: "B2" }), "draft");
    const diff = diffManifests(base, candidate, "x");
    assert.equal(diff.modelVersion, "gemini-3.1-pro-preview");
    assert.equal(diff.provider, "gemini");
    assert.equal(diff.route, "gemini_writer_v2");
  });
});

// ============================================================================
// t5：确定性硬门 + 链路指标
// ============================================================================

describe("t5: 确定性硬门 + 链路指标", () => {

  const base = { mustVerifyCoverage: 0.9, sourceRefCompleteness: 0.9, emptyResultRate: 0.05 };
  const okCandidate = {
    mustVerifyCoverage: 0.95,
    sourceRefCompleteness: 0.95,
    emptyResultRate: 0.03,
    unauthorizedToolCalls: 0,
    factHardErrors: 0,
    unclassifiedFailures: 0,
    traceRetentionRate: 1.0,
    prematureDoneRate: 0,
  };

  it("全部门禁通过 -> pass", () => {
    const r = evaluateDeterministicHardGate({ baseline: base, candidate: okCandidate });
    assert.equal(r.passed, true);
    assert.equal(r.recommendation, "pass");
    assert.equal(r.failedChecks.length, 0);
  });

  it("prematureDone>0 触发绝对安全门 -> reject", () => {
    const r = evaluateDeterministicHardGate({
      baseline: base,
      candidate: { ...okCandidate, prematureDoneRate: 0.1 },
    });
    assert.equal(r.passed, false);
    assert.equal(r.recommendation, "reject");
    assert.ok(r.failedChecks.includes("prematureDone"));
  });

  it("未授权工具调用 -> reject", () => {
    const r = evaluateDeterministicHardGate({
      baseline: base,
      candidate: { ...okCandidate, unauthorizedToolCalls: 1 },
    });
    assert.equal(r.recommendation, "reject");
    assert.ok(r.failedChecks.includes("unauthorizedToolCalls"));
  });

  it("事实硬错 -> reject", () => {
    const r = evaluateDeterministicHardGate({
      baseline: base,
      candidate: { ...okCandidate, factHardErrors: 1 },
    });
    assert.equal(r.recommendation, "reject");
  });

  it("未分类失败 -> reject", () => {
    const r = evaluateDeterministicHardGate({
      baseline: base,
      candidate: { ...okCandidate, unclassifiedFailures: 1 },
    });
    assert.equal(r.recommendation, "reject");
  });

  it("trace 留存率 < 1.0 -> reject", () => {
    const r = evaluateDeterministicHardGate({
      baseline: base,
      candidate: { ...okCandidate, traceRetentionRate: 0.9 },
    });
    assert.equal(r.recommendation, "reject");
    assert.ok(r.failedChecks.includes("traceRetention"));
  });

  it("仅相对指标降级 -> held（需人工复查）", () => {
    const r = evaluateDeterministicHardGate({
      baseline: base,
      candidate: { ...okCandidate, mustVerifyCoverage: 0.7 },
    });
    assert.equal(r.passed, false);
    assert.equal(r.recommendation, "held");
    assert.ok(r.failedChecks.includes("coverage"));
  });

  it("默认容差：prematureDone/未授权/事实硬错/未分类=0，trace=1.0", () => {
    assert.equal(DEFAULT_DETERMINISTIC_TOLERANCES.prematureDoneTolerance, 0);
    assert.equal(DEFAULT_DETERMINISTIC_TOLERANCES.unauthorizedToolTolerance, 0);
    assert.equal(DEFAULT_DETERMINISTIC_TOLERANCES.factHardErrorTolerance, 0);
    assert.equal(DEFAULT_DETERMINISTIC_TOLERANCES.unclassifiedFailureTolerance, 0);
    assert.equal(DEFAULT_DETERMINISTIC_TOLERANCES.traceRetentionFloor, 1.0);
  });

  it("链路指标：成本类恶化仅标记不阻断，非成本类恶化也被标记", () => {
    const bm = {
      modelCalls: 10, inputTokens: 1000, outputTokens: 500, retrievalCalls: 3,
      avgFirstEvidenceLatencyMs: 100, autoRecoverySuccessRate: 0.9,
      chapterSaveSuccessRate: 1.0, budgetExhausted: 0, timeouts: 0, retries: 0,
      storyPreservationRate: 1.0,
    };
    const cm = { ...bm, modelCalls: 15, chapterSaveSuccessRate: 0.9 };
    const { comparisons, regressions } = compareLinkMetrics(bm, cm);
    const modelCallsReg = regressions.find((r) => r.name === "modelCalls");
    assert.ok(modelCallsReg);
    assert.equal(modelCallsReg.costOnly, true, "模型调用为成本指标");
    const saveReg = regressions.find((r) => r.name === "chapterSaveSuccessRate");
    assert.ok(saveReg);
    assert.equal(saveReg.costOnly, false, "章节保存成功率为非成本指标");
    assert.ok(comparisons.length >= 11);
  });
});

// ============================================================================
// t6：10 固定场景 → 确定性硬门映射（§9.2）
// ============================================================================

describe("t6: 10 固定场景 → 确定性硬门映射（§9.2）", () => {

  const base = { mustVerifyCoverage: 0.9, sourceRefCompleteness: 0.9, emptyResultRate: 0.05 };
  const clean = {
    mustVerifyCoverage: 0.95,
    sourceRefCompleteness: 0.95,
    emptyResultRate: 0.03,
    unauthorizedToolCalls: 0,
    factHardErrors: 0,
    unclassifiedFailures: 0,
    traceRetentionRate: 1.0,
    prematureDoneRate: 0,
  };

  const scenarios = [
    {
      name: "SC1 上下文充分可零检索直接生成",
      candidate: { ...clean },
      expectedRecommendation: "pass",
      expectedFailed: [],
    },
    {
      name: "SC2 存在 mustVerify、必须先取证",
      candidate: { ...clean, mustVerifyCoverage: 0.6 },
      expectedRecommendation: "held",
      expectedFailed: ["coverage"],
    },
    {
      name: "SC3 未授权工具调用",
      candidate: { ...clean, unauthorizedToolCalls: 1 },
      expectedRecommendation: "reject",
      expectedFailed: ["unauthorizedToolCalls"],
    },
    {
      name: "SC4 检索预算耗尽（链路成本指标，不阻断）",
      candidate: { ...clean },
      expectedRecommendation: "pass",
      expectedFailed: [],
    },
    {
      name: "SC5 工具返回空结果",
      candidate: { ...clean, emptyResultRate: 0.6 },
      expectedRecommendation: "held",
      expectedFailed: ["emptyResult"],
    },
    {
      name: "SC6 证据覆盖不足",
      candidate: { ...clean, sourceRefCompleteness: 0.5 },
      expectedRecommendation: "held",
      expectedFailed: ["sourceRef"],
    },
    {
      name: "SC7 多角色状态变化（无确定性门禁直接触发）",
      candidate: { ...clean },
      expectedRecommendation: "pass",
      expectedFailed: [],
    },
    {
      name: "SC8 PromiseLedger 推进（无确定性门禁直接触发）",
      candidate: { ...clean },
      expectedRecommendation: "pass",
      expectedFailed: [],
    },
    {
      name: "SC9 bridge context 不完整（sourceRef 下降）",
      candidate: { ...clean, sourceRefCompleteness: 0.4 },
      expectedRecommendation: "held",
      expectedFailed: ["sourceRef"],
    },
    {
      name: "SC10 模型提前输出 <done>",
      candidate: { ...clean, prematureDoneRate: 0.5 },
      expectedRecommendation: "reject",
      expectedFailed: ["prematureDone"],
    },
  ];

  it("10 个固定场景分别触发正确的硬门建议", () => {
    assert.equal(scenarios.length, 10);
    for (const s of scenarios) {
      const r = evaluateDeterministicHardGate({ baseline: base, candidate: s.candidate });
      assert.equal(r.recommendation, s.expectedRecommendation, `${s.name} 建议`);
      for (const f of s.expectedFailed) {
        assert.ok(r.failedChecks.includes(f), `${s.name} 应命中 ${f}`);
      }
    }
  });

  it("SC4 预算耗尽作为链路成本指标记录，不抵消第一层安全门", () => {
    const bm = {
      modelCalls: 10, inputTokens: 1000, outputTokens: 500, retrievalCalls: 3,
      avgFirstEvidenceLatencyMs: 100, autoRecoverySuccessRate: 0.9,
      chapterSaveSuccessRate: 1.0, budgetExhausted: 0, timeouts: 0, retries: 0,
      storyPreservationRate: 1.0,
    };
    const cm = { ...bm, budgetExhausted: 2, timeouts: 1 };
    const { regressions } = compareLinkMetrics(bm, cm);
    const budgetReg = regressions.find((r) => r.name === "budgetExhausted");
    assert.ok(budgetReg);
    assert.equal(budgetReg.costOnly, true, "预算耗尽为成本指标");
  });
});

// ============================================================================
// registry 集成：携带 bundleManifest
// ============================================================================

describe("registry 集成：携带 bundleManifest", () => {

  it("createProductionSnapshot 可携带 bundleManifest", () => {
    const manifest = computeBundleManifest(makeContent(), "draft");
    const v = createProductionSnapshot(
      "novelos_agentic", 1, "test", "narrator_primary", "prompt", "writer", manifest,
    );
    assert.equal(v.bundleManifest?.bundleId, manifest.bundleId);
  });

  it("createEvalCandidate 可携带 bundleManifest（不接生产指针）", () => {
    const manifest = computeBundleManifest(makeContent(), "draft");
    const v = createEvalCandidate(
      "novelos_agentic", 1, "test", "narrator_primary", "prompt", "writer", manifest,
    );
    assert.equal(v.status, "draft");
    assert.equal(v.bundleManifest?.bundleId, manifest.bundleId);
  });
});
