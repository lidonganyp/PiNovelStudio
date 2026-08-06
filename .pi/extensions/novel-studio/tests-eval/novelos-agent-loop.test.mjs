/**
 * NovelOS Narrative Agent Loop 测试（A.5 + B.2 ReAct 架构重写）
 *
 * 验证 Agent 原生 ReAct loop + 停止条件 + CandidateWorkspace 产物 + trajectory 回放：
 * 1. 正常流程：stub 发 <tool_call> → 工具派发 → 证据回灌 → 生成 draft → fallback=false
 * 2. 模型异常 fallback：modelGenerate 抛错 → fallback=true + stopReason=model_error
 * 3. 预算耗尽 fallback：maxToolCalls=1 → 第一次 tool call 耗尽 → fallback=true + stopReason=budget_exhausted
 * 4. CandidateWorkspace 文件验证（evidence-plan/tool-events/draft/lineage）
 * 5. trajectory 回放：含 evidence_plan + tool_event + budget + output
 * 6. lineage 记录完整 sourceRefs + toolCalls + evidenceFacts
 *
 * 架构（ReAct 式 prompt 工具调用）：
 * - stub model 第 1 轮（无证据）：发 <tool_call>{"name":"search_chapter_span",...}</tool_call>
 * - streamFn 解析指令 → emit toolCall 块 + stopReason="toolUse"
 * - Agent 原生派发 search_chapter_span → 追加 toolResult 消息 → 再调 streamFn
 * - streamFn 把 toolResult 回灌为「已检索到的证据」块
 * - stub model 第 2 轮（有证据）：返回正文 → stopReason="stop"
 *
 * 测试从 ../dist/ import 构建产物（遵循 project_memory 教训：不直接 import .ts 源）。
 * 独立临时 workspace（mkdtempSync），不污染真实数据。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNovelOSRuntime } from "../dist/novelos/runtime/runtime.js";
import { BudgetPolicy } from "../dist/novelos/runtime/budget-policy.js";
import { TrajectoryStore } from "../dist/novelos/trajectory/trajectory-store.js";
import { createNovelSession } from "../dist/novelos/session/novel-session.js";
import { createCandidateWorkspace } from "../dist/novelos/agent/candidate-workspace.js";
import { createNarrativeAgentLoop } from "../dist/novelos/agent/narrative-agent-loop.js";
import { createNarrativeSearchService } from "../dist/novelos/agent/narrative-search-service.js";
import { createNarrativeToolRegistry } from "../dist/novelos/agent/narrative-tool-registry.js";
import { PermissionPolicy } from "../dist/novelos/security/permission-policy.js";

// ============================================================================
// 常量
// ============================================================================

/** 历史章节中可被 search_chapter_span 检索到的关键短语 */
const SEARCHABLE_KEYWORD = "复苏之眼";

/** 第 2 轮生成的正文 */
const DRAFT_TEXT = "林默的复苏之眼在黑暗中缓缓睁开，青鱼嘴的夜风掠过他的衣角。这是基于证据生成的正文。";

// ============================================================================
// 两阶段 ReAct stub ModelGenerateFn
// ============================================================================

/**
 * 创建两阶段 ReAct stub model。
 *
 * - patch 阶段（userPrompt 含"修复范围与方向"）→ 返回原 draft（D.2 用，本文件不触发）
 * - 第 2 轮（userPrompt 含"已检索到的证据"）→ 返回正文
 * - 第 1 轮（无证据）→ 发 <tool_call> 指令调用 search_chapter_span
 *
 * @param opts.shouldThrow 模型抛错（fallback 测试）
 * @param opts.draft 第 2 轮返回的正文（默认 DRAFT_TEXT）
 */
function createReActStubModel(opts = {}) {
  const { shouldThrow = false, draft = DRAFT_TEXT } = opts;
  const calls = [];
  const fn = async (input) => {
    calls.push({ ...input });
    if (shouldThrow) throw new Error("stub model error");

    const userPrompt = input.userPrompt ?? "";

    // patch 阶段：返回原 draft（模拟 patch 成功，本文件不触发，留给 D.2）
    if (userPrompt.includes("修复范围与方向")) {
      const original = extractBetween(userPrompt, "原始正文：", "修复范围与方向：");
      return { text: original || draft, model: "stub-patch", route: input.route, durationMs: 1 };
    }

    // 第 2 轮：有证据 → 生成正文
    if (userPrompt.includes("已检索到的证据")) {
      return { text: draft, model: "stub-doubao", route: input.route, durationMs: 2 };
    }

    // 第 1 轮：无证据 → 发 tool_call 指令
    const toolCallDirective = `<tool_call>{"name":"search_chapter_span","arguments":{"query":"${SEARCHABLE_KEYWORD}","maxChapters":10,"maxResults":5}}</tool_call>`;
    return { text: toolCallDirective, model: "stub-doubao", route: input.route, durationMs: 1 };
  };
  return { fn, calls };
}

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) return "";
  return text.slice(start + startMarker.length, end).trim();
}

