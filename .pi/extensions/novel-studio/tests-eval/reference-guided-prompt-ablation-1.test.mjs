/**
 * REFERENCE-GUIDED-PROMPT-ABLATION-1：reference 引导的 prompt 消融验收 spec（RED）
 *
 * 任务卡 §6 REFERENCE-GUIDED-PROMPT-ABLATION-1：
 * 利用《神秘复苏》原章作为 evaluator-only 样板，定位模型续写与成熟商业小说之间的
 * 叙事实现差距。
 *
 * 双轨比较（任务卡 §6 双轨比较）：
 *
 * 轨道 A：续写实现能力
 *   - 前 1-3 章 → 模型生成下一章 → 与真实下一章进行 reference-aware 评价
 *   - 评价时允许情节不同，重点比较：
 *     异常如何进入日常 / 危险确认是否延迟且有证据 / 规则信息如何分批释放 /
 *     主角是否做出可理解的生存选择 / 每个场景是否产生新状态 /
 *     对白是否同时承担人物与信息功能 / 章末是否由本章因果推出压力
 *
 * 轨道 B：注入词增益
 *   - 同一 prefix → A1 最小 prompt → A3 精准示例 prompt → A4 当前完整 prompt → 匿名比较各生成稿
 *   - reference 只帮助 evaluator 判断成熟实现包含了什么，不直接给 generator 提供答案
 *
 * 禁止项（任务卡 §6 禁止项）：
 * - 不以"复现原章事件更多"自动判胜
 * - 不把原文高频词、句长、固定短语直接转成强制 prompt
 * - 不生成"模仿佛前献花风格"等作者身份指令
 * - 不让 reference asset 跨过 evaluator/generator 权限边界
 *
 * 验收（任务卡 §6 验收）：
 * - 每个工艺差距必须附 reference span、生成稿对应 span 和读者影响说明
 * - 只允许形成高层、可迁移、可证伪的 craft hypothesis
 * - hypothesis 必须在未参与提炼的验证集上产生明确正收益，才能进入策略候选
 *
 * 架构边界：
 * - 复用 ReferenceRegistry.resolve()（evaluator-only）
 * - 复用 sanitizeForGenerator / auditLeakage（generator/evaluator 隔离）
 * - 复用 reference-aware-judge 的 5 维度 + span 验证 + 反向复判
 * - 复用 buildAblationPrompt（A1/A3/A4 arm 构造）来自 prompt-context-ablation.ts
 *
 * 授权边界（任务卡 §10）：
 * - 真实 Claude Opus 4.6 续写 / gpt-5.6-sol reference-aware judge 属于 REQUIRES_AUTH
 * - 本 RED spec 用 stub 模式验证框架结构与聚合逻辑，不调用真实 API
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");
const MODULE_PATH = join(
  EXTENSION_ROOT,
  "dist-eval",
  "novelos",
  "eval",
  "reference-guided-prompt-ablation.js",
);
const CLI_PATH = join(
  PROJECT_ROOT,
  "scripts",
  "novelbench",
  "reference-guided-prompt-ablation.mjs",
);

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：动态 import 模块
// ─────────────────────────────────────────────────────────────────────────────

async function importModule() {
  return import(`file://${MODULE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造 stub case / case set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一个最小可用的 ReferenceGuidedCase（用于 stub 测试）。
 * 包含 prefixChapters（前 1-3 章）+ referenceId（指向真实下一章）+
 * intent（用于 Track B 的 A1/A3/A4 prompt 构造）。
 */
