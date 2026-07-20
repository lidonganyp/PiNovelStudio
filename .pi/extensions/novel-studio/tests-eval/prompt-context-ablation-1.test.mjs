/**
 * PROMPT-CONTEXT-ABLATION-1：上下文块消融实验验收 spec（RED）
 *
 * 任务卡 §6 PROMPT-CONTEXT-ABLATION-1：
 * - 5 个实验臂 A0/A1/A2/A3/A4，逐层叠加上下文块
 * - 同模型 / 同 provider / 同 token 预算 / 同停止条件
 * - 每个 case × 每个实验臂 ≥ 2 个独立采样（seed/temperature/finish_reason）
 * - 至少 15 个验证 case
 * - 输出各实验臂匿名胜率、tie、事实 hard regression、AI 痕迹、成本、长度完整性
 * - 任一上下文块只有跨场景稳定正收益才保留默认注入
 * - 没有正收益证据的 advisory 改为 JIT 检索、editorial diagnosis 或移除
 *
 * 实验臂定义（任务卡 §6）：
 *   A0：极简续写基线        前文 + 写完整下一章
 *   A1：最小必要主链路      A0 + 前章桥接 + ChapterIntent + immutable facts + 关键角色状态
 *   A2：作品核心层          A1 + CreativeConstitution 相关字段
 *   A3：精准示例层          A2 + 2-3 个本作品 accepted/revision 对比示例
 *   A4：当前完整 prompt     当前所有生产可消费上下文块
 *
 * 控制变量：
 * - 同一模型版本、provider、上下文窗口、输出预算、停止条件
 * - 不通过更换模型掩盖 prompt 负收益
 * - prompt token、正文 token、延迟、成本单独统计
 *
 * 准入门槛：
 * - 至少 15 个验证 case
 * - 每个实验臂每 case ≥ 2 个独立采样
 * - 输出各臂匿名胜率 / tie / 事实 hard regression / AI 痕迹 / 成本 / 长度完整性
 * - 任一上下文块只有跨场景稳定正收益才保留默认注入
 *
 * 授权边界：
 * - 真实 Claude Opus 4.6 批量 raw 生成 / gpt-5.6-sol judge 属于 REQUIRES_AUTH
 * - 本 RED spec 用 stub 模式验证框架结构与聚合逻辑，不调用真实 API
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");
const MODULE_PATH = join(EXTENSION_ROOT, "dist-eval", "novelos", "eval", "prompt-context-ablation.js");
const CLI_PATH = join(PROJECT_ROOT, "scripts", "novelbench", "prompt-context-ablation.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：动态 import 模块
// ─────────────────────────────────────────────────────────────────────────────

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造 stub case set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一个最小可用的 AblationCase（用于 stub 测试）。
 * 不调用真实 workspace 加载，所有字段直接构造。
 */
function makeStubCase(caseId) {
  return {
    caseId,
    workspaceId: "stub-workspace",
    chapterNumber: 5,
    chapterId: `ch5-${caseId}`,
    previousText: `前文片段：主角站在门前，手心出汗。这是 case ${caseId} 的前文。`,
    intent: {
      primary: `case ${caseId} 本章意图：调查异常`,
      chapterTheme: "恐怖调查",
      chapterFunction: "investigation",
      readerExperience: ["紧张", "好奇"],
      currentPressure: ["时间紧迫", "信息不足"],
      inviolableFacts: ["主角不知道怪物身份"],
      focusCharacterGoals: [
        { character: "主角", goal: "查明真相" },
      ],
      resistance: ["线索中断"],
      choicesAndCosts: [
        { choice: "深入调查", cost: "暴露风险" },
      ],
      expectedIrreversibleChange: ["主角认知改变"],
      causalEndPressure: ["更深的谜团"],
      relevantCharacters: ["主角", "配角A"],
    },
    bridgeContext: {
      available: true,
      lastEventSummary: "前章主角发现线索",
      endingEmotion: "紧张",
      openHooks: ["hook-1"],
      unresolvedTensions: ["未解之谜"],
      introducedCharacters: ["配角A"],
    },
    immutableFacts: ["世界观硬约束1", "世界观硬约束2"],
    characterStates: [
      {
        characterId: "主角",
        name: "主角",
        state: {
          role: "protagonist",
          mentality: "焦虑",
          pendingTension: "对未知的恐惧",
          aliases: [],
        },
      },
    ],
    worldRules: [
      {
        id: "world:genre",
        description: "恐怖悬疑",
        type: "genre",
        affectedCharacters: [],
      },
      {
        id: "world:immutable:0",
        description: "世界观硬约束1",
        type: "immutable_fact",
        affectedCharacters: [],
      },
    ],
    constitution: {
      workIdentity: "心魔界",
      readerPromise: ["每一章都有新发现"],
      genrePromises: ["恐怖感递增"],
      protagonistCoreConflict: "主角 vs 内心恐惧",
      thematicQuestions: ["何为真实"],
      aestheticDirection: ["冷峻"],
      forbiddenDrift: ["不写轻松桥段"],
    },
    acceptedRevisionExamples: [
      {
        before: "他走向门。",
        after: "他屏息走向那扇虚掩的门，指尖触碰冰冷的铜把。",
        reason: "增加感官细节与紧张感",
        dimension: "场景沉浸",
      },
    ],
    modelRoute: "v2_rawstage2",
    timeoutMs: 60_000,
    maxTokens: 4096,
  };
}