// ============================================================================
// Setup helper：创建临时 workspace + 全套 NovelOS 组件
// ============================================================================

const tmpRoots = [];

function setupLoop(opts = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "novelos-loop-"));
  tmpRoots.push(tmpRoot);
  const workspaceId = "test-ws";
  const workspaceRoot = join(tmpRoot, "workspaces", workspaceId);

  // 写入历史章节（含可检索关键词）
  mkdirSync(join(workspaceRoot, "chapters", "chapter-1"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, "chapters", "chapter-1", "final.md"),
    `第一章 初醒\n\n林默睁开眼，感觉到复苏之眼在体内涌动。青鱼嘴的夜晚很静。\n`,
    "utf-8",
  );

  // config.json
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    join(workspaceRoot, "config.json"),
    JSON.stringify({
      workspaceId,
      novelType: "urban_fantasy",
      characters: [{ name: "林默", role: "protagonist" }],
    }),
    "utf-8",
  );

  // narrative-state.json（characterUpdates 格式）
  writeFileSync(
    join(workspaceRoot, "narrative-state.json"),
    JSON.stringify({
      characterUpdates: [
        { name: "林默", field: "ability", value: "复苏之眼" },
      ],
    }),
    "utf-8",
  );

  // skeleton.json（canon events）
  writeFileSync(
    join(workspaceRoot, "skeleton.json"),
    JSON.stringify({
      chapterId: "ch1",
      events: [
        { eventId: "evt-1", type: "ability_rule", summary: "复苏之眼能力觉醒", characters: ["林默"], location: "青鱼嘴" },
      ],
      locations: ["青鱼嘴"],
    }),
    "utf-8",
  );

  const session = createNovelSession({
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    workspaceId,
    chapterId: "ch2",
    requestSummary: "生成第2章正文",
    route: "narrator_primary",
  });

  const budget = new BudgetPolicy(
    opts.budget ?? { maxTurns: 10, maxToolCalls: 20, maxLatencyMs: 300_000 },
  );
  const trajectory = new TrajectoryStore({
    projectRoot: tmpRoot,
    workspaceId,
    sessionId: session.sessionId,
    persist: false,
  });

  const searchService = createNarrativeSearchService({
    projectRoot: tmpRoot,
    workspaceId,
    sourceChapter: "ch2",
  });
  const permissionPolicy = new PermissionPolicy({
    workspaceRoot,
    sessionId: session.sessionId,
  });
  const registry = createNarrativeToolRegistry({
    searchService,
    permissionPolicy,
  });

  const { fn: modelGenerate, calls } = createReActStubModel(opts.model ?? {});
  const tools = registry.getToolsForRole("agent");

  const runtime = createNovelOSRuntime({
    session,
    systemPrompt: "你是顶尖网文作家。通过工具检索证据后生成正文。",
    modelGenerate,
    route: "narrator_primary",
    tools,
    budget,
    trajectory,
    kind: "novelos_agentic",
  });

  const candidateWorkspace = createCandidateWorkspace({
    workspaceRoot,
    sessionId: session.sessionId,
  });

  const loop = createNarrativeAgentLoop({
    runtime,
    registry,
    searchService,
    candidateWorkspace,
    permissionPolicy,
    budget,
    trajectory,
    ...(opts.coverageGate ? { coverageGate: opts.coverageGate } : {}),
    ...(opts.maxCoverageRetries !== undefined
      ? { maxCoverageRetries: opts.maxCoverageRetries }
      : {}),
    // 不传 verifier/patchService → 跳过 verify/patch（D.2 专门测试）
  });

  return { loop, runtime, budget, trajectory, candidateWorkspace, tmpRoot, registry, modelCalls: calls };
}

// ============================================================================
// 最小 CompiledContext（loop.run 必填 context 字段）
// ============================================================================

function minimalContext() {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
  };
}

