/**
 * LANGUAGE-CALIBRATION-REAL-1 RED 测试
 *
 * 派工卡: delete/任务列表/项目优化20260718.md P1-4 L383-407
 *
 * 验证现有 voice_and_naturalness → v2_chinese_calibration 链路在 5 章真实 raw 文本上的
 * 端到端可达性 + 验收脚本输出格式。
 *
 * 任务规格验收口径：
 * - 至少 5 个真实章节（chapter-01/05/08/12/17，覆盖开篇/过渡/团队/中段/长章）
 * - 每个章节保存 raw、校准候选、匿名反向 A/B
 * - 必须引用具体翻译腔或不自然 span
 * - 校准只能修改目标 span
 * - 新增事实、人物动机或情节变化立即拒绝
 * - Judge 不明确胜出时保留 raw
 *
 * 真实模型调用 REQUIRES_AUTH：本切片为 offline stub 模式 + 真实 raw 文本 fixture，
 * 真实 Doubao + gpt-5.6-sol 调用作为后续 REQUIRES_AUTH 切片。
 *
 * RED 状态：runVerification 脚本尚未实现，Part B 全部 fail；Part A 验证现有链路（已实现）。
 * GREEN 状态：实现 scripts/language-calibration-real-1/run-verification.mjs 后全部通过。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { createEditorialCandidateGenerator } from "../dist/v2/core/editorial-candidate-generator.js";
import { createEditorialStrategyRegistry } from "../dist/v2/core/editorial-strategy-registry.js";
import { EditorialOpportunityJudge } from "../dist/v2/core/editorial-opportunity-judge.js";
import { JudgeArbitrator } from "../dist/v2/core/judge-arbitrator.js";
import { checkCandidateFactGuard } from "../dist/v2/core/orchestrator-factguard.js";

// ============================================================================
// 5 章真实 raw 文本 fixture（从 workspaces/xinmo/chapters/ 拷贝）
// ============================================================================

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const XINMO_CHAPTERS = join(REPO_ROOT, "workspaces", "xinmo", "chapters");
const EXPECTED_CHAPTERS = ["chapter-01.md", "chapter-05.md", "chapter-08.md", "chapter-12.md", "chapter-17.md"];

function loadChapterRaw(filename) {
  const path = join(XINMO_CHAPTERS, filename);
  assert.ok(existsSync(path), `真实章节缺失：${path}`);
  return readFileSync(path, "utf-8");
}

function loadAllChapters() {
  const chapters = {};
  for (const name of EXPECTED_CHAPTERS) {
    chapters[name] = loadChapterRaw(name);
  }
  return chapters;
}

// ============================================================================
// 5 章真实 raw 文本中的不自然 span（手工标注，作为校准目标）
// ============================================================================

/**
 * 每章 1 个真实存在的不自然 span：
 * - chapter-01: "心脏还在胸腔里疯狂跳动" — 略带翻译腔的直白描述
 * - chapter-05: "隐约感到一个黝黑的洞口" — 感知侵蚀词 "感到"
 * - chapter-08: "内心的激动慢慢安静来下" — 语病（"安静来下" 应为 "安静下来"）
 * - chapter-12: "隐约感到一股威压涌来" — 感知侵蚀词 "感到"
 * - chapter-17: "李一凡注意到他收紧的下颌线" — 感知侵蚀词 "注意到"
 */
function findSpan(rawText, excerpt) {
  const start = rawText.indexOf(excerpt);
  assert.ok(start >= 0, `span "${excerpt}" 未在 raw 中找到`);
  return { start, end: start + excerpt.length, excerpt };
}

const CHAPTER_SPANS = {
  "chapter-01.md": "心脏还在胸腔里疯狂跳动",
  "chapter-05.md": "隐约感到一个黝黑的洞口",
  "chapter-08.md": "内心的激动慢慢安静来下",
  "chapter-12.md": "隐约感到一股威压涌来",
  "chapter-17.md": "李一凡注意到他收紧的下颌线",
};

// ============================================================================
// stub modelGenerate
// ============================================================================

/**
 * stub modelGenerate 行为：
 * - v2_chinese_calibration: 返回 span 局部替换（仅修改 span excerpt，其余文本不变）
 * - v2_literary_judge: 返回 verdict（A/B/tie，可通过 verdictsByChapter 控制）
 * - v2_opportunity_judge: 返回本地扫描器结果（不调用模型，由 EditorialOpportunityJudge 处理）
 *
 * 设计：stub 直接接收 rawText + target excerpt（不解析 prompt，避免正则解析复杂格式出错）。
 * 每个 stub 实例可绑定多个 (rawText → target) 对，stub 用 prompt 中包含 rawText 来匹配。
 */
