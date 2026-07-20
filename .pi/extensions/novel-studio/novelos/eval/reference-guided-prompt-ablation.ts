/**
 * REFERENCE-GUIDED-PROMPT-ABLATION-1：reference 引导的 prompt 消融实验框架
 *
 * 任务卡 §6 REFERENCE-GUIDED-PROMPT-ABLATION-1：
 * 利用《神秘复苏》原章作为 evaluator-only 样板，定位模型续写与成熟商业小说之间
 * 的叙事实现差距。
 *
 * 双轨比较：
 *   轨道 A：续写实现能力
 *     - 前 1-3 章 → 模型生成下一章 → 与真实下一章进行 reference-aware 评价
 *     - 评价时允许情节不同，重点比较：异常如何进入日常 / 危险确认延迟 / 规则分批释放 /
 *       主角可理解的生存选择 / 场景产生新状态 / 对白承担人物+信息功能 / 章末因果压力
 *   轨道 B：注入词增益
 *     - 同一 prefix → A1/A3/A4 三臂 prompt → 匿名比较各生成稿
 *     - reference 只帮助 evaluator 判断成熟实现包含了什么，不直接给 generator 提供答案
 *
 * 禁止项：
 * - 不以"复现原章事件更多"自动判胜
 * - 不把原文高频词、句长、固定短语直接转成强制 prompt
 * - 不生成"模仿佛前献花风格"等作者身份指令
 * - 不让 reference asset 跨过 evaluator/generator 权限边界
 *
 * 验收：
 * - 每个工艺差距必须附 reference span、生成稿对应 span 和读者影响说明
 * - 只允许形成高层、可迁移、可证伪的 craft hypothesis
 * - hypothesis 必须在未参与提炼的验证集上产生明确正收益，才能进入策略候选
 *
 * 架构边界（evaluator 进程）：
 * - 本模块不直接 import reference-registry（CLI 调 registry.resolve() 后通过
 *   resolveReference 回调传入 referenceText 字符串）
 * - 本模块不直接 import generator-bundle / chapter-splitter / dataset-builder
 * - generator prompt 通过 enforceGeneratorIsolation 守护，不得含 reference 资产字段
 * - reference 正文只在 evaluator 路径（judgePair / extractCraftGaps）使用
 *
 * 授权边界（任务卡 §10）：
 * - 真实 Claude Opus 4.6 续写 / gpt-5.6-sol reference-aware judge 属于 REQUIRES_AUTH
 * - 本框架提供 stub 模式（globalThis.fetch 覆盖）用于离线结构与聚合逻辑验证
 * - productionGating.canChangeProductionPrompt = false，不直接改变生产
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { callJudgeModel, type JudgeModelConfig } from "./judge-model-adapter.js";
import {
  buildAblationPrompt,
  ABLATION_ARMS,
  type AblationCase,
} from "./prompt-context-ablation.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 双轨名称 */
export const TRACK_NAMES = ["A", "B"] as const;
export type TrackName = (typeof TRACK_NAMES)[number];

/**
 * CRAFT_GAP_DIMENSIONS：工艺差距维度（任务卡 §6 轨道 A 评价重点）。
 *
 * 7 个维度对应任务卡"评价时允许情节不同，重点比较"列出的 7 项。
 */
export const CRAFT_GAP_DIMENSIONS = [
  "异常进入日常",
  "危险确认延迟与证据",
  "规则信息分批释放",
  "主角可理解的生存选择",
  "场景产生新状态",
  "对白承担人物与信息功能",
  "章末因果压力",
] as const;
export type CraftGapDimension = (typeof CRAFT_GAP_DIMENSIONS)[number];

/**
 * HYPOTHESIS_RECOMMENDED_INJECTIONS：craft hypothesis 允许的推荐注入位置。
 *
 * 任务卡 §7 PORTABLE-CRAFT-HYPOTHESIS-1：
 * raw / scene solution / editorial diagnosis / judge rubric
 */
export const HYPOTHESIS_RECOMMENDED_INJECTIONS = [
  "raw_prompt",
  "scene_solution",
  "editorial_diagnosis",
  "judge_rubric",
] as const;
export type RecommendedInjection = (typeof HYPOTHESIS_RECOMMENDED_INJECTIONS)[number];

/** 验证集正收益门槛（任务卡 §6 验收） */
export const HYPOTHESIS_ADMISSION_THRESHOLDS = {
  minSampleSize: 5,
  minWinRate: 0.55,
} as const;

/** Track B 默认实验臂（任务卡 §6 轨道 B：A1/A3/A4 三臂） */
export const DEFAULT_TRACK_B_ARMS = ["A1", "A3", "A4"] as const;

/** Track B 默认 judgePairs：A1 vs A4, A3 vs A4 */
export const DEFAULT_TRACK_B_JUDGE_PAIRS: Array<[string, string]> = [
  ["A1", "A4"],
  ["A3", "A4"],
];

/** referenceEvidence.excerpt 最大长度（任务卡 §3：不复制原文长片段） */
export const MAX_REFERENCE_EXCERPT_LENGTH = 50;

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 前文章节（prefix） */
export interface PrefixChapter {
  chapterNumber: number;
  title?: string;
  text: string;
}

/** 单个 case（Track A 与 Track B 共用） */
export interface ReferenceGuidedCase extends AblationCase {
  /** 前文 1-3 章（Track A 与 Track B 共用同一 prefix） */
  prefixChapters: PrefixChapter[];
  /** referenceId（指向 ReferenceRegistry 中注册的真实下一章） */
  referenceId: string;
  /** reference 章节号（用于 prompt 中的章号） */
  referenceChapterNumber: number;
  /** reference 章节标题（仅 evaluator 用于审计，不进入 generator prompt） */
  referenceChapterTitle?: string;
}