function makeStubCaseSet(count) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    cases.push(makeStubCase(`case-${i + 1}`));
  }
  return {
    bookId: "stub-book",
    caseSetId: "stub-case-set-v1",
    cases,
    createdAt: "2026-07-19T00:00:00Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：stub model generator（覆盖 globalThis.fetch）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stub fetch：根据 prompt 中的特征返回不同的"生成正文"。
 * 不同实验臂返回不同质量的正文，便于测试聚合逻辑。
 *
 * 返回 OpenAI 兼容格式：
 * {
 *   choices: [{ message: { content: "..." }, finish_reason: "stop" }],
 *   usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }
 * }
 */
function makeStubFetchGenerator(qualityByArm) {
  return async (input, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages?.map((m) => m.content).join("\n") ?? "";
    // 根据 prompt 中的特征判断实验臂（与 buildAblationPrompt 的中文标记对齐）
    let arm = "A0";
    if (prompt.includes("前章悬置状态")) arm = "A1";
    if (prompt.includes("主角核心冲突") || prompt.includes("作品宪法")) arm = "A2";
    if (prompt.includes("accepted/revision") || prompt.includes("精准示例")) arm = "A3";
    if (prompt.includes("compact block") || prompt.includes("【承诺状态") || prompt.includes("【读者期待")) arm = "A4";

    const quality = qualityByArm[arm] ?? "medium";
    const text = generateStubChapterText(arm, quality, body);

    // 模拟延迟
    await new Promise((r) => setTimeout(r, 5));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model ?? "stub-model",
        choices: [
          {
            message: { content: text },
            finish_reason: text.length > 3500 ? "length" : "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(text.length / 4),
          total_tokens: Math.ceil((prompt.length + text.length) / 4),
        },
      }),
      text: async () => JSON.stringify({ text }),
    };
  };
}

function generateStubChapterText(arm, quality, body) {
  // 不同 arm + quality 返回不同长度/质量的正文
  const armTag = `[${arm}]`;
  const qualityTag = `[${quality}]`;
  const baseLength = quality === "high" ? 3000 : quality === "low" ? 800 : 2000;
  const body_text = Array.from({ length: Math.ceil(baseLength / 100) }, (_, i) =>
    `段落${i + 1}：${armTag}${qualityTag} 这是 ${body.model ?? "stub"} 生成的第 ${i + 1} 段正文，包含一些情节与对白。`
  ).join("\n\n");
  return `第${body.model ? "5" : "5"}章 标题\n\n${body_text}`;
}

/**
 * stub fetch：用于 pairwise judge（返回 JSON verdict）
 */
