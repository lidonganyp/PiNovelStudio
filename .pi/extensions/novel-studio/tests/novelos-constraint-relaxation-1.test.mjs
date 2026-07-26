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

import { buildChapterIntentString } from "../dist/novelos/agent/agentic-raw-candidate-source.js";
import { createNarrativeVerifierSuite } from "../dist/novelos/verification/narrative-verifier-suite.js";
import { createCandidatePatchService } from "../dist/novelos/agent/candidate-patch-service.js";
import { NarrativeAgentLoop } from "../dist/novelos/agent/narrative-agent-loop.js";

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
  const missingText = "李一凡独自走向青鱼嘴，水面平静。";
  const missingReport = verifier.verify({
    text: missingText,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: [],
    inviolableFacts: [],
  });
  const missingOmissions = missingReport.findings.filter(
    (f) => f.failureType === "intent_omission" && f.coverageStatus === "missing",
  );
  assert.ok(missingOmissions.length > 0,
    `真实遗漏应被检出（coverageStatus=missing），实际 findings: ${JSON.stringify(missingReport.findings)}`);
});

test("P0-2 #4：[verbatim] 原句缺失继续 hard block + certainty=deterministic", () => {
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
    assert.equal(f.coverageStatus, "missing",
      `anchor 缺失 coverageStatus=missing：${JSON.stringify(f)}`);
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
// P0-2 #11：第17章真实候选重放 hardCount=0
// ============================================================================

test("P0-2 #11：第17章真实候选重放 hardCount=0（heuristic 不再阻断）", () => {
  const verifier = createNarrativeVerifierSuite();
  // 第17章 fixture：多个 anchor 要求，正文用自然等价表达覆盖；
  // verbatim 原句已出现；无真实事实冲突。
  const chapterIntent = [
    "作者章纲必须包含：三队首次配合；战狼开枪无效；鳞片一击斩杀水怪；多只水怪围攻；倒计时型压力；暗金双眸一闪而过；章末预判定位将变",
    '作者章纲必须包含：[verbatim] 原句：「青鱼嘴采样箱少了一只」',
  ].join("\n");

  const text = [
    "三支队伍第一次协同作战，护住了研究员。",
    "战狼的机枪瞬间开火，子弹打在水怪鳞片上溅起火星，连皮都没擦破。",
    "浑浊中亮起两双猩红的眼睛。不止一只。水怪黑影从四面逼近。",
    "鳞片破开水怪的鳞甲，将它当场斩杀。",
    "氧气在快速消耗，倒计时型压力压上心头。",
    "暗金色的竖瞳一闪而过。",
    "李一凡清楚，自己在镇夜司和战队里的定位，再也回不到从前了。",
    "青鱼嘴采样箱少了一只。",
  ].join("\n");

  const report = verifier.verify({
    text,
    context: EMPTY_CONTEXT,
    chapterIntent,
    knownCharacterNames: ["李一凡"],
    inviolableFacts: [],
  });

  assert.equal(report.hardFindings.length, 0,
    `第17章自然等价表达不应 hard block，实际 hard findings：${JSON.stringify(report.hardFindings)}`);
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
