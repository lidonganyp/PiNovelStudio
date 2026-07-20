/**
 * V2 Regression Checks — 反退化独立检查函数（P7 子模块）
 *
 * 来源：从 legacy PatchQualityComparator 的 6 个 check 方法提取为独立纯函数。
 * 设计差异：
 * - legacy 是 patch before/after 比较（局部修订是否退化）
 * - V2 是候选正文 vs 基线正文比较（候选是否相对退化）
 * - 语义相通：均可作为 CandidateComparator.antiRegression 维度子评分输入
 *
 * 提取的 6 个检查：
 *   1. checkAgencyDilution           — 主角行动稀释检查
 *   2. checkChapterEndHookRegression — 章末钩子丢失检查
 *   3. checkParagraphRhythmRegression— 段落节奏退化检查（over360Count 严格上升）
 *   4. checkStyleScoreRegression     — 风格匹配分下降检查
 *   5. evaluateChineseNativeRewrite  — 中文母语语感退化检查
 *   6. hasClearScoreRegression       — 明显退化判定（score<70 跌幅 + aiPhrasing +2）
 *
 * 不复用 checkDialogueRatioRegression：V2 禁止对白比例作评分维度（规格 P7）。
 *
 * 依赖：analyzeChapterParagraphRhythm 通过 package 名导入 novel-studio（root
 * node_modules Junction symlink 解析），避免相对路径在 dist 子目录下漂移。
 */

import { analyzeChapterParagraphRhythm } from "../../craft/chapter-paragraph-rhythm-gate.js";

// ============================================================================
// 模式表（从 legacy patch-quality-comparator.ts 提取，保持一致以对齐历史 trace）
// ============================================================================

/**
 * 主角行动动词表。命中数下降 → 行动稀释信号。
 * 来源：legacy AGENCY_ACTION_PATTERN。
 *
 * P0.2-A 扩展（2026-07-10）：原 15 词不覆盖跳/劈/捞/踩/挥/刺/纵身/扑等高频主角行动词，
 * 导致 ch17-s1 rawStage2（纵身跳进/手刀劈/伸手捞/踩水）得 0 分 → characterAgency=30 地板。
 * 追加 36 词（2 字复合词为主，规避"心跳/扑通/刺眼"误命中；单字劈/捞/踩/拽/拦/递保留，FP 风险低）。
 */
export const AGENCY_ACTION_PATTERN = /推开|冲进|夺过|抓住|拿起|拿到|打开|关上|踢开|撞开|按下|锁住|切断|转身|决定|选择|拒绝|纵身|跳进|跳入|跳下|跳上|扑向|扑过|刺入|刺中|挥出|挥手|砸下|砸开|砸向|挡住|护住|护在|揽住|揽入|扣住|扣紧|探手|探身|扛起|扛上|塞进|塞入|跃起|跃过|摔下|摔向|劈|捞|踩|拽|拦|递/g;

/**
 * 感知侵蚀词模式。感知侵蚀词增多 + 行动词减少 → 主角主动性下降。
 * 来源：legacy PERCEPTION_LANGUAGE_PATTERN。
 *
 * P0 修复（2026-07-09 第八轮）：感知词分层，移出比喻/语气/情感标记词。
 * 质量根因分析发现 amplified 的 emotionalPayoff 在 3/4 样本系统性 −8（~35 vs rawStage2 ~43），
 * 根因是旧 7 词列表把两类不同性质的词混在一起：
 *   - 真感知侵蚀词（感到/意识到/注意到/突然明白）：用感知替代主角主动行动，应抑制
 *   - 比喻/语气/情感标记（觉得/似乎/仿佛）：如"仿佛被烙铁烫了一下""觉得心酸"，
 *     是文学比喻与情感内省，不是感知侵蚀；一律抑制会误伤 emotionalPayoff
 * 现仅保留 4 个真感知侵蚀词，释放情感内省与比喻语言空间。
 */
export const PERCEPTION_LANGUAGE_PATTERN = /感到|意识到|注意到|突然明白/g;

/**
 * 网文钩子信号模式。末段含此信号视为有章末钩子。
 * 来源：legacy WEBNOVEL_HOOK_PATTERN。
 */
export const WEBNOVEL_HOOK_PATTERN = /？|为什么|什么|谁|怎么|哪里|难道|难不成|发现|意识到|注意到|突然|却看到|却听到|才意识到|决定|选择|转身|走向|拿出|按下|原来|竟然|居然|不对|有问题|不对劲/;

// ============================================================================
// 通用 helpers
// ============================================================================

/**
 * 提取文本最后一句（按句末标点切分）。
 * 用于章末钩子检查：只看末句是否带钩子信号。
 *
 * 算法：按 (?<=[。！？!?]) 后置断言切句，过滤空段，取最后一条。
 */
