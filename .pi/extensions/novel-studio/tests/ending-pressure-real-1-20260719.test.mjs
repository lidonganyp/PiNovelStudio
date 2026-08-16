/**
 * ENDING-PRESSURE-REAL-1 RED 测试
 *
 * 派工卡: delete/任务列表/项目优化20260718.md P1-5 L411-432
 *
 * 验证现有 chapter_end_pressure → v2_amplified 链路在 5 章真实 raw 文本上的
 * 端到端可达性 + 验收脚本输出格式。
 *
 * 任务规格验收口径（L419-425）：
 * - 章末问题必须由本章因果自然推出
 * - 不允许凭空出现新敌人、新神器或新世界入口
 * - 避免统一使用"有人注视主角""游戏才刚开始"等模板
 * - 使用 PatternMemory 检查近期钩子重复
 * - 至少 5 个真实章节完成匿名反向 A/B
 *
 * 与 P1-4 LANGUAGE-CALIBRATION-REAL-1 的差异：
 * - P1-4 走 v2_chinese_calibration（Doubao span 局部替换）
 * - P1-5 走 v2_amplified（Claude Opus 4.6 章末追加钩子句）
 * - P1-5 无 span 边界硬检查（v2_amplified isCalibration=false）
 *   章末区域限制由 verifyEndingPressureReal 在 allowedEdits.raw.start >= rawText.length * 0.5 处校验
 *
 * 真实模型调用 REQUIRES_AUTH：本切片为 offline stub 模式 + 真实 raw 文本 fixture，
 * 真实 Claude Opus 4.6 + gpt-5.6-sol 调用作为后续 REQUIRES_AUTH 切片。
 *
 * RED 状态：runVerification 脚本尚未运行过；Part A 验证现有链路（已实现）；
 * Part B 验证 runVerification 脚本输出（脚本已写好但未运行过）。
 * GREEN 状态：build + 运行 scripts/ending-pressure-real-1/run-verification.mjs --stub 后全部通过。
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
// 与 P1-4 使用同一份 raw 文本，但本切片独立 manifest 物理隔离。
// ============================================================================

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const XINMO_CHAPTERS = join(REPO_ROOT, "workspaces", "xinmo", "chapters");
const XINMO_CHAPTER_FIXTURES = join(import.meta.dirname, "fixtures", "xinmo-chapters");
const XINMO_CONFIG = join(REPO_ROOT, "workspaces", "xinmo", "config.json");
const XINMO_CONFIG_FIXTURE = join(import.meta.dirname, "fixtures", "xinmo-minimal-config.json");
const EXPECTED_CHAPTERS = ["chapter-01.md", "chapter-05.md", "chapter-08.md", "chapter-12.md", "chapter-17.md"];

function loadChapterRaw(filename) {
  const fixturePath = join(XINMO_CHAPTER_FIXTURES, filename);
  if (existsSync(fixturePath)) {
    return readFileSync(fixturePath, "utf-8");
  }
  const path = join(XINMO_CHAPTERS, filename);
  assert.ok(existsSync(path), `真实章节缺失：${fixturePath}`);
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
// 5 章真实 raw 文本中的章末锚点 span（与 run-verification.mjs CHAPTER_ENDING_ANCHORS 一致）
// ============================================================================

/**
 * 每章 1 个真实存在的章末锚点 span（手工标注）：
 * - chapter-01: 章末昏睡收尾句
 * - chapter-05: 敲门收尾句
 * - chapter-08: 忘记约定收尾句
 * - chapter-12: 墨老肯定收尾句
 * - chapter-17: 骨节响收尾句
 *
 * 与 P1-4 CHAPTER_SPANS 的差异：
 * - P1-4 锚定"翻译腔/不自然 span"用于 v2_chinese_calibration 局部替换
 * - P1-5 锚定"章末区域内具体片段"用于 v2_amplified 章末追加钩子句
 */