function makeStubModelGenerate({ verdictsByChapter = {}, calibrationReplacements = [], defaultVerdict = "tie" } = {}) {
  /**
   * calibrationReplacements: Array<{ rawText, target, replacement }>
   * stub 找到 prompt 中包含 rawText 的对应条目，做局部替换。
   * 若未匹配，返回 rawText 不变（safe fallback）。
   *
   * defaultVerdict: 当 prompt 中无任何 verdictsByChapter key 命中时使用的默认 verdict。
   * 旧实现默认 "tie"，但既有的 "校准后文本" key 实际不在 prompt 中，导致测试一直跑 tie 路径。
   * 显式 defaultVerdict 参数让测试能可靠地触发 winner="A"|"B" 路径。
   */
  const calls = [];
  const fn = async (input) => {
    calls.push({
      route: input.route,
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
    });

    if (input.route === "v2_chinese_calibration") {
      // 匹配 calibrationReplacements：找到 prompt 中包含 rawText 的条目
      const promptText = input.userPrompt || "";
      let calibrated = "";
      let matched = false;
      for (const { rawText, target, replacement } of calibrationReplacements) {
        if (promptText.includes(rawText) && rawText.includes(target)) {
          calibrated = rawText.replace(target, replacement);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // 未匹配：返回 prompt 中第一个 rawText（兜底，避免空文本）
        // 这种情况意味着 calibrationReplacements 未覆盖到该 prompt
        return {
          text: "",
          model: "doubao-seed-2-1-pro-260628",
          route: input.route,
          provider: "doubao",
          durationMs: 50,
        };
      }
      return {
        text: calibrated,
        model: "doubao-seed-2-1-pro-260628",
        route: input.route,
        provider: "doubao",
        durationMs: 50,
      };
    }

    if (input.route === "v2_literary_judge") {
      // 解析 prompt 中的章节标识，决定 verdict
      const promptText = input.userPrompt || "";
      let verdict = defaultVerdict;
      let matched = false;
      for (const [key, v] of Object.entries(verdictsByChapter)) {
        if (promptText.includes(key)) {
          verdict = v;
          matched = true;
          break;
        }
      }
      // 构造正确 JudgeVerdict 契约（参考 judge-types.ts L31-38 + phase4-llm-judge.test.mjs L169-176）
      // 错误契约（verdict/confidence:0.4/winnerSpan/loserSpan/reasoning）会导致 parseJudgeVerdict
      // 返回 null → PairwiseLiteraryJudge 首轮 degraded → 直接保留 raw，无反向 A/B。
      // 正确契约：winner/confidence:"clear"|"slight"|"uncertain"/decisiveReasons/factualRisks/regressionRisks/constitutionAlignment
      // confidence="slight"/"uncertain" 触发 needsReverseReview=true（judge-types.ts L213-215），进入反向 A/B。
      const winnerLabel = verdict; // "A" | "B" | "tie"
      const confidence = verdict === "tie" ? "uncertain" : "slight";
      // decisiveReasons：winner 非 tie 时，betterCandidate 一方对另一方需有 evidence span
      // （validateVerdictEvidence judge-types.ts L155-176 要求 worse 一方 evidence 非空）
      // tie 时 betterCandidate="neither"，evidenceA/B 可空
      const reason = verdict === "tie"
        ? {
            dimension: "整体",
            betterCandidate: "neither",
            evidenceA: [],
            evidenceB: [],
            explanation: "两版质量接近，无明显胜出",
          }
        : {
            dimension: "中文自然度",
            betterCandidate: verdict, // "A" 或 "B"
            // worse 一方需有 evidence span
            evidenceA: verdict === "A" ? [] : [{ start: 0, end: 10, excerpt: "感知侵蚀词" }],
            evidenceB: verdict === "B" ? [] : [{ start: 0, end: 10, excerpt: "感知侵蚀词" }],
            explanation: `verdict=${verdict} (stub, matched=${matched})`,
          };
      return {
        text: JSON.stringify({
          winner: winnerLabel,
          confidence,
          decisiveReasons: [reason],
          factualRisks: [],
          regressionRisks: [],
          constitutionAlignment: "两者均对齐",
        }),
        model: "gpt-5.6-sol",
        route: input.route,
        provider: "openai",
        durationMs: 100,
      };
    }

    // 默认返回空文本
    return {
      text: "",
      model: "stub",
      route: input.route,
      provider: "stub",
      durationMs: 10,
    };
  };
  fn.calls = calls;
  return fn;
}

/**
 * 为指定 rawText + excerpt 构造 stub 的 calibrationReplacement。
 * 默认替换规则（replacePerceptionSpan）：
 * - "感到" → "察觉到"
 * - "注意到" → "看见"
 * - "安静来下" → "安静下来"
 * - "疯狂跳动" → "剧烈跳动"
 */
function makeCalibrationReplacement(rawText, excerpt) {
  return {
    rawText,
    target: excerpt,
    replacement: replacePerceptionSpan(excerpt),
  };
}

function replacePerceptionSpan(target) {
  // 局部替换规则（仅 span 内）：
  if (target.includes("感到")) return target.replace("感到", "察觉到");
  if (target.includes("注意到")) return target.replace("注意到", "看见");
  if (target.includes("安静来下")) return target.replace("安静来下", "安静下来");
  if (target.includes("疯狂跳动")) return target.replace("疯狂跳动", "剧烈跳动");
  return target; // 不替换
}

// ============================================================================
// 构造合法 ChapterIntent + CompiledContext + Candidate（最小 fixture）
// ============================================================================

function makeIntent() {
  return {
    chapterFunction: "character",
    readerExperience: [],
    currentPressure: [],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: [],
    inviolableFacts: [],
    sourceRefs: [],
  };
}

function makeContext() {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    // FactGuard（checkCandidateFactGuard）通过 input.context.bridgeContext 访问；
    // 显式 undefined 表示"无桥接上下文"，避免缺字段导致的访问异常。
    bridgeContext: undefined,
  };
}