export function extractLastSentence(text: string): string {
  if (!text) return "";
  const sentences = text
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return sentences.length > 0 ? sentences[sentences.length - 1] : "";
}

/**
 * 提取文本结尾区域（最后 600 字符），用于 hookQuality 评分。
 *
 * 设计理由（P0.2-B）：extractLastSentence 只取最后一句，强钩子在倒数第 2-4 段会被忽略
 * （ch17-s1 rawStage2 强钩子"命数不对/来历"在倒数第 4 段 → hookQuality=1）。
 * extractEndingRegion 取末段窗口，能捕获末段内的强钩子信号。
 *
 * 注意：extractLastSentence 保持不变（checkChapterEndHookRegression 仍用末句，
 * 保护 antiRegression 语义与硬编码测试 L253）。
 */
export function extractEndingRegion(text: string): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.slice(-600);
}

/**
 * 判定文本是否含网文钩子信号（用于章末钩子检查）。
 */
export function hasWebnovelHookSignal(text: string): boolean {
  if (!text) return false;
  return WEBNOVEL_HOOK_PATTERN.test(text);
}

/**
 * 提取文本中所有主角行动词命中（去重）。
 * 用于 checkAgencyDilution 比较 before/after 的行动词集合差。
 */
export function extractAgencyActions(text: string): string[] {
  if (!text) return [];
  const matches = text.match(AGENCY_ACTION_PATTERN) || [];
  return Array.from(new Set(matches));
}

/**
 * 提取文本中所有感知类语言命中（去重）。
 */
export function extractPerceptionMarkers(text: string): string[] {
  if (!text) return [];
  const matches = text.match(PERCEPTION_LANGUAGE_PATTERN) || [];
  return Array.from(new Set(matches));
}

// ============================================================================
// 检查 1：主角行动稀释
// ============================================================================

export interface AgencyDilutionCheck {
  diluted: boolean;
  beforeActions: string[];
  afterActions: string[];
  lostActions: string[];
  perceptionMarkers: string[];
}

/**
 * 主角行动稀释检查。
 *
 * 触发条件（任一即 diluted=true）：
 *   - after 比 before 丢失 ≥1 个不同行动词（行动词集合严格缩小）
 *   - after 感知类语言命中数 > before（感知词侵蚀行动）
 *
 * 来源：legacy PatchQualityComparator.checkAgencyDilution。
 */
export function checkAgencyDilution(before: string, after: string): AgencyDilutionCheck {
  const beforeActions = extractAgencyActions(before);
  const afterActions = extractAgencyActions(after);
  const lostActions = beforeActions.filter((a) => !afterActions.includes(a));
  const beforePerception = extractPerceptionMarkers(before);
  const afterPerception = extractPerceptionMarkers(after);

  const actionDiluted = lostActions.length > 0 && afterActions.length < beforeActions.length;
  const perceptionErosion = afterPerception.length > beforePerception.length;
  const diluted = actionDiluted || perceptionErosion;

  return {
    diluted,
    beforeActions,
    afterActions,
    lostActions,
    perceptionMarkers: afterPerception,
  };
}

// ============================================================================
// 检查 2：章末钩子退化
// ============================================================================

export interface ChapterEndHookRegression {
  regressed: boolean;
  beforeHasHook: boolean;
  afterHasHook: boolean;
  reason: string;
}

/**
 * 章末钩子退化检查（软保护）。
 *
 * 触发条件：before 末句有钩子信号 && after 末句无钩子信号。
 * 来源：legacy PatchQualityComparator.checkChapterEndHookRegression。
 *
 * 软保护语义：regressed=true 时降级候选分数，但不一定硬拒（由调用方决定）。
 */
export function checkChapterEndHookRegression(
  before: string,
  after: string
): ChapterEndHookRegression {
  const beforeLast = extractLastSentence(before);
  const afterLast = extractLastSentence(after);
  const beforeHasHook = hasWebnovelHookSignal(beforeLast);
  const afterHasHook = hasWebnovelHookSignal(afterLast);
  const regressed = beforeHasHook && !afterHasHook;

  return {
    regressed,
    beforeHasHook,
    afterHasHook,
    reason: regressed
      ? "章末钩子特征丢失：before 末句有钩子信号，after 末句无钩子信号"
      : "no chapter end hook regression",
  };
}

// ============================================================================
// 检查 3：段落节奏退化
// ============================================================================

export interface ParagraphRhythmRegression {
  regressed: boolean;
  beforeOver360Count: number;
  afterOver360Count: number;
  reason: string;
}