function makeStubCase(caseId, opts = {}) {
  const prefixCount = opts.prefixCount ?? 2;
  const prefixChapters = [];
  for (let i = 0; i < prefixCount; i++) {
    prefixChapters.push({
      chapterNumber: i + 1,
      title: `第${i + 1}章 异常开端`,
      text: `这是 case ${caseId} 的第 ${i + 1} 章前文。主角发现异常，开始调查。` +
        `段落${i + 1}：他听见门外有奇怪的声响，像是指甲刮过木板。`,
    });
  }
  return {
    caseId,
    workspaceId: "stub-workspace",
    bookId: "stub-book",
    prefixChapters,
    referenceId: `ref-${caseId}`,
    referenceChapterNumber: prefixCount + 1,
    referenceChapterTitle: `第${prefixCount + 1}章 规则初现`,
    intent: {
      primary: `case ${caseId} 本章意图：调查异常并发现规则`,
      chapterTheme: "恐怖调查",
      chapterFunction: "investigation",
      readerExperience: ["紧张", "好奇"],
      currentPressure: ["时间紧迫", "信息不足"],
      inviolableFacts: ["主角不知道怪物身份", "异常规则尚未揭示"],
      focusCharacterGoals: [
        { character: "主角", goal: "查明真相" },
      ],
      resistance: ["线索中断", "信息被隐藏"],
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

function makeStubCaseSet(count, opts = {}) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    cases.push(makeStubCase(`case-${i + 1}`, opts));
  }
  return {
    bookId: "stub-book",
    caseSetId: "stub-ref-case-set-v1",
    referenceSourcePath: opts.referenceSourcePath ?? "D:/Download/novelbag/神秘复苏.txt",
    cases,
    createdAt: "2026-07-19T00:00:00Z",
  };
}

/**
 * 构造一段伪造的 reference 正文（用于 stub 测试）。
 * 真实使用时由 ReferenceRegistry.resolve(referenceId) 读取外部文件。
 */
function makeStubReferenceText(caseId) {
  return `第3章 规则初现

主角走进昏暗的走廊，脚下的木板发出吱呀的声响。他屏住呼吸，握紧手中的手电筒。

走廊尽头有一扇虚掩的门，门缝里透出微弱的光。他犹豫了片刻，还是推开了门。

房间里空无一人，但桌上摊着一本笔记。他翻开第一页，上面只有一行字：
"看见它的人，必须在三秒内闭眼。"

他听见身后传来细微的脚步声。一秒。两秒。三秒——

他猛地闭眼，但已经太晚了。身后传来一声叹息，接着是冰冷的气息掠过他的后颈。`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：stub fetch（覆盖 globalThis.fetch）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stub fetch for raw generation：
 * - Track A：返回续写正文（不暴露 reference 内容）
 * - Track B：根据 arm 返回不同质量的正文（与 prompt-context-ablation 一致）
 */
function makeStubFetchGenerator(opts = {}) {
  const track = opts.track ?? "A"; // A or B
  return async (input, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages?.map((m) => m.content).join("\n") ?? "";

    let text = "";
    if (track === "A") {
      // Track A 续写：返回一段正文，不含 reference 内容
      text = `第3章 规则初现\n\n主角走进昏暗的走廊，脚下的木板发出吱呀声响。` +
        `他握紧手电筒，缓缓推开走廊尽头的门。` +
        `桌上有一本笔记，他翻开，看到一行字："看见它的人，必须立刻闭眼。"\n\n` +
        `[track-A stub] 这是续写生成的正文。`;
    } else {
      // Track B：根据 arm 返回不同质量
      let arm = "A0";
      if (prompt.includes("前章悬置状态")) arm = "A1";
      if (prompt.includes("主角核心冲突") || prompt.includes("作品宪法")) arm = "A2";
      if (prompt.includes("accepted/revision") || prompt.includes("精准示例")) arm = "A3";
      if (prompt.includes("compact block") || prompt.includes("【承诺状态")) arm = "A4";

      const qualityByArm = opts.qualityByArm ?? {
        A0: "low", A1: "medium", A2: "medium", A3: "high", A4: "high",
      };
      const quality = qualityByArm[arm] ?? "medium";
      const baseLength = quality === "high" ? 3000 : quality === "low" ? 800 : 2000;
      const body_text = Array.from({ length: Math.ceil(baseLength / 100) }, (_, i) =>
        `段落${i + 1}：[${arm}][${quality}] Track B stub 正文片段。`,
      ).join("\n\n");
      text = `第3章 标题\n\n${body_text}`;
    }

    await new Promise((r) => setTimeout(r, 5));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model ?? "stub-model",
        choices: [
          { message: { content: text }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(text.length / 4),
        },
      }),
      text: async () => JSON.stringify({ text }),
    };
  };
}

/**
 * stub fetch for reference-aware judge：返回 JSON verdict。
 * winner 为 "A" 或 "B" 或 "tie"。
 */