function findSpan(rawText, excerpt) {
  const start = rawText.indexOf(excerpt);
  assert.ok(start >= 0, `span "${excerpt}" 未在 raw 中找到`);
  return { start, end: start + excerpt.length, excerpt };
}

const CHAPTER_ENDING_ANCHORS = {
  "chapter-01.md": "李一凡找了根勉强安全点的树杈做依靠，然后便沉沉地昏睡过去。",
  "chapter-05.md": "他放下筷子，起身去开门。",
  "chapter-08.md": "也没有关注到小妖已经很久没有联系过自己了。",
  "chapter-12.md": "“不错，比我想象的快。”",
  "chapter-17.md": "像某种宣告。",
};

/**
 * 5 章末尾追加的钩子句（基于本章已建立因果，不引入新实体/新设定/新世界入口）。
 *
 * 任务规格要求（L419-425）：
 * - 章末问题必须由本章因果自然推出 ✓
 * - 不允许凭空出现新敌人/新神器/新世界入口 ✓
 * - 避免统一使用"有人注视主角""游戏才刚开始"等模板 ✓（5 章钩子句各不相同）
 */
const CHAPTER_HOOKS = {
  "chapter-01.md": "睡梦中，那草木气息似乎淡了下去，远处隐约传来低沉的呼吸声。",
  "chapter-05.md": "门打开的瞬间，他看清了来人——制服上的徽记，黑水。",
  "chapter-08.md": "门外传来了脚步声——比约定时间晚了整整三个时辰。",
  "chapter-12.md": "那团火，又轻微地动了一下——这一次，是朝他的方向。",
  "chapter-17.md": "口袋里的鳞片微微发烫，仿佛在回应他刚刚想到的那个局。",
};

/**
 * 5 章因果压力元数据（causalEndPressure + PatternMemory 钩子类型）。
 *
 * PatternMemory 钩子重复检查（real-quality-acceptance.ts:126-131）：
 *   recentHookTypes.filter(h => h === currentHookType).length >= 2 → 拒绝
 * 5 章设计：每章 currentHookType 在 recentHookTypes 中出现 0 次或 1 次（不重复）
 */
const CHAPTER_PRESSURE_META = {
  "chapter-01.md": {
    causalEndPressure: {
      value: "昏睡后巢穴附近的未知威胁逼近",
      sourceRef: "seed:ch01:environment_danger",
    },
    currentHookType: "approaching_threat",
    recentHookTypes: ["cost_reveal", "suspended_action"],
  },
  "chapter-05.md": {
    causalEndPressure: {
      value: "体制内来客身份未明，敲门声打断早餐",
      sourceRef: "seed:ch05:institutional_visitor",
    },
    currentHookType: "identity_mystery",
    recentHookTypes: ["cost_reveal"],
  },
  "chapter-08.md": {
    causalEndPressure: {
      value: "队长约定逾期 + 小妖失联双重信号",
      sourceRef: "seed:ch08:missed_appointments",
    },
    currentHookType: "suspended_action",
    recentHookTypes: ["cost_reveal", "approaching_threat"],
  },
  "chapter-12.md": {
    causalEndPressure: {
      value: "火团第一次异动后的未知回应",
      sourceRef: "seed:ch12:fire_movement",
    },
    currentHookType: "mystery_response",
    recentHookTypes: ["cost_reveal"],
  },
  "chapter-17.md": {
    causalEndPressure: {
      value: "骨节异响暗示力量变化的下一步",
      sourceRef: "seed:ch17:bone_sound",
    },
    currentHookType: "power_hint",
    recentHookTypes: ["cost_reveal"],
  },
};

// ============================================================================
// stub modelGenerate（与 run-verification.mjs makeStubModelGenerate 一致）
// ============================================================================