export interface ReferenceGuidedCaseSet {
  bookId: string;
  caseSetId: string;
  /** reference 源文件路径（仅 evaluator 用于 ReferenceRegistry；不进入 generator prompt） */
  referenceSourcePath?: string;
  cases: ReferenceGuidedCase[];
  createdAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track A 类型
// ─────────────────────────────────────────────────────────────────────────────

/** Track A 单次续写样本 */
export interface TrackASample {
  caseId: string;
  sampleIndex: number;
  seed: number;
  temperature: number;
  generatedText: string;
  finishReason: string;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

/** Track A 单个 pair 比较结果（generated vs reference-aware） */
export interface TrackAPairResult {
  /** 比较维度（属于 CRAFT_GAP_DIMENSIONS） */
  dimension: CraftGapDimension;
  /** 胜出方："generated" / "reference" / "tie" */
  winner: "generated" | "reference" | "tie";
  /** 理由 */
  reason: string;
  /** 生成稿 span */
  generatedSpan?: { excerpt: string };
  /** reference span */
  referenceSpan?: { excerpt: string };
}

/** Track A 单个 case 的结果 */
export interface TrackACaseResult {
  caseId: string;
  referenceId: string;
  referenceText: string;
  /** 第一份 sample 的生成正文（便于上层直接访问；等同 samples[0]?.generatedText） */
  generatedText: string;
  samples: TrackASample[];
  /** 取第一份 sample 与 reference 比较 */
  pairResults: TrackAPairResult[];
  /** 从 reference + generated 中提取的工艺差距 */
  craftGaps: CraftGap[];
  totalModelCalls: number;
  totalDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track B 类型
// ─────────────────────────────────────────────────────────────────────────────

/** Track B 单次 raw 样本 */
export interface TrackBSample {
  caseId: string;
  armId: string;
  sampleIndex: number;
  seed: number;
  temperature: number;
  text: string;
  finishReason: string;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

/** Track B 单个 pair 比较结果（匿名 A/B） */
export interface TrackBPairResult {
  armLeft: string;
  armRight: string;
  winner: "left" | "right" | "tie";
  reason: string;
  /** 匿名映射的胜出 armId（不暴露给 judge） */
  winnerArm: string | null;
  totalComparisons: number;
}

/** Track B 单个 case 的结果 */
export interface TrackBCaseResult {
  caseId: string;
  samples: TrackBSample[];
  pairResults: TrackBPairResult[];
  totalModelCalls: number;
  totalDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Craft Gap / Hypothesis 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 工艺差距（任务卡 §6 验收：必须附 reference span + 生成稿 span + 读者影响） */
export interface CraftGap {
  caseId: string;
  dimension: CraftGapDimension;
  referenceSpan: { excerpt: string; offset?: number };
  generatedSpan: { excerpt: string; offset?: number };
  readerImpact: string;
  /** 差距类型：reference 实现了 / 生成稿缺失 / 生成稿弱化 */
  gapType: "reference_has_generated_misses" | "reference_has_generated_weakens" | "tie";
}

/** Craft hypothesis（任务卡 §7 PORTABLE-CRAFT-HYPOTHESIS-1） */
export interface CraftHypothesis {
  hypothesisId: string;
  title: string;
  applicableScene: string;
  referenceEvidence: Array<{
    referenceId: string;
    excerpt: string;
    readerImpact: string;
  }>;
  expectedReaderGain: string;
  possibleDamage: string;
  forbiddenMigration: string[];
  recommendedInjection: RecommendedInjection;
  validationState: "pending" | "admitted" | "rejected" | "insufficient_evidence";
  /** 验证集正收益样本数 */
  sampleSize?: number;
  /** 验证集胜率（0-1） */
  winRate?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果聚合类型
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductionGating {
  canChangeProductionPrompt: boolean;
  canChangeDefaultInjection: boolean;
  note: string;
}

export interface ReferenceGuidedResult {
  ablationRunId: string;
  caseSetHash: string;
  totalCases: number;
  tracksRun: TrackName[];
  trackAResults: TrackACaseResult[];
  trackBResults: TrackBCaseResult[];
  craftGaps: CraftGap[];
  craftHypotheses: CraftHypothesis[];
  productionGating: ProductionGating;
  totalModelCalls: number;
  totalDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTrackAPrompt（轨道 A：续写实现能力）
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackAPromptResult {
  systemPrompt: string;
  userPrompt: string;
  promptTokenEstimate: number;
}

/**
 * 构造 Track A 续写 prompt。
 *
 * 设计原则：
 * - 只含 prefixChapters 的前文 + 写下一章指令
 * - 不得包含 reference 下一章正文 / sourcePath / offset / bodyHash
 * - 不得包含作者身份指令（"模仿佛前"/"模仿神秘复苏作者"等）
 * - 不得包含原作专有设定（佛前献花等）
 */
export function buildTrackAPrompt(caseData: ReferenceGuidedCase): TrackAPromptResult {
  const parts: string[] = [];

  // 前文章节
  for (const ch of caseData.prefixChapters) {
    const titleStr = ch.title ? `${ch.title}\n` : "";
    parts.push(`【前文·第${ch.chapterNumber}章】\n${titleStr}${ch.text}`);
  }

  // 写下一章指令
  parts.push(
    `你是顶尖网文作家。请基于上述前文，写第${caseData.referenceChapterNumber}章完整正文。` +
    `标题中的章节号必须是第${caseData.referenceChapterNumber}章，不得写成其他章节。`,
  );
  parts.push(
    "要求：写出自然流畅的中文网文章节正文，有完整的情节推进、角色行动和章末钩子。" +
    "不要写大纲或注释，直接输出正文。",
  );

  const userPrompt = parts.join("\n\n");
  const systemPrompt = "你是顶尖网文作家，擅长写出自然流畅、有张力的中文网文章节。";
  const promptTokenEstimate = Math.ceil((systemPrompt.length + userPrompt.length) / 4);

  return { systemPrompt, userPrompt, promptTokenEstimate };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTrackBPrompt（轨道 B：注入词增益，复用 A1/A3/A4）
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackBPromptResult {
  systemPrompt: string;
  userPrompt: string;
  consumedBlocks: string[];
  promptTokenEstimate: number;
}

/**
 * 构造 Track B 实验臂 prompt。
 *
 * 复用 prompt-context-ablation.ts 的 buildAblationPrompt，把 ReferenceGuidedCase
 * 适配为 AblationCase（previousText 由 prefixChapters 拼接）。
 */
export function buildTrackBPrompt(
  armId: string,
  caseData: ReferenceGuidedCase,
): TrackBPromptResult {
  // 校验 armId 合法
  const arm = ABLATION_ARMS.find((a) => a.id === armId);
  if (!arm) {
    throw new Error(`invalid armId: ${armId}（合法值：A0/A1/A2/A3/A4）`);
  }

  // 把 prefixChapters 拼成 previousText
  const previousText = caseData.prefixChapters
    .map((ch) => {
      const titleStr = ch.title ? `${ch.title}\n` : "";
      return `${titleStr}${ch.text}`;
    })
    .join("\n\n");

  // 构造 AblationCase（剥离 reference 资产字段）
  const ablationCase: AblationCase = {
    caseId: caseData.caseId,
    workspaceId: caseData.workspaceId,
    chapterNumber: caseData.referenceChapterNumber,
    chapterId: caseData.chapterId ?? `ch${caseData.referenceChapterNumber}-${caseData.caseId}`,
    previousText,
    intent: caseData.intent,
    bridgeContext: caseData.bridgeContext,
    immutableFacts: caseData.immutableFacts,
    characterStates: caseData.characterStates,
    worldRules: caseData.worldRules,
    constitution: caseData.constitution,
    acceptedRevisionExamples: caseData.acceptedRevisionExamples,
    modelRoute: caseData.modelRoute,
    timeoutMs: caseData.timeoutMs,
    maxTokens: caseData.maxTokens,
  };

  const result = buildAblationPrompt(armId, ablationCase);
  return {
    systemPrompt: result.systemPrompt,
    userPrompt: result.userPrompt,
    consumedBlocks: result.consumedBlocks,
    promptTokenEstimate: result.promptTokenEstimate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// loadReferenceGuidedCaseSet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 加载 reference-guided case set JSON 并校验。
 *
 * 必填字段：
 * - bookId / caseSetId / cases[]
 * - 每个 case 至少含 caseId / workspaceId / prefixChapters(1-3 章) / referenceId /
 *   referenceChapterNumber / intent
 */
export async function loadReferenceGuidedCaseSet(
  filePath: string,
): Promise<ReferenceGuidedCaseSet> {
  const content = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content) as Partial<ReferenceGuidedCaseSet>;

  if (!parsed.bookId) {
    throw new Error(`reference-guided case set 格式错误：缺少 bookId（${filePath}）`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error(`reference-guided case set 格式错误：缺少 cases 数组（${filePath}）`);
  }
  if (!parsed.caseSetId) {
    throw new Error(`reference-guided case set 格式错误：缺少 caseSetId（${filePath}）`);
  }

  for (let i = 0; i < parsed.cases.length; i++) {
    const c = parsed.cases[i];
    if (!c.caseId) {
      throw new Error(`case set 格式错误：cases[${i}] 缺少 caseId`);
    }
    if (!c.workspaceId) {
      throw new Error(`case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 workspaceId`);
    }
    if (!Array.isArray(c.prefixChapters) || c.prefixChapters.length === 0) {
      throw new Error(
        `case set 格式错误：cases[${i}] (caseId=${c.caseId}) prefixChapters 至少 1 章`,
      );
    }
    if (c.prefixChapters.length > 3) {
      throw new Error(
        `case set 格式错误：cases[${i}] (caseId=${c.caseId}) prefixChapters 至多 3 章`,
      );
    }
    if (!c.referenceId) {
      throw new Error(`case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 referenceId`);
    }
    if (typeof c.referenceChapterNumber !== "number") {
      throw new Error(
        `case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 referenceChapterNumber`,
      );
    }
    if (!c.intent) {
      throw new Error(`case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 intent`);
    }
  }

  return parsed as ReferenceGuidedCaseSet;
}

// ─────────────────────────────────────────────────────────────────────────────
// enforceGeneratorIsolation（generator/evaluator 边界守护）
// ─────────────────────────────────────────────────────────────────────────────

/** 禁止出现在 generator prompt 的字段名 */
const FORBIDDEN_PROMPT_FIELDS = [
  "sourcePath",
  "referenceId",
  "referenceNextChapter",
  "bodyHash",
  "startOffset",
  "endOffset",
];

/** 禁止出现在 generator prompt 的作者身份指令关键词 */
const FORBIDDEN_AUTHOR_IDENTITY_PATTERNS = [
  /模仿佛前/,
  /佛前献花/,
  /神秘复苏作者/,
  /作者风格/,
  /模仿[^。，\s]{1,10}风格/,
  /原作者笔触/,
];

export interface IsolationCheckResult {
  passed: boolean;
  violations: string[];
}

/**
 * 检查 generator prompt 是否泄露 reference 资产字段或作者身份指令。
 *
 * 任务卡 §6 禁止项：
 * - 不让 reference asset 跨过 evaluator/generator 权限边界
 * - 不生成"模仿佛前献花风格"等作者身份指令
 */
export function enforceGeneratorIsolation(prompt: {
  systemPrompt: string;
  userPrompt: string;
}): IsolationCheckResult {
  const fullText = `${prompt.systemPrompt}\n${prompt.userPrompt}`;
  const violations: string[] = [];

  // 检查禁止字段名
  for (const field of FORBIDDEN_PROMPT_FIELDS) {
    if (fullText.includes(field)) {
      violations.push(`generator prompt 含禁止字段：${field}`);
    }
  }

  // 检查作者身份指令
  for (const pattern of FORBIDDEN_AUTHOR_IDENTITY_PATTERNS) {
    if (pattern.test(fullText)) {
      violations.push(`generator prompt 含作者身份指令：${pattern.source}`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractCraftGaps（工艺差距提取）
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractCraftGapsOptions {
  caseId: string;
  /** 提取的最多 gap 数（默认 5） */
  maxGaps?: number;
}

/**
 * 从 reference + generated 中提取工艺差距。
 *
 * 策略（启发式，stub-friendly）：
 * - 对每个 CRAFT_GAP_DIMENSIONS，在 reference 中寻找关键短语（dimension 关键词）
 * - 若 reference 中存在但 generated 中缺失或弱化，则记录为 craft gap
 * - 每个 gap 必须含 referenceSpan + generatedSpan + readerImpact + dimension
 * - 空输入返回空数组（不编造 gap）
 *
 * 真实生产实现应使用 LLM 抽取，这里提供启发式版本用于 stub 模式。
 */
export function extractCraftGaps(
  referenceText: string,
  generatedText: string,
  options: ExtractCraftGapsOptions,
): CraftGap[] {
  if (!referenceText || !generatedText) return [];

  const maxGaps = options.maxGaps ?? 5;
  const gaps: CraftGap[] = [];

  // 每个 dimension 的关键短语特征
  const dimensionKeywords: Record<CraftGapDimension, string[]> = {
    "异常进入日常": ["门", "声响", "光", "笔记", "脚步", "气息"],
    "危险确认延迟与证据": ["犹豫", "屏住呼吸", "屏息", "握紧", "三秒", "秒"],
    "规则信息分批释放": ["笔记", "一行字", "规则", "看见", "闭眼"],
    "主角可理解的生存选择": ["推开", "闭眼", "转身", "深入", "退后"],
    "场景产生新状态": ["叹息", "冰冷", "已知", "认知", "改变"],
    "对白承担人物与信息功能": ["对白", "说", "问", "答"],
    "章末因果压力": ["更深的谜团", "未解", "钩子", "悬念", "声音"],
  };

  const refNormalized = referenceText.replace(/\s+/g, "");
  const genNormalized = generatedText.replace(/\s+/g, "");

  for (const dimension of CRAFT_GAP_DIMENSIONS) {
    if (gaps.length >= maxGaps) break;

    const keywords = dimensionKeywords[dimension];
    // 在 reference 中找到第一个关键词
    let refExcerpt = "";
    for (const kw of keywords) {
      const idx = refNormalized.indexOf(kw);
      if (idx >= 0) {
        const start = Math.max(0, idx - 5);
        const end = Math.min(refNormalized.length, idx + 20);
        refExcerpt = referenceText.slice(
          Math.max(0, referenceText.indexOf(kw)),
          Math.min(referenceText.length, referenceText.indexOf(kw) + 25),
        );
        break;
      }
    }

    if (!refExcerpt) continue;

    // 检查 generated 是否有相似关键词
    let genExcerpt = "";
    let gapType: CraftGap["gapType"] = "reference_has_generated_misses";
    for (const kw of keywords) {
      const idx = genNormalized.indexOf(kw);
      if (idx >= 0) {
        const srcIdx = generatedText.indexOf(kw);
        genExcerpt = generatedText.slice(
          Math.max(0, srcIdx),
          Math.min(generatedText.length, srcIdx + 25),
        );
        gapType = "tie"; // generated 也有，不算 gap
        break;
      }
    }

    // 若 generated 缺失该关键词，则记录为 gap
    if (gapType === "reference_has_generated_misses") {
      gaps.push({
        caseId: options.caseId,
        dimension,
        referenceSpan: {
          excerpt: refExcerpt.slice(0, MAX_REFERENCE_EXCERPT_LENGTH),
        },
        generatedSpan: {
          excerpt: genExcerpt || generatedText.slice(0, 20),
        },
        readerImpact: `reference 在"${dimension}"维度有更成熟的实现；生成稿缺失对应细节，读者可能感到场景单薄。`,
        gapType,
      });
    }
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateCraftHypothesis
// ─────────────────────────────────────────────────────────────────────────────

export interface HypothesisValidationResult {
  schemaValid: boolean;
  schemaErrors: string[];
  validationState: CraftHypothesis["validationState"];
  sampleSize: number;
  winRate: number;
}

/**
 * 校验 craft hypothesis 的 schema 与验证集正收益。
 *
 * Schema 校验：
 * - applicableScene / expectedReaderGain 必填非空
 * - referenceEvidence 数组至少 1 条
 * - recommendedInjection 必须属于 HYPOTHESIS_RECOMMENDED_INJECTIONS
 *
 * 验证集正收益门槛（任务卡 §6 验收）：
 * - sampleSize ≥ 5
 * - winRate ≥ 0.55
 * - 否则 validationState = "insufficient_evidence"（样本不足）或 "rejected"（负收益）
 */
export function validateCraftHypothesis(
  hypothesis: CraftHypothesis,
  validationSamples: Array<{
    withHypothesisWin: boolean;
    withoutHypothesisWin?: boolean;
  }>,
): HypothesisValidationResult {
  const schemaErrors: string[] = [];

  // Schema 校验
  if (!hypothesis.applicableScene || hypothesis.applicableScene.trim().length === 0) {
    schemaErrors.push("applicableScene 必填非空");
  }
  if (
    !hypothesis.expectedReaderGain ||
    hypothesis.expectedReaderGain.trim().length === 0
  ) {
    schemaErrors.push("expectedReaderGain 必填非空");
  }
  if (
    !Array.isArray(hypothesis.referenceEvidence) ||
    hypothesis.referenceEvidence.length === 0
  ) {
    schemaErrors.push("referenceEvidence 至少 1 条");
  }
  if (
    !HYPOTHESIS_RECOMMENDED_INJECTIONS.includes(hypothesis.recommendedInjection)
  ) {
    schemaErrors.push(
      `recommendedInjection 必须属于 ${HYPOTHESIS_RECOMMENDED_INJECTIONS.join("/")}`,
    );
  }

  const schemaValid = schemaErrors.length === 0;

  // 验证集正收益计算
  const sampleSize = validationSamples.length;
  const wins = validationSamples.filter((s) => s.withHypothesisWin).length;
  const winRate = sampleSize > 0 ? wins / sampleSize : 0;

  let validationState: CraftHypothesis["validationState"];
  if (!schemaValid) {
    validationState = "rejected";
  } else if (sampleSize < HYPOTHESIS_ADMISSION_THRESHOLDS.minSampleSize) {
    validationState = "insufficient_evidence";
  } else if (winRate >= HYPOTHESIS_ADMISSION_THRESHOLDS.minWinRate) {
    validationState = "admitted";
  } else {
    validationState = "rejected";
  }

  return {
    schemaValid,
    schemaErrors,
    validationState,
    sampleSize,
    winRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心执行函数：runReferenceGuidedAblation
// ─────────────────────────────────────────────────────────────────────────────

export interface RunReferenceGuidedOptions {
  caseSet: ReferenceGuidedCaseSet;
  tracks: TrackName[];
  /** evaluator-only：通过 referenceId 解封 reference 正文 */
  resolveReference: (referenceId: string) => string | null;
  samplesPerCase: number;
  /** Track A 反向复判轮数（默认 1，stub 模式） */
  rounds?: number;
  /** Track B 实验臂（默认 A1/A3/A4） */
  trackBArms?: string[];
  /** Track B judgePairs（默认 [[A1,A4],[A3,A4]]） */
  judgePairs?: Array<[string, string]>;
  /** 生成 raw 正文的模型调用函数（stub 与 real 各自注入） */
  generateRaw?: (
    prompt: { systemPrompt: string; userPrompt: string },
    seed: number,
    options: { maxTokens?: number; timeoutMs?: number; modelRoute?: string },
  ) => Promise<{
    text: string;
    model: string;
    finishReason?: string;
    promptTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  }>;
  /** Track A reference-aware judge 调用函数 */
  judgeReferenceAware?: (
    generatedText: string,
    referenceText: string,
    context: { caseId: string; chapterIntent: string },
    seed: number,
  ) => Promise<{
    pairResults: TrackAPairResult[];
  }>;
  /** Track B 匿名 pairwise judge 调用函数 */
  judgePair?: (
    leftText: string,
    rightText: string,
    context: { workGoal: string; chapterIntent: string },
    seed: number,
  ) => Promise<{
    winner: "left" | "right" | "tie";
    reason: string;
    hardFactRisk: boolean;
  }>;
  controlVariables?: ControlVariables;
}

export interface ControlVariables {
  modelRoute: string;
  provider: string;
  modelVersion: string;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * 核心 reference-guided ablation 执行函数。
 * stub 与 real 模式共用此实现，差异在 generateRaw / judgeReferenceAware / judgePair 注入。
 */
export async function runReferenceGuidedAblation(
  options: RunReferenceGuidedOptions,
): Promise<ReferenceGuidedResult> {
  const {
    caseSet,
    tracks,
    resolveReference,
    samplesPerCase,
    rounds = 1,
    trackBArms = [...DEFAULT_TRACK_B_ARMS],
    judgePairs = [...DEFAULT_TRACK_B_JUDGE_PAIRS],
    generateRaw,
    judgeReferenceAware,
    judgePair,
    controlVariables,
  } = options;

  if (!generateRaw) {
    throw new Error("runReferenceGuidedAblation 需要 generateRaw 注入");
  }
  if (tracks.includes("A") && !judgeReferenceAware) {
    throw new Error("Track A 需要 judgeReferenceAware 注入");
  }
  if (tracks.includes("B") && !judgePair) {
    throw new Error("Track B 需要 judgePair 注入");
  }

  const ablationRunId = `ref-ablation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const caseSetHash = computeCaseSetHash(caseSet);

  const trackAResults: TrackACaseResult[] = [];
  const trackBResults: TrackBCaseResult[] = [];
  const allCraftGaps: CraftGap[] = [];
  let totalModelCalls = 0;
  const startMs = Date.now();

  // ── Track A：续写实现能力 ──────────────────────────────────────────
  if (tracks.includes("A")) {
    for (const caseData of caseSet.cases) {
      const referenceText = resolveReference(caseData.referenceId);
      if (!referenceText) {
        // reference 解封失败：跳过该 case，但仍记录空结果
        trackAResults.push({
          caseId: caseData.caseId,
          referenceId: caseData.referenceId,
          referenceText: "",
          generatedText: "",
          samples: [],
          pairResults: [],
          craftGaps: [],
          totalModelCalls: 0,
          totalDurationMs: 0,
        });
        continue;
      }

      const samples: TrackASample[] = [];
      let caseModelCalls = 0;
      const caseStartMs = Date.now();

      // 每个 case 生成 samplesPerCase 个续写样本
      for (let s = 0; s < samplesPerCase; s++) {
        const prompt = buildTrackAPrompt(caseData);
        const seed = hashSeed(`${caseData.caseId}|A|${s}`);
        const temperature = 0.7 + (seed % 100) / 1000;
        const sampleStartMs = Date.now();
        const result = await generateRaw(
          { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt },
          seed,
          {
            maxTokens: caseData.maxTokens ?? 4096,
            timeoutMs: caseData.timeoutMs ?? 60_000,
            modelRoute: caseData.modelRoute ?? "v2_rawstage2",
          },
        );
        caseModelCalls++;
        samples.push({
          caseId: caseData.caseId,
          sampleIndex: s,
          seed,
          temperature,
          generatedText: result.text ?? "",
          finishReason: result.finishReason ?? "stop",
          promptTokens: result.promptTokens ?? prompt.promptTokenEstimate,
          outputTokens: result.outputTokens ?? Math.ceil((result.text ?? "").length / 4),
          latencyMs: Date.now() - sampleStartMs,
          model: result.model ?? "unknown",
        });
      }

      // 取第一份 sample 与 reference 比较
      const firstSample = samples[0];
      let pairResults: TrackAPairResult[] = [];
      let craftGaps: CraftGap[] = [];
      if (firstSample && referenceText) {
        const seed = hashSeed(`${caseData.caseId}|A|judge`);
        const judgeResult = await judgeReferenceAware!(
          firstSample.generatedText,
          referenceText,
          {
            caseId: caseData.caseId,
            chapterIntent: caseData.intent?.primary ?? "",
          },
          seed,
        );
        caseModelCalls++;
        pairResults = judgeResult.pairResults;

        // 提取工艺差距
        craftGaps = extractCraftGaps(referenceText, firstSample.generatedText, {
          caseId: caseData.caseId,
        });
        allCraftGaps.push(...craftGaps);
      }

      trackAResults.push({
        caseId: caseData.caseId,
        referenceId: caseData.referenceId,
        referenceText,
        generatedText: firstSample?.generatedText ?? "",
        samples,
        pairResults,
        craftGaps,
        totalModelCalls: caseModelCalls,
        totalDurationMs: Date.now() - caseStartMs,
      });
      totalModelCalls += caseModelCalls;
    }
  }

  // ── Track B：注入词增益 ────────────────────────────────────────────
  if (tracks.includes("B")) {
    for (const caseData of caseSet.cases) {
      const samples: TrackBSample[] = [];
      let caseModelCalls = 0;
      const caseStartMs = Date.now();

      // 每个 arm × samplesPerCase 生成 raw
      for (const armId of trackBArms) {
        const prompt = buildTrackBPrompt(armId, caseData);
        for (let s = 0; s < samplesPerCase; s++) {
          const seed = hashSeed(`${caseData.caseId}|B|${armId}|${s}`);
          const temperature = 0.7 + (seed % 100) / 1000;
          const sampleStartMs = Date.now();
          const result = await generateRaw(
            { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt },
            seed,
            {
              maxTokens: caseData.maxTokens ?? 4096,
              timeoutMs: caseData.timeoutMs ?? 60_000,
              modelRoute: caseData.modelRoute ?? "v2_rawstage2",
            },
          );
          caseModelCalls++;
          samples.push({
            caseId: caseData.caseId,
            armId,
            sampleIndex: s,
            seed,
            temperature,
            text: result.text ?? "",
            finishReason: result.finishReason ?? "stop",
            promptTokens: result.promptTokens ?? prompt.promptTokenEstimate,
            outputTokens: result.outputTokens ?? Math.ceil((result.text ?? "").length / 4),
            latencyMs: Date.now() - sampleStartMs,
            model: result.model ?? "unknown",
          });
        }
      }

      // 执行 judgePairs
      const pairResults: TrackBPairResult[] = [];
      for (const [leftArm, rightArm] of judgePairs) {
        const leftSample = samples.find(
          (s) => s.armId === leftArm && s.sampleIndex === 0,
        );
        const rightSample = samples.find(
          (s) => s.armId === rightArm && s.sampleIndex === 0,
        );
        if (!leftSample || !rightSample) continue;

        const seed = hashSeed(`${caseData.caseId}|B|${leftArm}|${rightArm}`);
        const leftIsA = seed % 2 === 0;
        const candidateA = leftIsA ? leftSample.text : rightSample.text;
        const candidateB = leftIsA ? rightSample.text : leftSample.text;

        // 清理 candidate 中的 arm 标识（匿名化）
        const armMarkerPattern = /\[A[0-4]\]/g;
        const qualityMarkerPattern = /\[(low|medium|high)\]/g;
        const sanitizedA = candidateA.replace(armMarkerPattern, "").replace(qualityMarkerPattern, "");
        const sanitizedB = candidateB.replace(armMarkerPattern, "").replace(qualityMarkerPattern, "");

        const result = await judgePair!(
          sanitizedA,
          sanitizedB,
          {
            workGoal: caseData.constitution?.workIdentity ?? caseData.workspaceId,
            chapterIntent: caseData.intent?.primary ?? "",
          },
          seed,
        );
        caseModelCalls++;

        // 把 A/B winner 映射回 left/right
        let physicalWinner: "left" | "right" | "tie";
        let winnerArm: string | null;
        if (result.winner === "tie") {
          physicalWinner = "tie";
          winnerArm = null;
        } else if (result.winner === "left") {
          physicalWinner = leftIsA ? "left" : "right";
          winnerArm = leftIsA ? leftArm : rightArm;
        } else {
          physicalWinner = leftIsA ? "right" : "left";
          winnerArm = leftIsA ? rightArm : leftArm;
        }

        pairResults.push({
          armLeft: leftArm,
          armRight: rightArm,
          winner: physicalWinner,
          reason: result.reason,
          winnerArm,
          totalComparisons: 1,
        });
      }

      trackBResults.push({
        caseId: caseData.caseId,
        samples,
        pairResults,
        totalModelCalls: caseModelCalls,
        totalDurationMs: Date.now() - caseStartMs,
      });
      totalModelCalls += caseModelCalls;
    }
  }

  // ── 构造 craftHypotheses（stub 模式下为空，由真实实验填入）──────
  const craftHypotheses: CraftHypothesis[] = [];

  // ── productionGating：不直接改变生产 ──────────────────────────────
  const productionGating: ProductionGating = {
    canChangeProductionPrompt: false,
    canChangeDefaultInjection: false,
    note:
      "REFERENCE-GUIDED-PROMPT-ABLATION-1 是评估框架，不直接改变生产 prompt。" +
      "craftHypotheses 仅供人工评审，需在 INJECTION-STRATEGY-ADMISSION-1 通过后才进入生产。",
  };

  return {
    ablationRunId,
    caseSetHash,
    totalCases: caseSet.cases.length,
    tracksRun: tracks,
    trackAResults,
    trackBResults,
    craftGaps: allCraftGaps,
    craftHypotheses,
    productionGating,
    totalModelCalls,
    totalDurationMs: Date.now() - startMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runReferenceGuidedAblationStub（stub 模式）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stub 模式：覆盖 globalThis.fetch，返回确定性 stub 响应。
 *
 * 用于：
 * - 离线验证 reference-guided ablation 框架结构与聚合逻辑
 * - CI 测试不依赖真实 API
 *
 * stub 生成器优先调用 globalThis.fetch（测试或 CLI 可覆盖）。
 * 若 fetch 未被覆盖或调用失败，退回 inline 生成，保证 stub 模式离线可用。
 */
export async function runReferenceGuidedAblationStub(
  options: {
    caseSet: ReferenceGuidedCaseSet;
    tracks: TrackName[];
    resolveReference: (referenceId: string) => string | null;
    samplesPerCase: number;
    rounds?: number;
    trackBArms?: string[];
    judgePairs?: Array<[string, string]>;
    controlVariables?: ControlVariables;
  },
): Promise<ReferenceGuidedResult> {
  const generateRaw: NonNullable<RunReferenceGuidedOptions["generateRaw"]> = async (
    prompt,
    seed,
    opts,
  ) => {
    const fullPrompt = prompt.systemPrompt + "\n" + prompt.userPrompt;

    // 优先调用 globalThis.fetch（测试或 CLI 可覆盖以注入 stub 响应）。
    try {
      const requestBody = {
        model: "stub-model",
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userPrompt },
        ],
        temperature: 0.7 + (seed % 100) / 1000,
        max_tokens: opts.maxTokens ?? 4096,
        seed,
      };
      const response = await globalThis.fetch("stub://ref-ablation/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (response && response.ok) {
        const data = (await response.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = data.choices?.[0]?.message?.content ?? "";
        if (text) {
          return {
            text,
            model: data.model ?? "stub-model",
            finishReason: data.choices?.[0]?.finish_reason ?? "stop",
            promptTokens: data.usage?.prompt_tokens ?? Math.ceil(fullPrompt.length / 4),
            outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
            latencyMs: 5,
          };
        }
      }
    } catch {
      // fetch 未覆盖或失败，退回 inline 生成
    }

    // inline 默认生成（不依赖 fetch 覆盖）
    const text = `第3章 标题\n\n[A4][high] stub-model 默认生成正文片段，包含一些情节与对白。`;
    return {
      text,
      model: "stub-model",
      finishReason: "stop",
      promptTokens: Math.ceil(fullPrompt.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      latencyMs: 5,
    };
  };

  const judgeReferenceAware: NonNullable<
    RunReferenceGuidedOptions["judgeReferenceAware"]
  > = async (generatedText, referenceText, context, _seed) => {
    // 优先调用 globalThis.fetch（让测试能覆盖 judge 行为）
    try {
      const systemPrompt = "你是资深文学评委，请比较生成稿与参考正文的叙事实现。";
      const userPrompt = `【参考正文】\n${referenceText.slice(0, 2000)}\n\n【生成稿】\n${generatedText.slice(0, 2000)}\n\n请输出 JSON。`;
      const response = await globalThis.fetch("stub://ref-ablation/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "stub-judge",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (response && response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content ?? "";
        if (content) {
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed.pairResults)) {
              return { pairResults: parsed.pairResults };
            }
            // 若是 reference-aware-judge 的 verdict 格式，转换成 pairResults
            if (parsed.winner) {
              const winner = parsed.winner === "A" ? "generated" : "reference";
              return {
                pairResults: [
                  {
                    dimension: "异常进入日常",
                    winner,
                    reason: parsed.reason ?? "stub reason",
                  },
                ],
              };
            }
          } catch {
            // JSON 解析失败，fallthrough
          }
        }
      }
    } catch {
      // fallthrough
    }

    // inline 默认：返回每个 dimension 都为 tie
    const pairResults: TrackAPairResult[] = CRAFT_GAP_DIMENSIONS.map((dim) => ({
      dimension: dim,
      winner: "tie" as const,
      reason: "stub 默认 tie（reference-aware judge 未覆盖）",
    }));
    return { pairResults };
  };

  const judgePair: NonNullable<RunReferenceGuidedOptions["judgePair"]> = async (
    leftText,
    rightText,
    _context,
    _seed,
  ) => {
    // 优先调用 globalThis.fetch（让测试能覆盖 judge 行为）
    try {
      const systemPrompt = "你是顶尖网文文学裁判。请匿名比较两个候选章节正文。";
      const userPrompt = `候选甲：${leftText.slice(0, 500)}\n\n候选乙：${rightText.slice(0, 500)}\n\n请输出 JSON。`;
      const response = await globalThis.fetch("stub://ref-ablation/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "stub-judge",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (response && response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content ?? "";
        if (content) {
          try {
            const parsed = JSON.parse(content);
            if (parsed.winner === "A" || parsed.winner === "B" || parsed.winner === "tie") {
              const winner = parsed.winner === "A" ? "left" : parsed.winner === "B" ? "right" : "tie";
              return {
                winner,
                reason: parsed.reason ?? "stub",
                hardFactRisk: parsed.hardFactRisk ?? false,
              };
            }
          } catch {
            // fallthrough
          }
        }
      }
    } catch {
      // fallthrough
    }

    // inline 默认：根据文本长度决定胜方
    let winner: "left" | "right" | "tie";
    if (leftText.length > rightText.length * 1.1) winner = "left";
    else if (rightText.length > leftText.length * 1.1) winner = "right";
    else winner = "tie";
    return { winner, reason: "stub 长度比较", hardFactRisk: false };
  };

  return runReferenceGuidedAblation({
    caseSet: options.caseSet,
    tracks: options.tracks,
    resolveReference: options.resolveReference,
    samplesPerCase: options.samplesPerCase,
    rounds: options.rounds,
    trackBArms: options.trackBArms,
    judgePairs: options.judgePairs,
    controlVariables: options.controlVariables,
    generateRaw,
    judgeReferenceAware,
    judgePair,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// runReferenceGuidedAblationReal（真实模式，REQUIRES_AUTH）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 真实模式：使用 JudgeModelConfig 调用真实模型 API。
 *
 * 授权边界（任务卡 §10）：
 * - Claude Opus 4.6 续写 / gpt-5.6-sol reference-aware judge 属于 REQUIRES_AUTH
 * - 调用前必须固定 modelRoute / maxTokens / timeoutMs / samplesPerCase
 * - 调用前必须确认 caseSet 已冻结（frozen-test-set 不解封）
 */
export async function runReferenceGuidedAblationReal(
  options: {
    caseSet: ReferenceGuidedCaseSet;
    tracks: TrackName[];
    resolveReference: (referenceId: string) => string | null;
    samplesPerCase: number;
    rounds?: number;
    trackBArms?: string[];
    judgePairs?: Array<[string, string]>;
    controlVariables: ControlVariables;
    judgeConfig: JudgeModelConfig;
    rawModelConfig: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs?: number;
    };
  },
): Promise<ReferenceGuidedResult> {
  const { rawModelConfig, judgeConfig } = options;

  const generateRaw: NonNullable<RunReferenceGuidedOptions["generateRaw"]> = async (
    prompt,
    seed,
    opts,
  ) => {
    const url = `${rawModelConfig.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const startMs = Date.now();
    const requestBody = {
      model: rawModelConfig.model,
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userPrompt },
      ],
      temperature: 0.7 + (seed % 100) / 1000,
      max_tokens: opts.maxTokens ?? 4096,
      seed,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawModelConfig.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(
        `raw model API error (HTTP ${response.status}): ${errText.substring(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: data.model ?? rawModelConfig.model,
      finishReason: data.choices?.[0]?.finish_reason ?? "stop",
      promptTokens: data.usage?.prompt_tokens ??
        Math.ceil((prompt.systemPrompt.length + prompt.userPrompt.length) / 4),
      outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      latencyMs: Date.now() - startMs,
    };
  };

  const judgeReferenceAware: NonNullable<
    RunReferenceGuidedOptions["judgeReferenceAware"]
  > = async (generatedText, referenceText, context, seed) => {
    const systemPrompt =
      "你是资深文学评委。请比较生成稿（candidate）与参考正文（reference）。" +
      "评价时允许情节不同，重点比较 7 个维度：异常进入日常 / 危险确认延迟与证据 / " +
      "规则信息分批释放 / 主角可理解的生存选择 / 场景产生新状态 / " +
      "对白承担人物与信息功能 / 章末因果压力。";
    const userPrompt =
      `caseId：${context.caseId}\n` +
      `本章意图：${context.chapterIntent}\n\n` +
      `【参考正文】（已出版实际章节）\n${referenceText.slice(0, 4000)}\n\n` +
      `【生成稿】（模型续写）\n${generatedText.slice(0, 4000)}\n\n` +
      `请输出 JSON：{ "pairResults": [{ "dimension": "...", "winner": "generated"|"reference"|"tie", ` +
      `"reason": "...", "generatedSpan": {"excerpt": "..."}, "referenceSpan": {"excerpt": "..."} }] }`;

    const result = await callJudgeModel(
      judgeConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        responseFormat: "json_schema",
        schema: {
          type: "object",
          properties: {
            pairResults: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  dimension: { type: "string" },
                  winner: { type: "string", enum: ["generated", "reference", "tie"] },
                  reason: { type: "string" },
                  generatedSpan: {
                    type: "object",
                    properties: { excerpt: { type: "string" } },
                  },
                  referenceSpan: {
                    type: "object",
                    properties: { excerpt: { type: "string" } },
                  },
                },
                required: ["dimension", "winner", "reason"],
              },
            },
          },
          required: ["pairResults"],
          additionalProperties: false,
        },
        schemaName: "reference_aware_verdict",
        temperature: 0.2,
        maxTokens: 1024,
      },
    );

    const parsed = JSON.parse(result.text) as {
      pairResults: TrackAPairResult[];
    };
    return { pairResults: parsed.pairResults ?? [] };
  };

  const judgePair: NonNullable<RunReferenceGuidedOptions["judgePair"]> = async (
    leftText,
    rightText,
    context,
    _seed,
  ) => {
    const systemPrompt = "你是顶尖网文文学裁判。请匿名比较两个候选章节正文。";
    const userPrompt = `作品目标：${context.workGoal}\n本章意图：${context.chapterIntent}\n\n` +
      `候选甲：\n${leftText}\n\n候选乙：\n${rightText}\n\n` +
      `请输出 JSON：{ "winner": "A" | "B" | "tie", "reason": "...", "hardFactRisk": boolean }`;
    const result = await callJudgeModel(
      judgeConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        responseFormat: "json_schema",
        schema: {
          type: "object",
          properties: {
            winner: { type: "string", enum: ["A", "B", "tie"] },
            reason: { type: "string" },
            hardFactRisk: { type: "boolean" },
          },
          required: ["winner", "reason", "hardFactRisk"],
          additionalProperties: false,
        },
        schemaName: "ablation_pair_verdict",
        temperature: 0.2,
        maxTokens: 256,
      },
    );
    const parsed = JSON.parse(result.text) as {
      winner: "A" | "B" | "tie";
      reason: string;
      hardFactRisk: boolean;
    };
    const winner =
      parsed.winner === "A" ? "left" : parsed.winner === "B" ? "right" : "tie";
    return { winner, reason: parsed.reason, hardFactRisk: parsed.hardFactRisk };
  };

  return runReferenceGuidedAblation({
    caseSet: options.caseSet,
    tracks: options.tracks,
    resolveReference: options.resolveReference,
    samplesPerCase: options.samplesPerCase,
    rounds: options.rounds,
    trackBArms: options.trackBArms,
    judgePairs: options.judgePairs,
    controlVariables: options.controlVariables,
    generateRaw,
    judgeReferenceAware,
    judgePair,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// formatReferenceGuidedResultAsMarkdown
// ─────────────────────────────────────────────────────────────────────────────

export function formatReferenceGuidedResultAsMarkdown(
  result: ReferenceGuidedResult,
): string {
  const lines: string[] = [];
  lines.push("# REFERENCE-GUIDED-PROMPT-ABLATION-1：reference 引导的 prompt 消融结果");
  lines.push("");
  lines.push(`**ablationRunId**：${result.ablationRunId}`);
  lines.push(`**caseSetHash**：${result.caseSetHash}`);
  lines.push(`**totalCases**：${result.totalCases}`);
  lines.push(`**tracksRun**：${result.tracksRun.join(", ")}`);
  lines.push(`**totalModelCalls**：${result.totalModelCalls}`);
  lines.push(`**totalDurationMs**：${result.totalDurationMs}`);
  lines.push("");

  // ── 轨道 A 章节 ──
  if (result.tracksRun.includes("A")) {
    lines.push("## 轨道 A：续写实现能力（trackAResults）");
    lines.push("");
    if (result.trackAResults.length === 0) {
      lines.push("- 无 Track A 结果");
    } else {
      for (const r of result.trackAResults) {
        lines.push(`### case ${r.caseId}`);
        lines.push(`- referenceId：${r.referenceId}`);
        lines.push(`- samples：${r.samples.length}`);
        lines.push(`- pairResults：${r.pairResults.length} 条`);
        lines.push(`- craftGaps：${r.craftGaps.length} 条`);
        lines.push(`- totalModelCalls：${r.totalModelCalls}`);
        lines.push("");
      }
    }
    lines.push("");
  }

  // ── 轨道 B 章节 ──
  if (result.tracksRun.includes("B")) {
    lines.push("## 轨道 B：注入词增益（trackBResults）");
    lines.push("");
    if (result.trackBResults.length === 0) {
      lines.push("- 无 Track B 结果");
    } else {
      for (const r of result.trackBResults) {
        lines.push(`### case ${r.caseId}`);
        const armIds = [...new Set(r.samples.map((s) => s.armId))].sort();
        lines.push(`- 实验臂：${armIds.join(", ")}`);
        lines.push(`- samples：${r.samples.length}`);
        lines.push(`- pairResults：${r.pairResults.length} 条`);
        for (const p of r.pairResults) {
          lines.push(`  - ${p.armLeft} vs ${p.armRight}：winner=${p.winner}（arm=${p.winnerArm ?? "tie"}）`);
        }
        lines.push("");
      }
    }
    lines.push("");
  }

  // ── 工艺差距章节 ──
  lines.push("## 工艺差距（craftGaps）");
  lines.push("");
  if (result.craftGaps.length === 0) {
    lines.push("- 未提取到工艺差距");
  } else {
    for (const gap of result.craftGaps) {
      lines.push(`### case ${gap.caseId} / ${gap.dimension}`);
      lines.push(`- gapType：${gap.gapType}`);
      lines.push(`- referenceSpan：${gap.referenceSpan.excerpt.slice(0, 40)}...`);
      lines.push(`- generatedSpan：${gap.generatedSpan.excerpt.slice(0, 40)}...`);
      lines.push(`- readerImpact：${gap.readerImpact}`);
      lines.push("");
    }
  }
  lines.push("");

  // ── craft hypothesis 章节 ──
  lines.push("## craft hypothesis");
  lines.push("");
  if (result.craftHypotheses.length === 0) {
    lines.push("- 未提炼 craft hypothesis（stub 模式下为空，需真实实验填入）");
  } else {
    for (const h of result.craftHypotheses) {
      lines.push(`### ${h.title}`);
      lines.push(`- hypothesisId：${h.hypothesisId}`);
      lines.push(`- applicableScene：${h.applicableScene}`);
      lines.push(`- expectedReaderGain：${h.expectedReaderGain}`);
      lines.push(`- possibleDamage：${h.possibleDamage}`);
      lines.push(`- forbiddenMigration：${h.forbiddenMigration.join("; ")}`);
      lines.push(`- recommendedInjection：${h.recommendedInjection}`);
      lines.push(`- validationState：${h.validationState}`);
      if (h.sampleSize !== undefined) lines.push(`- sampleSize：${h.sampleSize}`);
      if (h.winRate !== undefined) lines.push(`- winRate：${h.winRate.toFixed(2)}`);
      lines.push("");
    }
  }
  lines.push("");

  // ── productionGating 警告 ──
  lines.push("## productionGating（不直接改变生产 / REQUIRES_AUTH）");
  lines.push("");
  lines.push(`- canChangeProductionPrompt：${result.productionGating.canChangeProductionPrompt}`);
  lines.push(`- canChangeDefaultInjection：${result.productionGating.canChangeDefaultInjection}`);
  lines.push(`- note：${result.productionGating.note}`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：hash
// ─────────────────────────────────────────────────────────────────────────────

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

function computeCaseSetHash(caseSet: ReferenceGuidedCaseSet): string {
  const stable = {
    bookId: caseSet.bookId,
    caseSetId: caseSet.caseSetId,
    caseIds: caseSet.cases.map((c) => c.caseId).sort(),
    referenceIds: caseSet.cases.map((c) => c.referenceId).sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}