function makeStubJudgeFetch(winnerLetter = "A") {
  return async (input, init) => {
    const body = JSON.parse(init.body);
    const userPrompt = body.messages?.find((m) => m.role === "user")?.content ?? "";
    const textA = userPrompt.match(/【正文 A】\n([\s\S]*?)\n\n【正文 B】/)?.[1] ?? "A";
    const textB = userPrompt.match(/【正文 B】\n([\s\S]*?)\n\n请比较/)?.[1] ?? "B";

    const winner = winnerLetter;
    const loser = winner === "A" ? "B" : "A";
    const winnerText = winner === "A" ? textA : textB;
    const loserText = winner === "A" ? textB : textA;

    const verdict = {
      winner,
      reason: `${winner} 在叙事实现上更成熟。`,
      dimensions: [
        { dimension: "中文自然度", winner, reason: "更自然" },
        { dimension: "情节推进", winner, reason: "推进更实质" },
        { dimension: "人物质感", winner, reason: "人物更鲜活" },
        { dimension: "细节画面", winner, reason: "画面感更强" },
        { dimension: "章末张力", winner, reason: "钩子更足" },
      ],
      winningSpans: [{ letter: winner, excerpt: winnerText.slice(0, 20) }],
      losingSpans: [{ letter: loser, excerpt: loserText.slice(0, 20) }],
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model ?? "stub-judge",
        choices: [{ message: { content: JSON.stringify(verdict) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
      text: async () => JSON.stringify(verdict),
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：模块导出
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：模块导出", () => {
  it("模块文件存在且可导入", async () => {
    const mod = await importModule();
    assert.ok(mod, "模块应可导入");
  });

  it("导出双轨 prompt 构造函数：buildTrackAPrompt + buildTrackBPrompt", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.buildTrackAPrompt, "function", "应导出 buildTrackAPrompt");
    assert.equal(typeof mod.buildTrackBPrompt, "function", "应导出 buildTrackBPrompt");
  });

  it("导出 case set 加载函数 loadReferenceGuidedCaseSet", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.loadReferenceGuidedCaseSet, "function");
  });

  it("导出 stub / real / 核心运行函数", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.runReferenceGuidedAblation, "function");
    assert.equal(typeof mod.runReferenceGuidedAblationStub, "function");
    assert.equal(typeof mod.runReferenceGuidedAblationReal, "function");
  });

  it("导出 craft gap / hypothesis 工具函数", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.extractCraftGaps, "function", "应导出 extractCraftGaps");
    assert.equal(typeof mod.validateCraftHypothesis, "function", "应导出 validateCraftHypothesis");
    assert.equal(typeof mod.enforceGeneratorIsolation, "function", "应导出 enforceGeneratorIsolation");
  });

  it("导出 markdown 格式化函数", async () => {
    const mod = await importModule();
    assert.equal(typeof mod.formatReferenceGuidedResultAsMarkdown, "function");
  });

  it("导出常量：TRACK_NAMES + CRAFT_GAP_DIMENSIONS + HYPOTHESIS_RECOMMENDED_INJECTIONS", async () => {
    const mod = await importModule();
    assert.ok(Array.isArray(mod.TRACK_NAMES), "TRACK_NAMES 应为数组");
    assert.ok(mod.TRACK_NAMES.includes("A"), "TRACK_NAMES 应含 'A'");
    assert.ok(mod.TRACK_NAMES.includes("B"), "TRACK_NAMES 应含 'B'");
    assert.ok(Array.isArray(mod.CRAFT_GAP_DIMENSIONS), "CRAFT_GAP_DIMENSIONS 应为数组");
    assert.ok(mod.CRAFT_GAP_DIMENSIONS.length >= 5, "至少 5 个差距维度");
    assert.ok(Array.isArray(mod.HYPOTHESIS_RECOMMENDED_INJECTIONS));
    assert.ok(mod.HYPOTHESIS_RECOMMENDED_INJECTIONS.length >= 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：buildTrackAPrompt（轨道 A：续写实现能力）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：buildTrackAPrompt", () => {
  it("Track A prompt 含前文章节正文（prefixChapters）", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackAPrompt(caseData);
    assert.ok(result.userPrompt.includes("前文") || result.userPrompt.includes("前章"),
      "Track A prompt 应含前文");
    // 应至少包含一个 prefix chapter 的内容片段
    assert.ok(
      result.userPrompt.includes("主角发现异常") ||
      result.userPrompt.includes("异常开端"),
      "Track A prompt 应含 prefixChapters 内容",
    );
  });

  it("Track A prompt 含写下一章指令", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackAPrompt(caseData);
    assert.ok(
      result.userPrompt.includes("写完整下一章") ||
      result.userPrompt.includes("写第") ||
      result.userPrompt.includes("完整正文"),
      "Track A prompt 应含写下一章指令",
    );
  });

  it("Track A prompt 不得包含 reference 下一章正文 / sourcePath / offset / bodyHash", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackAPrompt(caseData);
    // 不得泄露 reference 内容
    assert.ok(!result.userPrompt.includes("看见它的人，必须"),
      "Track A prompt 不得包含 reference 下一章正文片段");
    assert.ok(!result.userPrompt.includes(caseData.referenceId),
      "Track A prompt 不得包含 referenceId");
    // 不得泄露 sourcePath / offset / bodyHash
    assert.ok(!result.userPrompt.includes("sourcePath"),
      "Track A prompt 不得包含 sourcePath");
    assert.ok(!result.userPrompt.includes("startOffset"),
      "Track A prompt 不得包含 startOffset");
    assert.ok(!result.userPrompt.includes("bodyHash"),
      "Track A prompt 不得包含 bodyHash");
  });

  it("Track A prompt 不得包含作者身份指令", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackAPrompt(caseData);
    // 任务卡禁止项：不生成"模仿佛前献花风格"等作者身份指令
    assert.ok(!result.userPrompt.includes("模仿佛前"),
      "Track A prompt 不得包含作者身份指令（模仿佛前）");
    assert.ok(!result.userPrompt.includes("模仿"),
      "Track A prompt 不得包含'模仿'作者风格指令");
    assert.ok(!/作者风格|佛前|神秘复苏作者/.test(result.userPrompt),
      "Track A prompt 不得包含原作作者身份相关指令");
  });

  it("Track A prompt 返回 systemPrompt + userPrompt + promptTokenEstimate", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackAPrompt(caseData);
    assert.ok(typeof result.systemPrompt === "string");
    assert.ok(typeof result.userPrompt === "string");
    assert.ok(typeof result.promptTokenEstimate === "number");
    assert.ok(result.promptTokenEstimate > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：buildTrackBPrompt（轨道 B：注入词增益，复用 A1/A3/A4）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：buildTrackBPrompt", () => {
  it("Track B A1 prompt 含 bridge_context / chapter_intent / immutable_facts", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackBPrompt("A1", caseData);
    assert.ok(
      result.userPrompt.includes("前章悬置状态") ||
      result.userPrompt.includes("前章末事件"),
      "Track B A1 应含 bridge_context",
    );
    assert.ok(
      result.userPrompt.includes("本章意图") ||
      result.userPrompt.includes("本章功能"),
      "Track B A1 应含 chapter_intent",
    );
  });

  it("Track B A3 prompt 含 accepted/revision 示例", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackBPrompt("A3", caseData);
    assert.ok(
      result.userPrompt.includes("accepted/revision") ||
      result.userPrompt.includes("精准示例") ||
      result.userPrompt.includes("他屏息走向"),
      "Track B A3 应含 accepted/revision 示例",
    );
  });

  it("Track B A4 prompt 是当前完整 prompt（含 compact block）", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    const result = mod.buildTrackBPrompt("A4", caseData);
    // A4 应包含生产 compact block 标记
    assert.ok(
      result.userPrompt.includes("compact block") ||
      result.userPrompt.includes("【承诺状态"),
      "Track B A4 应含 compact block 标记",
    );
  });

  it("Track B prompt 同样不得包含 reference 内容 / 作者身份指令", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    for (const armId of ["A1", "A3", "A4"]) {
      const result = mod.buildTrackBPrompt(armId, caseData);
      assert.ok(!result.userPrompt.includes("看见它的人，必须"),
        `Track B ${armId} 不得包含 reference 正文`);
      assert.ok(!result.userPrompt.includes(caseData.referenceId),
        `Track B ${armId} 不得包含 referenceId`);
      assert.ok(!/作者风格|佛前|神秘复苏作者|模仿/.test(result.userPrompt),
        `Track B ${armId} 不得包含作者身份指令`);
    }
  });

  it("Track B 支持合法 armId（A0/A1/A2/A3/A4），非法 armId 抛错", async () => {
    const mod = await importModule();
    const caseData = makeStubCase("c1");
    for (const armId of ["A0", "A1", "A2", "A3", "A4"]) {
      const result = mod.buildTrackBPrompt(armId, caseData);
      assert.ok(result.userPrompt.length > 0, `armId=${armId} 应返回非空 prompt`);
    }
    assert.throws(() => mod.buildTrackBPrompt("A5", caseData), /armId|invalid/i);
    assert.throws(() => mod.buildTrackBPrompt("X", caseData), /armId|invalid/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：loadReferenceGuidedCaseSet
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：loadReferenceGuidedCaseSet", () => {
  it("加载合法 JSON 文件", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ref-case-set.json");
    const fs = await import("node:fs/promises");
    const caseSet = makeStubCaseSet(3);
    await fs.writeFile(tmpFile, JSON.stringify(caseSet), "utf-8");
    try {
      const loaded = await mod.loadReferenceGuidedCaseSet(tmpFile);
      assert.equal(loaded.caseSetId, caseSet.caseSetId);
      assert.equal(loaded.cases.length, 3);
      assert.equal(loaded.bookId, "stub-book");
    } finally {
      await fs.unlink(tmpFile);
    }
  });

  it("缺少 cases 数组时抛错", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ref-case-set-bad.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpFile, JSON.stringify({ bookId: "x" }), "utf-8");
    try {
      await assert.rejects(() => mod.loadReferenceGuidedCaseSet(tmpFile), /cases/);
    } finally {
      await fs.unlink(tmpFile);
    }
  });

  it("case 缺少 prefixChapters 或 referenceId 时抛错", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ref-case-set-bad2.json");
    const fs = await import("node:fs/promises");
    const badCaseSet = {
      bookId: "x",
      caseSetId: "y",
      cases: [{ caseId: "c1", workspaceId: "w" }], // 缺 prefixChapters 和 referenceId
    };
    await fs.writeFile(tmpFile, JSON.stringify(badCaseSet), "utf-8");
    try {
      await assert.rejects(
        () => mod.loadReferenceGuidedCaseSet(tmpFile),
        /prefixChapters|referenceId/,
      );
    } finally {
      await fs.unlink(tmpFile);
    }
  });

  it("case 的 prefixChapters 至少 1 章，至多 3 章", async () => {
    const mod = await importModule();
    const tmpFile = join(PROJECT_ROOT, ".tmp-test-ref-case-set-bad3.json");
    const fs = await import("node:fs/promises");
    const badCaseSet = {
      bookId: "x",
      caseSetId: "y",
      cases: [
        { caseId: "c1", workspaceId: "w", prefixChapters: [], referenceId: "r1" },
      ],
    };
    await fs.writeFile(tmpFile, JSON.stringify(badCaseSet), "utf-8");
    try {
      await assert.rejects(
        () => mod.loadReferenceGuidedCaseSet(tmpFile),
        /prefixChapters|至少|empty/,
      );
    } finally {
      await fs.unlink(tmpFile);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 5：enforceGeneratorIsolation（generator/evaluator 边界）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：enforceGeneratorIsolation", () => {
  it("合法 generator prompt（无 reference 资产字段）通过检查", async () => {
    const mod = await importModule();
    const prompt = {
      systemPrompt: "你是顶尖网文作家。",
      userPrompt: "前文：主角走入走廊。\n请写第3章完整正文。",
    };
    const result = mod.enforceGeneratorIsolation(prompt);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it("含 sourcePath 的 generator prompt 不通过检查", async () => {
    const mod = await importModule();
    const prompt = {
      systemPrompt: "你是顶尖网文作家。",
      userPrompt: "参考：sourcePath=D:/secret/神秘复苏.txt\n请写第3章完整正文。",
    };
    const result = mod.enforceGeneratorIsolation(prompt);
    assert.equal(result.passed, false);
    assert.ok(result.violations.length > 0);
    assert.ok(result.violations.some((v) => /sourcePath/.test(v)));
  });

  it("含 referenceId / referenceNextChapter 的 generator prompt 不通过检查", async () => {
    const mod = await importModule();
    const prompt = {
      systemPrompt: "你是顶尖网文作家。",
      userPrompt: "referenceId=ref-c1\nreferenceNextChapter=第3章 规则初现\n请写第3章完整正文。",
    };
    const result = mod.enforceGeneratorIsolation(prompt);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => /referenceId|referenceNextChapter/.test(v)));
  });

  it("含 bodyHash / startOffset / endOffset 的 generator prompt 不通过检查", async () => {
    const mod = await importModule();
    const prompt = {
      systemPrompt: "你是顶尖网文作家。",
      userPrompt: "bodyHash=abc123\nstartOffset=1024\nendOffset=2048\n请写第3章正文。",
    };
    const result = mod.enforceGeneratorIsolation(prompt);
    assert.equal(result.passed, false);
    assert.ok(result.violations.length >= 3, "应识别 bodyHash/startOffset/endOffset 三处违规");
  });

  it("含原作作者身份指令的 generator prompt 不通过检查", async () => {
    const mod = await importModule();
    const prompt = {
      systemPrompt: "你是顶尖网文作家。",
      userPrompt: "请模仿佛前献花风格写第3章。\n保持神秘复苏作者的笔触。",
    };
    const result = mod.enforceGeneratorIsolation(prompt);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => /作者|模仿|佛前/.test(v)),
      "应识别作者身份指令违规");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 6：extractCraftGaps（工艺差距提取）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：extractCraftGaps", () => {
  it("从 reference + generated 中提取至少一个 craft gap", async () => {
    const mod = await importModule();
    const referenceText = makeStubReferenceText("c1");
    const generatedText = `第3章 规则初现\n\n主角走进走廊，看见一扇门，推开，发现一本笔记。\n笔记上写着规则。他看完规则，转身离开。`;
    const gaps = mod.extractCraftGaps(referenceText, generatedText, {
      caseId: "c1",
    });
    assert.ok(Array.isArray(gaps));
    assert.ok(gaps.length >= 1, "应至少提取一个 craft gap");
  });

  it("每个 craft gap 必须含 referenceSpan + generatedSpan + readerImpact", async () => {
    const mod = await importModule();
    const referenceText = makeStubReferenceText("c1");
    const generatedText = `第3章 规则初现\n\n主角推开门，发现笔记。他看完规则，转身离开。`;
    const gaps = mod.extractCraftGaps(referenceText, generatedText, {
      caseId: "c1",
    });
    for (const gap of gaps) {
      assert.ok(gap.referenceSpan, "gap.referenceSpan 必填");
      assert.ok(typeof gap.referenceSpan.excerpt === "string");
      assert.ok(gap.referenceSpan.excerpt.length > 0);
      assert.ok(gap.generatedSpan, "gap.generatedSpan 必填");
      assert.ok(typeof gap.generatedSpan.excerpt === "string");
      assert.ok(gap.generatedSpan.excerpt.length > 0);
      assert.ok(gap.readerImpact, "gap.readerImpact 必填");
      assert.ok(typeof gap.readerImpact === "string");
      assert.ok(gap.readerImpact.length > 0);
    }
  });

  it("referenceSpan.excerpt 必须是 referenceText 的子串", async () => {
    const mod = await importModule();
    const referenceText = makeStubReferenceText("c1");
    const generatedText = `第3章 规则初现\n\n主角推开门，发现笔记。`;
    const gaps = mod.extractCraftGaps(referenceText, generatedText, {
      caseId: "c1",
    });
    for (const gap of gaps) {
      assert.ok(
        referenceText.includes(gap.referenceSpan.excerpt) ||
        referenceText.replace(/\s+/g, "").includes(gap.referenceSpan.excerpt.replace(/\s+/g, "")),
        `referenceSpan.excerpt 必须是 referenceText 的子串：${gap.referenceSpan.excerpt.slice(0, 30)}`,
      );
    }
  });

  it("generatedSpan.excerpt 必须是 generatedText 的子串", async () => {
    const mod = await importModule();
    const referenceText = makeStubReferenceText("c1");
    const generatedText = `第3章 规则初现\n\n主角推开门，发现笔记。他看完规则，转身离开。`;
    const gaps = mod.extractCraftGaps(referenceText, generatedText, {
      caseId: "c1",
    });
    for (const gap of gaps) {
      assert.ok(
        generatedText.includes(gap.generatedSpan.excerpt) ||
        generatedText.replace(/\s+/g, "").includes(gap.generatedSpan.excerpt.replace(/\s+/g, "")),
        `generatedSpan.excerpt 必须是 generatedText 的子串：${gap.generatedSpan.excerpt.slice(0, 30)}`,
      );
    }
  });

  it("craft gap 必须含 dimension（属于 CRAFT_GAP_DIMENSIONS）", async () => {
    const mod = await importModule();
    const referenceText = makeStubReferenceText("c1");
    const generatedText = `第3章 规则初现\n\n主角推开门，发现笔记。`;
    const gaps = mod.extractCraftGaps(referenceText, generatedText, {
      caseId: "c1",
    });
    for (const gap of gaps) {
      assert.ok(gap.dimension, "gap.dimension 必填");
      assert.ok(
        mod.CRAFT_GAP_DIMENSIONS.includes(gap.dimension),
        `gap.dimension=${gap.dimension} 应属于 CRAFT_GAP_DIMENSIONS`,
      );
    }
  });

  it("空 reference 或空 generated 返回空数组（不得编造 gap）", async () => {
    const mod = await importModule();
    const gaps1 = mod.extractCraftGaps("", "some text", { caseId: "c1" });
    assert.deepEqual(gaps1, []);
    const gaps2 = mod.extractCraftGaps("some text", "", { caseId: "c1" });
    assert.deepEqual(gaps2, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 7：validateCraftHypothesis
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：validateCraftHypothesis", () => {
  function makeStubHypothesis() {
    return {
      hypothesisId: "h-001",
      title: "异常先以日常媒介出现",
      applicableScene: "恐怖悬疑日常转异常",
      referenceEvidence: [
        {
          referenceId: "ref-c1",
          excerpt: "门缝里透出微弱的光",
          readerImpact: "建立日常与异常的过渡",
        },
      ],
      expectedReaderGain: "读者感到异常逐渐侵蚀日常，紧张感递增",
      possibleDamage: "若过度使用门/光媒介会变成套路",
      forbiddenMigration: ["不复制原文具体措辞", "不引入佛前献花设定"],
      recommendedInjection: "raw_prompt",
      validationState: "pending",
    };
  }

  it("合法 hypothesis 结构通过 schema 校验", async () => {
    const mod = await importModule();
    const h = makeStubHypothesis();
    const result = mod.validateCraftHypothesis(h, []);
    assert.ok(result.schemaValid, "合法 hypothesis 应通过 schema 校验");
    assert.equal(result.schemaErrors.length, 0);
  });

  it("缺 applicableScene / referenceEvidence / expectedReaderGain 时 schema 失败", async () => {
    const mod = await importModule();
    const bad = { ...makeStubHypothesis(), applicableScene: "" };
    const r1 = mod.validateCraftHypothesis(bad, []);
    assert.equal(r1.schemaValid, false);
    assert.ok(r1.schemaErrors.some((e) => /applicableScene/.test(e)));

    const bad2 = { ...makeStubHypothesis(), referenceEvidence: [] };
    const r2 = mod.validateCraftHypothesis(bad2, []);
    assert.equal(r2.schemaValid, false);
    assert.ok(r2.schemaErrors.some((e) => /referenceEvidence/.test(e)));

    const bad3 = { ...makeStubHypothesis(), expectedReaderGain: "" };
    const r3 = mod.validateCraftHypothesis(bad3, []);
    assert.equal(r3.schemaValid, false);
    assert.ok(r3.schemaErrors.some((e) => /expectedReaderGain/.test(e)));
  });

  it("recommendedInjection 必须属于 HYPOTHESIS_RECOMMENDED_INJECTIONS", async () => {
    const mod = await importModule();
    const bad = { ...makeStubHypothesis(), recommendedInjection: "invalid_location" };
    const r = mod.validateCraftHypothesis(bad, []);
    assert.equal(r.schemaValid, false);
    assert.ok(r.schemaErrors.some((e) => /recommendedInjection/.test(e)));
  });

  it("未在验证集上产生正收益的 hypothesis 不得进入候选（validationState≠admitted）", async () => {
    const mod = await importModule();
    const h = makeStubHypothesis();
    // 空验证集 → 无证据 → 不得 admitted
    const r = mod.validateCraftHypothesis(h, []);
    assert.notEqual(r.validationState, "admitted",
      "空验证集下 hypothesis 不得 admitted");
    assert.ok(["pending", "rejected", "insufficient_evidence"].includes(r.validationState),
      `空验证集下 validationState 应为 pending/rejected/insufficient_evidence，实际：${r.validationState}`);
  });

  it("在验证集上产生明确正收益的 hypothesis 可 admitted", async () => {
    const mod = await importModule();
    const h = makeStubHypothesis();
    // 构造多个正收益样本：hypothesis 注入后胜率 > 0.55
    const validationSamples = [];
    for (let i = 0; i < 10; i++) {
      validationSamples.push({
        caseId: `val-${i + 1}`,
        withHypothesisWin: true,  // 注入后胜出
        withoutHypothesisWin: false,  // 不注入时落败
        seed: i,
      });
    }
    const r = mod.validateCraftHypothesis(h, validationSamples);
    assert.equal(r.validationState, "admitted",
      `正收益样本≥门槛时 hypothesis 应 admitted，实际：${r.validationState}`);
    assert.ok(r.winRate >= 0.55, `winRate 应 ≥ 0.55，实际：${r.winRate}`);
  });

  it("样本数不足时 hypothesis 不得 admitted（insufficient_evidence）", async () => {
    const mod = await importModule();
    const h = makeStubHypothesis();
    const validationSamples = [
      { caseId: "v1", withHypothesisWin: true, withoutHypothesisWin: false, seed: 0 },
      { caseId: "v2", withHypothesisWin: true, withoutHypothesisWin: false, seed: 1 },
    ];
    const r = mod.validateCraftHypothesis(h, validationSamples);
    assert.equal(r.validationState, "insufficient_evidence");
    assert.ok(r.sampleSize < 5, "样本数应不足 5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 8：runReferenceGuidedAblationStub — 轨道 A（续写实现能力）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：Track A stub 执行", () => {
  it("Track A stub 生成续写正文并执行 reference-aware 评价", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(3);
    const originalFetch = globalThis.fetch;
    let rawCalled = false;
    let judgeCalled = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("stub://ref-ablation/raw") || url.includes("/chat/completions")) {
        rawCalled = true;
        return makeStubFetchGenerator({ track: "A" })(input, init);
      }
      if (url.includes("stub://ref-ablation/judge") || url.includes("/judge")) {
        judgeCalled = true;
        return makeStubJudgeFetch("A")(input, init);
      }
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        rounds: 1,
      });
      assert.ok(rawCalled, "Track A 应调用 raw 生成");
      assert.ok(judgeCalled, "Track A 应调用 reference-aware judge");
      assert.ok(result.trackAResults, "结果应含 trackAResults");
      assert.equal(result.trackAResults.length, 3, "每个 case 一个 Track A 结果");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Track A 每个 case 结果含 generatedText + referenceText + pairResults + craftGaps", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        rounds: 1,
      });
      for (const r of result.trackAResults) {
        assert.ok(typeof r.generatedText === "string");
        assert.ok(r.generatedText.length > 0);
        assert.ok(typeof r.referenceText === "string");
        assert.ok(r.referenceText.length > 0);
        assert.ok(Array.isArray(r.pairResults));
        assert.ok(Array.isArray(r.craftGaps));
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Track A 不得以'复现原章事件更多'自动判胜", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        rounds: 1,
      });
      // Track A 结果不得包含"事件复现率"作为 winner 决定因素
      for (const r of result.trackAResults) {
        for (const p of r.pairResults) {
          assert.ok(!p.reason || !/事件复现|event_reproduction|reproduces_more/.test(p.reason),
            "不得以事件复现率自动判胜");
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Track A referenceText 仅出现在 evaluator 路径（judge prompt），不出现在 raw 生成 prompt", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    const rawPrompts = [];
    const judgePrompts = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(init.body);
      const prompt = body.messages?.map((m) => m.content).join("\n") ?? "";
      if (url.includes("judge")) {
        judgePrompts.push(prompt);
        return makeStubJudgeFetch("A")(input, init);
      }
      rawPrompts.push(prompt);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        rounds: 1,
      });
      // raw prompt 不得包含 reference 内容
      const refSnippet = "看见它的人，必须";
      for (const p of rawPrompts) {
        assert.ok(!p.includes(refSnippet),
          "raw 生成 prompt 不得包含 reference 正文片段");
      }
      // judge prompt 应包含 reference 内容（reference-aware 评价需要）
      const judgeHasRef = judgePrompts.some((p) => p.includes(refSnippet));
      assert.ok(judgeHasRef, "judge prompt 应包含 reference 正文（reference-aware 评价）");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 9：runReferenceGuidedAblationStub — 轨道 B（注入词增益）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：Track B stub 执行", () => {
  it("Track B stub 对每个 case 生成 A1/A3/A4 三臂候选并匿名比较", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "B" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        trackBArms: ["A1", "A3", "A4"],
        judgePairs: [["A1", "A4"], ["A3", "A4"]],
      });
      assert.ok(result.trackBResults);
      assert.equal(result.trackBResults.length, 2);
      // 每个 case 应有 A1/A3/A4 三臂候选
      for (const r of result.trackBResults) {
        const armIds = r.samples.map((s) => s.armId).sort();
        assert.deepEqual(armIds, ["A1", "A3", "A4"]);
        // 应有匿名比较结果
        assert.ok(Array.isArray(r.pairResults));
        assert.ok(r.pairResults.length >= 1);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Track B 匿名比较时不得在 judge prompt 中暴露 arm 标识", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    const judgePrompts = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(init.body);
      const prompt = body.messages?.map((m) => m.content).join("\n") ?? "";
      if (url.includes("judge")) {
        judgePrompts.push(prompt);
        return makeStubJudgeFetch("A")(input, init);
      }
      return makeStubFetchGenerator({ track: "B" })(input, init);
    };
    try {
      await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        trackBArms: ["A1", "A3", "A4"],
        judgePairs: [["A1", "A4"]],
      });
      // judge prompt 不得直接包含 "A1"/"A3"/"A4" 标识
      for (const p of judgePrompts) {
        // 注意：reference-aware judge prompt 可能包含 reference 正文（其中可能有 A/B 字母）
        // 但不应包含 "[A1]"/"[A3]"/"[A4]" 这样的 arm 标记
        assert.ok(!/\[A[1-4]\]/.test(p), "judge prompt 不得包含 [A1]/[A3]/[A4] arm 标记");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Track B 默认 judgePairs 为 [[A1, A4], [A3, A4]]（A1/A3 vs A4）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "B" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        // 不传 trackBArms / judgePairs，使用默认
      });
      const r = result.trackBResults[0];
      const pairKeys = r.pairResults.map((p) => `${p.armLeft}-${p.armRight}`);
      assert.ok(pairKeys.includes("A1-A4"), "默认应包含 A1 vs A4 比较");
      assert.ok(pairKeys.includes("A3-A4"), "默认应包含 A3 vs A4 比较");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Track B stub 至少运行 A1/A3/A4 三臂（任务卡指定）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "B" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      const r = result.trackBResults[0];
      const armIds = new Set(r.samples.map((s) => s.armId));
      assert.ok(armIds.has("A1"), "Track B 应至少运行 A1");
      assert.ok(armIds.has("A3"), "Track B 应至少运行 A3");
      assert.ok(armIds.has("A4"), "Track B 应至少运行 A4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 10：双轨联合执行 + 结果聚合
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：双轨联合执行 + 结果聚合", () => {
  it("同时运行 Track A + Track B 并分别返回结果", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A", "B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
        rounds: 1,
      });
      assert.ok(result.trackAResults);
      assert.ok(result.trackBResults);
      assert.equal(result.trackAResults.length, 2);
      assert.equal(result.trackBResults.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("结果含 ablationRunId + caseSetHash（可复现性 / 稳定性）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A", "B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      assert.ok(typeof result.ablationRunId === "string");
      assert.ok(result.ablationRunId.length > 0);
      assert.ok(typeof result.caseSetHash === "string");
      assert.ok(result.caseSetHash.length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("相同 caseSet 两次运行 caseSetHash 相同（稳定性）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const r1 = await mod.runReferenceGuidedAblationStub({
        caseSet, tracks: ["A"], resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      const r2 = await mod.runReferenceGuidedAblationStub({
        caseSet, tracks: ["A"], resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      assert.equal(r1.caseSetHash, r2.caseSetHash, "相同 caseSet 的 caseSetHash 应相同");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("productionGating.canChangeProductionPrompt = false（不直接改变生产）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A", "B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      assert.ok(result.productionGating);
      assert.equal(result.productionGating.canChangeProductionPrompt, false);
      assert.equal(result.productionGating.canChangeDefaultInjection, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 11：craft hypothesis 提炼与验证集正收益门槛
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：craft hypothesis 提炼门槛", () => {
  it("stub 模式下结果含 craftHypotheses 数组（可为空，但字段必须存在）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      assert.ok(Array.isArray(result.craftHypotheses),
        "结果应含 craftHypotheses 数组（stub 模式下可为空）");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("所有 admitted 的 hypothesis 必须有 ≥ 0.55 验证集胜率 + ≥ 5 样本数", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      for (const h of result.craftHypotheses) {
        if (h.validationState === "admitted") {
          assert.ok(h.winRate >= 0.55, `admitted hypothesis winRate 应 ≥ 0.55，实际：${h.winRate}`);
          assert.ok(h.sampleSize >= 5, `admitted hypothesis sampleSize 应 ≥ 5，实际：${h.sampleSize}`);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hypothesis 不得包含原文长片段（≥ 20 字连续串）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      // 任务卡 §3 强制边界：衍生规则不得包含可识别的长原文片段
      for (const h of result.craftHypotheses) {
        for (const ev of h.referenceEvidence ?? []) {
          if (ev.excerpt) {
            assert.ok(ev.excerpt.length < 50,
              `referenceEvidence.excerpt 长度应 < 50 字（span 只用于本地审计），实际：${ev.excerpt.length}`);
          }
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 12：CLI 入口
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：CLI 入口", () => {
  it("CLI 文件存在", () => {
    assert.ok(existsSync(CLI_PATH), `CLI 应存在于 ${CLI_PATH}`);
  });

  it("CLI --help 输出用法说明", () => {
    const result = spawnSync("node", [CLI_PATH, "--help"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, `CLI --help 应退出 0，实际：${result.status}\nstderr: ${result.stderr}`);
    const stdout = result.stdout ?? "";
    assert.ok(/usage|用法|--case-set|--stub/i.test(stdout),
      "CLI --help 应输出用法说明");
  });

  it("CLI --stub 模式可运行并输出 JSON 结果", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ref-ablation-cli-"));
    const caseSetPath = join(tmpDir, "case-set.json");
    const outputPath = join(tmpDir, "result.json");
    await writeFile(caseSetPath, JSON.stringify(makeStubCaseSet(2)), "utf-8");
    try {
      const result = spawnSync("node", [
        CLI_PATH,
        "--case-set", caseSetPath,
        "--stub",
        "--tracks", "A,B",
        "--samples-per-case", "1",
        "--output", outputPath,
      ], {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0,
        `CLI --stub 应退出 0，实际：${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
      const fs = await import("node:fs/promises");
      const out = JSON.parse(await fs.readFile(outputPath, "utf-8"));
      assert.ok(out.ablationRunId, "结果应含 ablationRunId");
      assert.ok(out.caseSetHash, "结果应含 caseSetHash");
      assert.ok(Array.isArray(out.trackAResults) || Array.isArray(out.trackBResults),
        "结果应含 trackAResults 或 trackBResults");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("CLI --stub 缺少 --case-set 时退出非零并报错", () => {
    const result = spawnSync("node", [
      CLI_PATH, "--stub",
    ], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0, "缺少 --case-set 应退出非零");
    const combined = (result.stderr ?? "") + (result.stdout ?? "");
    assert.ok(/case-set|required|missing/i.test(combined),
      "应提示缺少 --case-set");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 13：markdown 格式化
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：formatReferenceGuidedResultAsMarkdown", () => {
  it("markdown 含 ablationRunId + caseSetHash", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A", "B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      const md = mod.formatReferenceGuidedResultAsMarkdown(result);
      assert.ok(typeof md === "string");
      assert.ok(md.includes(result.ablationRunId), "markdown 应含 ablationRunId");
      assert.ok(md.includes(result.caseSetHash), "markdown 应含 caseSetHash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("markdown 含中文关键章节标题（轨道 A / 轨道 B / 工艺差距 / craft hypothesis）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A", "B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      const md = mod.formatReferenceGuidedResultAsMarkdown(result);
      // markdown 应至少包含轨道 A / 轨道 B 标题
      assert.ok(/轨道\s*A|Track\s*A|trackAResults/i.test(md), "markdown 应含轨道 A 章节");
      assert.ok(/轨道\s*B|Track\s*B|trackBResults/i.test(md), "markdown 应含轨道 B 章节");
      // 应包含工艺差距或 craft hypothesis 章节
      assert.ok(/工艺差距|craft\s*gap|craftGaps/i.test(md) ||
                /craft\s*hypothesis|craftHypotheses/i.test(md),
        "markdown 应含工艺差距 / craft hypothesis 章节");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("markdown 含 productionGating 警告（不直接改变生产）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      const result = await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A", "B"],
        resolveReference: (refId) => makeStubReferenceText(refId),
        samplesPerCase: 1,
      });
      const md = mod.formatReferenceGuidedResultAsMarkdown(result);
      assert.ok(/productionGating|不直接改变生产|授权|REQUIRES_AUTH/i.test(md),
        "markdown 应含 productionGating 警告");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 14：架构边界
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-GUIDED-PROMPT-ABLATION-1：架构边界", () => {
  it("模块不得直接 import reference-registry（reference 解封由 CLI 处理）", async () => {
    // 模块通过 resolveReference 回调接收 reference 正文，不直接 import ReferenceRegistry
    const mod = await importModule();
    // 模块导出不含 ReferenceRegistry 类
    assert.ok(!mod.ReferenceRegistry, "不得导出 ReferenceRegistry 类");
    // 模块应有 resolveReference 回调参数（通过函数签名间接验证）
    assert.equal(typeof mod.runReferenceGuidedAblation, "function");
  });

  it("resolveReference 回调是 evaluator-only 入口（CLI 调 registry.resolve 后传入）", async () => {
    const mod = await importModule();
    const caseSet = makeStubCaseSet(1);
    const originalFetch = globalThis.fetch;
    let resolveCalled = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("judge")) return makeStubJudgeFetch("A")(input, init);
      return makeStubFetchGenerator({ track: "A" })(input, init);
    };
    try {
      await mod.runReferenceGuidedAblationStub({
        caseSet,
        tracks: ["A"],
        resolveReference: (refId) => {
          resolveCalled = true;
          return makeStubReferenceText(refId);
        },
        samplesPerCase: 1,
        rounds: 1,
      });
      assert.ok(resolveCalled, "Track A 应调用 resolveReference 回调");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("模块不得 import generator-bundle / chapter-splitter / dataset-builder", async () => {
    // 通过模块导出间接验证：模块不应导出这些 novelbench 内部模块的函数
    const mod = await importModule();
    assert.ok(!mod.sanitizeForGenerator, "不得直接导出 sanitizeForGenerator");
    assert.ok(!mod.writeGeneratorBundle, "不得直接导出 writeGeneratorBundle");
    assert.ok(!mod.auditLeakage, "不得直接导出 auditLeakage");
    assert.ok(!mod.ChapterSplitter, "不得直接导出 ChapterSplitter");
  });
});