/**
 * 段落节奏退化检查。
 *
 * 触发条件：afterOver360Count > beforeOver360Count（严格上升）。
 * 来源：legacy PatchQualityComparator.checkParagraphRhythmRegression。
 *
 * 防止候选把已经分好的合格短段合并成长段。
 */
export function checkParagraphRhythmRegression(
  before: string,
  after: string
): ParagraphRhythmRegression {
  const beforeAnalysis = analyzeChapterParagraphRhythm(before);
  const afterAnalysis = analyzeChapterParagraphRhythm(after);
  const beforeOver360Count = beforeAnalysis.over360Count;
  const afterOver360Count = afterAnalysis.over360Count;
  const regressed = afterOver360Count > beforeOver360Count;

  return {
    regressed,
    beforeOver360Count,
    afterOver360Count,
    reason: regressed
      ? `over360Count 严格上升 ${beforeOver360Count} -> ${afterOver360Count}（候选合并了短段或新增超长段）`
      : "no paragraph rhythm regression",
  };
}

// ============================================================================
// 检查 4：风格匹配分退化
// ============================================================================

export interface StyleScoreRegression {
  regressed: boolean;
  beforeStyleScore: number;
  afterStyleScore: number;
  reason: string;
}

/**
 * 风格匹配分退化检查。
 *
 * 触发条件：afterScore < beforeScore - 0.01（下降 > 0.01 视为退化）。
 * 来源：legacy PatchQualityComparator.checkStyleScoreRegression。
 *
 * 调用方需提供 before/after 的 style match score（0-1 区间）。
 * 缺失 evidence 时 regressed=false（无法判定）。
 */
export function checkStyleScoreRegression(
  beforeScore: number | undefined,
  afterScore: number | undefined
): StyleScoreRegression {
  if (beforeScore === undefined || afterScore === undefined) {
    return {
      regressed: false,
      beforeStyleScore: beforeScore ?? 0,
      afterStyleScore: afterScore ?? 0,
      reason: "no style evidence provided",
    };
  }
  const regressed = afterScore < beforeScore - 0.01;
  return {
    regressed,
    beforeStyleScore: beforeScore,
    afterStyleScore: afterScore,
    reason: regressed
      ? `style score 下降 ${beforeScore.toFixed(3)} -> ${afterScore.toFixed(3)}（delta ${(afterScore - beforeScore).toFixed(3)}）`
      : "no style score regression",
  };
}

// ============================================================================
// 检查 5：中文母语语感退化
// ============================================================================

export interface ChineseNativeEvidence {
  beforeRiskLevel: "low" | "medium" | "high";
  afterRiskLevel: "low" | "medium" | "high";
  beforeCount: number;
  afterCount: number;
}

export interface ChineseNativeRewriteAllowance {
  allowed: boolean;
  riskWorsened: boolean;
  countIncreased: boolean;
  reason: string;
}

const RISK_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * 中文母语语感退化检查。
 *
 * 触发条件（任一即 allowed=false）：
 *   - afterRiskLevel > beforeRiskLevel（风险等级上升）
 *   - afterCount > beforeCount（翻译腔命中数增加）
 *
 * 来源：legacy PatchQualityComparator.evaluateChineseNativeRewriteAllowance。
 *
 * 调用方需提供 before/after 的 riskLevel 和命中数（来自母语语感 scanner）。
 */
export function evaluateChineseNativeRewriteAllowance(
  evidence: ChineseNativeEvidence
): ChineseNativeRewriteAllowance {
  const riskWorsened = RISK_RANK[evidence.afterRiskLevel] > RISK_RANK[evidence.beforeRiskLevel];
  const countIncreased = evidence.afterCount > evidence.beforeCount;
  const allowed = !riskWorsened && !countIncreased;

  return {
    allowed,
    riskWorsened,
    countIncreased,
    reason: allowed
      ? "chinese native rewrite allowed: 风险等级与命中数均未上升"
      : riskWorsened
        ? `chinese native rewrite rejected: 风险等级上升 ${evidence.beforeRiskLevel} -> ${evidence.afterRiskLevel}`
        : `chinese native rewrite rejected: 翻译腔命中数增加 ${evidence.beforeCount} -> ${evidence.afterCount}`,
  };
}

// ============================================================================
// 检查 6：明显退化判定
// ============================================================================

export interface ClearRegressionInput {
  beforeScore: number;
  afterScore: number;
  beforeAiPhrasing: number;
  afterAiPhrasing: number;
}

/**
 * 明显退化判定。
 *
 * 触发条件（任一即 regressed=true）：
 *   - afterScore < 70 且 afterScore < beforeScore（跌破 70 阈值且下降）
 *   - afterAiPhrasing >= beforeAiPhrasing + 2（AI 腔密度上升 ≥2）
 *
 * 来源：legacy PatchQualityComparator.hasClearRegression。
 *
 * 用于 CandidateComparator 在维度分数对比中识别"明显退化"候选，
 * 即使加权总分接近，也应在 winner 选择中降权。
 */