function makeVoiceHypothesis(rawText, excerpt, id = "h-voice-1") {
  const span = findSpan(rawText, excerpt);
  return {
    id,
    opportunityType: "voice_and_naturalness",
    diagnosis: `不自然 span "${excerpt}" 存在感知侵蚀/翻译腔/语病`,
    evidenceSpans: [span],
    expectedReaderGain: "把 span 改写为母语自然表达",
    damageRisks: ["改写可能轻微影响段落情感重量"],
    rewriteScope: "span_candidate",
    confidence: 0.6,
  };
}

// ============================================================================
// Part A：现有链路在 5 章真实 raw 上的端到端验证（已实现，应通过）
// ============================================================================

describe("LANGUAGE-CALIBRATION-REAL-1 · Part A: 现有链路在 5 章真实 raw 上的端到端处理", () => {
  test("5 章真实 raw 文本加载 + 长度校验", () => {
    const chapters = loadAllChapters();
    for (const name of EXPECTED_CHAPTERS) {
      const text = chapters[name];
      assert.ok(text && text.length > 100, `${name} 加载失败或过短`);
      assert.ok(text.includes("李一凡") || text.includes("第"), `${name} 应为真实章节`);
    }
    assert.equal(Object.keys(chapters).length, 5, "应加载 5 章");
  });

  test("5 章 raw 文本均能找到具体 span（必须引用具体翻译腔或不自然 span）", () => {
    const chapters = loadAllChapters();
    for (const name of EXPECTED_CHAPTERS) {
      const rawText = chapters[name];
      const excerpt = CHAPTER_SPANS[name];
      const span = findSpan(rawText, excerpt);
      assert.ok(span.start >= 0, `${name} 的 span "${excerpt}" 未找到`);
      assert.equal(span.excerpt, excerpt);
      assert.ok(span.end > span.start);
    }
  });

  test("对 5 章 raw 跑 EditorialOpportunityJudge（本地扫描器，无 LLM）记录 scannedSignals", async () => {
    const chapters = loadAllChapters();
    const judge = new EditorialOpportunityJudge();
    for (const name of EXPECTED_CHAPTERS) {
      const rawText = chapters[name];
      const result = await judge.judge({
        rawText,
        intent: makeIntent(),
        longTermState: null,
        constitution: null,
        characterNames: ["李一凡"],
      });
      assert.ok(Array.isArray(result.scannedSignals), `${name} 应返回 scannedSignals`);
      assert.ok(result.scannedSignals.length >= 1, `${name} 应至少有 1 个扫描器信号`);
      // 不要求自动生成 hypothesis（真实章节命中率低），但扫描器必须运行
    }
  });

  test("5 章手工 voice_and_naturalness hypothesis 通过 EditorialCandidateGenerator 生成校准候选（v2_chinese_calibration 路由）", async () => {
    const chapters = loadAllChapters();
    for (const name of EXPECTED_CHAPTERS) {
      const rawText = chapters[name];
      const excerpt = CHAPTER_SPANS[name];
      const hypothesis = makeVoiceHypothesis(rawText, excerpt, `h-voice-${name}`);
      const modelGenerate = makeStubModelGenerate({
        calibrationReplacements: [makeCalibrationReplacement(rawText, excerpt)],
      });
      const gen = createEditorialCandidateGenerator();
      const result = await gen.generate({
        rawText,
        rawCandidateId: `candidate:raw:${name}`,
        hypotheses: [hypothesis],
        intent: makeIntent(),
        context: makeContext(),
        contextHash: createHash("sha256").update(rawText).digest("hex").slice(0, 8),
        chapterNumber: 1,
        modelGenerate,
        strategyRegistry: createEditorialStrategyRegistry(),
      });
      assert.ok(
        result.candidates.length >= 1 || result.failures.length >= 1,
        `${name} 应生成候选或失败记录`,
      );
      if (result.candidates.length > 0) {
        const cand = result.candidates[0];
        assert.equal(
          cand.route,
          "v2_chinese_calibration",
          `${name} 校准候选 route 必须为 v2_chinese_calibration`,
        );
      }
    }
  });

  test("通过 FactGuard 的校准候选进入 PairwiseJudge 反向 A/B（两轮 verdict）", async () => {
    const chapters = loadAllChapters();
    // 选 chapter-05（含 "感到"，会通过 span 边界检查）
    const rawText = chapters["chapter-05.md"];
    const excerpt = CHAPTER_SPANS["chapter-05.md"];
    const hypothesis = makeVoiceHypothesis(rawText, excerpt, "h-voice-reverse-ab");
    // 使用 defaultVerdict="B" 可靠触发 winner="B" + confidence="slight" 路径
    // （旧实现用 "校准后文本" key 但实际不在 prompt 中，导致 verdict 一直为 "tie"）
    const modelGenerate = makeStubModelGenerate({
      defaultVerdict: "B", // B = editorial 胜出
      verdictsByChapter: {},
      calibrationReplacements: [makeCalibrationReplacement(rawText, excerpt)],
    });
    const gen = createEditorialCandidateGenerator();
    const genResult = await gen.generate({
      rawText,
      rawCandidateId: "candidate:raw:reverse-ab",
      hypotheses: [hypothesis],
      intent: makeIntent(),
      context: makeContext(),
      contextHash: "hash-reverse-ab",
      chapterNumber: 5,
      modelGenerate,
      strategyRegistry: createEditorialStrategyRegistry(),
    });
    if (genResult.candidates.length === 0) {
      console.error("DEBUG: candidates 为空，failures =", JSON.stringify(genResult.failures, null, 2));
      console.error("DEBUG: stub calls =", modelGenerate.calls.length);
      if (modelGenerate.calls[0]) {
        console.error("DEBUG: first call route =", modelGenerate.calls[0].route);
        console.error("DEBUG: first call userPrompt 前 500 字符 =", modelGenerate.calls[0].userPrompt?.slice(0, 500));
      }
    }
    assert.ok(genResult.candidates.length >= 1, "应生成至少 1 个校准候选");

    const editorialCandidate = genResult.candidates[0];
    const rawCandidate = {
      id: "candidate:raw:reverse-ab",
      kind: "context_enhanced",
      text: rawText,
      model: "stub-raw",
      route: "v2_rawstage2",
      promptProfile: { type: "editorial", tokensIn: 0, containsDialogueRatio: false, containsParagraphLengthConstraint: false, containsControlChecklist: false, containsMechanicalMetric: false, contractIds: [] },
      contextHash: "hash-reverse-ab",
      generatedAt: new Date().toISOString(),
      durationMs: 0,
    };

    const arbitrator = new JudgeArbitrator();
    const arbResult = await arbitrator.arbitrate({
      rawCandidate,
      editorialCandidate,
      intent: makeIntent(),
      constitution: null,
      modelGenerate,
      seed: 42,
      route: "v2_literary_judge",
    });

    // ── 加强断言（Change 5 part 1）──
    // 旧断言 rounds.length >= 1 太弱：首轮 degraded 也会 rounds.length=1 通过，但实际无反向 A/B。
    // 正确的两轮 A/B 应满足：
    // 1. 首轮不降级（stub 返回合法 JSON，parseJudgeVerdict 不返回 null）
    // 2. 首轮 verdict 字段合法（winner/confidence/decisiveReasons）
    // 3. confidence != "clear" 触发 needsReverseReview=true
    // 4. reverseReviewed=true + reverseRound != null
    // 5. rounds.length >= 2（首轮 + 反向）
    assert.ok(arbResult.firstRound, "应有首轮裁判结果");
    assert.equal(arbResult.firstRound.degraded, false, `首轮不应降级（stub 应返回合法 JSON）：${arbResult.firstRound.degradeReason ?? ""}`);
    assert.ok(arbResult.firstRound.verdict, "首轮应有 verdict 对象（非 null）");
    assert.ok(
      ["A", "B", "tie"].includes(arbResult.firstRound.verdict.winner),
      `首轮 verdict.winner 应合法：${arbResult.firstRound.verdict?.winner}`,
    );
    assert.equal(
      arbResult.firstRound.verdict.confidence,
      "slight",
      `confidence 应为 slight（触发反向复判），实际：${arbResult.firstRound.verdict?.confidence}`,
    );
    assert.ok(
      Array.isArray(arbResult.firstRound.verdict.decisiveReasons),
      "首轮 verdict.decisiveReasons 应为数组",
    );
    assert.equal(
      arbResult.reverseReviewed,
      true,
      `应触发反向复判（confidence=slight → needsReverseReview=true），实际 reverseReviewed=${arbResult.reverseReviewed}`,
    );
    assert.ok(arbResult.reverseRound, "应有反向复判结果（reverseRound 非 null）");
    assert.ok(
      arbResult.rounds.length >= 2,
      `应至少有 2 轮记录（首轮+反向），实际：${arbResult.rounds.length}`,
    );
    assert.equal(arbResult.rounds[0].round, "first", "首轮记录 round=first");
    assert.equal(arbResult.rounds[1].round, "reverse", "第二轮记录 round=reverse");
    // 两轮都应有 winnerCandidateId（tie 时为 null，但仍应存在该字段）
    assert.ok(arbResult.rounds[0].winnerCandidateId !== undefined, "首轮应有 winnerCandidateId 字段");
    assert.ok(arbResult.rounds[1].winnerCandidateId !== undefined, "反向轮应有 winnerCandidateId 字段");
  });

  test("Judge 不明确胜出（tie）→ SelectionPolicy 保留 raw", async () => {
    const chapters = loadAllChapters();
    const rawText = chapters["chapter-05.md"];
    const excerpt = CHAPTER_SPANS["chapter-05.md"];
    const hypothesis = makeVoiceHypothesis(rawText, excerpt, "h-voice-tie");
    // 全部 tie
    const modelGenerate = makeStubModelGenerate({
      verdictsByChapter: { "校准后文本": "tie" },
      calibrationReplacements: [makeCalibrationReplacement(rawText, excerpt)],
    });
    const gen = createEditorialCandidateGenerator();
    const genResult = await gen.generate({
      rawText,
      rawCandidateId: "candidate:raw:tie",
      hypotheses: [hypothesis],
      intent: makeIntent(),
      context: makeContext(),
      contextHash: "hash-tie",
      chapterNumber: 5,
      modelGenerate,
      strategyRegistry: createEditorialStrategyRegistry(),
    });
    assert.ok(genResult.candidates.length >= 1, "应生成校准候选");

    const editorialCandidate = genResult.candidates[0];
    const rawCandidate = {
      id: "candidate:raw:tie",
      kind: "context_enhanced",
      text: rawText,
      model: "stub-raw",
      route: "v2_rawstage2",
      promptProfile: { type: "editorial", tokensIn: 0, containsDialogueRatio: false, containsParagraphLengthConstraint: false, containsControlChecklist: false, containsMechanicalMetric: false, contractIds: [] },
      contextHash: "hash-tie",
      generatedAt: new Date().toISOString(),
      durationMs: 0,
    };

    const arbitrator = new JudgeArbitrator();
    const arbResult = await arbitrator.arbitrate({
      rawCandidate,
      editorialCandidate,
      intent: makeIntent(),
      constitution: null,
      modelGenerate,
      seed: 42,
      route: "v2_literary_judge",
    });

    // tie → 保留 raw
    assert.equal(
      arbResult.finalSelectedCandidateId,
      "candidate:raw:tie",
      `tie 时应保留 raw，实际：${arbResult.finalSelectedCandidateId}`,
    );
  });

  test("FactGuard 立即拒绝凭空新增的高影响新设定", () => {
    const rawText = "李一凡走入大殿，环顾四周。";
    // 凭空新增秘法/神器/组织计划/升级结果（IMMUTABLE-FACTS-COMPILER-1 检查目标）
    const candidateText = "李一凡走入大殿，环顾四周。他突然想起师父传授的天罡三十六诀，其中第七式「定魂」正是克制眼前阵法的关键。他从乾坤袋中取出一件神器「星陨剑」，剑身流转着上古神纹。据天机阁密档记载，此剑曾斩杀三十六位魔君。";

    // 构造 UnifiedOrchestratorInput 最小 fixture（与编排器调用方式一致）
    const factGuardInput = {
      context: makeContext(),
      characterNames: ["李一凡"],
      chapterNumber: 1,
      ontologyLevels: [],
      constitution: null,
      intent: makeIntent(),
      contextSafety: undefined,
    };
    const fg = checkCandidateFactGuard(candidateText, factGuardInput, rawText);

    assert.equal(fg.ok, false, "凭空新增高影响新设定应被 FactGuard 立即拒绝");
    assert.equal(fg.report.hasHardBlock, true, "未授权高影响新设定应进入 hardBlocks");

    const unauthorizedDiags = fg.report.allDiagnostics.filter(
      (d) => d.source === "unauthorized_high_impact_setting",
    );
    assert.ok(unauthorizedDiags.length >= 1, "应至少产生一条未授权高影响新设定诊断");
    for (const d of unauthorizedDiags) {
      assert.equal(d.severity, "hard", "未授权高影响新设定必须是 hard 诊断");
      assert.ok(fg.report.hardBlocks.some((block) => block.id === d.id));
    }
  });

  test("FactGuard 不重复阻断 raw 已有且候选未新增的高影响术语", () => {
    const rawText = "李一凡握着那件神器，站在门前。他感到一阵寒意。";
    const candidateText = "李一凡握着那件神器，站在门前。他察觉到一阵寒意。";
    const factGuardInput = {
      context: makeContext(),
      characterNames: ["李一凡"],
      chapterNumber: 1,
      ontologyLevels: [],
      constitution: null,
      intent: makeIntent(),
      contextSafety: undefined,
    };

    const fg = checkCandidateFactGuard(candidateText, factGuardInput, rawText);
    const unauthorizedDiags = fg.report.allDiagnostics.filter(
      (d) => d.source === "unauthorized_high_impact_setting",
    );
    assert.equal(unauthorizedDiags.length, 0, "候选未新增的 raw 既有术语不应重复报错");
  });
});

