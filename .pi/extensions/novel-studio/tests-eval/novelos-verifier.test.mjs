/**
 * NovelOS Narrative Verifier 测试（OPT-9.6/9.7）
 *
 * 验证：
 * 1. 硬错误（格式损坏/大段重复/实体幻觉）→ hardFindings → compileFeedback → patch candidate
 * 2. 软意见（语言风险）→ softFindings → compileFeedback 返回空 → 不触发 patch
 * 3. 知识边界检查：角色 forbiddenKnowledge 出现在正文 → hard finding
 * 4. canon 冲突检查：canon 约束被违反 → hard finding
 * 5. 事件遗漏检查：chapterIntent 关键词不在正文 → hard finding
 * 6. patch 退化检查：正文缩短 > 30% 或 agency 稀释 → accepted=false
 * 7. verifier precision/recall 在 fixture 可测量
 *
 * 用 stub CompiledContext + 构造 draft text，独立测试，不依赖真实 workspace。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNarrativeVerifierSuite } from "../dist/novelos/verification/narrative-verifier-suite.js";
import { compileFeedback, extractSoftFindings } from "../dist/novelos/verification/verification-feedback-compiler.js";
import { createCandidatePatchService } from "../dist/novelos/agent/candidate-patch-service.js";

// ============================================================================
// Fixture helpers
// ============================================================================

/**
 * 构造最小 CompiledContext（只填充 verifier 需要的字段）。
 */