export function hasClearScoreRegression(input: ClearRegressionInput): boolean {
  const scoreDropBelow70 =
    input.afterScore < 70 && input.afterScore < input.beforeScore;
  const aiPhrasingIncrease = input.afterAiPhrasing >= input.beforeAiPhrasing + 2;
  return scoreDropBelow70 || aiPhrasingIncrease;
}

// ============================================================================
// 聚合：antiRegression 维度子评分
// ============================================================================

export interface AntiRegressionSubscoreInput {
  baseline?: string;
  candidate: string;
  baselineStyleScore?: number;
  candidateStyleScore?: number;
  baselineNativeEvidence?: ChineseNativeEvidence;
  /** 候选自身 SegmentCraftEvaluation score（0-100），用于 hasClearScoreRegression */
  baselineSegScore?: number;
  candidateSegScore?: number;
  baselineAiPhrasing?: number;
  candidateAiPhrasing?: number;
}

export interface AntiRegressionSubscore {
  /** 0-100，100 表示无任何退化，每命中一项退化扣分 */
  score: number;
  regressedChecks: string[];
  details: {
    agencyDilution?: AgencyDilutionCheck;
    chapterEndHook?: ChapterEndHookRegression;
    paragraphRhythm?: ParagraphRhythmRegression;
    styleScore?: StyleScoreRegression;
    chineseNative?: ChineseNativeRewriteAllowance;
    clearRegression?: boolean;
  };
}

/**
 * 计算 antiRegression 维度子评分。
 *
 * 无 baseline 时：返回满分 100（无法判定退化，不扣分）。
 * 有 baseline 时：每命中一项退化检查扣 20 分，hasClearScoreRegression 额外扣 30 分。
 * 最低 0 分。
 *
 * 该子评分作为 CandidateComparator.antiRegression 维度的输入。
 */
export function computeAntiRegressionSubscore(
  input: AntiRegressionSubscoreInput
): AntiRegressionSubscore {
  const regressedChecks: string[] = [];
  const details: AntiRegressionSubscore["details"] = {};
  let score = 100;

  if (!input.baseline) {
    return { score, regressedChecks, details };
  }

  // 1. 主角行动稀释
  const agencyDilution = checkAgencyDilution(input.baseline, input.candidate);
  details.agencyDilution = agencyDilution;
  if (agencyDilution.diluted) {
    regressedChecks.push("agency_dilution");
    score -= 20;
  }

  // 2. 章末钩子退化
  const chapterEndHook = checkChapterEndHookRegression(input.baseline, input.candidate);
  details.chapterEndHook = chapterEndHook;
  if (chapterEndHook.regressed) {
    regressedChecks.push("chapter_end_hook");
    score -= 20;
  }

  // 3. 段落节奏退化
  const paragraphRhythm = checkParagraphRhythmRegression(input.baseline, input.candidate);
  details.paragraphRhythm = paragraphRhythm;
  if (paragraphRhythm.regressed) {
    regressedChecks.push("paragraph_rhythm");
    score -= 20;
  }

  // 4. 风格匹配分退化
  const styleScore = checkStyleScoreRegression(
    input.baselineStyleScore,
    input.candidateStyleScore
  );
  details.styleScore = styleScore;
  if (styleScore.regressed) {
    regressedChecks.push("style_score");
    score -= 20;
  }

  // 5. 中文母语语感退化
  if (input.baselineNativeEvidence) {
    const chineseNative = evaluateChineseNativeRewriteAllowance(input.baselineNativeEvidence);
    details.chineseNative = chineseNative;
    if (!chineseNative.allowed) {
      regressedChecks.push("chinese_native");
      score -= 20;
    }
  }

  // 6. 明显退化（额外扣分）
  if (
    input.baselineSegScore !== undefined &&
    input.candidateSegScore !== undefined &&
    input.baselineAiPhrasing !== undefined &&
    input.candidateAiPhrasing !== undefined
  ) {
    const clearRegression = hasClearScoreRegression({
      beforeScore: input.baselineSegScore,
      afterScore: input.candidateSegScore,
      beforeAiPhrasing: input.baselineAiPhrasing,
      afterAiPhrasing: input.candidateAiPhrasing,
    });
    details.clearRegression = clearRegression;
    if (clearRegression) {
      regressedChecks.push("clear_regression");
      score -= 30;
    }
  }

  return {
    score: Math.max(0, score),
    regressedChecks,
    details,
  };
}
