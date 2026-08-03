/**
 * NaturalLanguageFeedbackCompiler — 自然语言反馈编译器（Phase 4D，P1-3 修复）
 *
 * 把用户的自然语言反馈编译为结构化策略反馈，降低用户使用门槛。
 *
 * 设计原则：
 * - 不调用 LLM，纯规则驱动（关键词 + 情感极性匹配）
 * - 保守映射：只映射高置信度的关键词，无法映射时返回 null（不误导学习）
 * - 支持三种策略 ID：guidance_reduction / voice_emphasis / rhythm_adjustment
 * - 情感极性：positive（策略生效，应奖励）/ negative（策略无效或有害，应惩罚）
 *
 * 映射规则（基于策略 objective）：
 * - guidance_reduction（缩减风格指导）：
 *   - "太长"/"太啰嗦"/"指导太多" → positive（需要更多缩减）
 *   - "太短"/"不够详细"/"细节太少" → negative（缩减过度）
 * - voice_emphasis（人物声音强调）：
 *   - "角色不像"/"语气不对"/"声音不一致"/"对白分不清" → positive（需要更多声音强调）
 *   - "角色很好"/"语气到位"/"声音很贴" → positive（策略生效）
 * - rhythm_adjustment（段落节奏调整）：
 *   - "节奏太平"/"段落太均匀"/"太机械" → positive（需要更多节奏调整）
 *   - "节奏很好"/"段落有变化" → positive（策略生效）
 * - 通用情感：
 *   - "不错"/"好"/"满意"/"喜欢" → positive（所有选中策略生效）
 *   - "不好"/"差"/"不满意"/"不喜欢" → negative（所有选中策略无效）
 *
 * 与 user-feedback-ingestor 的关系：
 * - 编译器输出 StructuredFeedback，由 public-handlers 传给 ingestor
 * - ingestor 更新 Thompson Sampling 的 alpha/beta 参数
 * - 编译器不直接修改策略信誉库
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 策略 ID（与 author-style-strategy-registry.ts 同步） */
export type StrategyId = "guidance_reduction" | "voice_emphasis" | "rhythm_adjustment";

/** 情感极性 */
export type FeedbackSentiment = "positive" | "negative" | "neutral";

/** 编译后的结构化反馈 */
export interface CompiledFeedback {
  /** 匹配到的策略 ID（null 表示无法映射） */
  strategyId: StrategyId | null;
  /** 情感极性 */
  sentiment: FeedbackSentiment;
  /** 映射的反馈操作（positive→choice:editorial, negative→edit:modified, neutral→rating:3） */
  inferredAction: "choice" | "edit" | "rating";
  /** 推断的评分（1-5，positive=5, negative=1, neutral=3） */
  inferredRating: number;
  /** 匹配到的关键词（用于可解释性） */
  matchedKeywords: string[];
  /** 原始自然语言反馈 */
  rawFeedback: string;
  /** 编译原因（用于 trace 审计） */
  reason: string;
}

// ============================================================================
// 关键词表
// ============================================================================

interface KeywordMapping {
  keywords: readonly string[];
  strategyId: StrategyId;
  sentiment: FeedbackSentiment;
}

const KEYWORD_MAPPINGS: readonly KeywordMapping[] = [
  // guidance_reduction — 正向（需要更多缩减 / 策略生效）
  {
    keywords: ["太长", "太啰嗦", "指导太多", "风格指导过重", "指导过载", "太繁杂", "冗长"],
    strategyId: "guidance_reduction",
    sentiment: "positive",
  },
  // guidance_reduction — 负向（缩减过度）
  {
    keywords: ["太短", "不够详细", "细节太少", "内容太少", "不够丰富", "太简略"],
    strategyId: "guidance_reduction",
    sentiment: "negative",
  },
  // voice_emphasis — 正向（需要更多声音强调 / 策略生效）
  {
    keywords: ["角色不像", "语气不对", "声音不一致", "对白分不清", "人物像同一个", "语气没区别", "声音不贴", "角色扁平"],
    strategyId: "voice_emphasis",
    sentiment: "positive",
  },
  {
    keywords: ["角色很好", "语气到位", "声音很贴", "角色鲜明", "人物很活", "对白有个性"],
    strategyId: "voice_emphasis",
    sentiment: "positive",
  },
  // rhythm_adjustment — 正向（需要更多节奏调整 / 策略生效）
  {
    keywords: ["节奏太平", "段落太均匀", "太机械", "段落一样长", "没有节奏感", "节奏单调", "太均匀"],
    strategyId: "rhythm_adjustment",
    sentiment: "positive",
  },
  {
    keywords: ["节奏很好", "段落有变化", "节奏舒服", "长短交替", "节奏分明"],
    strategyId: "rhythm_adjustment",
    sentiment: "positive",
  },
];