// ============================================================================
// Part B：runVerification 验收脚本（GREEN 阶段实现）
// ============================================================================

const SCRIPT_DIR = join(REPO_ROOT, ".pi", "extensions", "novel-studio", "scripts", "language-calibration-real-1");
const SCRIPT_PATH = join(SCRIPT_DIR, "run-verification.mjs");
const RAW_MANIFEST_PATH = join(SCRIPT_DIR, "raw-manifest.json");
const REPORT_DIR = join(REPO_ROOT, "reports", "language-calibration-real-1");
const REPORT_PATH = join(REPORT_DIR, "verification-report.md");
const BOUNDARY_REJECTION_PATH = join(REPORT_DIR, "stub-boundary-rejection.json");

describe("LANGUAGE-CALIBRATION-REAL-1 · Part B: runVerification 验收脚本输出", () => {
  // 测试前确保脚本存在 + 运行一次（如果脚本不存在，所有测试 fail）

  test("run-verification.mjs 脚本存在", () => {
    assert.ok(existsSync(SCRIPT_PATH), `脚本应存在：${SCRIPT_PATH}`);
  });

  test("独立 raw manifest 冻结 5 章完整 SHA-256", () => {
    assert.ok(existsSync(RAW_MANIFEST_PATH), `raw manifest 应存在：${RAW_MANIFEST_PATH}`);
    const manifest = JSON.parse(readFileSync(RAW_MANIFEST_PATH, "utf-8"));
    assert.equal(manifest.schema, "pinovel.language-calibration-raw-manifest.v1");
    assert.equal(manifest.chapters.length, EXPECTED_CHAPTERS.length);
    assert.deepEqual(manifest.chapters.map((entry) => entry.filename), EXPECTED_CHAPTERS);
    for (const entry of manifest.chapters) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/i, `${entry.filename} 必须记录完整 SHA-256`);
    }
  });

  test("raw 与冻结 manifest hash 不匹配时脚本必须在候选生成前阻断", () => {
    assert.ok(existsSync(RAW_MANIFEST_PATH), "raw manifest 必须先存在");
    const tempChapters = mkdtempSync(join(tmpdir(), "pinovel-calibration-raw-mismatch-"));
    try {
      for (const filename of EXPECTED_CHAPTERS) {
        const source = loadChapterRaw(filename);
        const text = filename === "chapter-17.md" ? `${source}\n篡改检测。` : source;
        writeFileSync(join(tempChapters, filename), text, "utf-8");
      }
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, "--stub", "--chapters-dir", tempChapters],
        {
          cwd: join(REPO_ROOT, ".pi", "extensions", "novel-studio"),
          env: { ...process.env, V2_FORCE_STUB: "1" },
          encoding: "utf-8",
          timeout: 60000,
        },
      );
      assert.notEqual(result.status, 0, "raw hash 不匹配时脚本不得继续运行");
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /chapter-17\.md.*(?:hash|SHA-256).*(?:不匹配|mismatch)/is,
        "阻断信息必须指出具体章节和 hash 不匹配",
      );
    } finally {
      rmSync(tempChapters, { recursive: true, force: true });
    }
  });

  test("脚本以 --stub 模式运行并生成 verification-report.md", () => {
    assert.ok(existsSync(SCRIPT_PATH), "脚本必须先存在");
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--stub"],
      {
        cwd: join(REPO_ROOT, ".pi", "extensions", "novel-studio"),
        env: { ...process.env, V2_FORCE_STUB: "1" },
        encoding: "utf-8",
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, `脚本应正常退出（exit 0），实际：${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(existsSync(REPORT_PATH), `报告应生成：${REPORT_PATH}`);
  });

  test("报告包含 5 章真实样本章节标题（chapter-01/05/08/12/17）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    for (const name of EXPECTED_CHAPTERS) {
      assert.ok(
        report.includes(name.replace(".md", "")),
        `报告应包含章节标识：${name}`,
      );
    }
  });

  test("每章报告段含 raw hash + 候选 hash + judge verdict + 最终选择 + 退化检查字段", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    // 验证每章都有这些字段
    for (const name of EXPECTED_CHAPTERS) {
      const chapterId = name.replace(".md", "");
      // 找到该章节的段落
      const sectionIdx = report.indexOf(chapterId);
      assert.ok(sectionIdx >= 0, `报告应包含 ${chapterId} 段落`);
      // 在该段落后面 800 字符内查找字段
      const section = report.slice(sectionIdx, sectionIdx + 2000);
      assert.ok(/raw\s*hash|rawHash/i.test(section), `${chapterId} 段应含 raw hash`);
      assert.ok(/候选\s*hash|candidateHash|calibrationHash/i.test(section), `${chapterId} 段应含候选 hash`);
      assert.ok(/verdict|judge/i.test(section), `${chapterId} 段应含 judge verdict`);
      assert.ok(/最终选择|selectedSource|finalSource/i.test(section), `${chapterId} 段应含最终选择`);
      assert.ok(/退化检查|regression/i.test(section), `${chapterId} 段应含退化检查`);
    }
  });

  test("报告含 5 章总体统计（通过率 + 越界拒绝数 + raw 兜底数）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    assert.ok(/总体统计|Summary|统计/i.test(report), "报告应含总体统计段");
    assert.ok(/通过率|passRate/i.test(report), "报告应含通过率");
    assert.ok(/越界拒绝|outOfBounds|spanBoundary/i.test(report), "报告应含越界拒绝数");
    assert.ok(/raw\s*兜底|rawFallback|fallback/i.test(report), "报告应含 raw 兜底数");
    assert.ok(/manifest.*[a-f0-9]{64}/i.test(report), "报告应记录冻结 raw manifest 的完整 hash");
  });

  test("stub 产出真实 span 越界候选并由生成器拒绝", () => {
    assert.ok(existsSync(BOUNDARY_REJECTION_PATH), "应保存 stub-boundary-rejection.json");
    const evidence = JSON.parse(readFileSync(BOUNDARY_REJECTION_PATH, "utf-8"));
    assert.equal(evidence.rejected, true, "越界候选必须被拒绝");
    assert.equal(evidence.candidatesGenerated, 0, "越界候选不得进入候选集");
    assert.match(evidence.reason, /span.*边界|越界|修改了 span 外文本/i);
    assert.match(evidence.rawHash, /^[a-f0-9]{64}$/i);
    assert.match(evidence.attemptedCandidateHash, /^[a-f0-9]{64}$/i);
  });

  test("报告含至少 1 章保留 raw 的记录（验证 raw 兜底机制端到端可达）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    // 至少 1 章 tie 或退化导致保留 raw
    assert.ok(
      /保留\s*raw|rawFallback|finalSource.*raw|selectedSource.*raw/i.test(report),
      "报告应至少有 1 章保留 raw",
    );
  });

  test("报告标注 REQUIRES_AUTH 边界（真实模型调用为后续切片）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    assert.ok(
      /REQUIRES_AUTH|真实模型|stub\s*模式|offline/i.test(report),
      "报告应明确标注 REQUIRES_AUTH / stub 模式",
    );
  });

  test("验收状态严格标记 COMPLETE_L0，真实模型与正收益保持 REQUIRES_AUTH", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    assert.match(report, /验收状态[^\n]*COMPLETE_L0/i, "offline/stub 只能标记 COMPLETE_L0");
    assert.match(
      report,
      /真实模型与正收益[^\n]*REQUIRES_AUTH/i,
      "真实 Doubao + gpt-5.6-sol 与 B4/B0 正收益必须保持 REQUIRES_AUTH",
    );
    assert.match(report, /--auth[^\n]*(?:退出码|exit code)[^\n]*2[^\n]*fail-closed/i);
    assert.match(report, /Git HEAD[^\n]*(?:不代表|不能代表)[^\n]*脏工作树/i);
  });

  test("--auth 未获授权时以退出码 2 fail-closed，不调用真实模型", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--auth"],
      {
        cwd: join(REPO_ROOT, ".pi", "extensions", "novel-studio"),
        encoding: "utf-8",
        timeout: 60000,
      },
    );
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /REQUIRES_AUTH|未启用|未授权/i);
  });

  // ── Change 5 part 2：新增逐章产物结构测试 ──
  // 任务规格 L395 "每个章节保存 raw、校准候选、匿名反向 A/B"。
  // 旧实现只生成一份汇总 markdown 报告，被 .gitignore 排除；
  // 新实现每章保存 6 个文件到 reports/language-calibration-real-1/{chapterId}/。
  //
  // 严格规格：5 章全部通过 FactGuard，并各自完成匿名反向 A/B。
  test("每章产物目录含 raw.md / candidate.md / hypothesis.json / fact-guard.json / judge-verdict.json / selection.json", () => {
    const passedChapters = [];
    for (const name of EXPECTED_CHAPTERS) {
      const chapterId = name.replace(".md", "");
      const chapterDir = join(REPORT_DIR, chapterId);
      assert.ok(existsSync(chapterDir), `章节目录应存在：${chapterDir}`);
      assert.ok(existsSync(join(chapterDir, "raw.md")), `${chapterId}/raw.md 应存在`);
      assert.ok(existsSync(join(chapterDir, "candidate.md")), `${chapterId}/candidate.md 应存在`);
      assert.ok(existsSync(join(chapterDir, "hypothesis.json")), `${chapterId}/hypothesis.json 应存在`);
      assert.ok(existsSync(join(chapterDir, "fact-guard.json")), `${chapterId}/fact-guard.json 应存在`);
      assert.ok(existsSync(join(chapterDir, "judge-verdict.json")), `${chapterId}/judge-verdict.json 应存在`);
      assert.ok(existsSync(join(chapterDir, "selection.json")), `${chapterId}/selection.json 应存在`);

      // 验证 fact-guard.json 结构
      const fg = JSON.parse(readFileSync(join(chapterDir, "fact-guard.json"), "utf-8"));
      assert.ok(typeof fg.ok === "boolean", `${chapterId}/fact-guard.json 应有 ok 字段`);
      assert.ok(Array.isArray(fg.hardBlocks), `${chapterId}/fact-guard.json 应有 hardBlocks 数组`);
      assert.equal(fg.ok, true, `${chapterId} FactGuard 必须通过：${fg.factGuardReason}`);
      assert.equal(fg.hardBlocks.length, 0, `${chapterId} hardBlocks 应为空`);
      passedChapters.push(chapterId);

      // 验证 judge-verdict.json 完整双轮结构
      const jv = JSON.parse(readFileSync(join(chapterDir, "judge-verdict.json"), "utf-8"));
      assert.ok(typeof jv.reverseReviewed === "boolean", `${chapterId}/judge-verdict.json 应有 reverseReviewed boolean`);
      assert.ok(typeof jv.auditSummary === "string" && jv.auditSummary.length > 0, `${chapterId} 应有 auditSummary`);
      assert.ok(jv.firstRound, `${chapterId}/judge-verdict.json 应有 firstRound`);
      assert.equal(jv.firstRound.degraded, false, `${chapterId} 首轮不应降级`);
      assert.ok(jv.firstRound.verdict, `${chapterId} 首轮应有 verdict 对象`);
      assert.equal(jv.reverseReviewed, true, `${chapterId} 应触发反向复判`);
      assert.ok(jv.reverseRound, `${chapterId} 应有 reverseRound 对象`);
      assert.ok(jv.rounds >= 2, `${chapterId} 应至少有 2 轮，实际：${jv.rounds}`);

      // 验证 selection.json 结构
      const sel = JSON.parse(readFileSync(join(chapterDir, "selection.json"), "utf-8"));
      assert.ok(typeof sel.finalSelectedSource === "string", `${chapterId}/selection.json 应有 finalSelectedSource`);
      assert.ok(sel.regressionCheck, `${chapterId}/selection.json 应有 regressionCheck`);
      assert.match(sel.rawHash, /^[a-f0-9]{64}$/i, `${chapterId}/selection.json 应有完整 raw SHA-256`);
      assert.match(sel.rawManifestHash, /^[a-f0-9]{64}$/i, `${chapterId}/selection.json 应关联冻结 manifest hash`);
    }

    assert.equal(
      passedChapters.length,
      EXPECTED_CHAPTERS.length,
      `5/5 章 FactGuard 都应通过，实际：${passedChapters.length}/5 [${passedChapters.join(", ")}]`,
    );
  });

  test("五章 judge-verdict.json 反向 A/B 两轮 verdict 字段均合法", () => {
    for (const name of EXPECTED_CHAPTERS) {
      const chapterId = name.replace(".md", "");
      const fg = JSON.parse(readFileSync(join(REPORT_DIR, chapterId, "fact-guard.json"), "utf-8"));
      assert.equal(fg.ok, true, `${chapterId} 必须通过 FactGuard 后执行 A/B`);
      const jv = JSON.parse(readFileSync(join(REPORT_DIR, chapterId, "judge-verdict.json"), "utf-8"));

      // 首轮 verdict 字段合法性
      assert.ok(
        ["A", "B", "tie"].includes(jv.firstRound.verdict.winner),
        `${chapterId} 首轮 winner 应合法（A/B/tie）：${jv.firstRound.verdict?.winner}`,
      );
      assert.ok(
        ["clear", "slight", "uncertain"].includes(jv.firstRound.verdict.confidence),
        `${chapterId} 首轮 confidence 应合法（clear/slight/uncertain）：${jv.firstRound.verdict?.confidence}`,
      );
      assert.ok(
        Array.isArray(jv.firstRound.verdict.decisiveReasons),
        `${chapterId} 首轮 decisiveReasons 应为数组`,
      );
      assert.ok(
        typeof jv.firstRound.verdict.constitutionAlignment === "string",
        `${chapterId} 首轮 constitutionAlignment 应为字符串`,
      );

      // 反向 verdict 字段合法性（reverseRound 非 null 已在上一个测试断言）
      assert.ok(
        ["A", "B", "tie"].includes(jv.reverseRound.verdict.winner),
        `${chapterId} 反向 winner 应合法：${jv.reverseRound.verdict?.winner}`,
      );
      assert.ok(
        ["clear", "slight", "uncertain"].includes(jv.reverseRound.verdict.confidence),
        `${chapterId} 反向 confidence 应合法：${jv.reverseRound.verdict?.confidence}`,
      );
      assert.ok(
        Array.isArray(jv.reverseRound.verdict.decisiveReasons),
        `${chapterId} 反向 decisiveReasons 应为数组`,
      );

      // 匿名映射字段（不暴露真实身份，只验证 A/B 标签存在）
      assert.ok(jv.mapping, `${chapterId} 应有匿名映射`);
      assert.ok(["A", "B"].includes(jv.mapping.leftLabel), `${chapterId} mapping.leftLabel 应为 A/B`);
      assert.ok(["A", "B"].includes(jv.mapping.rightLabel), `${chapterId} mapping.rightLabel 应为 A/B`);
      assert.equal(
        jv.mapping.leftLabel !== jv.mapping.rightLabel,
        true,
        `${chapterId} leftLabel/rightLabel 应不同`,
      );
    }
  });
});
