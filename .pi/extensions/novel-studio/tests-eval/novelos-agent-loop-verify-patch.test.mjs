/**
 * NovelOS Agent Loop verify/patch/reverify 闭环测试（D.2）
 *
 * 验证 draft → verify → patch candidate → regression check → reverify 闭环：
 * 1. verifier 清零：draft 无硬失败 → verifierCleared=true, repairRounds=0
 * 2. patch 成功：违规 draft → verify 检出 → patch 修复 → reverify 清零 → 替换 draft
 * 3. patch 退化：违规 draft → patch 大幅缩短 → evaluatePatch 拒绝 → 保留原稿
 * 4. verifier 未提供：不传 verifier/patchService → 跳过 verify/patch
 * 5. 6 文件完整性：含 verifier-report.json + patch-proposals.json
 *
 * 架构（3 阶段 ReAct stub model）：
 * - 第 1 轮（无证据）：发 <tool_call> 指令
 * - 第 2 轮（有证据）：返回 draft（含/不含违规）
 * - patch 阶段（"修复范围与方向"）：返回 patchedText 或退化文本
 *
 * 测试从 ../dist/ import 构建产物（遵循 project_memory 教训）。
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
import { createNarrativeVerifierSuite } from "../dist/novelos/verification/narrative-verifier-suite.js";
import { createCandidatePatchService } from "../dist/novelos/agent/candidate-patch-service.js";

// ============================================================================
// 常量
// ============================================================================

/** 历史章节中可被 search_chapter_span 检索到的关键短语 */
const SEARCHABLE_KEYWORD = "复苏之眼";

/** 干净 draft（无违规，不含 "暗流"） */
const CLEAN_DRAFT =
  "林默站在青鱼嘴的岸边，望着远方的海面。风很大，他紧了紧衣领。" +
  "他知道前方有危险，但必须继续前行。他迈开脚步，向礁石走去。";

/** 违规 draft（含 "林默" + "暗流"，50 字符内 → 触发 knowledge_boundary） */
const VIOLATION_DRAFT =
  "林默站在青鱼嘴的岸边，心中想着水下的暗流。他知道暗流很危险，" +
  "但必须下水。他检查了装备，准备潜入水中寻找线索。";

/** 修复 draft（不含 "暗流"，长度与违规 draft 相近 → 不退化） */
const PATCHED_DRAFT =
  "林默站在青鱼嘴的岸边，心中想着水下的危险。他知道必须下水，" +
  "但不会轻举妄动。他检查了装备，准备潜入水中寻找线索。";

/** 退化 patch（极短 → lengthRatio < 0.7 → 退化） */
const DEGRADED_PATCH = "短。";

// ============================================================================
// 3 阶段 ReAct stub ModelGenerateFn
// ============================================================================

/**
 * 创建 3 阶段 stub model。
 *
 * @param opts.draft 第 2 轮返回的正文（含/不含违规）
 * @param opts.patchedText patch 阶段返回的修复版正文
 * @param opts.patchShouldDegrade patch 阶段返回退化文本
 */