// ============================================================================
// 清理
// ============================================================================

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
});

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS Narrative Agent Loop（ReAct 架构）", () => {
  it("正常流程：stub 发 tool_call → 工具派发 → 证据回灌 → 生成 draft → fallback=false", async () => {
    const { loop, modelCalls } = setupLoop();

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力复苏",
      seedContext: "角色：林默，地点：青鱼嘴",
      context: minimalContext(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, false, "不应 fallback");
    assert.ok(result.text.length > 0, "应返回 draft 文本");
    assert.equal(
      result.lineage.stopReason,
      "model_declares_sufficient",
      "stopReason 应为 model_declares_sufficient",
    );
    assert.ok(
      result.lineage.sourceRefs.length > 0,
      "应有 confirmed sourceRefs（search_chapter_span 命中）",
    );
    // stub model 应被调用 ≥2 次（第 1 轮发指令，第 2 轮生成正文）
    assert.ok(modelCalls.length >= 2, `model 应被调用 ≥2 次，实际 ${modelCalls.length}`);
  });

  it("模型异常：modelGenerate 抛错 → fallback=true + stopReason=model_error", async () => {
    const { loop, trajectory } = setupLoop({
      model: { shouldThrow: true },
    });

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力",
      seedContext: "角色：林默",
      context: minimalContext(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, true, "应 fallback");
    assert.equal(result.text, "", "fallback 时 text 应为空");
    assert.equal(result.lineage.stopReason, "model_error");

    // trajectory 应记录 failure（streamFn 内部捕获错误 → draft 为空 → loop 记录 failure）
    const failures = trajectory.getEntries().filter((e) => e.type === "failure");
    assert.ok(failures.length >= 1, "trajectory 应记录 failure envelope");
    // stage 为 novelos_draft_generation（覆盖"模型调用失败"与"模型未返回有效 draft 文本"两条路径）
    const draftFailure = failures.find(
      (e) => typeof e.data?.stage === "string" && e.data.stage === "novelos_draft_generation",
    );
    assert.ok(draftFailure, "应有 draft 生成阶段 failure 记录");
  });

  it("预算耗尽：maxToolCalls=1 → 第一次 tool call 耗尽 → fallback=true + stopReason=budget_exhausted", async () => {
    const { loop } = setupLoop({
      budget: { maxTurns: 10, maxToolCalls: 1, maxLatencyMs: 300_000 },
    });

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力",
      seedContext: "角色：林默",
      context: minimalContext(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, true, "应 fallback");
    assert.equal(
      result.lineage.stopReason,
      "budget_exhausted",
      "stopReason 应为 budget_exhausted",
    );
    assert.ok(
      result.lineage.budgetSnapshot.exhausted,
      "budgetSnapshot 应标记 exhausted",
    );
  });

  it("CandidateWorkspace 文件验证：evidence-plan/tool-events/draft/lineage 存在", async () => {
    const { loop, candidateWorkspace } = setupLoop();

    await loop.run({
      chapterIntent: "第2章：林默的能力",
      seedContext: "角色：林默",
      context: minimalContext(),
      knownCharacterNames: ["林默"],
    });

    const dir = candidateWorkspace.getDir();
    assert.ok(existsSync(join(dir, "evidence-plan.json")), "evidence-plan.json 应存在");
    assert.ok(existsSync(join(dir, "tool-events.jsonl")), "tool-events.jsonl 应存在");
    assert.ok(existsSync(join(dir, "draft.md")), "draft.md 应存在");
    assert.ok(existsSync(join(dir, "lineage.json")), "lineage.json 应存在");

    // evidence-plan.json 内容合法
    const plan = JSON.parse(readFileSync(join(dir, "evidence-plan.json"), "utf-8"));
    assert.ok(Array.isArray(plan.mustVerify), "mustVerify 应为数组");

    // lineage.json 内容合法
    const lineage = JSON.parse(readFileSync(join(dir, "lineage.json"), "utf-8"));
    assert.equal(lineage.stopReason, "model_declares_sufficient");
    assert.ok(lineage.toolCalls >= 1, "toolCalls 应 ≥1");
  });

  it("trajectory 回放：含 evidence_plan + tool_event + budget + output", async () => {
    const { loop, trajectory } = setupLoop();

    await loop.run({
      chapterIntent: "第2章：林默的能力",
      seedContext: "角色：林默",
      context: minimalContext(),
      knownCharacterNames: ["林默"],
    });

    const entries = trajectory.getEntries();
    const types = new Set(entries.map((e) => e.type));

    assert.ok(types.has("evidence_plan"), "trajectory 应含 evidence_plan");
    assert.ok(types.has("tool_event"), "trajectory 应含 tool_event");
    assert.ok(types.has("budget"), "trajectory 应含 budget");
    assert.ok(types.has("output"), "trajectory 应含 output（正常完成）");
  });

  it("lineage 记录完整 sourceRefs + toolCalls + evidenceFacts", async () => {
    const { loop } = setupLoop();

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力",
      seedContext: "角色：林默",
      context: minimalContext(),
      knownCharacterNames: ["林默"],
    });

    assert.ok(
      result.lineage.sourceRefs.length > 0,
      "sourceRefs 应非空（search_chapter_span 返回 confirmed）",
    );
    assert.ok(
      result.lineage.sourceRefs.every((r) => typeof r === "string" && r.length > 0),
      "所有 sourceRef 应为非空字符串",
    );
    assert.ok(result.lineage.toolCalls >= 1, "toolCalls 应 ≥1");
    assert.ok(
      result.lineage.evidenceFacts.length > 0,
      "evidenceFacts 应非空（toolResult 文本回灌）",
    );
    assert.ok(
      typeof result.lineage.budgetSnapshot.toolCalls === "number",
      "budgetSnapshot.toolCalls 应为数字",
    );
    // 未传 verifier → verifierCleared=false
    assert.equal(result.lineage.verifierCleared, false, "未传 verifier 时 verifierCleared 应为 false");
    assert.equal(result.repairRounds, 0, "未传 patchService 时 repairRounds 应为 0");
  });

  it("coverage gate receives the plan, compiled context facts, and trajectory path", async () => {
    const calls = [];
    const coverageGate = {
      checkAndBlock(input) {
        calls.push(input);
        return {
          passed: true,
          unverifiedHighRisk: [],
          confirmedItems: [],
          skippedReason: "context_covered",
          failureEnvelope: undefined,
        };
      },
    };
    const { loop, trajectory } = setupLoop({ coverageGate });

    const evidencePlan = {
      known: [],
      unknown: [],
      mustVerify: ["林默真实身份"],
      allowedTools: ["search_chapter_span"],
      stopConditions: {
        maxStagnantRounds: 2,
        verifierHardErrorsCleared: true,
        modelDeclaresSufficient: true,
      },
    };
    await loop.run({
      chapterIntent: "章节意图",
      seedContext: "林默在青鱼嘴",
      context: {
        ...minimalContext(),
        facts: [{ id: "fact-1", content: "林默真实身份已确认", sourceIds: [], kind: "fact" }],
      },
      inviolableFacts: ["林默真实身份"],
      evidencePlan,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].evidencePlan, evidencePlan);
    assert.ok(calls[0].contextCoveredFacts.includes("林默真实身份已确认"));
    assert.equal(calls[0].trajectoryPath, trajectory.getOutputPath());
  });

  it("retries once with an explicit uncovered-fact retrieval prompt", async () => {
    const calls = [];
    const coverageGate = {
      checkAndBlock(input) {
        calls.push(input);
        if (calls.length === 1) {
          return {
            passed: false,
            unverifiedHighRisk: [{ item: "林默真实身份", riskLevel: "P0", reason: "uncovered" }],
            confirmedItems: [],
            failureEnvelope: {
              stage: "must_verify_coverage_gate",
              gate: "unverified_high_risk_facts",
              severity: "hard",
              evidence: [{ item: "林默真实身份", riskLevel: "P0", reason: "uncovered" }],
              recoverable: true,
              retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt",
            },
          };
        }
        return { passed: true, unverifiedHighRisk: [], confirmedItems: [], skippedReason: "context_covered" };
      },
    };
    const { loop, modelCalls } = setupLoop({ coverageGate });

    const result = await loop.run({
      chapterIntent: "章节意图",
      seedContext: "林默在青鱼嘴",
      context: minimalContext(),
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["林默真实身份"],
        allowedTools: ["search_chapter_span"],
        stopConditions: {
          maxStagnantRounds: 2,
          verifierHardErrorsCleared: true,
          modelDeclaresSufficient: true,
        },
      },
    });

    assert.equal(result.fallback, false);
    assert.equal(calls.length, 2);
    assert.ok(
      modelCalls.some((call) => String(call.userPrompt ?? "").includes("林默真实身份")),
      "重试 prompt 应显式包含未覆盖事实",
    );
  });

  it("hard-blocks after the bounded coverage retry is exhausted", async () => {
    const coverageGate = {
      checkAndBlock() {
        return {
          passed: false,
          unverifiedHighRisk: [{ item: "林默真实身份", riskLevel: "P0", reason: "uncovered" }],
          confirmedItems: [],
          failureEnvelope: {
            stage: "must_verify_coverage_gate",
            gate: "unverified_high_risk_facts",
            severity: "hard",
            evidence: [{ item: "林默真实身份", riskLevel: "P0", reason: "uncovered" }],
            recoverable: true,
            retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt",
          },
        };
      },
    };
    const { loop } = setupLoop({ coverageGate, maxCoverageRetries: 1 });

    const result = await loop.run({
      chapterIntent: "章节意图",
      seedContext: "林默在青鱼嘴",
      context: minimalContext(),
      evidencePlan: {
        known: [],
        unknown: [],
        mustVerify: ["林默真实身份"],
        allowedTools: ["search_chapter_span"],
        stopConditions: {
          maxStagnantRounds: 2,
          verifierHardErrorsCleared: true,
          modelDeclaresSufficient: true,
        },
      },
    });

    assert.equal(result.fallback, true);
    assert.equal(result.text, "");
    assert.equal(result.lineage.stopReason, "must_verify_coverage_failed");
    assert.equal(result.lineage.coverageGate?.passed, false);
  });
});
