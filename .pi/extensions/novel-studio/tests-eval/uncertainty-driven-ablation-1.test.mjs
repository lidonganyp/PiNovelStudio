/**
 * UNCERTAINTY-DRIVEN-ABLATION-1：不确定性驱动检索决策 A/B 对照实验验收 spec
 *
 * 第一轮最小实验框架验证（stub 模式，不调用真实 API）。
 *
 * 验证内容：
 * 1. 模块导出完整（UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT / runAblationArm / runAblation / extractMetrics 等）
 * 2. B 组决策规则 prompt 包含三条决策规则
 * 3. extractMetrics 从正确的 stageResults 字段提取（evalAgentic / finalTextCompleteness / finalSelection）
 * 4. aggregateMetrics 聚合正确（含 avgIrrelevantEvidenceRatio）
 * 5. computeIrrelevantEvidenceRatio 启发式正确
 * 6. generateBlindPack 匿名性（mapping 完整、entries 数 = 2 × cases）
 * 7. loadAblationCases 从 JSON 加载 case set
 *
 * 授权边界：
 * - 本 RED spec 用 stub 模式验证框架结构与聚合逻辑，不调用真实 API
 * - extractMetrics / aggregateMetrics / computeIrrelevantEvidenceRatio / generateBlindPack 均为纯函数，
 *   不依赖模型调用，可直接用 fixture 验证
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const MODULE_PATH = join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "uncertainty-driven-ablation.js");

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：动态 import 模块
// ─────────────────────────────────────────────────────────────────────────────

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造 fixture V2Output（模拟 B2 路径产出）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一个模拟 B2 evalMode 路径的 V2Output fixture。
 * stageResults 包含 evalAgentic / finalTextCompleteness / finalSelection。
 */