function createContext(overrides = {}) {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

/**
 * 构造含 forbiddenKnowledge 的角色状态。
 */
function createCharacterWithForbiddenKnowledge(characterId, name, forbidden) {
  return {
    characterId,
    name,
    state: { forbiddenKnowledge: forbidden },
    sourceIds: [`src:${characterId}`],
  };
}

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS Narrative Verifier（OPT-9.6/9.7）", () => {
  const verifier = createNarrativeVerifierSuite();
  const patchService = createCandidatePatchService();

  it("硬错误：格式损坏（空文）→ hardFindings → patch candidate", () => {
    const report = verifier.verify({
      text: "   \n   \n   ",
      context: createContext(),
      chapterIntent: "本章关于「林默」的能力",
    });

    assert.ok(report.hasHardFailure, "空文应触发硬失败");
    assert.ok(
      report.hardFindings.some((f) => f.failureType === "format_error"),
      "应含 format_error 硬 finding",
    );

    const feedbacks = compileFeedback(report);
    assert.ok(feedbacks.length >= 1, "应编译出至少 1 个 feedback");
    assert.ok(
      feedbacks.every((fb) => fb.repairSuggestion.length > 0),
      "每个 feedback 应有修复建议",
    );

    const proposals = patchService.proposePatches("   ", feedbacks);
    assert.ok(proposals.length >= 1, "应产生至少 1 个 patch proposal");
    assert.ok(
      proposals.every((p) => p.applied === false),
      "patch proposal 默认 applied=false（不直接覆盖）",
    );
  });

  it("硬错误：大段重复 → hardFindings", () => {
    const repeated = "林默站在青鱼嘴的礁石上，望着远方的海平面。".repeat(3);
    const report = verifier.verify({
      text: repeated,
      context: createContext(),
      chapterIntent: "本章关于「林默」",
    });

    const duplicateFindings = report.hardFindings.filter(
      (f) => f.failureType === "duplicate_pollution",
    );
    assert.ok(
      duplicateFindings.length >= 1,
      "应检测到大段重复（duplicate_pollution）",
    );
    assert.ok(
      duplicateFindings.every((f) => f.span.start >= 0),
      "重复 finding 应带 span",
    );
  });

  it("软意见：语言风险 → softFindings → compileFeedback 返回空", () => {
    // 构造正常正文（无硬错误，但可能含 AI 腔）
    const text = "林默站在礁石上，感到一阵寒意。他意识到远方有什么东西在靠近。突然，他注意到海面上泛起涟漪。".repeat(2);
    const report = verifier.verify({
      text,
      context: createContext(),
      chapterIntent: "本章关于「林默」",
    });

    // 软意见应在 softFindings 中
    const softFindings = extractSoftFindings(report);
    // 可能有或无语言风险（取决于文本），但软意见不应出现在 hardFindings
    assert.ok(
      report.hardFindings.every((f) => f.severity === "hard" || f.severity === "fatal"),
      "hardFindings 只含 hard/fatal",
    );

    // compileFeedback 只编译 hard findings → 软意见不触发 patch
    const feedbacks = compileFeedback(report);
    // 软意见不应产生 feedback
    const softFeedbacks = feedbacks.filter((fb) => fb.failureType === "language_risk");
    assert.equal(
      softFeedbacks.length,
      0,
      "软意见（language_risk）不应编译为 feedback",
    );
  });

  it("知识边界检查：角色 forbiddenKnowledge 出现在正文 → hard finding", () => {
    const context = createContext({
      characterStates: [
        createCharacterWithForbiddenKnowledge("char:linmo", "林默", ["复苏之眼"]),
      ],
    });

    // 正文在林默附近提到"复苏之眼"（不该知道）
    const text = "林默看着前方，心中想着复苏之眼的力量。这股力量让他感到不安。他继续向前走去，步伐坚定。".repeat(2);

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "本章关于林默",
    });

    const knowledgeFindings = report.hardFindings.filter(
      (f) => f.failureType === "knowledge_boundary",
    );
    assert.ok(
      knowledgeFindings.length >= 1,
      "应检测到知识边界违规",
    );
    assert.ok(
      knowledgeFindings.every((f) => f.sourceRef.includes("forbiddenKnowledge")),
      "sourceRef 应指向 character:forbiddenKnowledge",
    );
    assert.ok(
      knowledgeFindings.every((f) => f.confidence > 0),
      "应带置信度",
    );
  });

  it("canon 冲突检查：canon 约束被违反 → hard finding", () => {
    const context = createContext({
      facts: [
        {
          id: "fact:canon:resurrection_eye",
          content: "林默不能使用复苏之眼的全部力量",
          sourceIds: ["src:canon"],
          kind: "fact",
        },
      ],
    });

    // 正文违反 canon：使用全部力量
    const text = "林默终于使用复苏之眼的全部力量，将敌人击溃。这一击惊天动地，所有人都震惊了。".repeat(2);

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "本章关于林默的战斗",
    });

    const canonFindings = report.hardFindings.filter(
      (f) => f.failureType === "canon_conflict",
    );
    assert.ok(
      canonFindings.length >= 1,
      "应检测到 canon 冲突",
    );
    assert.ok(
      canonFindings.every((f) => f.sourceRef.includes("fact:")),
      "sourceRef 应指向 fact",
    );
  });

  it("事件遗漏检查：chapterIntent 关键词不在正文 → review finding（P0-2 降级）", () => {
    // chapterIntent 提到「青鱼嘴」，但正文完全不包含
    const text = "林默走在路上，看着风景。天气不错，阳光明媚。他继续前行，心中平静。".repeat(3);

    const report = verifier.verify({
      text,
      context: createContext(),
      chapterIntent: "本章关于「青鱼嘴」的事件",
    });

    // P0-2 修复（NOVELOS-CONSTRAINT-RELAXATION-1）：
    // 引号/关于X 关键词遗漏降为 review + heuristic + uncertain + 空范围（诊断 only，不触发 hard block）。
    // 真实遗漏仍被检出，但作为诊断证据（report.findings）而非硬阻断（hardFindings）。
    // inc-2 修复：heuristic 遗漏的 coverageStatus 从 missing 改为 uncertain（三态语义统一）。
    const omissionFindings = report.findings.filter(
      (f) => f.failureType === "intent_omission"
        && f.certainty === "heuristic"
        && f.coverageStatus === "uncertain",
    );
    assert.ok(
      omissionFindings.length >= 1,
      "应检测到关键事件遗漏（青鱼嘴）作为 heuristic finding",
    );
    assert.ok(
      omissionFindings.every((f) => f.sourceRef.includes("intent:")),
      "sourceRef 应指向 intent",
    );
    assert.ok(
      omissionFindings.every((f) => f.severity === "review"),
      "P0-2：关键词遗漏应为 review 严重度",
    );
  });

  it("patch 退化检查：正文缩短 > 30% → accepted=false", () => {
    const originalDraft = "林默站在青鱼嘴的礁石上，望着远方的海平面。海风吹过，带着咸涩的味道。他心中充满了对未来的期待，也有对过去的怀念。".repeat(2);
    // patched 大幅缩短
    const patchedText = "林默站着。";

    const proposal = {
      findingId: "test-finding-1",
      type: "sentence_patch",
      // span 覆盖全文：本测试验证长度/agency 退化，不验证 span 精度，
      // 故 targetSpan 取全文范围，使 span 不变性检查 no-op，让长度/agency 检查运行。
      targetSpan: { start: 0, end: originalDraft.length, excerpt: "全文" },
      suggestion: "修复",
      repairDirection: "修复方向",
      applied: false,
    };

    const result = patchService.evaluatePatch(originalDraft, patchedText, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "正文大幅缩短应拒绝 patch");
    assert.ok(result.reason.includes("缩短"), "拒绝原因应提及缩短");
    assert.equal(proposal.rejected, true, "proposal 应标记 rejected");
    assert.ok(proposal.rejectionReason, "应有 rejectionReason");
  });

  it("patch 退化检查：agency 稀释 → accepted=false", () => {
    // 原文行动词密集
    const originalDraft = "林默跑向礁石，跳起来，抓住绳索，推开石门，冲进洞穴。他拿起草稿，撕碎，扔掉。他说，走！他喊，快跑！".repeat(2);
    // patched 行动词大幅减少
    const patchedText = "林默站在礁石上，感受着海风。他觉得周围很安静，似乎什么都没有发生。他想着过去的事情，心中感到平静。".repeat(2);

    const proposal = {
      findingId: "test-finding-2",
      type: "sentence_patch",
      // span 覆盖全文：本测试验证长度/agency 退化，不验证 span 精度。
      targetSpan: { start: 0, end: originalDraft.length, excerpt: "全文" },
      suggestion: "修复",
      repairDirection: "修复方向",
      applied: false,
    };

    const result = patchService.evaluatePatch(originalDraft, patchedText, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, false, "agency 稀释应拒绝 patch");
    assert.ok(
      result.reason.includes("agency") || result.reason.includes("行动词"),
      "拒绝原因应提及 agency/行动词",
    );
  });

  it("patch 非退化：正文长度与 agency 保持 → accepted=true", () => {
    const originalDraft = "林默站在青鱼嘴的礁石上，望着远方的海平面。海风吹过，带着咸涩的味道。他走向高处，查看四周。他说，这里就是青鱼嘴。".repeat(2);
    // patched 修正了问题但保持长度和 agency
    const patchedText = "林默站在青鱼嘴的礁石上，望着远方的海平面。海风吹过，带着咸涩的味道。他走向高处，查看四周。他说，这里就是青鱼嘴的入口。".repeat(2);

    const proposal = {
      findingId: "test-finding-3",
      type: "sentence_patch",
      // span 覆盖全文：本测试验证长度/agency 退化，不验证 span 精度。
      targetSpan: { start: 0, end: originalDraft.length, excerpt: "全文" },
      suggestion: "修复",
      repairDirection: "修复方向",
      applied: false,
    };

    const result = patchService.evaluatePatch(originalDraft, patchedText, [proposal.targetSpan], [proposal]);
    assert.equal(result.accepted, true, "非退化 patch 应被接受");
    assert.equal(proposal.rejected, undefined, "非退化时 proposal 不标记 rejected");
  });

  it("verifier precision/recall：已知问题 fixture 可测量", () => {
    // 构造含 3 个已知问题的 fixture
    const context = createContext({
      characterStates: [
        createCharacterWithForbiddenKnowledge("char:linmo", "林默", ["禁忌知识"]),
      ],
      facts: [
        {
          id: "fact:canon:1",
          content: "主角不能进入禁地",
          sourceIds: ["src"],
          kind: "fact",
        },
      ],
    });

    // 正文含 3 个问题：知识边界违规 + canon 冲突 + 关键事件遗漏
    const text = "林默站在禁地入口，心中想着禁忌知识。他终于进入禁地，打破了封印。这一刻，他感到无比强大。".repeat(2);

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "本章关于「青鱼嘴」",  // 青鱼嘴不在正文 → 事件遗漏
    });

    // 已知问题：3 个
    // 1. 知识边界（禁忌知识）→ hard
    // 2. canon 冲突（进入禁地）→ hard
    // 3. 事件遗漏（青鱼嘴）→ P0-2 降级为 review + heuristic（不再 hard block）
    const knownProblemTypes = new Set([
      "knowledge_boundary",
      "canon_conflict",
      "intent_omission",
    ]);

    // P0-2 修复：intent_omission 现在是 review finding，需在 report.findings 中检测
    const detectedAll = report.findings.filter((f) =>
      knownProblemTypes.has(f.failureType),
    );
    const detectedTypes = new Set(detectedAll.map((f) => f.failureType));

    // recall = 检测到的已知问题类型 / 已知问题类型总数
    const recall = detectedTypes.size / knownProblemTypes.size;
    assert.ok(
      recall >= 0.66,
      `recall 应 ≥ 0.66（检测到 ${detectedTypes.size}/${knownProblemTypes.size} 类），实际：${recall}`,
    );

    // precision = 正确检测 / 总检测（所有 findings 中属于已知问题的比例）
    const precision = detectedAll.length / report.findings.length;
    assert.ok(
      precision >= 0.1,
      `precision 应 ≥ 0.1（可能有其他检测如 duplicate_scan、language_risk），实际：${precision}`,
    );

    // 所有 findings 都带 span + sourceRef + confidence
    assert.ok(
      report.findings.every((f) => f.span && f.sourceRef && typeof f.confidence === "number"),
      "所有 findings 应带 span + sourceRef + confidence",
    );

    // P0-2：knowledge_boundary 和 canon_conflict 仍为 hard；intent_omission 降为 review
    const hardTypes = new Set(
      report.hardFindings
        .filter((f) => knownProblemTypes.has(f.failureType))
        .map((f) => f.failureType),
    );
    assert.ok(hardTypes.has("knowledge_boundary"), "知识边界仍应为 hard");
    assert.ok(hardTypes.has("canon_conflict"), "canon 冲突仍应为 hard");
    assert.ok(!hardTypes.has("intent_omission"), "P0-2：intent_omission 不再为 hard");
  });
});