/** 通用情感关键词（不绑定特定策略） */
const POSITIVE_GENERAL = ["不错", "好", "满意", "喜欢", "很棒", "优秀", "出色", "到位", "好评", "赞"];
const NEGATIVE_GENERAL = ["不好", "差", "不满意", "不喜欢", "糟糕", "太差", "不行", "难看", "差评", "烂"];

// ============================================================================
// 编译器
// ============================================================================

/**
 * 编译自然语言反馈为结构化策略反馈。
 *
 * @param feedback 用户的自然语言反馈文本
 * @param selectedStrategyIds 当前章节选中的策略 ID 列表（用于通用情感的策略归因）
 * @returns 编译后的结构化反馈
 */
export function compileNaturalLanguageFeedback(
  feedback: string,
  selectedStrategyIds: readonly string[] = [],
): CompiledFeedback {
  const rawFeedback = feedback.trim();
  if (rawFeedback.length === 0) {
    return {
      strategyId: null,
      sentiment: "neutral",
      inferredAction: "rating",
      inferredRating: 3,
      matchedKeywords: [],
      rawFeedback,
      reason: "空反馈",
    };
  }

  // 1. 按关键词表匹配特定策略
  const matchedKeywords: string[] = [];
  let bestMatch: KeywordMapping | null = null;
  for (const mapping of KEYWORD_MAPPINGS) {
    for (const keyword of mapping.keywords) {
      if (rawFeedback.includes(keyword)) {
        matchedKeywords.push(keyword);
        // 取第一个匹配（优先级按表顺序）
        if (!bestMatch) {
          bestMatch = mapping;
        }
      }
    }
  }

  if (bestMatch) {
    const sentiment = bestMatch.sentiment;
    return {
      strategyId: bestMatch.strategyId,
      sentiment,
      inferredAction: sentiment === "positive" ? "choice" : "edit",
      inferredRating: sentiment === "positive" ? 5 : sentiment === "negative" ? 1 : 3,
      matchedKeywords,
      rawFeedback,
      reason: `关键词匹配：${matchedKeywords.join(", ")} → ${bestMatch.strategyId} (${sentiment})`,
    };
  }

  // 2. 通用情感匹配（不绑定特定策略，归因到选中的第一个策略）
  // 注意：必须先检查 NEGATIVE_GENERAL，否则 "不好" 会因子串 "好" 误匹配 POSITIVE_GENERAL
  for (const keyword of NEGATIVE_GENERAL) {
    if (rawFeedback.includes(keyword)) {
      matchedKeywords.push(keyword);
      const strategyId = (selectedStrategyIds[0] as StrategyId) ?? null;
      return {
        strategyId,
        sentiment: "negative",
        inferredAction: "edit",
        inferredRating: 1,
        matchedKeywords,
        rawFeedback,
        reason: `通用负向情感：${keyword} → 归因到选中策略 ${strategyId ?? "(无)"}`,
      };
    }
  }

  for (const keyword of POSITIVE_GENERAL) {
    if (rawFeedback.includes(keyword)) {
      matchedKeywords.push(keyword);
      const strategyId = (selectedStrategyIds[0] as StrategyId) ?? null;
      return {
        strategyId,
        sentiment: "positive",
        inferredAction: "choice",
        inferredRating: 5,
        matchedKeywords,
        rawFeedback,
        reason: `通用正向情感：${keyword} → 归因到选中策略 ${strategyId ?? "(无)"}`,
      };
    }
  }

  // 3. 无法映射
  return {
    strategyId: null,
    sentiment: "neutral",
    inferredAction: "rating",
    inferredRating: 3,
    matchedKeywords: [],
    rawFeedback,
    reason: "无法匹配任何关键词，反馈已接收但不生成结构化策略反馈",
  };
}

/**
 * 从 trace 的 stageResults 中提取最近一章选中的策略 ID 列表。
 *
 * @param stageResults 来自 trace 的 stageResults 对象
 * @returns 选中的策略 ID 列表
 */
export function extractSelectedStrategyIds(stageResults: Record<string, unknown>): string[] {
  // authorStyleStrategySelection.selectedStrategyIds（Agentic 风格路径）
  const authorStyleSelection = stageResults.authorStyleStrategySelection as
    | { selectedStrategyIds?: string[] }
    | undefined;
  if (authorStyleSelection?.selectedStrategyIds && authorStyleSelection.selectedStrategyIds.length > 0) {
    return authorStyleSelection.selectedStrategyIds;
  }

  // strategySelection.sampled[].strategyId（editorial 路径）
  const strategySelection = stageResults.strategySelection as
    | { sampled?: Array<{ strategyId?: string }> }
    | undefined;
  if (strategySelection?.sampled && strategySelection.sampled.length > 0) {
    return strategySelection.sampled
      .map((s) => s.strategyId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  return [];
}