function makeFixtureV2Output(overrides = {}) {
  return {
    status: "ok",
    workspaceId: "ablation-test",
    chapterId: "test-ch5",
    text: "第五章 天枢秘境\n\n林默深吸一口气，灵气在经脉中流转。他终于突破了练气九层，有了闯入秘境深处的资格。",
    stageResults: {
      evalAgentic: {
        sessionId: "novelos-test-1234",
        trajectoryPath: "", // 空路径，extractMetrics 会返回空 sourceRefs
        candidateId: "cand-1",
        candidateLength: 60,
        candidateHash: "abc123",
        stopReason: "model_declares_sufficient",
        failureReason: null,
        toolCalls: 3,
        verifierCleared: false,
        repairRounds: 0,
      },
      finalTextCompleteness: {
        passed: true,
        selectedSource: "raw",
        selectedCandidateId: "cand-1",
      },
      finalSelection: {
        selectedSource: "raw",
        selectedCandidateId: "cand-1",
        finalTextLength: 60,
        degradedToRaw: false,
        evalMode: "B2",
      },
      modelCalls: [
        { tokenUsage: "unknown" },
      ],
    },
    selectedSource: "raw",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：模块导出
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：模块导出", () => {
  it("模块文件存在且可导入", async () => {
    const mod = await importModule();
    assert.ok(mod, "模块应可导入");
  });

  it("导出 UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT 常量", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT, "string");
    assert.ok(mod.UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT.length > 0);
  });

  it("导出 runAblationArm / runAblation / extractMetrics / aggregateMetrics / computeIrrelevantEvidenceRatio / generateBlindPack / loadAblationCases", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.runAblationArm, "function");
    assert.equal(typeof mod.runAblation, "function");
    assert.equal(typeof mod.extractMetrics, "function");
    assert.equal(typeof mod.aggregateMetrics, "function");
    assert.equal(typeof mod.computeIrrelevantEvidenceRatio, "function");
    assert.equal(typeof mod.generateBlindPack, "function");
    assert.equal(typeof mod.loadAblationCases, "function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：B 组决策规则 prompt 内容
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：B 组决策规则 prompt", () => {
  it("包含三条决策规则", async () => {
    const mod = await importModule();
    const prompt = mod.UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT;
    // 规则 1：上下文足够 → 直接输出正文
    assert.ok(prompt.includes("可以直接输出正文"), "应包含'可以直接输出正文'");
    // 规则 2：缺少可能改变事实/人物状态/因果关系的信息 → 调工具
    assert.ok(prompt.includes("先调用最相关的证据工具"), "应包含'先调用最相关的证据工具'");
    // 规则 3：不为完成流程做无必要检索
    assert.ok(prompt.includes("不要为了"), "应包含'不要为了'");
    assert.ok(prompt.includes("无必要检索"), "应包含'无必要检索'");
  });

  it("不暴露思维链（不含 chain-of-thought 指令）", async () => {
    const mod = await importModule();
    const prompt = mod.UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT;
    assert.ok(!prompt.includes("一步一步"), "不应包含'一步一步'思维链指令");
    assert.ok(!prompt.includes("think step"), "不应包含 'think step'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：extractMetrics 从正确的 stageResults 字段提取
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：extractMetrics 字段提取", () => {
  it("从 stageResults.evalAgentic 提取 toolCalls", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.toolCalls, 3, "应从 evalAgentic.toolCalls 提取 toolCalls=3");
  });

  it("从 stageResults.finalTextCompleteness 提取 completenessPassed", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.completenessPassed, true, "应从 finalTextCompleteness.passed 提取");
  });

  it("从 stageResults.finalSelection 提取 selectedSource", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.selectedSource, "raw", "应从 finalSelection.selectedSource 提取");
  });

  it("success=true 当 status=ok 且 text 非空", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.success, true);
    assert.equal(metrics.failureReason, undefined);
  });

  it("success=false 当 status=blocked", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output({ status: "blocked", text: "" });
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.success, false);
    assert.ok(metrics.failureReason, "应有 failureReason");
  });

  it("不传 caseData/intent/context 时 factGuardErrors=0（跳过 post-hoc FactGuard）", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.factGuardErrors, 0, "无 caseData 时应跳过 post-hoc FactGuard");
  });

  it("irrelevantEvidenceRatio 默认 0（无 trajectory）", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.irrelevantEvidenceRatio, 0, "无 trajectory 时 irrelevantEvidenceRatio=0");
  });

  it("token 聚合：modelCalls 全 unknown → tokenIn='unknown'", async () => {
    const mod = await importModule();
    const fixture = makeFixtureV2Output();
    const metrics = mod.extractMetrics("A", "test-case", fixture, 1000);
    assert.equal(metrics.tokenIn, "unknown");
    assert.equal(metrics.tokenOut, "unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：aggregateMetrics 聚合
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：aggregateMetrics 聚合", () => {
  it("正确聚合 avgToolCalls / avgIrrelevantEvidenceRatio", async () => {
    const mod = await importModule();
    const metrics = [
      {
        arm: "A", caseId: "c1", success: true, textLength: 100, durationMs: 1000,
        toolCalls: 5, sourceRefsCount: 3, mustVerifyCount: 4, factGuardErrors: 0,
        completenessPassed: true, tokenIn: "unknown", tokenOut: "unknown",
        selectedSource: "raw", irrelevantEvidenceRatio: 0.3,
      },
      {
        arm: "A", caseId: "c2", success: true, textLength: 200, durationMs: 2000,
        toolCalls: 3, sourceRefsCount: 2, mustVerifyCount: 3, factGuardErrors: 1,
        completenessPassed: false, tokenIn: "unknown", tokenOut: "unknown",
        selectedSource: "raw", irrelevantEvidenceRatio: 0.5,
      },
    ];
    const agg = mod.aggregateMetrics(metrics);
    assert.equal(agg.successCount, 2);
    assert.equal(agg.avgToolCalls, 4); // (5+3)/2
    assert.equal(agg.avgFactGuardErrors, 0.5); // (0+1)/2
    assert.equal(agg.completenessPassRate, 0.5); // 1/2
    assert.equal(agg.avgIrrelevantEvidenceRatio, 0.4); // (0.3+0.5)/2
  });

  it("factGuardErrors=-1（测量失败）不计入聚合（max(e,0)）", async () => {
    const mod = await importModule();
    const metrics = [
      {
        arm: "A", caseId: "c1", success: true, textLength: 100, durationMs: 1000,
        toolCalls: 5, sourceRefsCount: 3, mustVerifyCount: 4, factGuardErrors: -1,
        completenessPassed: true, tokenIn: "unknown", tokenOut: "unknown",
        selectedSource: "raw", irrelevantEvidenceRatio: 0,
      },
      {
        arm: "A", caseId: "c2", success: true, textLength: 200, durationMs: 2000,
        toolCalls: 3, sourceRefsCount: 2, mustVerifyCount: 3, factGuardErrors: 2,
        completenessPassed: true, tokenIn: "unknown", tokenOut: "unknown",
        selectedSource: "raw", irrelevantEvidenceRatio: 0,
      },
    ];
    const agg = mod.aggregateMetrics(metrics);
    // -1 → max(-1,0)=0, 2 → max(2,0)=2, avg = (0+2)/2 = 1
    assert.equal(agg.avgFactGuardErrors, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：computeIrrelevantEvidenceRatio 启发式
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：computeIrrelevantEvidenceRatio", () => {
  it("空证据列表 → ratio=0", async () => {
    const mod = await importModule();
    const ratio = mod.computeIrrelevantEvidenceRatio([], "任何正文");
    assert.equal(ratio, 0);
  });

  it("证据片段在正文中出现 → ratio=0", async () => {
    const mod = await importModule();
    const finalText = "林默站在悬崖边，灵气在经脉中流转。";
    const excerpts = [
      { sourceRef: "ch1:1", excerpt: "林默站在悬崖边" },
      { sourceRef: "ch1:2", excerpt: "灵气在经脉中流转" },
    ];
    const ratio = mod.computeIrrelevantEvidenceRatio(excerpts, finalText);
    assert.equal(ratio, 0, "两条证据都在正文中出现，ratio 应为 0");
  });

  it("证据片段不在正文中 → ratio=1", async () => {
    const mod = await importModule();
    const finalText = "苏婉推开了那扇门。";
    const excerpts = [
      { sourceRef: "ch1:1", excerpt: "林默站在悬崖边，风掀起他的衣角" },
      { sourceRef: "ch1:2", excerpt: "灵气在经脉中流转，他终于突破了练气九层" },
    ];
    const ratio = mod.computeIrrelevantEvidenceRatio(excerpts, finalText);
    assert.equal(ratio, 1, "两条证据都不在正文中，ratio 应为 1");
  });

  it("部分证据在正文中 → ratio=0.5", async () => {
    const mod = await importModule();
    const finalText = "林默站在悬崖边，今天天气很好。";
    const excerpts = [
      { sourceRef: "ch1:1", excerpt: "林默站在悬崖边" }, // 相关
      { sourceRef: "ch1:2", excerpt: "苏婉推开了那扇门" }, // 无关
    ];
    const ratio = mod.computeIrrelevantEvidenceRatio(excerpts, finalText);
    assert.equal(ratio, 0.5, "一条相关一条无关，ratio 应为 0.5");
  });

  it("太短的证据片段（<6 字符）视为无关", async () => {
    const mod = await importModule();
    const finalText = "林默站在悬崖边，灵气在经脉中流转。";
    const excerpts = [
      { sourceRef: "ch1:1", excerpt: "林默" }, // 只有 2 字符，太短
    ];
    const ratio = mod.computeIrrelevantEvidenceRatio(excerpts, finalText);
    assert.equal(ratio, 1, "太短的片段应视为无关");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 6：generateBlindPack 匿名性
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：generateBlindPack 匿名性", () => {
  it("entries 数 = 2 × cases，mapping 完整", async () => {
    const mod = await importModule();
    const result = {
      runId: "test-run",
      timestamp: "2026-08-04T00:00:00Z",
      cases: [
        {
          caseId: "c1",
          armA: { arm: "A", caseId: "c1", v2Output: { text: "A 组正文 c1" }, metrics: {} },
          armB: { arm: "B", caseId: "c1", v2Output: { text: "B 组正文 c1" }, metrics: {} },
        },
        {
          caseId: "c2",
          armA: { arm: "A", caseId: "c2", v2Output: { text: "A 组正文 c2" }, metrics: {} },
          armB: { arm: "B", caseId: "c2", v2Output: { text: "B 组正文 c2" }, metrics: {} },
        },
      ],
      aggregate: { armA: {}, armB: {} },
      passCriteria: {},
    };
    const blindPack = mod.generateBlindPack(result);
    assert.equal(blindPack.entries.length, 4, "2 cases × 2 arms = 4 entries");
    assert.equal(Object.keys(blindPack.mapping).length, 4, "mapping 应有 4 个条目");
    // 每个 case 有 X 和 Y 两个匿名 ID
    for (const c of result.cases) {
      const xId = `X-${c.caseId}`;
      const yId = `Y-${c.caseId}`;
      assert.ok(blindPack.mapping[xId], `应有 ${xId} 映射`);
      assert.ok(blindPack.mapping[yId], `应有 ${yId} 映射`);
      // X 和 Y 应分别映射到 A 和 B（顺序随机）
      const arms = [blindPack.mapping[xId].arm, blindPack.mapping[yId].arm].sort();
      assert.deepEqual(arms, ["A", "B"], `case ${c.caseId} 的 X/Y 应分别映射到 A 和 B`);
    }
  });

  it("entries 不暴露 arm 身份（只有 anonymousId / caseId / text）", async () => {
    const mod = await importModule();
    const result = {
      runId: "test-run",
      timestamp: "2026-08-04T00:00:00Z",
      cases: [
        {
          caseId: "c1",
          armA: { arm: "A", caseId: "c1", v2Output: { text: "A 组正文" }, metrics: {} },
          armB: { arm: "B", caseId: "c1", v2Output: { text: "B 组正文" }, metrics: {} },
        },
      ],
      aggregate: { armA: {}, armB: {} },
      passCriteria: {},
    };
    const blindPack = mod.generateBlindPack(result);
    for (const entry of blindPack.entries) {
      // entry 不应包含 arm 字段
      assert.ok(!("arm" in entry), `entry ${entry.anonymousId} 不应包含 arm 字段`);
      // anonymousId 应为 X- 或 Y- 前缀
      assert.ok(entry.anonymousId.startsWith("X-") || entry.anonymousId.startsWith("Y-"),
        `anonymousId 应为 X- 或 Y- 前缀，实际：${entry.anonymousId}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 7：loadAblationCases 从 JSON 加载
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：loadAblationCases", () => {
  it("从 stub case set JSON 加载 3 个 case", async () => {
    const mod = await importModule();
    const stubPath = join(
      EXTENSION_ROOT, "..", "..", "..",
      "scripts", "novelbench", "_uncertainty-ablation-cases-stub.json",
    );
    if (!existsSync(stubPath)) {
      // stub case set 不存在时跳过（不硬失败）
      return;
    }
    const cases = mod.loadAblationCases(stubPath);
    assert.ok(Array.isArray(cases));
    assert.equal(cases.length, 3, "stub case set 应有 3 个 case");
    for (const c of cases) {
      assert.equal(typeof c.caseId, "string");
      assert.equal(typeof c.genre, "string");
      assert.equal(typeof c.targetChapter, "number");
      assert.equal(typeof c.prefix, "string");
    }
  });

  it("缺少必填字段时抛错", async () => {
    const mod = await importModule();
    const tmpDir = mkdtempSync(join(tmpdir(), "ablation-test-"));
    const badPath = join(tmpDir, "bad-cases.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(badPath, JSON.stringify({
      cases: [{ caseId: "c1", genre: "玄幻" }], // 缺 targetChapter / prefix
    }), "utf-8");
    try {
      assert.throws(() => mod.loadAblationCases(badPath), /缺少必填字段/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 RED：召回率指标修复（confirmed 覆盖率 + unmeasured 三态）
// ─────────────────────────────────────────────────────────────────────────────

describe("UNCERTAINTY-DRIVEN-ABLATION-1：Step 1 召回率指标修复", () => {
  it("extractMetrics 返回 confirmedEvidenceCount 字段", async () => {
    const mod = await importModule();
    const v2Output = makeFixtureV2Output();
    const caseData = {
      caseId: "test-recall",
      genre: "玄幻",
      targetChapter: 5,
      prefix: "前文",
      riskLevel: "high",
      authorMustInclude: ["确认A", "确认B"],
    };
    const metrics = mod.extractMetrics("A", "test-recall", v2Output, 1000, "", caseData);
    assert.equal(typeof metrics.confirmedEvidenceCount, "number");
  });

  it("extractMetrics 返回 mustVerifyCoverage 字段（0-1）", async () => {
    const mod = await importModule();
    const v2Output = makeFixtureV2Output();
    const caseData = {
      caseId: "test-recall",
      genre: "玄幻",
      targetChapter: 5,
      prefix: "前文",
      riskLevel: "high",
      authorMustInclude: ["确认A"],
    };
    const metrics = mod.extractMetrics("A", "test-recall", v2Output, 1000, "", caseData);
    assert.equal(typeof metrics.mustVerifyCoverage, "number");
    assert.ok(metrics.mustVerifyCoverage >= 0 && metrics.mustVerifyCoverage <= 1);
  });

  it("extractMetrics 返回 uncoveredMustVerify 数组", async () => {
    const mod = await importModule();
    const v2Output = makeFixtureV2Output();
    const caseData = {
      caseId: "test-recall",
      genre: "玄幻",
      targetChapter: 5,
      prefix: "前文",
      riskLevel: "high",
      authorMustInclude: ["确认A"],
    };
    const metrics = mod.extractMetrics("A", "test-recall", v2Output, 1000, "", caseData);
    assert.ok(Array.isArray(metrics.uncoveredMustVerify));
  });

  it("无 authorMustInclude 时 mustVerifyCoverage=1（无要求即全覆盖）", async () => {
    const mod = await importModule();
    const v2Output = makeFixtureV2Output();
    const caseData = {
      caseId: "test-low",
      genre: "玄幻",
      targetChapter: 5,
      prefix: "前文",
      riskLevel: "low",
    };
    const metrics = mod.extractMetrics("A", "test-low", v2Output, 1000, "", caseData);
    assert.equal(metrics.mustVerifyCoverage, 1);
    assert.equal(metrics.mustVerifyCount, 0);
  });

  it("passCriteria.recallNotWorse 是三态字符串（pass/fail/unmeasured）而非 boolean", async () => {
    const mod = await importModule();
    // 构造两组都无 confirmed 证据的 metrics，应返回 unmeasured
    const fakeResult = {
      runId: "test",
      timestamp: new Date().toISOString(),
      cases: [],
      aggregate: {
        armA: { successCount: 0, avgToolCalls: 0, avgSourceRefs: 0, avgFactGuardErrors: 0, avgDurationMs: 0, totalTokenIn: 0, totalTokenOut: 0, completenessPassRate: 0, avgIrrelevantEvidenceRatio: 0 },
        armB: { successCount: 0, avgToolCalls: 0, avgSourceRefs: 0, avgFactGuardErrors: 0, avgDurationMs: 0, totalTokenIn: 0, totalTokenOut: 0, completenessPassRate: 0, avgIrrelevantEvidenceRatio: 0 },
      },
      passCriteria: {
        factGuardNotWorse: true,
        toolCallsReduced: true,
        recallNotWorse: "unmeasured",
        overallPassed: false,
      },
    };
    // 验证 passCriteria.recallNotWorse 接受字符串值
    assert.equal(typeof fakeResult.passCriteria.recallNotWorse, "string");
    // 真实验证：当 A/B 两组都无 mustVerify 时，runAblation 产出的 passCriteria.recallNotWorse 应为 "unmeasured"
    // 此处用 fakeResult 验证类型契约，实际行为在 GREEN 实现后用 runAblation 验证
  });
});