function makeStubJudgeFetch(winnerArm = "A4") {
  return async (input, init) => {
    const body = JSON.parse(init.body);
    const userPrompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
    // 简单：根据 prompt 中是否包含 "A4" 标记决定胜方
    // 实际 stub 中我们会让 A4 总是赢（除非测试相反场景）
    const leftWins = userPrompt.includes("候选甲") && userPrompt.includes(winnerArm);
    const rightWins = userPrompt.includes("候选乙") && userPrompt.includes(winnerArm);
    let verdictWinner = "tie";
    if (leftWins && !rightWins) verdictWinner = "A";
    else if (rightWins && !leftWins) verdictWinner = "B";

    const verdict = {
      winner: verdictWinner,
      confidence: 0.7,
      dimensions: [
        {
          name: "事实正确性（与前文/设定一致性）",
          winner: verdictWinner,
          reason: "stub reason",
          evidenceA: [{ start: 0, end: 10, excerpt: "stub excerpt A" }],
          evidenceB: [{ start: 0, end: 10, excerpt: "stub excerpt B" }],
        },
        {
          name: "叙事推进力（情节/冲突/状态变化）",
          winner: verdictWinner,
          reason: "stub reason",
          evidenceA: [{ start: 0, end: 10, excerpt: "stub excerpt A" }],
          evidenceB: [{ start: 0, end: 10, excerpt: "stub excerpt B" }],
        },
        {
          name: "中文自然度（语感/翻译腔/AI腔）",
          winner: verdictWinner,
          reason: "stub reason",
          evidenceA: [{ start: 0, end: 10, excerpt: "stub excerpt A" }],
          evidenceB: [{ start: 0, end: 10, excerpt: "stub excerpt B" }],
        },
        {
          name: "读者体验（钩子/期待/信息释放）",
          winner: verdictWinner,
          reason: "stub reason",
          evidenceA: [{ start: 0, end: 10, excerpt: "stub excerpt A" }],
          evidenceB: [{ start: 0, end: 10, excerpt: "stub excerpt B" }],
        },
        {
          name: "人物塑造（动机/矛盾/群像层次）",
          winner: verdictWinner,
          reason: "stub reason",
          evidenceA: [{ start: 0, end: 10, excerpt: "stub excerpt A" }],
          evidenceB: [{ start: 0, end: 10, excerpt: "stub excerpt B" }],
        },
      ],
      hardFactRisk: false,
      literaryRegressionRisk: false,
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model ?? "stub-judge",
        choices: [{ message: { content: JSON.stringify(verdict) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      }),
      text: async () => JSON.stringify(verdict),
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：模块导出
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：模块导出", () => {
  it("模块文件存在且可导入", async () => {
    const mod = await importModule();
    assert.ok(mod, "模块应可导入");
  });

  it("导出 5 个实验臂常量", async () => {
    const mod = await importModule();
    assert.equal(mod.ABLATION_ARMS.length, 5, "应有 5 个实验臂");
    const armIds = mod.ABLATION_ARMS.map((a) => a.id);
    assert.deepEqual(armIds, ["A0", "A1", "A2", "A3", "A4"], "实验臂 ID 顺序应为 A0→A4");
  });

  it("每个实验臂定义了名称、描述、激活上下文块清单", async () => {
    const mod = await importModule();
    for (const arm of mod.ABLATION_ARMS) {
      assert.ok(arm.id, "arm.id 必填");
      assert.ok(arm.name, "arm.name 必填");
      assert.ok(arm.description, "arm.description 必填");
      assert.ok(Array.isArray(arm.activeBlocks), "arm.activeBlocks 必填为数组");
    }
  });

  it("A0 activeBlocks 不含 chapter_intent / bridge_context / immutable_facts", async () => {
    const mod = await importModule();
    const a0 = mod.ABLATION_ARMS.find((a) => a.id === "A0");
    assert.ok(a0, "A0 必须存在");
    assert.ok(!a0.activeBlocks.includes("chapter_intent"), "A0 不应含 chapter_intent");
    assert.ok(!a0.activeBlocks.includes("bridge_context"), "A0 不应含 bridge_context");
    assert.ok(!a0.activeBlocks.includes("immutable_facts"), "A0 不应含 immutable_facts");
  });

  it("A1 activeBlocks 含 bridge_context / chapter_intent / immutable_facts / character_states", async () => {
    const mod = await importModule();
    const a1 = mod.ABLATION_ARMS.find((a) => a.id === "A1");
    assert.ok(a1, "A1 必须存在");
    assert.ok(a1.activeBlocks.includes("bridge_context"), "A1 应含 bridge_context");
    assert.ok(a1.activeBlocks.includes("chapter_intent"), "A1 应含 chapter_intent");
    assert.ok(a1.activeBlocks.includes("immutable_facts"), "A1 应含 immutable_facts");
    assert.ok(a1.activeBlocks.includes("character_states"), "A1 应含 character_states");
  });

  it("A2 = A1 + creative_constitution", async () => {
    const mod = await importModule();
    const a1 = mod.ABLATION_ARMS.find((a) => a.id === "A1");
    const a2 = mod.ABLATION_ARMS.find((a) => a.id === "A2");
    for (const b of a1.activeBlocks) {
      assert.ok(a2.activeBlocks.includes(b), `A2 应包含 A1 的所有块：${b}`);
    }
    assert.ok(a2.activeBlocks.includes("creative_constitution"), "A2 应含 creative_constitution");
  });

  it("A3 = A2 + accepted_revision_examples", async () => {
    const mod = await importModule();
    const a2 = mod.ABLATION_ARMS.find((a) => a.id === "A2");
    const a3 = mod.ABLATION_ARMS.find((a) => a.id === "A3");
    for (const b of a2.activeBlocks) {
      assert.ok(a3.activeBlocks.includes(b), `A3 应包含 A2 的所有块：${b}`);
    }
    assert.ok(a3.activeBlocks.includes("accepted_revision_examples"), "A3 应含 accepted_revision_examples");
  });

  it("A4 activeBlocks 包含所有生产上下文块", async () => {
    const mod = await importModule();
    const a4 = mod.ABLATION_ARMS.find((a) => a.id === "A4");
    assert.ok(a4.activeBlocks.includes("promise_context"), "A4 应含 promise_context");
    assert.ok(a4.activeBlocks.includes("expectation_context"), "A4 应含 expectation_context");
    assert.ok(a4.activeBlocks.includes("genre_contract"), "A4 应含 genre_contract");
    assert.ok(a4.activeBlocks.includes("dialogue_craft"), "A4 应含 dialogue_craft");
    assert.ok(a4.activeBlocks.includes("emotion_rhythm"), "A4 应含 emotion_rhythm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：buildAblationPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：buildAblationPrompt", () => {
  it("A0 prompt 仅含前文 + 写下一章指令，不含任何上下文块", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildAblationPrompt("A0", caseData);
    assert.ok(result.userPrompt.includes("前文"), "A0 应含前文");
    assert.ok(result.userPrompt.includes("写完整下一章") || result.userPrompt.includes("完整正文"), "A0 应含写章指令");
    // A0 不应包含任何上下文块内容
    assert.ok(!result.userPrompt.includes("前章悬置状态"), "A0 不应含 bridge_context");
    assert.ok(!result.userPrompt.includes("本章意图"), "A0 不应含 chapter_intent");
    assert.ok(!result.userPrompt.includes("不可破坏的事实"), "A0 不应含 immutable_facts");
    assert.ok(!result.userPrompt.includes("主角核心冲突"), "A0 不应含 constitution");
  });

  it("A1 prompt 含 bridge_context + chapter_intent + immutable_facts + character_states", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildAblationPrompt("A1", caseData);
    assert.ok(result.userPrompt.includes("前章悬置状态") || result.userPrompt.includes("前章末事件"), "A1 应含 bridge_context");
    assert.ok(result.userPrompt.includes("本章意图") || result.userPrompt.includes("本章功能"), "A1 应含 chapter_intent");
    assert.ok(result.userPrompt.includes("不可破坏") || result.userPrompt.includes("不可破坏的事实"), "A1 应含 immutable_facts");
  });

  it("A2 prompt 含 CreativeConstitution 字段", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildAblationPrompt("A2", caseData);
    assert.ok(result.userPrompt.includes("主角核心冲突"), "A2 应含 protagonistCoreConflict");
    assert.ok(result.userPrompt.includes("心魔界"), "A2 应含 workIdentity");
  });

  it("A3 prompt 含 accepted/revision 对比示例", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildAblationPrompt("A3", caseData);
    assert.ok(
      result.userPrompt.includes("accepted/revision") ||
      result.userPrompt.includes("精准示例") ||
      result.userPrompt.includes("对比示例") ||
      result.userPrompt.includes("他屏息走向"),
      "A3 应含 accepted/revision 示例内容"
    );
  });

  it("A4 prompt 含完整生产上下文块（promise/expectation/genre 等）", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildAblationPrompt("A4", caseData);
    // A4 至少应包含 A3 的所有内容
    assert.ok(result.userPrompt.includes("主角核心冲突"), "A4 应含 constitution");
    // A4 应包含生产 compact block（即使为空也会写 emptyReason 或不写，这里检查 prompt 长度 > A3）
    const a3Result = mod.buildAblationPrompt("A3", caseData);
    assert.ok(result.userPrompt.length >= a3Result.userPrompt.length, "A4 prompt 长度应 ≥ A3");
  });

  it("所有 arm 返回 systemPrompt + userPrompt + consumedBlocks + promptTokenEstimate", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    for (const arm of mod.ABLATION_ARMS) {
      const result = mod.buildAblationPrompt(arm.id, caseData);
      assert.ok(typeof result.systemPrompt === "string", `${arm.id} systemPrompt 应为 string`);
      assert.ok(typeof result.userPrompt === "string", `${arm.id} userPrompt 应为 string`);
      assert.ok(Array.isArray(result.consumedBlocks), `${arm.id} consumedBlocks 应为数组`);
      assert.ok(typeof result.promptTokenEstimate === "number", `${arm.id} promptTokenEstimate 应为 number`);
      assert.ok(result.promptTokenEstimate > 0, `${arm.id} promptTokenEstimate 应 > 0`);
    }
  });

  it("consumedBlocks 反映实际进入 prompt 的块（A0 应远少于 A4）", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const a0 = mod.buildAblationPrompt("A0", caseData);
    const a4 = mod.buildAblationPrompt("A4", caseData);
    assert.ok(a0.consumedBlocks.length < a4.consumedBlocks.length, "A0 consumedBlocks 应少于 A4");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：AblationCaseSet 加载与校验
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：loadAblationCaseSet", () => {
  it("加载合法 JSON 文件", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ablation-case-set.json");
    const fs = await import("node:fs/promises");
    const caseSet = makeStubCaseSet(3);
    await fs.writeFile(tmpFile, JSON.stringify(caseSet), "utf-8");
    try {
      const loaded = await mod.loadAblationCaseSet(tmpFile);
      assert.equal(loaded.caseSetId, caseSet.caseSetId);
      assert.equal(loaded.cases.length, 3);
    } finally {
      await fs.unlink(tmpFile);
    }
  });

  it("缺少 cases 数组时抛错", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ablation-case-set-bad.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpFile, JSON.stringify({ bookId: "x" }), "utf-8");
    try {
      await assert.rejects(() => mod.loadAblationCaseSet(tmpFile), /cases/);
    } finally {
      await fs.unlink(tmpFile);
    }
  });

  it("case 缺少 caseId 字段抛错", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ablation-case-set-bad2.json");
    const fs = await import("node:fs/promises");
    const badCaseSet = {
      bookId: "x",
      caseSetId: "y",
      cases: [{ workspaceId: "w" }], // 缺 caseId
    };
    await fs.writeFile(tmpFile, JSON.stringify(badCaseSet), "utf-8");
    try {
      await assert.rejects(() => mod.loadAblationCaseSet(tmpFile), /caseId/);
    } finally {
      await fs.unlink(tmpFile);
    }
  });

  it("case 缺少 intent 字段抛错", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ablation-case-set-bad3.json");
    const fs = await import("node:fs/promises");
    const badCaseSet = {
      bookId: "x",
      caseSetId: "y",
      cases: [{ caseId: "c1", workspaceId: "w" }], // 缺 intent
    };
    await fs.writeFile(tmpFile, JSON.stringify(badCaseSet), "utf-8");
    try {
      await assert.rejects(() => mod.loadAblationCaseSet(tmpFile), /intent/);
    } finally {
      await fs.unlink(tmpFile);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：runPromptContextAblation 主函数（stub 模式）
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：runPromptContextAblationStub", () => {
  it("stub 模式不调用真实 API（fetch 被覆盖）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return makeStubFetchGenerator({ A0: "low", A1: "medium", A2: "medium", A3: "high", A4: "high" })();
    };
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      assert.ok(fetchCalled, "stub fetch 应被调用");
      assert.ok(result, "应返回结果");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("返回结构包含 totalCases / samplesPerCasePerArm / armResults / pairResults", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      assert.equal(result.totalCases, 2);
      assert.equal(result.samplesPerCasePerArm, 1);
      assert.ok(Array.isArray(result.armResults), "armResults 应为数组");
      assert.ok(Array.isArray(result.pairResults), "pairResults 应为数组");
      assert.ok(result.thresholds, "thresholds 必填");
      assert.ok(typeof result.passed === "boolean", "passed 应为 boolean");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("armResults 包含所有 5 个实验臂", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      const armIds = result.armResults.map((a) => a.armId);
      assert.deepEqual(armIds, ["A0", "A1", "A2", "A3", "A4"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("每个 armResult 含 promptTokens / outputTokens / latencyMs / sampleCount / truncatedCount", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      for (const arm of result.armResults) {
        assert.ok(typeof arm.promptTokens === "number", `${arm.armId} promptTokens`);
        assert.ok(typeof arm.outputTokens === "number", `${arm.armId} outputTokens`);
        assert.ok(typeof arm.latencyMs === "number", `${arm.armId} latencyMs`);
        assert.ok(typeof arm.sampleCount === "number", `${arm.armId} sampleCount`);
        assert.ok(typeof arm.truncatedCount === "number", `${arm.armId} truncatedCount`);
        assert.equal(arm.sampleCount, 2, `${arm.armId} sampleCount 应 = samplesPerCasePerArm`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("pairResults 含匿名胜率 / tie / 总比较次数", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      assert.ok(result.pairResults.length >= 1, "至少 1 个 pair 结果");
      const pair = result.pairResults[0];
      assert.ok(pair.armLeft, "pair.armLeft");
      assert.ok(pair.armRight, "pair.armRight");
      assert.ok(typeof pair.leftWinRate === "number", "pair.leftWinRate");
      assert.ok(typeof pair.rightWinRate === "number", "pair.rightWinRate");
      assert.ok(typeof pair.tieRate === "number", "pair.tieRate");
      assert.ok(typeof pair.totalComparisons === "number", "pair.totalComparisons");
      assert.ok(pair.leftWinRate + pair.rightWinRate + pair.tieRate > 0, "胜负率之和应 > 0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("匿名 A/B：pairResults 不暴露 baseline 身份（pairId 不含 winner arm 标识）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      for (const pair of result.pairResults) {
        // pairId 可以含 arm 标识（人类可读），但 judge 调用日志的 prompt 不应含
        assert.ok(pair.judgeInvocations, "pair 应记录 judge 调用日志");
        for (const inv of pair.judgeInvocations) {
          // judge prompt 中不应包含 arm 标识
          assert.ok(!inv.judgePrompt.includes("A0"), "judge prompt 不应含 'A0'");
          assert.ok(!inv.judgePrompt.includes("A4"), "judge prompt 不应含 'A4'");
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hardFactRegressionRate 在 armResult 中追踪", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      for (const arm of result.armResults) {
        assert.ok(typeof arm.hardFactRegressionRate === "number", `${arm.armId} hardFactRegressionRate`);
        assert.ok(arm.hardFactRegressionRate >= 0 && arm.hardFactRegressionRate <= 1, "rate 应在 [0,1]");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aiTraceRate 在 armResult 中追踪", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      for (const arm of result.armResults) {
        assert.ok(typeof arm.aiTraceRate === "number", `${arm.armId} aiTraceRate`);
        assert.ok(arm.aiTraceRate >= 0 && arm.aiTraceRate <= 1, "rate 应在 [0,1]");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lengthIntegrityRate 在 armResult 中追踪（非截断比例）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      for (const arm of result.armResults) {
        assert.ok(typeof arm.lengthIntegrityRate === "number", `${arm.armId} lengthIntegrityRate`);
        assert.ok(arm.lengthIntegrityRate >= 0 && arm.lengthIntegrityRate <= 1, "rate 应在 [0,1]");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：门槛与生产准入
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：门槛与生产准入", () => {
  it("导出 ABLATION_THRESHOLDS 门槛常量", async () => {
    const mod = await importModule();
    assert.ok(mod.ABLATION_THRESHOLDS, "ABLATION_THRESHOLDS 必填");
    assert.ok(typeof mod.ABLATION_THRESHOLDS.minCases === "number", "minCases");
    assert.ok(typeof mod.ABLATION_THRESHOLDS.minSamplesPerCasePerArm === "number", "minSamplesPerCasePerArm");
    assert.equal(mod.ABLATION_THRESHOLDS.minCases, 15, "至少 15 个验证 case");
    assert.ok(mod.ABLATION_THRESHOLDS.minSamplesPerCasePerArm >= 2, "每 case 每 arm 至少 2 个采样");
  });

  it("case 数 < 15 时 passed=false", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(10); // < 15
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      assert.equal(result.passed, false, "case 数不足时 passed=false");
      assert.ok(result.failureReasons?.some((r) => r.includes("minCases") || r.includes("case")), "应记录 minCases 失败原因");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("samplesPerCasePerArm < 2 时 passed=false", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(15);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1, // < 2
        judgePairs: [["A0", "A4"]],
      });
      assert.equal(result.passed, false, "samples 不足时 passed=false");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("productionGating 字段恒为 false（消融实验不改变生产）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(15);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      // 即使实验通过，也不直接改变生产 prompt
      assert.equal(result.productionGating.canChangeProductionPrompt, false, "消融实验不直接改变生产 prompt");
      assert.equal(result.productionGating.canChangeDefaultInjection, false, "消融实验不直接改变默认注入");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retentionRecommendation 字段标注每个上下文块的去留建议", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(15);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"], ["A1", "A4"], ["A2", "A4"], ["A3", "A4"]],
      });
      assert.ok(Array.isArray(result.retentionRecommendation), "retentionRecommendation 应为数组");
      assert.ok(result.retentionRecommendation.length > 0, "应至少有 1 条建议");
      for (const rec of result.retentionRecommendation) {
        assert.ok(rec.blockName, "rec.blockName");
        assert.ok(typeof rec.stablePositiveGain === "boolean", "rec.stablePositiveGain");
        assert.ok(["retain", "demote_to_jit", "demote_to_editorial", "remove"].includes(rec.recommendation), "rec.recommendation 应为合法枚举");
        assert.ok(typeof rec.evidenceSummary === "string", "rec.evidenceSummary");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 6：成本与控制变量
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：成本与控制变量", () => {
  it("每个 armResult 含 promptTokenStats（min/median/max）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      for (const arm of result.armResults) {
        assert.ok(arm.promptTokenStats, `${arm.armId} promptTokenStats`);
        assert.ok(typeof arm.promptTokenStats.min === "number", "min");
        assert.ok(typeof arm.promptTokenStats.median === "number", "median");
        assert.ok(typeof arm.promptTokenStats.max === "number", "max");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("每个 armResult 含 outputTokenStats 与 latencyMsStats", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      for (const arm of result.armResults) {
        assert.ok(arm.outputTokenStats, `${arm.armId} outputTokenStats`);
        assert.ok(arm.latencyMsStats, `${arm.armId} latencyMsStats`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("控制变量元数据记录 model / provider / maxTokens / timeoutMs", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
        controlVariables: {
          modelRoute: "v2_rawstage2",
          provider: "anthropic",
          modelVersion: "claude-opus-4.6",
          maxTokens: 4096,
          timeoutMs: 60_000,
        },
      });
      assert.ok(result.controlVariables, "controlVariables 必填");
      assert.equal(result.controlVariables.modelRoute, "v2_rawstage2");
      assert.equal(result.controlVariables.modelVersion, "claude-opus-4.6");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("每个 sample 记录 seed / temperature / finishReason", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      // samples 应在 details 中可访问
      assert.ok(result.details, "result.details 必填");
      assert.ok(result.details.length > 0, "应至少有 1 个 case detail");
      const caseDetail = result.details[0];
      assert.ok(caseDetail.samples, "caseDetail.samples 必填");
      const a0Samples = caseDetail.samples.filter((s) => s.armId === "A0");
      assert.ok(a0Samples.length >= 1, "应至少有 1 个 A0 sample");
      for (const s of a0Samples) {
        assert.ok(typeof s.seed === "number", "sample.seed");
        assert.ok(typeof s.temperature === "number", "sample.temperature");
        assert.ok(typeof s.finishReason === "string", "sample.finishReason");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 7：Markdown 报告
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：formatPromptContextAblationResultAsMarkdown", () => {
  it("生成 Markdown 报告含关键章节", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(15);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      const md = mod.formatPromptContextAblationResultAsMarkdown(result);
      assert.ok(typeof md === "string", "应返回 string");
      assert.ok(md.includes("PROMPT-CONTEXT-ABLATION-1"), "应含任务 ID");
      assert.ok(md.includes("## ") || md.includes("# "), "应含 markdown 标题");
      assert.ok(md.includes("A0"), "应含 A0");
      assert.ok(md.includes("A4"), "应含 A4");
      assert.ok(md.includes("胜率") || md.includes("win"), "应含胜率信息");
      assert.ok(md.includes("成本") || md.includes("cost") || md.includes("token"), "应含成本信息");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Markdown 含各 arm 的成本与长度完整性表", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"]],
      });
      const md = mod.formatPromptContextAblationResultAsMarkdown(result);
      assert.ok(md.includes("promptTokens") || md.includes("prompt token"), "应含 prompt token");
      assert.ok(md.includes("lengthIntegrity") || md.includes("长度完整性") || md.includes("截断"), "应含长度完整性");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Markdown 含 retentionRecommendation 表", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(15);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 2,
        judgePairs: [["A0", "A4"], ["A1", "A4"], ["A2", "A4"], ["A3", "A4"]],
      });
      const md = mod.formatPromptContextAblationResultAsMarkdown(result);
      assert.ok(
        md.includes("retentionRecommendation") ||
        md.includes("去留建议") ||
        md.includes("保留") ||
        md.includes("移除"),
        "应含去留建议"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 8：CLI
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：CLI scripts/novelbench/prompt-context-ablation.mjs", () => {
  it("CLI 文件存在", () => {
    const fs = readFileSync;
    assert.doesNotThrow(() => fs(CLI_PATH, "utf-8"), "CLI 文件应存在");
  });

  it("CLI --help 显示用法", async () => {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("node", [CLI_PATH, "--help"], { encoding: "utf-8" });
    assert.ok(output.includes("PROMPT-CONTEXT-ABLATION-1"), "应含任务 ID");
    assert.ok(output.includes("--case-set"), "应含 --case-set 参数");
    assert.ok(output.includes("--output"), "应含 --output 参数");
    assert.ok(output.includes("--stub"), "应含 --stub 参数");
  });

  it("CLI --stub 模式不调用真实 API，返回结构化结果", async () => {
    const { execFileSync } = await import("node:child_process");
    // 构造 stub case set 文件
    const tmpCaseSet = join(PROJECT_ROOT, ".tmp-test-ablation-cases.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpCaseSet, JSON.stringify(makeStubCaseSet(2)), "utf-8");
    const tmpOutput = join(PROJECT_ROOT, ".tmp-test-ablation-output.json");
    try {
      execFileSync(
        "node",
        [CLI_PATH, "--stub", "--case-set", tmpCaseSet, "--samples-per-case", "1", "--output", tmpOutput],
        { encoding: "utf-8", timeout: 30_000 }
      );
      const result = JSON.parse(await fs.readFile(tmpOutput, "utf-8"));
      assert.ok(result.totalCases === 2, "应返回 2 个 case 结果");
      assert.ok(result.armResults, "应含 armResults");
    } finally {
      await fs.unlink(tmpCaseSet).catch(() => {});
      await fs.unlink(tmpOutput).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 9：实验臂之间的差异验证
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：实验臂差异", () => {
  it("A0 prompt 长度 < A1 < A2 < A3 ≤ A4", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const lengths = {};
    for (const arm of mod.ABLATION_ARMS) {
      const result = mod.buildAblationPrompt(arm.id, caseData);
      lengths[arm.id] = result.userPrompt.length;
    }
    assert.ok(lengths.A0 < lengths.A1, `A0 (${lengths.A0}) 应 < A1 (${lengths.A1})`);
    assert.ok(lengths.A1 < lengths.A2, `A1 (${lengths.A1}) 应 < A2 (${lengths.A2})`);
    assert.ok(lengths.A2 < lengths.A3, `A2 (${lengths.A2}) 应 < A3 (${lengths.A3})`);
    assert.ok(lengths.A3 <= lengths.A4, `A3 (${lengths.A3}) 应 ≤ A4 (${lengths.A4})`);
  });

  it("A0 consumedBlocks ⊂ A1 ⊂ A2 ⊂ A3 ⊂ A4", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const consumedSets = {};
    for (const arm of mod.ABLATION_ARMS) {
      const result = mod.buildAblationPrompt(arm.id, caseData);
      consumedSets[arm.id] = new Set(result.consumedBlocks);
    }
    // 验证子集关系
    for (const [smaller, larger] of [["A0", "A1"], ["A1", "A2"], ["A2", "A3"], ["A3", "A4"]]) {
      for (const block of consumedSets[smaller]) {
        assert.ok(
          consumedSets[larger].has(block),
          `${larger} 应包含 ${smaller} 的所有 consumedBlocks（缺：${block}）`
        );
      }
    }
  });

  it("不同实验臂生成不同正文（stub 模式）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A1: "medium", A2: "medium", A3: "high", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [],
      });
      const samples = result.details[0].samples;
      const a0Text = samples.find((s) => s.armId === "A0")?.text ?? "";
      const a4Text = samples.find((s) => s.armId === "A4")?.text ?? "";
      // 不同 arm 应产生不同的 stub 正文（包含 arm 标识）
      assert.ok(a0Text.includes("[A0]"), "A0 sample 应含 [A0] 标识");
      assert.ok(a4Text.includes("[A4]"), "A4 sample 应含 [A4] 标识");
      assert.notEqual(a0Text, a4Text, "A0 与 A4 正文应不同");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 10：judgePairs 参数校验
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：judgePairs 参数", () => {
  it("judgePairs 默认包含 [(A0,A4), (A1,A4), (A2,A4), (A3,A4)]", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        // 不传 judgePairs，用默认
      });
      const defaultPairs = result.pairResults.map((p) => [p.armLeft, p.armRight]);
      assert.ok(defaultPairs.some(([l, r]) => l === "A0" && r === "A4"), "默认应含 A0 vs A4");
      assert.ok(defaultPairs.some(([l, r]) => l === "A1" && r === "A4"), "默认应含 A1 vs A4");
      assert.ok(defaultPairs.some(([l, r]) => l === "A2" && r === "A4"), "默认应含 A2 vs A4");
      assert.ok(defaultPairs.some(([l, r]) => l === "A3" && r === "A4"), "默认应含 A3 vs A4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("非法 armId 在 judgePairs 中抛错", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      await assert.rejects(
        () => mod.runPromptContextAblationStub({
          caseSet,
          samplesPerCasePerArm: 1,
          judgePairs: [["A0", "A5"]], // A5 不存在
        }),
        /A5|invalid arm|armId/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("judgePairs=[] 时不生成 pairResults（仅生成 armResults）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [],
      });
      assert.equal(result.pairResults.length, 0, "judgePairs=[] 时 pairResults 应为空");
      assert.ok(result.armResults.length === 5, "仍应生成 5 个 armResults");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 11：实验臂与上下文块映射
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：上下文块映射", () => {
  it("导出 CONTEXT_BLOCK_NAMES（所有上下文块清单）", async () => {
    const mod = await importModule();
    assert.ok(Array.isArray(mod.CONTEXT_BLOCK_NAMES), "CONTEXT_BLOCK_NAMES 应为数组");
    // 应包含核心块
    const expected = ["bridge_context", "chapter_intent", "immutable_facts", "character_states", "creative_constitution", "accepted_revision_examples"];
    for (const name of expected) {
      assert.ok(mod.CONTEXT_BLOCK_NAMES.includes(name), `CONTEXT_BLOCK_NAMES 应含 ${name}`);
    }
  });

  it("A4 activeBlocks ⊆ CONTEXT_BLOCK_NAMES", async () => {
    const mod = await importModule();
    const a4 = mod.ABLATION_ARMS.find((a) => a.id === "A4");
    for (const block of a4.activeBlocks) {
      assert.ok(
        mod.CONTEXT_BLOCK_NAMES.includes(block),
        `A4 activeBlocks 中的 '${block}' 应在 CONTEXT_BLOCK_NAMES 中`
      );
    }
  });

  it("getBlocksForArm('A2') 返回 A2 的激活块", async () => {
    const mod = await importModule();
    const blocks = mod.getBlocksForArm("A2");
    assert.ok(Array.isArray(blocks));
    assert.ok(blocks.includes("creative_constitution"));
    assert.ok(!blocks.includes("accepted_revision_examples"));
  });

  it("getBlocksForArm('A0') 返回空或仅含 previous_text", async () => {
    const mod = await importModule();
    const blocks = mod.getBlocksForArm("A0");
    // A0 仅含 previous_text（不算"上下文块"）
    assert.ok(!blocks.includes("chapter_intent"));
    assert.ok(!blocks.includes("bridge_context"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 12：稳定性与可复现性
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT-CONTEXT-ABLATION-1：稳定性与可复现性", () => {
  it("相同 seed + 相同输入应产生相同的 prompt（A4）", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const r1 = mod.buildAblationPrompt("A4", caseData);
    const r2 = mod.buildAblationPrompt("A4", caseData);
    assert.equal(r1.userPrompt, r2.userPrompt, "相同输入应产生相同 prompt");
    assert.equal(r1.systemPrompt, r2.systemPrompt, "相同输入应产生相同 systemPrompt");
  });

  it("result 含 ablationRunId（可追溯）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      assert.ok(result.ablationRunId, "ablationRunId 必填");
      assert.ok(typeof result.ablationRunId === "string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("result 含 caseSetHash（绑定输入 case set）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeStubFetchGenerator({ A0: "low", A4: "high" });
    try {
      const result = await mod.runPromptContextAblationStub({
        caseSet,
        samplesPerCasePerArm: 1,
        judgePairs: [["A0", "A4"]],
      });
      assert.ok(result.caseSetHash, "caseSetHash 必填");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
