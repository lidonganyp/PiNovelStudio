/**
 * NOVELOS-CONSTRAINT-RELAXATION-1 — RED 测试套件
 *
 * 目标：保留事实安全/连续性/事务硬门，同时消除三类问题：
 * - 写前上下文把全量状态灌入 prompt（P0-1）
 * - verifier 把启发式命中直接判 hard（P0-2）
 * - 语义遗漏触发 [0, text.length] 整章重写循环（P0-3）
 *
 * 本套件为 TDD RED：先全部失败，GREEN 实现后全部通过。
 * 所有测试使用 stub，不调用真实模型。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildChapterIntentString } from "../dist/novelos/agent/agentic-raw-candidate-source.js";
import { createNarrativeVerifierSuite } from "../dist/novelos/verification/narrative-verifier-suite.js";
import { createCandidatePatchService } from "../dist/novelos/agent/candidate-patch-service.js";
import { NarrativeAgentLoop } from "../dist/novelos/agent/narrative-agent-loop.js";
import { classifyAgenticVerificationBlock } from "../dist/v2/core/unified-orchestrator.js";
import { compileFeedback, findingToFeedback } from "../dist/novelos/verification/verification-feedback-compiler.js";
import { selectRepairFindings } from "../dist/novelos/agent/narrative-repair-selector.js";
import { applyLocalReplacements, buildLocalReplacementPrompt } from "../dist/novelos/agent/narrative-patch-merger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMPTY_CONTEXT = {
  facts: [],
  characterStates: [],
  openLoops: [],
  worldRules: [],
  styleReferences: [],
  sourceMap: [],
};

// ============================================================================
// P0-1：收敛 NovelOS 写前上下文
// ============================================================================

test("P0-1 #1：60 条开放伏笔时 prompt 只含选中的 ≤3 条 selectedPromisesToAdvance", () => {
  // 构造 60 条 openPromises，但只选中 3 条
  const openPromises = Array.from({ length: 60 }, (_, i) => ({
    promiseId: `P-${i + 1}`,
    description: `伏笔${i + 1}描述`,
  }));
  const selectedPromisesToAdvance = [
    { promiseId: "P-1", description: "伏笔1描述" },
    { promiseId: "P-30", description: "伏笔30描述" },
    { promiseId: "P-60", description: "伏笔60描述" },
  ];

  const prompt = buildChapterIntentString({
    chapterFunction: "测试章节",
    readerExperience: ["紧张"],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: openPromises.map((p) => `${p.promiseId}：${p.description}`),
    possibleEndPressure: [],
    relevantCharacters: ["李一凡"],
    inviolableFacts: [],
    selectedPromisesToAdvance,
  });

  // 选中 3 条出现在 prompt 中
  assert.match(prompt, /伏笔1描述/);
  assert.match(prompt, /伏笔30描述/);
  assert.match(prompt, /伏笔60描述/);

  // 未选中的 57 条不出现（P-2..P-29, P-31..P-59）
  assert.doesNotMatch(prompt, /伏笔2描述/);
  assert.doesNotMatch(prompt, /伏笔31描述/);
  assert.doesNotMatch(prompt, /伏笔59描述/);

  // 未选中的 promiseId 不出现
  assert.doesNotMatch(prompt, /P-2[：:]/);
  assert.doesNotMatch(prompt, /P-31[：:]/);
});

test("P0-1 #2：prompt 不含全部 thematicQuestions，优先 causalEndPressure", () => {
  const thematicQuestions = [
    "主角的命运是否由自己掌握",
    "力量与责任的关系",
    "信任的边界在哪里",
    "成长意味着什么",
    "牺牲是否值得",
    "真相是否总是必要",
  ];
  const causalEndPressure = "章末必须建立：水怪群退却但暗金竖瞳未消失，定位倒计时启动";

  const prompt = buildChapterIntentString({
    chapterFunction: "测试章节",
    readerExperience: ["紧张"],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    // 旧字段：来自 thematicQuestions 全量
    possibleEndPressure: thematicQuestions.map((q) => `可借章末抛回问题：${q}`),
    relevantCharacters: ["李一凡"],
    inviolableFacts: [],
    causalEndPressure: [causalEndPressure],
  });

  // causalEndPressure 出现
  assert.match(prompt, /水怪群退却但暗金竖瞳未消失/);

  // 全量 thematicQuestions 不出现（旧 possibleEndPressure 不再注入）
  assert.doesNotMatch(prompt, /主角的命运是否由自己掌握/);
  assert.doesNotMatch(prompt, /信任的边界在哪里/);
  assert.doesNotMatch(prompt, /可借章末抛回问题/);
});

// ============================================================================
// P0-2：重建 verifier 严重度分层
// ============================================================================

test("P0-2 #3：自然等价表达通过，真实遗漏仍被检出", () => {
  const verifier = createNarrativeVerifierSuite();
  const chapterIntent = [
    "作者章纲必须包含：三队首次配合；暗金双眸一闪而过",
  ].join("\n");

  // 自然等价表达：三支队伍协同作战 = 三队首次配合
  const coveredText = "三支队伍第一次协同作战，护住研究员。暗金色的竖瞳在浑浊中一闪而过。";
  const coveredReport = verifier.verify({
    text: coveredText,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const coveredOmissions = coveredReport.findings.filter(
    (f) => f.failureType === "intent_omission",
  );
  assert.equal(coveredOmissions.length, 0,
    `自然等价表达应通过，实际 findings: ${JSON.stringify(coveredOmissions)}`);

  // 真实遗漏：完全没有"三队"语义
  // inc-2：anchor 模式 heuristic 遗漏现在标为 uncertain（不是 missing）
  // missing 仅用于 deterministic verbatim 原句缺失
  const missingText = "李一凡独自走向青鱼嘴，水面平静。";
  const missingReport = verifier.verify({
    text: missingText,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const missingOmissions = missingReport.findings.filter(
    (f) => f.failureType === "intent_omission" && f.coverageStatus === "uncertain",
  );
  assert.ok(missingOmissions.length > 0,
    `真实遗漏应被检出（coverageStatus=uncertain for heuristic anchor），实际 findings: ${JSON.stringify(missingReport.findings)}`);
});

test("P0-2 #4：[verbatim] 原句缺失继续 hard block + certainty=deterministic + 零宽插入点", () => {
  const verifier = createNarrativeVerifierSuite();
  const chapterIntent = [
    '作者章纲必须包含：[verbatim] 原句：「青鱼嘴采样箱少了一只」',
  ].join("\n");

  const text = "三支队伍协同作战。鳞片斩杀水怪。但采样箱数量未提及。";
  const report = verifier.verify({
    text,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });

  const verbatimFindings = report.findings.filter(
    (f) => f.failureType === "intent_omission" && /verbatim|原句/u.test(f.sourceRef),
  );
  assert.ok(verbatimFindings.length > 0, "verbatim 缺失应产生 finding");
  const f = verbatimFindings[0];
  assert.equal(f.severity, "hard", "verbatim 缺失必须 hard block");
  assert.equal(f.certainty, "deterministic", "verbatim 缺失 certainty=deterministic");
  assert.equal(f.coverageStatus, "missing", "verbatim 缺失 coverageStatus=missing");

  // inc-3 修复：allowedRepairRange 必须是零宽插入点 [textLen, textLen]，
  // 不使用 [0, text.length] 整章范围，也不使用 [textLen-80, textLen] 覆盖原结尾。
  const textLen = text.length;
  assert.equal(f.allowedRepairRange.start, textLen,
    `verbatim 缺失 allowedRepairRange.start 必须是 textLen（零宽插入点），实际：${f.allowedRepairRange.start}`);
  assert.equal(f.allowedRepairRange.end, textLen,
    `verbatim 缺失 allowedRepairRange.end 必须是 textLen（零宽插入点），实际：${f.allowedRepairRange.end}`);
  assert.equal(f.allowedRepairRange.start, f.allowedRepairRange.end,
    "verbatim 零宽插入点：start === end");
});

test("P0-2 #5：[anchor] 词表无法确定时返回 review 不触发改写 + 空范围", () => {
  const verifier = createNarrativeVerifierSuite();
  const chapterIntent = [
    "作者章纲必须包含：定位改变；倒计时压力",
  ].join("\n");

  // 正文完全不含 anchor 词表
  const text = "李一凡坐在车内，看着窗外风景，没有任何相关表达。";
  const report = verifier.verify({
    text,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });

  const anchorFindings = report.findings.filter(
    (f) => f.failureType === "intent_omission"
      && f.certainty === "heuristic",
  );
  assert.ok(anchorFindings.length > 0, "anchor 缺失应产生 heuristic finding");
  for (const f of anchorFindings) {
    assert.equal(f.severity, "review",
      `anchor heuristic 缺失应 review，实际 ${f.severity}：${JSON.stringify(f)}`);
    // inc-2：heuristic 无法判定 → uncertain（不是 missing）
    assert.equal(f.coverageStatus, "uncertain",
      `anchor 缺失 coverageStatus=uncertain：${JSON.stringify(f)}`);
    // 空 allowedRepairRange（start === end）= 诊断 only，不触发改写
    assert.equal(f.allowedRepairRange.end, f.allowedRepairRange.start,
      `anchor heuristic 应空范围（诊断 only），实际：${JSON.stringify(f.allowedRepairRange)}`);
  }
});

test("P0-2 #6：知识关键词出现在其他角色附近不误伤目标角色", () => {
  const verifier = createNarrativeVerifierSuite();
  // forbiddenKnowledge 绑定李一凡：李一凡不该知道"暗流来源"
  const context = {
    facts: [],
    characterStates: [
      {
        characterId: "char-li",
        name: "李一凡",
        state: { forbiddenKnowledge: ["暗流来源"] },
      },
      {
        characterId: "char-xiao",
        name: "小妖",
        state: {},
      },
    ],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
  };

  // "暗流来源" 出现在小妖（其他角色）的对话中，不是李一凡的对话/内心
  const text = [
    "李一凡站在岸边观察水面。",
    "小妖低声对赵明远说：'我听人提到过暗流来源，好像在青鱼嘴。'",
    "李一凡没有听到这句话。",
  ].join("\n");

  const report = verifier.verify({
    text,
    context,
    chapterIntent: "本章功能：调查",
    knownCharacterNames: ["李一凡", "小妖", "赵明远"],
    inviolableFacts: [],
  });

  const knowledgeFindings = report.hardFindings.filter(
    (f) => f.failureType === "knowledge_boundary",
  );
  assert.equal(knowledgeFindings.length, 0,
    `其他角色附近出现关键词不应 hard 误伤，实际 hard findings：${JSON.stringify(knowledgeFindings)}`);
});

test("P0-2 #7：promise 关键词与'完成'出现在无关句中不触发 hard", () => {
  const verifier = createNarrativeVerifierSuite();
  // openLoop description 含逗号 → 拆出 keyword "暗流来源"
  const context = {
    facts: [],
    characterStates: [],
    openLoops: [
      { id: "loop-1", description: "暗流来源, 调查" },
    ],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
  };

  // "暗流来源" 后 20 字符窗口内出现 "完成"，但 "完成" 修饰的是 "记录"，
  // 不是 promise 的兑现声明。当前代码会误判 hard；修复后应 review。
  const text = "他提到暗流来源，完成了记录。";

  const report = verifier.verify({
    text,
    context,
    chapterIntent: "本章功能：调查",
    knownCharacterNames: ["李一凡"],
    inviolableFacts: [],
  });

  const promiseConflicts = report.hardFindings.filter(
    (f) => f.failureType === "promise_conflict",
  );
  assert.equal(promiseConflicts.length, 0,
    `无关句中的 keyword+完成 不应 hard（"完成了记录" 非 promise 兑现），实际：${JSON.stringify(promiseConflicts)}`);
});

test("P0-2 #8：'次日早上'不被判为相对前一天下午的时间回退", () => {
  const verifier = createNarrativeVerifierSuite();
  const context = {
    facts: [
      { id: "fact-time", content: "第16章结尾时间：下午3点", sourceIds: ["ch16"], kind: "fact" },
    ],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
  };

  // 本章开头明确"次日早上8点"——这是正常时间推进，不是回退
  const text = "次日早上8点，李一凡来到青鱼嘴水域。";

  const report = verifier.verify({
    text,
    context,
    chapterIntent: "本章功能：调查",
    knownCharacterNames: ["李一凡"],
    inviolableFacts: [],
  });

  const timelineFindings = report.hardFindings.filter(
    (f) => f.failureType === "timeline_inconsistency",
  );
  assert.equal(timelineFindings.length, 0,
    `'次日早上'不应判为时间回退 hard，实际：${JSON.stringify(timelineFindings)}`);
});

// ============================================================================
// P0-3：取消语义整章循环重写
// ============================================================================

test("P0-3 #9：语义 finding 不产生整章 [0, text.length] patch", () => {
  const verifier = createNarrativeVerifierSuite();
  const chapterIntent = [
    "作者章纲必须包含：定位改变；倒计时压力",
  ].join("\n");
  const text = "李一凡坐在车内，看着窗外风景。";

  const report = verifier.verify({
    text,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });

  const heuristicOmissions = report.findings.filter(
    (f) => f.failureType === "intent_omission" && f.certainty === "heuristic",
  );
  assert.ok(heuristicOmissions.length > 0, "应产生 heuristic omission finding");

  for (const f of heuristicOmissions) {
    const range = f.allowedRepairRange;
    const isFullChapter = range.start === 0 && range.end === text.length;
    assert.equal(isFullChapter, false,
      `heuristic omission 不应使用 [0, text.length] 整章范围，实际：${JSON.stringify(range)}`);
  }
});

test("P0-3 #10：同一语义 finding 最多触发1次局部修复", async () => {
  // 构造 stub：verifier 永远返回 1 个 heuristic intent_omission finding（永远不收敛）
  const heuristicFinding = {
    id: "verifier:intent_omission:anchor-1",
    source: "intent_omission_checker",
    failureType: "intent_omission",
    severity: "review",
    span: { start: 0, end: 0, excerpt: "" },
    conflictFact: "锚点遗漏",
    sourceRef: "author-outline:定位改变",
    confidence: 0.6,
    certainty: "heuristic",
    coverageStatus: "missing",
    allowedRepairRange: { start: 10, end: 30, excerpt: "" },
    description: "锚点遗漏：定位改变",
  };

  // 注意：heuristic finding 是 review，不会进入 hardFindings，不会触发修复
  // 但为了测试"语义修复预算"上限，构造一个 hard + heuristic 混合场景：
  // - 1 个 deterministic verbatim（可修 2 轮）
  // - 1 个 heuristic anchor（应只修 1 轮）
  // 这里我们直接测：即使 verifier 把 heuristic finding 误放进 hardFindings，
  // loop 也应限制 semantic 修复轮数为 1。
  // 实际实现中 heuristic 不会进 hardFindings；本测试模拟"semantic finding 进入修复"的边界。
  const verbatimFinding = {
    id: "verifier:verbatim:1",
    source: "intent_omission_checker",
    failureType: "intent_omission",
    severity: "hard",
    span: { start: 0, end: 0, excerpt: "" },
    conflictFact: "原句缺失",
    sourceRef: "author-outline:原句：测试",
    confidence: 1,
    certainty: "deterministic",
    coverageStatus: "missing",
    allowedRepairRange: { start: 0, end: 20, excerpt: "" },
    description: "verbatim 原句缺失",
  };

  // 混合 hardFindings：1 个 heuristic（标 hard 用于测试预算）+ 1 个 deterministic
  // 实际 GREEN 实现后 heuristic 不会进 hardFindings，但 selectRepairFindings 仍可能收到
  // 测试目标：loop 对 heuristic finding 的修复轮数 ≤ 1
  const mixedHardFindings = [
    { ...heuristicFinding, severity: "hard" }, // 模拟边界
    verbatimFinding,
  ];
  const unchangedReport = {
    findings: mixedHardFindings,
    hardFindings: mixedHardFindings,
    softFindings: [],
    hasHardFailure: true,
  };

  const prompts = [];
  const runtime = {
    agent: { state: { messages: [] } },
    subscribe() {},
    async prompt(prompt) {
      prompts.push(prompt);
      this.agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `修复后的片段 ${prompts.length}` }],
      });
    },
    async waitForIdle() {},
  };

  const verifier = { verify: () => unchangedReport };
  const patchService = {
    proposePatches(_draft, feedbacks) {
      return feedbacks.map((fb) => ({
        findingId: fb.findingId,
        type: "paragraph_patch",
        targetSpan: fb.allowedRepairRange,
        suggestion: fb.repairSuggestion,
        repairDirection: `repair ${fb.findingId}`,
        applied: false,
      }));
    },
    evaluatePatch() {
      return { accepted: true, reason: "ok", metrics: {} };
    },
  };

  const noOpStore = new Proxy({}, { get: () => () => {} });
  const budget = {
    isExhausted: () => false,
    getSnapshot: () => ({ turns: prompts.length, toolCalls: 0 }),
  };

  const loop = new NarrativeAgentLoop({
    runtime,
    registry: {},
    searchService: {},
    candidateWorkspace: noOpStore,
    permissionPolicy: {},
    budget,
    trajectory: noOpStore,
    verifier,
    patchService,
    maxRepairRounds: 10, // PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS=10
  });

  const result = await loop.run({
    chapterIntent: "作者章纲必须包含：原句：测试；定位改变",
    seedContext: "seed",
    context: EMPTY_CONTEXT,
  });

  // heuristic finding 最多触发 1 轮修复（即使 maxRepairRounds=10）
  // 修复调用次数 = 初稿 1 + 修复轮数
  // heuristic 修复 ≤ 1 轮 → 总 prompt ≤ 2（初稿 + 最多1轮 semantic 修复）
  // deterministic verbatim 可继续修复，但 heuristic 不应连续重写
  assert.ok(result.repairRounds <= 2,
    `heuristic + deterministic 混合，总修复轮数应受 semantic 预算约束（≤2），实际：${result.repairRounds}`);
});

// ============================================================================
// P0-2 #11：第17章真实候选完整回放 hardCount=0
// ============================================================================

test("P0-2 #11：第17章真实候选完整回放 hardCount=0（heuristic 不再阻断）", () => {
  // inc-5 修复：使用真实 NovelOS 会话的完整 chapterIntent（4041 字符）替换 271 字符压缩版。
  // fixture 来源：workspaces/xinmo/novelos-sessions/novelos-17-f97db599/
  //   - draft.md（2607 字符，NovelOS Agentic 生成的真实初稿）
  //   - trajectory.jsonl 中提取的完整 chapterIntent（4041 字符，包含本章功能/读者体验目标/
  //     作者章纲必须包含/作者章纲状态变化/作者章纲章末目标 五个结构化字段）
  // 该会话在旧 verifier 下产生 8 个 hard intent_omission findings（误报），
  // 修复后所有 heuristic findings 应为 review + uncertain，不触发 hard block。
  const draftPath = path.resolve(__dirname, "fixtures", "chapter-17-real-draft.md");
  const intentPath = path.resolve(__dirname, "fixtures", "chapter-17-real-chapter-intent.txt");

  // inc-5 修复：fixture 文件必须存在，不存在则测试失败（不静默通过）
  assert.ok(fs.existsSync(draftPath),
    `fixture 文件必须存在：${draftPath}（请确认 tests/fixtures/ 已提交）`);
  assert.ok(fs.existsSync(intentPath),
    `fixture 文件必须存在：${intentPath}（请确认 tests/fixtures/ 已提交）`);

  const text = fs.readFileSync(draftPath, "utf8");
  const chapterIntent = fs.readFileSync(intentPath, "utf8");

  // 验证 fixture 数据完整性：draft=2607, intent=4041
  assert.equal(text.length, 2607,
    `真实 draft 应为 2607 字符，实际：${text.length}`);
  assert.equal(chapterIntent.length, 4041,
    `真实 chapterIntent 应为 4041 字符，实际：${chapterIntent.length}`);
  assert.ok(chapterIntent.includes("作者章纲必须包含"),
    `真实 chapterIntent 应包含"作者章纲必须包含"`);
  assert.ok(chapterIntent.includes("作者章纲状态变化"),
    `真实 chapterIntent 应包含"作者章纲状态变化"（完整 4041 字符 fixture）`);
  assert.ok(chapterIntent.includes("作者章纲章末目标"),
    `真实 chapterIntent 应包含"作者章纲章末目标"（完整 4041 字符 fixture）`);

  const verifier = createNarrativeVerifierSuite();
  const report = verifier.verify({
    text,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: ["李一凡", "赵明远", "小妖", "王研究员", "战狼", "黑玫瑰"],
    inviolableFacts: [],
  });

  // 核心断言：heuristic findings 不再 hard block
  assert.equal(report.hardFindings.length, 0,
    `第17章真实正文完整回放不应 hard block，实际 hard findings：${JSON.stringify(report.hardFindings)}`);

  // 补充断言：应产生 intent_covered（正向证据）
  const coveredFindings = report.findings.filter(
    (f) => f.failureType === "intent_covered",
  );
  assert.ok(coveredFindings.length > 0,
    `应产生 intent_covered 正向证据，实际：${coveredFindings.length}`);

  // 验证所有 intent_omission findings 都是 heuristic + uncertain（不是 deterministic + missing）
  const allOmissions = report.findings.filter(
    (f) => f.failureType === "intent_omission",
  );
  for (const f of allOmissions) {
    assert.equal(f.certainty, "heuristic",
      `intent_omission 应为 heuristic，实际 ${f.certainty}：${JSON.stringify(f)}`);
    assert.equal(f.coverageStatus, "uncertain",
      `intent_omission 应为 uncertain，实际 ${f.coverageStatus}：${JSON.stringify(f)}`);
    assert.equal(f.severity, "review",
      `intent_omission 应为 review，实际 ${f.severity}：${JSON.stringify(f)}`);
  }
});

// ============================================================================
// P0-2 #12：真正事实冲突/截断/格式损坏回归仍 hard
// ============================================================================

test("P0-2 #12：真正事实冲突/截断/格式损坏回归仍 hard", () => {
  const verifier = createNarrativeVerifierSuite();

  // 案例 A：canon 颜色矛盾（corroborated → hard）
  const colorContext = {
    facts: [
      { id: "fact-color", content: "老周的潜水面罩是蓝色", sourceIds: ["ch1"], kind: "fact" },
    ],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
  };
  const colorText = "老周戴上红色面罩，跳入水中。";
  const colorReport = verifier.verify({
    text: colorText,
    context: colorContext,
    chapterIntent: "本章功能：潜水",
    knownCharacterNames: ["老周"],
    inviolableFacts: [],
  });
  const colorHard = colorReport.hardFindings.filter(
    (f) => f.failureType === "fact_contradiction",
  );
  assert.ok(colorHard.length > 0,
    `canon 颜色矛盾应 hard，实际：${JSON.stringify(colorReport.hardFindings)}`);
  assert.equal(colorHard[0].certainty, "corroborated",
    `canon 颜色矛盾 certainty=corroborated，实际：${colorHard[0].certainty}`);

  // 案例 B：verbatim 原句缺失（deterministic → hard）
  const verbatimIntent = '作者章纲必须包含：[verbatim] 原句：「钥匙在花瓶里」';
  const verbatimText = "他翻遍了房间，没有找到任何东西。";
  const verbatimReport = verifier.verify({
    text: verbatimText,
    context: EMPTY_CONTEXT,
    chapterIntent: verbatimIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const verbatimHard = verbatimReport.hardFindings.filter(
    (f) => f.failureType === "intent_omission" && f.certainty === "deterministic",
  );
  assert.ok(verbatimHard.length > 0,
    `verbatim 缺失应 hard + deterministic，实际：${JSON.stringify(verbatimReport.hardFindings)}`);

  // 案例 C：事实遗漏（"有X"类，corroborated → hard）
  const factOmissionReport = verifier.verify({
    text: "李一凡收回鳞片，水面重新安静下来。",
    context: EMPTY_CONTEXT,
    chapterIntent: "本章功能：收尾",
    knownCharacterNames: ["李一凡"],
    inviolableFacts: ["青鱼嘴水域有暗流"],
  });
  const factOmissionHard = factOmissionReport.hardFindings.filter(
    (f) => f.failureType === "fact_omission",
  );
  assert.ok(factOmissionHard.length > 0,
    `必需事实「有暗流」遗漏应 hard，实际：${JSON.stringify(factOmissionReport.hardFindings)}`);
});

// ============================================================================
// P0-4：阻断恢复建议归类（system/author/content 三类）
// ============================================================================

test("P0-4 #13：heuristic finding 误入 hard 时归 system_verifier_uncertain，不要求用户改章纲", () => {
  const findings = [
    {
      id: "f1",
      failureType: "intent_omission",
      sourceRef: "author-outline:anchor",
      description: "锚点遗漏",
      conflictFact: "锚点遗漏",
      certainty: "heuristic",
      coverageStatus: "missing",
    },
  ];
  const guidance = classifyAgenticVerificationBlock(findings, 17);
  assert.equal(guidance.blockCategory, "system_verifier_uncertain",
    `heuristic finding 应归 system_verifier_uncertain，实际：${guidance.blockCategory}`);
  // 不应出现"修订 ChapterSeed 或作者章纲"等正向要求用户改输入的提示
  // （"无需用户修订章纲" 是反向声明，不算要求用户改章纲）
  const userActions = guidance.userActionRequired ?? [];
  const asksUserToReviseInput = userActions.some((a) =>
    /修订第.*章.*输入|修订.*ChapterSeed|修订.*作者章纲/u.test(a));
  assert.equal(asksUserToReviseInput, false,
    `system_verifier_uncertain 不应要求用户改章纲，实际 userActionRequired：${JSON.stringify(userActions)}`);
  // 禁止动作仍保留：阻断候选不可交付/保存/跳章
  assert.ok(guidance.prohibitedActions?.includes("accept_or_deliver_blocked_candidate"));
  assert.ok(guidance.prohibitedActions?.includes("save_blocked_candidate_as_chapter"));
  assert.ok(guidance.prohibitedActions?.includes("skip_to_next_chapter"));
});

test("P0-4 #14：fact_contradiction 归 confirmed_content_omission，不要求用户改章纲（P1-3 修复）", () => {
  const findings = [
    {
      id: "f2",
      failureType: "fact_contradiction",
      sourceRef: "canon:color",
      description: "颜色矛盾",
      conflictFact: "老周面罩颜色矛盾（蓝 vs 红）",
      certainty: "corroborated",
      coverageStatus: "missing",
    },
  ];
  const guidance = classifyAgenticVerificationBlock(findings, 17);
  // P1-3 修复：fact_contradiction 是模型正文错误（模型写成红色，canon 是蓝色），
  // 不是作者输入错误。应归 confirmed_content_omission，由系统重写或 patch。
  assert.equal(guidance.blockCategory, "confirmed_content_omission",
    `fact_contradiction 应归 confirmed_content_omission（模型正文错误），实际：${guidance.blockCategory}`);
  const userActions = guidance.userActionRequired ?? [];
  const asksUserToReviseInput = userActions.some((a) =>
    /修订第.*章.*输入|修订.*ChapterSeed|修订.*作者章纲/u.test(a));
  assert.equal(asksUserToReviseInput, false,
    `confirmed_content_omission 不应要求用户改章纲，实际 userActionRequired：${JSON.stringify(userActions)}`);
});

test("P0-4 #15：deterministic verbatim 缺失归 confirmed_content_omission，不要求用户改章纲", () => {
  const findings = [
    {
      id: "f3",
      failureType: "intent_omission",
      sourceRef: "author-outline:原句：测试",
      description: "verbatim 原句缺失",
      conflictFact: "原句缺失",
      certainty: "deterministic",
      coverageStatus: "missing",
    },
  ];
  const guidance = classifyAgenticVerificationBlock(findings, 17);
  assert.equal(guidance.blockCategory, "confirmed_content_omission",
    `deterministic verbatim 缺失应归 confirmed_content_omission，实际：${guidance.blockCategory}`);
  const userActions = guidance.userActionRequired ?? [];
  const asksUserToReviseInput = userActions.some((a) =>
    /修订第.*章.*输入|修订.*ChapterSeed|修订.*作者章纲/u.test(a));
  assert.equal(asksUserToReviseInput, false,
    `confirmed_content_omission 不应要求用户改章纲，实际 userActionRequired：${JSON.stringify(userActions)}`);
});

test("P0-4 #16：混合 heuristic + fact_contradiction 归 system_verifier_uncertain（P1-3 修复）", () => {
  const findings = [
    {
      id: "f4",
      failureType: "intent_omission",
      sourceRef: "author-outline:anchor",
      description: "锚点遗漏",
      conflictFact: "锚点遗漏",
      certainty: "heuristic",
      coverageStatus: "missing",
    },
    {
      id: "f5",
      failureType: "fact_contradiction",
      sourceRef: "canon:color",
      description: "颜色矛盾",
      conflictFact: "颜色矛盾",
      certainty: "corroborated",
      coverageStatus: "missing",
    },
  ];
  const guidance = classifyAgenticVerificationBlock(findings, 17);
  // P1-3 修复：fact_contradiction 不再归 author_input_conflict，
  // 混合 finding 时 heuristic 主导 → system_verifier_uncertain
  // 优先级：author_input_conflict（无）> system_verifier_uncertain（有 heuristic）> confirmed_content_omission
  assert.equal(guidance.blockCategory, "system_verifier_uncertain",
    `混合 heuristic + fact_contradiction 应归 system_verifier_uncertain（heuristic 优先于 content_omission），实际：${guidance.blockCategory}`);
});

// ============================================================================
// inc-4：author_input_conflict 检测（inviolableFacts 内部矛盾）
// ============================================================================

test("inc-4 #17：inviolableFacts 直接否定冲突 → author_input_conflict hard finding", () => {
  const verifier = createNarrativeVerifierSuite();
  const report = verifier.verify({
    text: "李一凡站在岸边。",
    context: EMPTY_CONTEXT,
    chapterIntent: "本章功能：调查",
    knownCharacterNames: ["李一凡"],
    inviolableFacts: [
      "李一凡在场",
      "李一凡不在场",
    ],
  });
  const conflictFindings = report.findings.filter(
    (f) => f.failureType === "author_input_conflict",
  );
  assert.ok(conflictFindings.length > 0,
    `inviolableFacts 直接否定应产生 author_input_conflict finding，实际：${JSON.stringify(report.findings)}`);
  const f = conflictFindings[0];
  assert.equal(f.severity, "hard", "author_input_conflict 必须 hard");
  assert.equal(f.certainty, "deterministic", "author_input_conflict certainty=deterministic");
  assert.ok(f.sourceRef.includes("chapter-seed:inviolableFacts"),
    `sourceRef 应指向 chapter-seed:inviolableFacts，实际：${f.sourceRef}`);
});

test("inc-4 #18：inviolableFacts 必须/禁止互斥 → author_input_conflict", () => {
  const verifier = createNarrativeVerifierSuite();
  const report = verifier.verify({
    text: "队伍出发了。",
    context: EMPTY_CONTEXT,
    chapterIntent: "本章功能：行军",
    knownCharacterNames: [],
    inviolableFacts: [
      "必须单独行动",
      "禁止单独行动",
    ],
  });
  const conflictFindings = report.findings.filter(
    (f) => f.failureType === "author_input_conflict",
  );
  assert.ok(conflictFindings.length > 0,
    `必须/禁止互斥应产生 author_input_conflict finding，实际：${JSON.stringify(report.findings)}`);
});

test("inc-4 #19：inviolableFacts 相同主体冲突属性 → author_input_conflict", () => {
  const verifier = createNarrativeVerifierSuite();
  const report = verifier.verify({
    text: "赵明远站在那里。",
    context: EMPTY_CONTEXT,
    chapterIntent: "本章功能：对话",
    knownCharacterNames: ["赵明远"],
    inviolableFacts: [
      "赵明远是冷静",
      "赵明远是暴躁",
    ],
  });
  const conflictFindings = report.findings.filter(
    (f) => f.failureType === "author_input_conflict",
  );
  assert.ok(conflictFindings.length > 0,
    `相同主体冲突属性应产生 author_input_conflict finding，实际：${JSON.stringify(report.findings)}`);
});

test("inc-4 #20：无冲突的 inviolableFacts 不产生 author_input_conflict", () => {
  const verifier = createNarrativeVerifierSuite();
  const report = verifier.verify({
    text: "李一凡站在岸边观察水面。赵明远在旁边。",
    context: EMPTY_CONTEXT,
    chapterIntent: "本章功能：调查",
    knownCharacterNames: ["李一凡", "赵明远"],
    inviolableFacts: [
      "李一凡在场",
      "赵明远在场",
      "时间是白天",
      "地点是青鱼嘴",
    ],
  });
  const conflictFindings = report.findings.filter(
    (f) => f.failureType === "author_input_conflict",
  );
  assert.equal(conflictFindings.length, 0,
    `无冲突的 inviolableFacts 不应产生 author_input_conflict，实际：${JSON.stringify(conflictFindings)}`);
});

test("inc-4 #21：author_input_conflict finding → classifyAgenticVerificationBlock 归 author_input_conflict", () => {
  const findings = [
    {
      id: "f-conflict-1",
      failureType: "author_input_conflict",
      sourceRef: "chapter-seed:inviolableFacts[0],chapter-seed:inviolableFacts[1]",
      description: "作者输入自相矛盾：主体「李一凡」同时被赋予冲突属性",
      conflictFact: "inviolableFacts 内部矛盾：事实[0]「李一凡在场」与事实[1]「李一凡不在场」对主体「李一凡」给出冲突属性",
      certainty: "deterministic",
      coverageStatus: "missing",
    },
  ];
  const guidance = classifyAgenticVerificationBlock(findings, 17);
  assert.equal(guidance.blockCategory, "author_input_conflict",
    `author_input_conflict finding 应归 author_input_conflict，实际：${guidance.blockCategory}`);
  // 应要求用户修订 ChapterSeed
  const userActions = guidance.userActionRequired ?? [];
  const asksUserToReviseInput = userActions.some((a) =>
    /修订第.*章.*输入|ChapterSeed|章纲/u.test(a));
  assert.equal(asksUserToReviseInput, true,
    `author_input_conflict 应要求用户修订输入，实际 userActionRequired：${JSON.stringify(userActions)}`);
});

// ============================================================================
// inc-5：零宽 verbatim 插入完整链路测试
// checker → feedback → selector → proposal → merger
// 验证 [textLen, textLen] 零宽插入点在所有过滤层都贯通
// ============================================================================

test("inc-5 #22：零宽 verbatim 插入完整链路 checker→feedback→selector→proposal→merger", () => {
  // 1. Checker：构造 verbatim 原句缺失场景
  const verifier = createNarrativeVerifierSuite();
  const chapterIntent = [
    '作者章纲必须包含：[verbatim] 原句：「这条原句必须被插入到章末」',
  ].join("\n");
  const draft = "这是一段正文，但不包含 verbatim 原句。";
  const report = verifier.verify({
    text: draft,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });

  // 验证 checker 产出 verbatim hard finding + 零宽插入点
  const verbatimFindings = report.hardFindings.filter(
    (f) => f.failureType === "intent_omission" && f.certainty === "deterministic",
  );
  assert.ok(verbatimFindings.length > 0, "checker 应产出 verbatim hard finding");
  const vf = verbatimFindings[0];
  const textLen = draft.length;
  assert.equal(vf.allowedRepairRange.start, textLen,
    `checker 应产出零宽插入点 start=textLen=${textLen}，实际：${vf.allowedRepairRange.start}`);
  assert.equal(vf.allowedRepairRange.end, textLen,
    `checker 应产出零宽插入点 end=textLen=${textLen}，实际：${vf.allowedRepairRange.end}`);

  // 2. Feedback：compileFeedback 应保留零宽 deterministic finding
  const feedbacks = compileFeedback(report);
  assert.ok(feedbacks.length > 0,
    `compileFeedback 应保留零宽 deterministic finding，实际：${feedbacks.length}`);
  assert.equal(feedbacks[0].certainty, "deterministic",
    "feedback 应传播 certainty=deterministic");

  // 3. Selector：selectRepairFindings 应保留零宽 deterministic finding
  const selected = selectRepairFindings(report.hardFindings);
  assert.ok(selected.length > 0,
    `selectRepairFindings 应保留零宽 deterministic finding，实际：${selected.length}`);

  // 3b. findingToFeedback 传播（agent loop 实际使用的路径）
  const loopFeedbacks = selected.map(findingToFeedback);
  assert.ok(loopFeedbacks.length > 0,
    `findingToFeedback 应传播零宽 finding，实际：${loopFeedbacks.length}`);

  // 4. Proposal：patchService.proposePatches 应产出 proposal
  const patchService = createCandidatePatchService();
  const proposals = patchService.proposePatches(draft, loopFeedbacks);
  assert.ok(proposals.length > 0,
    `proposePatches 应为零宽 deterministic finding 产出 proposal，实际：${proposals.length}`);
  const proposal = proposals[0];
  assert.equal(proposal.targetSpan.start, textLen,
    `proposal targetSpan.start 应为 textLen=${textLen}，实际：${proposal.targetSpan.start}`);
  assert.equal(proposal.targetSpan.end, textLen,
    `proposal targetSpan.end 应为 textLen=${textLen}，实际：${proposal.targetSpan.end}`);
  assert.equal(proposal.localReplacement, true,
    "零宽插入应使用 localReplacement 模式");

  // 5. Merger：applyLocalReplacements 应在章末插入原句，不删除原文
  const insertText = "这条原句必须被插入到章末";
  // 构造模型输出（模拟 [替换1] 格式）
  const modelOutput = `[替换1]\n${insertText}`;
  const merged = applyLocalReplacements(draft, proposals, modelOutput);
  assert.notEqual(merged, null,
    "applyLocalReplacements 不应返回 null（格式应匹配）");
  assert.ok(merged.includes(draft),
    "合并后正文应包含原 draft 全文（零宽插入不删除原文）");
  assert.ok(merged.includes(insertText),
    "合并后正文应包含插入的原句");
  assert.ok(merged.endsWith(insertText),
    "插入的原句应在章末（最后出现）");
  assert.equal(merged.length, draft.length + insertText.length,
    `合并后长度应为 draft+插入=${draft.length + insertText.length}，实际：${merged.length}`);

  // 6. Span 不变性验证：evaluatePatch 应通过
  const evalResult = patchService.evaluatePatch(draft, merged, proposal);
  assert.equal(evalResult.accepted, true,
    `零宽插入应通过退化检查（span 外不变），实际：${evalResult.reason}`);
  assert.equal(evalResult.metrics.spanImmutabilityPassed, true,
    "零宽插入的 span 外不变性应通过");
});

test("inc-5 #23：heuristic 零宽 finding 仍被过滤（不进入修复链路）", () => {
  // 验证 heuristic finding 的零宽范围仍被过滤（诊断 only）
  const verifier = createNarrativeVerifierSuite();
  const chapterIntent = "作者章纲必须包含：定位改变；倒计时压力";
  const draft = "李一凡坐在车内，看着窗外风景。";
  const report = verifier.verify({
    text: draft,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });

  // heuristic findings 应有零宽范围
  const heuristicFindings = report.findings.filter(
    (f) => f.failureType === "intent_omission" && f.certainty === "heuristic",
  );
  assert.ok(heuristicFindings.length > 0, "应产出 heuristic finding");
  for (const f of heuristicFindings) {
    assert.equal(f.allowedRepairRange.start, f.allowedRepairRange.end,
      "heuristic finding 应有零宽范围（诊断 only）");
  }

  // compileFeedback 应过滤掉 heuristic 零宽 finding
  const feedbacks = compileFeedback(report);
  const heuristicFeedbacks = feedbacks.filter(
    (fb) => fb.certainty === "heuristic" && fb.allowedRepairRange.start === fb.allowedRepairRange.end,
  );
  assert.equal(heuristicFeedbacks.length, 0,
    "compileFeedback 应过滤 heuristic 零宽 finding");

  // selectRepairFindings 应过滤掉 heuristic 零宽 finding
  const selected = selectRepairFindings(report.hardFindings);
  // heuristic findings 是 review，不在 hardFindings 中，所以 selected 应为空
  // 但即使误入 hardFindings，零宽 heuristic 也应被过滤
  const heuristicSelected = selected.filter(
    (f) => f.certainty === "heuristic" && f.allowedRepairRange.start === f.allowedRepairRange.end,
  );
  assert.equal(heuristicSelected.length, 0,
    "selectRepairFindings 应过滤 heuristic 零宽 finding");
});