function createVerifyPatchStubModel(opts = {}) {
  const { draft = CLEAN_DRAFT, patchedText = PATCHED_DRAFT, patchShouldDegrade = false } = opts;
  const calls = [];
  const fn = async (input) => {
    calls.push({ ...input });
    const userPrompt = input.userPrompt ?? "";

    // patch 阶段：userPrompt 含"修复范围与方向"
    if (userPrompt.includes("修复范围与方向")) {
      if (patchShouldDegrade) {
        return { text: DEGRADED_PATCH, model: "stub-patch", route: input.route, durationMs: 1 };
      }
      return { text: patchedText, model: "stub-patch", route: input.route, durationMs: 1 };
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

// ============================================================================
// Setup helper
// ============================================================================

const tmpRoots = [];

function setupVerifyPatchLoop(opts = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "novelos-verify-patch-"));
  tmpRoots.push(tmpRoot);
  const workspaceId = "test-ws";
  const workspaceRoot = join(tmpRoot, "workspaces", workspaceId);

  // 历史章节（含可检索关键词）
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

  // narrative-state.json
  writeFileSync(
    join(workspaceRoot, "narrative-state.json"),
    JSON.stringify({
      characterUpdates: [{ name: "林默", field: "ability", value: "复苏之眼" }],
    }),
    "utf-8",
  );

  // skeleton.json
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

  const { fn: modelGenerate, calls } = createVerifyPatchStubModel(opts.model ?? {});
  const tools = registry.getToolsForRole("agent");

  const runtime = createNovelOSRuntime({
    session,
    systemPrompt: "你是顶尖网文作家。通过工具检索证据后生成正文。",
    modelGenerate,
    route: "narrator_primary",
    tools,
    allowedToolNames: new Set(tools.map((t) => t.name)),
    budget,
    trajectory,
    kind: "novelos_agentic",
  });

  const candidateWorkspace = createCandidateWorkspace({
    workspaceRoot,
    sessionId: session.sessionId,
  });

  // 默认传入 verifier + patchService；opts.noVerifier=true 时跳过
  const loopOpts = {
    runtime,
    registry,
    searchService,
    candidateWorkspace,
    permissionPolicy,
    budget,
    trajectory,
  };
  if (!opts.noVerifier) {
    loopOpts.verifier = createNarrativeVerifierSuite();
    loopOpts.patchService = createCandidatePatchService();
  }

  const loop = createNarrativeAgentLoop(loopOpts);

  return { loop, runtime, budget, trajectory, candidateWorkspace, tmpRoot, modelCalls: calls };
}

// ============================================================================
// Context（含 forbiddenKnowledge 使 verifier 能检出知识边界违规）
// ============================================================================

function contextWithForbiddenKnowledge() {
  return {
    facts: [],
    characterStates: [
      {
        characterId: "char:linmo",
        name: "林默",
        state: { forbiddenKnowledge: ["暗流"] },
        sourceIds: ["src:linmo"],
      },
    ],
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

describe("NovelOS Agent Loop verify/patch/reverify 闭环（D.2）", () => {
  it("verifier 清零：draft 无硬失败 → verifierCleared=true, repairRounds=0", async () => {
    const { loop } = setupVerifyPatchLoop({
      model: { draft: CLEAN_DRAFT },
    });

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力复苏",
      seedContext: "角色：林默，地点：青鱼嘴",
      context: contextWithForbiddenKnowledge(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, false, "不应 fallback");
    assert.equal(result.repairRounds, 0, "无硬失败 → repairRounds=0");
    assert.equal(result.lineage.verifierCleared, true, "verifierCleared 应为 true");
    assert.ok(result.verifierReport, "应有 verifierReport");
    assert.equal(
      result.verifierReport.hasHardFailure,
      false,
      "干净 draft 不应有硬失败",
    );
  });

  it("patch 成功：违规 draft → verify 检出 → patch 修复 → reverify 清零 → 替换 draft", async () => {
    const { loop } = setupVerifyPatchLoop({
      model: { draft: VIOLATION_DRAFT, patchedText: PATCHED_DRAFT },
    });

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力复苏",
      seedContext: "角色：林默，地点：青鱼嘴",
      context: contextWithForbiddenKnowledge(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, false, "不应 fallback");
    assert.equal(result.lineage.verifierCleared, true, "patch 后 reverify 清零 → verifierCleared=true");
    assert.ok(result.repairRounds >= 1, "应至少执行 1 轮修复");
    assert.equal(result.text, PATCHED_DRAFT, "patch 后应替换为修复版 draft");
    assert.ok(result.patchProposals.length >= 1, "应有 patch proposals");
    assert.ok(
      result.patchProposals.some((p) => !p.rejected),
      "至少 1 个 proposal 被接受",
    );
  });

  it("patch 退化：违规 draft → patch 大幅缩短 → evaluatePatch 拒绝 → 保留原稿", async () => {
    const { loop } = setupVerifyPatchLoop({
      model: { draft: VIOLATION_DRAFT, patchShouldDegrade: true },
    });

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力复苏",
      seedContext: "角色：林默，地点：青鱼嘴",
      context: contextWithForbiddenKnowledge(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, false, "退化不触发 fallback");
    assert.equal(result.lineage.verifierCleared, false, "退化 → verifierCleared=false");
    assert.equal(result.text, VIOLATION_DRAFT, "退化时应保留原稿（不替换）");
    assert.ok(
      result.patchProposals.some((p) => p.rejected === true),
      "退化 patch 应标记 rejected",
    );
  });

  it("verifier 未提供：不传 verifier/patchService → 跳过 verify/patch", async () => {
    const { loop } = setupVerifyPatchLoop({
      model: { draft: VIOLATION_DRAFT },
      noVerifier: true,
    });

    const result = await loop.run({
      chapterIntent: "第2章：林默的能力复苏",
      seedContext: "角色：林默，地点：青鱼嘴",
      context: contextWithForbiddenKnowledge(),
      knownCharacterNames: ["林默"],
    });

    assert.equal(result.fallback, false, "不应 fallback");
    assert.equal(result.lineage.verifierCleared, false, "未传 verifier → verifierCleared=false");
    assert.equal(result.repairRounds, 0, "未传 patchService → repairRounds=0");
    assert.equal(result.verifierReport, undefined, "未传 verifier → verifierReport undefined");
  });

  it("6 文件完整性：含 verifier-report.json + patch-proposals.json", async () => {
    const { loop, candidateWorkspace } = setupVerifyPatchLoop({
      model: { draft: VIOLATION_DRAFT, patchedText: PATCHED_DRAFT },
    });

    await loop.run({
      chapterIntent: "第2章：林默的能力复苏",
      seedContext: "角色：林默，地点：青鱼嘴",
      context: contextWithForbiddenKnowledge(),
      knownCharacterNames: ["林默"],
    });

    const dir = candidateWorkspace.getDir();
    // 6 文件全部存在
    assert.ok(existsSync(join(dir, "evidence-plan.json")), "evidence-plan.json 应存在");
    assert.ok(existsSync(join(dir, "tool-events.jsonl")), "tool-events.jsonl 应存在");
    assert.ok(existsSync(join(dir, "draft.md")), "draft.md 应存在");
    assert.ok(existsSync(join(dir, "verifier-report.json")), "verifier-report.json 应存在");
    assert.ok(existsSync(join(dir, "patch-proposals.json")), "patch-proposals.json 应存在");
    assert.ok(existsSync(join(dir, "lineage.json")), "lineage.json 应存在");

    // verifier-report.json 含 hasHardFailure 字段
    const report = JSON.parse(readFileSync(join(dir, "verifier-report.json"), "utf-8"));
    assert.equal(typeof report.hasHardFailure, "boolean", "verifier-report 应含 hasHardFailure");

    // patch-proposals.json 是数组且非空
    const proposals = JSON.parse(readFileSync(join(dir, "patch-proposals.json"), "utf-8"));
    assert.ok(Array.isArray(proposals), "patch-proposals 应为数组");
    assert.ok(proposals.length >= 1, "patch-proposals 应非空");
  });
});