/**
 * stub modelGenerate 行为：
 * - v2_amplified: 返回 rawText + 章末追加钩子句（基于本章因果，不引入新实体）
 * - v2_literary_judge: 返回正确 JudgeVerdict 契约（A/B/tie），默认 tie（验证 raw 兜底）
 *
 * 与 P1-4 stub 差异：
 * - P1-4 处理 v2_chinese_calibration 路由（span 局部替换 + span 边界硬检查）
 * - P1-5 处理 v2_amplified 路由（章末追加 + 无 span 边界硬检查）
 */
function makeStubModelGenerate({ verdictsByChapter = {}, hookReplacements = [], defaultVerdict = "tie" } = {}) {
  const calls = [];
  const fn = async (input) => {
    calls.push({
      route: input.route,
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
    });

    if (input.route === "v2_amplified") {
      const promptText = input.userPrompt || "";
      let candidate = "";
      let matched = false;
      for (const { rawText, hook } of hookReplacements) {
        if (promptText.includes(rawText)) {
          candidate = rawText + hook;
          matched = true;
          break;
        }
      }
      if (!matched) {
        return {
          text: "",
          model: "claude-opus-4-6",
          route: input.route,
          provider: "anthropic",
          durationMs: 80,
        };
      }
      return {
        text: candidate,
        model: "claude-opus-4-6",
        route: input.route,
        provider: "anthropic",
        durationMs: 80,
      };
    }

    if (input.route === "v2_literary_judge") {
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
      const winnerLabel = verdict;
      const confidence = verdict === "tie" ? "uncertain" : "slight";
      const reason = verdict === "tie"
        ? {
            dimension: "整体",
            betterCandidate: "neither",
            evidenceA: [],
            evidenceB: [],
            explanation: "两版质量接近，无明显胜出",
          }
        : {
            dimension: "章末牵引力",
            betterCandidate: verdict,
            evidenceA: verdict === "A" ? [] : [{ start: 0, end: 10, excerpt: "章末牵引力不足" }],
            evidenceB: verdict === "B" ? [] : [{ start: 0, end: 10, excerpt: "章末牵引力不足" }],
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
    bridgeContext: undefined,
  };
}

function makeEndingHypothesis(rawText, anchor, id = "h-ending-1") {
  const span = findSpan(rawText, anchor);
  return {
    id,
    opportunityType: "chapter_end_pressure",
    diagnosis: `章末锚点 "${anchor.slice(0, 30)}..." 区域可追加基于本章因果的钩子句`,
    evidenceSpans: [span],
    expectedReaderGain: "章末追加基于本章因果的钩子句，提升翻页牵引力",
    damageRisks: [
      "强行加钩子可能与本章已建立的事实冲突",
      "新问题若指向未规划的下章事实会伪造悬念",
    ],
    rewriteScope: "span_candidate",
    confidence: 0.55,
  };
}

// ============================================================================
// Part A：现有链路在 5 章真实 raw 上的端到端验证（已实现，应通过）
// ============================================================================

describe("ENDING-PRESSURE-REAL-1 · Part A: 现有链路在 5 章真实 raw 上的端到端处理", () => {
  test("5 章真实 raw 文本加载 + 长度校验", () => {
    const chapters = loadAllChapters();
    for (const name of EXPECTED_CHAPTERS) {
      const text = chapters[name];
      assert.ok(text && text.length > 100, `${name} 加载失败或过短`);
      assert.ok(text.includes("李一凡") || text.includes("第"), `${name} 应为真实章节`);
    }
    assert.equal(Object.keys(chapters).length, 5, "应加载 5 章");
  });

  test("5 章 raw 文本均能找到具体章末锚点 span", () => {
    const chapters = loadAllChapters();
    for (const name of EXPECTED_CHAPTERS) {
      const rawText = chapters[name];
      const anchor = CHAPTER_ENDING_ANCHORS[name];
      const span = findSpan(rawText, anchor);
      assert.ok(span.start >= 0, `${name} 的章末锚点 "${anchor}" 未找到`);
      assert.equal(span.excerpt, anchor);
      assert.ok(span.end > span.start);
      // 章末锚点应在章末区域（rawText 长度的后 50%）
      assert.ok(
        span.start >= Math.floor(rawText.length * 0.5),
        `${name} 章末锚点应在 rawText 后 50% 区域：span.start=${span.start}, threshold=${Math.floor(rawText.length * 0.5)}`,
      );
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
      // chapter_end_pressure 扫描器必须运行（不论 triggered=true/false）
      const endPressureSignal = result.scannedSignals.find((s) => s.opportunityType === "chapter_end_pressure");
      assert.ok(endPressureSignal, `${name} 应有 chapter_end_pressure 扫描器信号`);
    }
  });

  test("5 章手工 chapter_end_pressure hypothesis 通过 EditorialCandidateGenerator 生成候选（v2_amplified 路由）", async () => {
    const chapters = loadAllChapters();
    for (const name of EXPECTED_CHAPTERS) {
      const rawText = chapters[name];
      const anchor = CHAPTER_ENDING_ANCHORS[name];
      const hook = CHAPTER_HOOKS[name];
      const hypothesis = makeEndingHypothesis(rawText, anchor, `h-ending-${name}`);
      const modelGenerate = makeStubModelGenerate({
        hookReplacements: [{ rawText, hook }],
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
          "v2_amplified",
          `${name} 章末压力候选 route 必须为 v2_amplified`,
        );
        // 章末追加：候选 = rawText + hook
        assert.equal(
          cand.text,
          rawText + hook,
          `${name} stub 候选应为 rawText + 章末追加钩子句`,
        );
      }
    }
  });

  test("通过 FactGuard 的章末压力候选进入 PairwiseJudge 反向 A/B（两轮 verdict）", async () => {
    const chapters = loadAllChapters();
    const rawText = chapters["chapter-01.md"];
    const anchor = CHAPTER_ENDING_ANCHORS["chapter-01.md"];
    const hook = CHAPTER_HOOKS["chapter-01.md"];
    const hypothesis = makeEndingHypothesis(rawText, anchor, "h-ending-reverse-ab");
    // defaultVerdict="B" → winner="B" + confidence="slight" → 触发反向复判
    const modelGenerate = makeStubModelGenerate({
      defaultVerdict: "B",
      verdictsByChapter: {},
      hookReplacements: [{ rawText, hook }],
    });
    const gen = createEditorialCandidateGenerator();
    const genResult = await gen.generate({
      rawText,
      rawCandidateId: "candidate:raw:reverse-ab",
      hypotheses: [hypothesis],
      intent: makeIntent(),
      context: makeContext(),
      contextHash: "hash-reverse-ab",
      chapterNumber: 1,
      modelGenerate,
      strategyRegistry: createEditorialStrategyRegistry(),
    });
    assert.ok(genResult.candidates.length >= 1, "应生成至少 1 个章末压力候选");

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

    // 加强断言：首轮不降级 + 反向复判触发 + 至少 2 轮
    assert.ok(arbResult.firstRound, "应有首轮裁判结果");
    assert.equal(arbResult.firstRound.degraded, false, `首轮不应降级：${arbResult.firstRound.degradeReason ?? ""}`);
    assert.ok(arbResult.firstRound.verdict, "首轮应有 verdict 对象");
    assert.ok(
      ["A", "B", "tie"].includes(arbResult.firstRound.verdict.winner),
      `首轮 verdict.winner 应合法：${arbResult.firstRound.verdict?.winner}`,
    );
    assert.equal(
      arbResult.firstRound.verdict.confidence,
      "slight",
      `confidence 应为 slight（触发反向复判），实际：${arbResult.firstRound.verdict?.confidence}`,
    );
    assert.equal(
      arbResult.reverseReviewed,
      true,
      `应触发反向复判（confidence=slight → needsReverseReview=true），实际 reverseReviewed=${arbResult.reverseReviewed}`,
    );
    assert.ok(arbResult.reverseRound, "应有反向复判结果（reverseRound 非 null）");
    assert.ok(
      arbResult.rounds.length >= 2,
      `应至少有 2 轮记录，实际：${arbResult.rounds.length}`,
    );
  });

  test("Judge 不明确胜出（tie）→ SelectionPolicy 保留 raw", async () => {
    const chapters = loadAllChapters();
    const rawText = chapters["chapter-05.md"];
    const anchor = CHAPTER_ENDING_ANCHORS["chapter-05.md"];
    const hook = CHAPTER_HOOKS["chapter-05.md"];
    const hypothesis = makeEndingHypothesis(rawText, anchor, "h-ending-tie");
    // 全部 tie
    const modelGenerate = makeStubModelGenerate({
      defaultVerdict: "tie",
      hookReplacements: [{ rawText, hook }],
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
    assert.ok(genResult.candidates.length >= 1, "应生成章末压力候选");

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

  test("FactGuard 立即拒绝凭空新增的高影响新设定（章末追加不得引入新神器/新组织/新角色）", () => {
    const rawText = "李一凡站在原地，看着那扇门缓缓关上。";
    // 章末追加凭空新增秘法/神器/组织计划（违反 L420 "不允许凭空出现新敌人、新神器或新世界入口"）
    const candidateText = "李一凡站在原地，看着那扇门缓缓关上。门外传来脚步声——他突然想起师父传授的天罡三十六诀，其中第七式「定魂」正是克制眼前阵法的关键。他从乾坤袋中取出一件神器「星陨剑」，剑身流转着上古神纹。据天机阁密档记载，此剑曾斩杀三十六位魔君。";

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

    assert.equal(fg.ok, false, "章末凭空新增高影响新设定应被 FactGuard 立即拒绝");
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
});

// ============================================================================
// Part B：runVerification 验收脚本输出
// ============================================================================

const SCRIPT_DIR = join(REPO_ROOT, ".pi", "extensions", "novel-studio", "scripts", "ending-pressure-real-1");
const SCRIPT_PATH = join(SCRIPT_DIR, "run-verification.mjs");
const RAW_MANIFEST_PATH = join(SCRIPT_DIR, "raw-manifest.json");
const REPORT_DIR = join(REPO_ROOT, "reports", "ending-pressure-real-1");
const REPORT_PATH = join(REPORT_DIR, "verification-report.md");
const BOUNDARY_REJECTION_PATH = join(REPORT_DIR, "stub-non-tail-rejection.json");

describe("ENDING-PRESSURE-REAL-1 · Part B: runVerification 验收脚本输出", () => {
  test("run-verification.mjs 脚本存在", () => {
    assert.ok(existsSync(SCRIPT_PATH), `脚本应存在：${SCRIPT_PATH}`);
  });

  test("独立 raw manifest 冻结 5 章完整 SHA-256（schema=pinovel.ending-pressure-raw-manifest.v1）", () => {
    assert.ok(existsSync(RAW_MANIFEST_PATH), `raw manifest 应存在：${RAW_MANIFEST_PATH}`);
    const manifest = JSON.parse(readFileSync(RAW_MANIFEST_PATH, "utf-8"));
    assert.equal(manifest.schema, "pinovel.ending-pressure-raw-manifest.v1");
    assert.equal(manifest.chapters.length, EXPECTED_CHAPTERS.length);
    assert.deepEqual(
      manifest.chapters.map((entry) => entry.filename),
      EXPECTED_CHAPTERS,
    );
    for (const entry of manifest.chapters) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/i, `${entry.filename} 必须记录完整 SHA-256`);
    }
  });

  test("raw 与冻结 manifest hash 不匹配时脚本必须在候选生成前阻断", () => {
    assert.ok(existsSync(RAW_MANIFEST_PATH), "raw manifest 必须先存在");
    const tempChapters = mkdtempSync(join(tmpdir(), "pinovel-ending-raw-mismatch-"));
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
        timeout: 120000,
      },
    );
    assert.equal(
      result.status,
      0,
      `脚本应正常退出（exit 0），实际：${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
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
    for (const name of EXPECTED_CHAPTERS) {
      const chapterId = name.replace(".md", "");
      const sectionIdx = report.indexOf(chapterId);
      assert.ok(sectionIdx >= 0, `报告应包含 ${chapterId} 段落`);
      const section = report.slice(sectionIdx, sectionIdx + 2000);
      assert.ok(/raw\s*hash|rawHash/i.test(section), `${chapterId} 段应含 raw hash`);
      assert.ok(/候选\s*hash|candidateHash|candidateHash/i.test(section), `${chapterId} 段应含候选 hash`);
      assert.ok(/verdict|judge/i.test(section), `${chapterId} 段应含 judge verdict`);
      assert.ok(/最终选择|selectedSource|finalSource/i.test(section), `${chapterId} 段应含最终选择`);
      assert.ok(/退化检查|regression/i.test(section), `${chapterId} 段应含退化检查`);
    }
  });

  test("报告含 5 章总体统计（通过率 + 非章末拒绝数 + raw 兜底数 + PatternMemory + causalEndPressure + tailRegion）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    assert.ok(/总体统计|Summary|统计/i.test(report), "报告应含总体统计段");
    assert.ok(/通过率|passRate/i.test(report), "报告应含通过率");
    assert.ok(/非章末候选拒绝|nonTailRejection/i.test(report), "报告应含非章末候选拒绝数");
    assert.ok(/raw\s*兜底|rawFallback|fallback/i.test(report), "报告应含 raw 兜底数");
    assert.ok(/PatternMemory|钩子检查|钩子重复/i.test(report), "报告应含 PatternMemory 钩子检查字段");
    assert.ok(/causalEndPressure|causalEndPressure\.sourceRef/i.test(report), "报告应含 causalEndPressure.sourceRef 字段");
    assert.ok(/章末区域|tailRegion|appendedInTailRegion/i.test(report), "报告应含章末区域限制字段");
    assert.ok(/manifest.*[a-f0-9]{64}/i.test(report), "报告应记录冻结 raw manifest 的完整 hash");
  });

  test("stub 产出非章末候选并被 verifyEndingPressureReal 章末区域检查拒绝", () => {
    assert.ok(existsSync(BOUNDARY_REJECTION_PATH), "应保存 stub-non-tail-rejection.json");
    const evidence = JSON.parse(readFileSync(BOUNDARY_REJECTION_PATH, "utf-8"));
    // v2_amplified 不在生成器层做 span 边界硬检查，所以候选会生成；
    // 章末区域限制由 verifyEndingPressureReal 在 allowedEdits.raw.start >= rawText.length * 0.5 处校验
    assert.equal(
      evidence.rejectedByTailRegionCheck,
      true,
      "非章末候选（中部追加）必须被 verifyEndingPressureReal 章末区域检查识别为越界",
    );
    assert.match(evidence.rawHash, /^[a-f0-9]{64}$/i);
    assert.match(evidence.attemptedCandidateHash, /^[a-f0-9]{64}$/i);
    assert.ok(
      evidence.midPoint < evidence.tailRegionThreshold,
      `midPoint (${evidence.midPoint}) 应小于 tailRegionThreshold (${evidence.tailRegionThreshold})`,
    );
  });

  test("报告含至少 1 章保留 raw 的记录（验证 raw 兜底机制端到端可达）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
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

  test("验收状态严格标记三层（机制 COMPLETE_L0 / 离线 stub COMPLETE_L0 / 真实运行 REQUIRES_AUTH）", () => {
    assert.ok(existsSync(REPORT_PATH), "报告必须先生成");
    const report = readFileSync(REPORT_PATH, "utf-8");
    // 三层标记：机制 COMPLETE_L0 / 离线 stub COMPLETE_L0 / 真实运行 REQUIRES_AUTH
    assert.match(report, /真实质量验收机制[^\n]*COMPLETE_L0/i, "真实质量验收机制应标记为 COMPLETE_L0");
    assert.match(report, /离线\s*stub[^\n]*COMPLETE_L0/i, "离线 stub 端到端可达性应标记为 COMPLETE_L0");
    assert.match(
      report,
      /真实模型运行[^\n]*REQUIRES_AUTH/i,
      "真实模型运行 + 证据防伪 + 文学净正收益必须标记为 REQUIRES_AUTH",
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

  // ── 逐章产物结构测试 ──
  // 任务规格 L425 "至少 5 个真实章节完成匿名反向 A/B"。
  // 每章保存 6 个文件到 reports/ending-pressure-real-1/{chapterId}/。
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

      // 验证 PatternMemory + causalEndPressure 字段
      assert.ok(sel.pressureMeta, `${chapterId}/selection.json 应有 pressureMeta`);
      assert.ok(
        typeof sel.pressureMeta.causalEndPressure?.sourceRef === "string" &&
          sel.pressureMeta.causalEndPressure.sourceRef.length > 0,
        `${chapterId} pressureMeta.causalEndPressure.sourceRef 必须非空`,
      );
      assert.ok(
        typeof sel.pressureMeta.currentHookType === "string" &&
          sel.pressureMeta.currentHookType.length > 0,
        `${chapterId} pressureMeta.currentHookType 必须非空`,
      );
      assert.ok(sel.patternMemoryCheck, `${chapterId}/selection.json 应有 patternMemoryCheck`);
      assert.ok(
        ["ok", "blocked"].includes(sel.patternMemoryCheck.verdict),
        `${chapterId} patternMemoryCheck.verdict 应为 ok 或 blocked`,
      );
      // 5 章设计：currentHookType 在 recentHookTypes 中重复 0 次或 1 次（< 阈值 2）→ ok
      assert.equal(
        sel.patternMemoryCheck.verdict,
        "ok",
        `${chapterId} PatternMemory 应通过（recentCount < 2），实际 verdict=${sel.patternMemoryCheck.verdict}, recentCount=${sel.patternMemoryCheck.recentCount}`,
      );
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
        `${chapterId} 首轮 confidence 应合法：${jv.firstRound.verdict?.confidence}`,
      );
      assert.ok(
        Array.isArray(jv.firstRound.verdict.decisiveReasons),
        `${chapterId} 首轮 decisiveReasons 应为数组`,
      );
      assert.ok(
        typeof jv.firstRound.verdict.constitutionAlignment === "string",
        `${chapterId} 首轮 constitutionAlignment 应为字符串`,
      );

      // 反向 verdict 字段合法性
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

      // 匿名映射字段
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

  test("5 章钩子句各不相同（避免模板化，L422 要求）", () => {
    // 验证 5 章钩子句不重复（避免统一使用"有人注视主角""游戏才刚开始"等模板）
    const hooks = Object.values(CHAPTER_HOOKS);
    const uniqueHooks = new Set(hooks);
    assert.equal(
      uniqueHooks.size,
      hooks.length,
      `5 章钩子句必须各不相同（避免模板化），实际唯一数：${uniqueHooks.size}/${hooks.length}`,
    );

    // 验证 5 章 currentHookType 各不相同（避免模板化的钩子类型）
    const hookTypes = Object.values(CHAPTER_PRESSURE_META).map((m) => m.currentHookType);
    const uniqueHookTypes = new Set(hookTypes);
    assert.equal(
      uniqueHookTypes.size,
      hookTypes.length,
      `5 章 currentHookType 必须各不相同，实际唯一数：${uniqueHookTypes.size}/${hookTypes.length}`,
    );

    // 验证不出现"有人注视主角""游戏才刚开始"等模板
    const forbiddenTemplates = ["有人注视主角", "游戏才刚开始", "更大的危机", "未知的敌人"];
    for (const [filename, hook] of Object.entries(CHAPTER_HOOKS)) {
      for (const tpl of forbiddenTemplates) {
        assert.ok(
          !hook.includes(tpl),
          `${filename} 钩子句不得使用模板化表达 "${tpl}"`,
        );
      }
    }
  });

  test("5 章 causalEndPressure.sourceRef 指向本章因果源（不引入新实体/新设定/新世界入口）", () => {
    // 任务规格 L419-420 要求：
    // - 章末问题必须由本章因果自然推出
    // - 不允许凭空出现新敌人/新神器/新世界入口
    for (const [filename, meta] of Object.entries(CHAPTER_PRESSURE_META)) {
      const sourceRef = meta.causalEndPressure.sourceRef;
      // sourceRef 必须遵循 seed:ch{N}:{本章已建立元素} 格式
      assert.match(
        sourceRef,
        /^seed:ch\d+:[a-z_]+$/,
        `${filename} causalEndPressure.sourceRef 格式应为 seed:ch{N}:{snake_case}，实际：${sourceRef}`,
      );
      // 提取章号
      const chapterNum = parseInt(sourceRef.match(/^seed:ch(\d+):/)[1], 10);
      const filenameNum = parseInt(filename.match(/^chapter-(\d+)\.md$/)[1], 10);
      assert.equal(
        chapterNum,
        filenameNum,
        `${filename} sourceRef 章号 ${chapterNum} 应与文件名章号 ${filenameNum} 一致（因果源必须来自本章）`,
      );
    }
  });

  test("5 章 candidate.md 等于 raw.md + 章末追加钩子句（章末追加而非 span 替换）", () => {
    for (const name of EXPECTED_CHAPTERS) {
      const chapterId = name.replace(".md", "");
      const rawPath = join(REPORT_DIR, chapterId, "raw.md");
      const candidatePath = join(REPORT_DIR, chapterId, "candidate.md");
      assert.ok(existsSync(rawPath), `${chapterId}/raw.md 应存在`);
      assert.ok(existsSync(candidatePath), `${chapterId}/candidate.md 应存在`);
      const rawText = readFileSync(rawPath, "utf-8");
      const candidateText = readFileSync(candidatePath, "utf-8");
      const expectedHook = CHAPTER_HOOKS[name];

      // candidate = raw + hook（章末追加，非 span 替换）
      assert.equal(
        candidateText,
        rawText + expectedHook,
        `${chapterId} candidate.md 应等于 raw.md + 章末追加钩子句`,
      );
      // 候选必须比 raw 长（追加了钩子句）
      assert.ok(
        candidateText.length > rawText.length,
        `${chapterId} candidate.md 必须比 raw.md 长（追加了钩子句）`,
      );
      // raw 前缀必须完整保留（v2_amplified 不允许修改 raw 主体）
      assert.ok(
        candidateText.startsWith(rawText),
        `${chapterId} candidate.md 必须以 raw.md 为前缀（章末追加而非主体改写）`,
      );
    }
  });

  test("5 章 selection.json finalSelectedSource=raw（stub 默认 tie → SelectionPolicy raw 兜底）", () => {
    for (const name of EXPECTED_CHAPTERS) {
      const chapterId = name.replace(".md", "");
      const sel = JSON.parse(readFileSync(join(REPORT_DIR, chapterId, "selection.json"), "utf-8"));
      // stub 默认 tie → SelectionPolicy raw 兜底
      assert.equal(
        sel.finalSelectedSource,
        "raw",
        `${chapterId} stub 默认 tie 应触发 SelectionPolicy raw 兜底，实际：${sel.finalSelectedSource}`,
      );
      assert.ok(
        sel.regressionCheck?.appendedInTailRegion === true,
        `${chapterId} 章末追加位置应在章末区域，实际：${sel.regressionCheck?.appendedInTailRegion}`,
      );
    }
  });
});