// ============================================================================
// M1.1 新增 verifier 测试：fact_omission / timeline / location / contradiction
// ============================================================================

describe("NovelOS Narrative Verifier M1.1（事实/连续性/矛盾检查）", () => {
  const verifier = createNarrativeVerifierSuite();

  it("fact_omission：inviolableFacts 关键短语在正文遗漏 → hard finding", () => {
    // F1 场景：inviolableFacts 含"青鱼嘴水域有暗流"，但正文完全不含"暗流"
    const text = "林川跳进青鱼嘴，水面平静无波。他在水下待了一个小时，搜遍了整个水域。";
    const report = verifier.verify({
      text,
      context: createContext(),
      chapterIntent: "第3章 生成正文",
      inviolableFacts: ["青鱼嘴水域有暗流"],
    });

    const omissionFindings = report.hardFindings.filter(
      (f) => f.failureType === "fact_omission",
    );
    assert.ok(
      omissionFindings.length >= 1,
      "应检测到 fact_omission（暗流遗漏）",
    );
    assert.ok(
      omissionFindings.every((f) => f.sourceRef.includes("inviolableFact:")),
      "sourceRef 应指向 inviolableFact",
    );
  });

  it("fact_omission：正文包含关键短语 → 不报 fact_omission", () => {
    // 健康候选：正文含"暗流"
    const text = "林川跳进青鱼嘴，水下暗流拉扯着他的腿，他用力蹬水才稳住身体。";
    const report = verifier.verify({
      text,
      context: createContext(),
      chapterIntent: "第3章 生成正文",
      inviolableFacts: ["青鱼嘴水域有暗流"],
    });

    const omissionFindings = report.hardFindings.filter(
      (f) => f.failureType === "fact_omission",
    );
    assert.equal(
      omissionFindings.length,
      0,
      "正文含关键短语 → 不应报 fact_omission",
    );
  });

  it("timeline_inconsistency：正文时间早于 canon 锚点 → review finding（P0-2 降级）", () => {
    // F3 场景：canon 记录第2章时间到中午十二点，正文写上午九点
    // P0-2 修复（NOVELOS-CONSTRAINT-RELAXATION-1）：
    // 无明确日期推进上下文（次日/第二天/回忆等）时，启发式无法确定是否为同日回退，
    // 降为 review + heuristic + uncertain，不触发 hard block。
    const context = createContext({
      facts: [
        {
          id: "canon:timeline-ch2",
          content: "第2章时间：上午十点到中午十二点",
          sourceIds: ["ch2#final.md"],
          kind: "fact",
        },
      ],
    });
    const text = "林川从青鱼嘴的水里爬上来。此时是上午九点，阳光刚刚升起。他看了眼手表。".repeat(2);

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "第3章 生成正文",
    });

    // P0-2：不确定日期上下文 → review + heuristic + uncertain
    const timelineFindings = report.findings.filter(
      (f) => f.failureType === "timeline_inconsistency"
        && f.certainty === "heuristic"
        && f.coverageStatus === "uncertain",
    );
    assert.ok(
      timelineFindings.length >= 1,
      "应检测到 timeline_inconsistency（9点 < 12点锚点）作为 heuristic finding",
    );
    assert.ok(
      timelineFindings.every((f) => f.sourceRef.includes("timeline:anchor:")),
      "sourceRef 应指向 timeline:anchor",
    );
    assert.ok(
      timelineFindings.every((f) => f.severity === "review"),
      "P0-2：无日期上下文的 timeline 不确定应为 review 严重度",
    );
  });

  it("timeline_inconsistency：正文时间晚于 canon 锚点 → 不报", () => {
    // 健康候选：正文写中午十二点半（晚于十二点锚点）
    const context = createContext({
      facts: [
        {
          id: "canon:timeline-ch2",
          content: "第2章时间：上午十点到中午十二点",
          sourceIds: ["ch2#final.md"],
          kind: "fact",
        },
      ],
    });
    const text = "林川从青鱼嘴的水里爬上岸，大口喘着气。他看了眼手表，已经是中午十二点半了。";

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "第3章 生成正文",
    });

    const timelineFindings = report.hardFindings.filter(
      (f) => f.failureType === "timeline_inconsistency",
    );
    assert.equal(
      timelineFindings.length,
      0,
      "正文时间晚于锚点 → 不应报 timeline_inconsistency",
    );
  });

  it("location_discontinuity：正文开头无过门词直接跳位置 → hard finding", () => {
    // F3 场景：canon 记录林川在青鱼嘴水下，正文开头"立刻开车去了镇上"
    const context = createContext({
      facts: [
        {
          id: "canon:location-linchuan-ch2",
          content: "第2章结尾林川位置：青鱼嘴水下",
          sourceIds: ["ch2#final.md"],
          kind: "fact",
        },
      ],
    });
    const text = "林川从青鱼嘴的水里爬上来，立刻开车去了镇上找苏婉。他在路上想着刚才的事。".repeat(2);

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "第3章 生成正文",
    });

    const locationFindings = report.hardFindings.filter(
      (f) => f.failureType === "location_discontinuity",
    );
    assert.ok(
      locationFindings.length >= 1,
      "应检测到 location_discontinuity（无过门跳转）",
    );
  });

  it("location_discontinuity：正文开头有过门词 → 不报", () => {
    // 健康候选：正文开头"爬上岸"是过门词
    const context = createContext({
      facts: [
        {
          id: "canon:location-linchuan-ch2",
          content: "第2章结尾林川位置：青鱼嘴水下",
          sourceIds: ["ch2#final.md"],
          kind: "fact",
        },
      ],
    });
    const text = "林川从青鱼嘴的水里爬上岸，大口喘着气。他看了眼手表，已经是中午十二点半了。";

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "第3章 生成正文",
    });

    const locationFindings = report.hardFindings.filter(
      (f) => f.failureType === "location_discontinuity",
    );
    assert.equal(
      locationFindings.length,
      0,
      "正文开头有过门词 → 不应报 location_discontinuity",
    );
  });

  it("fact_contradiction：正文颜色与 canon 声明冲突 → hard finding", () => {
    // F5 场景：canon 声明老周装备是蓝色，正文写红色
    const context = createContext({
      facts: [
        {
          id: "fact:laozhou-color",
          content: "老周的潜水装备是蓝色的",
          sourceIds: ["ch1#final.md"],
          kind: "fact",
        },
      ],
    });
    const text = "林川看到老周拿出一套红色的潜水装备，递给他。这是老周用了十年的装备。".repeat(2);

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "第3章 生成正文",
    });

    const contradictionFindings = report.hardFindings.filter(
      (f) => f.failureType === "fact_contradiction",
    );
    assert.ok(
      contradictionFindings.length >= 1,
      "应检测到 fact_contradiction（蓝色 vs 红色）",
    );
    assert.ok(
      contradictionFindings.every((f) => f.sourceRef.includes("fact:")),
      "sourceRef 应指向 fact",
    );
  });

  it("fact_contradiction：正文颜色与 canon 一致 → 不报", () => {
    // 健康候选：正文写蓝色（与 canon 一致）
    const context = createContext({
      facts: [
        {
          id: "fact:laozhou-color",
          content: "老周的潜水装备是蓝色的",
          sourceIds: ["ch1#final.md"],
          kind: "fact",
        },
      ],
    });
    const text = "林川看到老周拿出一套蓝色的潜水装备，递给他。这是老周用了十年的装备。";

    const report = verifier.verify({
      text,
      context,
      chapterIntent: "第3章 生成正文",
    });

    const contradictionFindings = report.hardFindings.filter(
      (f) => f.failureType === "fact_contradiction",
    );
    assert.equal(
      contradictionFindings.length,
      0,
      "正文颜色与 canon 一致 → 不应报 fact_contradiction",
    );
  });
});
