/**
 * PiNovelStudio — Anti-AI Pattern Residue Classifier
 *
 * 从 anti-ai-detector.ts 提取的纯函数模块（refactor，行为零变化）。
 * 区分"风格冲突型"与"结构性 AI 腔残留"，供 anti-ai-detector 及适配层消费。
 *
 * 提取原因：这组符号（2 个 const Set + 1 个 type + 2 个纯函数）在
 * anti-ai-detector.ts 内部零引用，仅被外部消费者（legacy-language-risk-adapter、
 * characterization tests）通过 re-export 使用，是最低风险、最高自包含度的提取切片。
 */

// ============================================================================
// P25 风险分层：区分"风格冲突型"与"结构性 AI 腔残留"
//
// 背景：事件级 anti-ai 把低密度、低数量、孤立命中的风格冲突型 pattern
// （如短句、省略、数字短句、局部形容词短句）误判为 real_hard_block，
// 触发 LLM 事件重写，越改越差。
//
// 分类：
//   - style_conflict：容易和作品风格冲突的孤例（短句、省略、数字短句、
//     局部形容词短句、弱副词、眼/心口细节等）。低密度孤例不应触发重写，
//     交 Stage 8 整章 density 兜底。
//   - structural_ai_residue：真正 AI 腔结构污染（成片解释、总结腔、模板化
//     转述、否定铺垫后接肯定、括号式插入解释等）。可触发重写或 hard block。
//
// 注意：默认归为 structural_ai_residue，只有显式白名单内的 patternId 才算
// style_conflict，避免误放行真正高风险结构污染。
// ============================================================================

export type AntiAIPatternResidueKind = "style_conflict" | "structural_ai_residue";

/**
 * 风格冲突型 pattern 白名单。
 * 这些 pattern 在低密度孤例下不应触发事件级重写，交 Stage 8 整章 density 兜底。
 *
 * 说明：白名单聚焦"短句/省略/局部形容词副词/单调标签"等容易和作品风格冲突的孤例，
 * 最高 severity 为 0.8（heart_surge）。模板化隐喻（如 empty_beast_eye_metaphor 0.85）
 * 不纳入白名单，归为 structural_ai_residue，避免放行真正的 AI 模板污染。
 */
export const STYLE_CONFLICT_PATTERN_IDS: ReadonlySet<string> = new Set<string>([
  // 短句/省略/电报式
  "excessive_ellipsis",
  "bare_number_measure",
  "bare_adjective_sentence",
  // 局部形容词/副词
  "narr_double_adj",
  "weak_adverb",
  "extreme_adverb",
  // 眼/心/身体局部细节孤例（模板化程度低，孤例可交 Stage 8 兜底）
  "eye_flash",
  "heart_surge",
  "stiff_body_failure",
  // 单调标签/时间/转折词
  "mono_tag",
  "mono_time",
  "unnecessary_turning_word",
]);

/**
 * 判定 patternId 的残留类型。
 * 默认归为 structural_ai_residue，只有显式白名单内的才算 style_conflict。
 */
export const STRUCTURAL_AI_RESIDUE_BLOCKLIST: ReadonlySet<string> = new Set<string>([
  "parenthetical_explanation",
  "over_explain",
  "summarize",
  "template_syntax",
  "negative_definition_chain",
  "structured_enum",
  "binary_oppose",
  "conclusion_before_evidence",
  "behavior_cause_explained",
  "redundant_sensory_confirm",
  "narr_because_motivation",
  "narr_perception_confirm",
  "info_dump_dialogue",
  "env_list",
  "scene_listing",
  "passive_pileup",
  "emotion_adjective_stack",
  "metaphor_abuse",
  "empty_beast_eye_metaphor",
  "universal_describe",
  "lazy_mystery",
  "pre_label_emotion",
  "narr_pre_label_emotion",
]);

export function isStructuralResidueBlocklisted(patternId: string): boolean {
  return STRUCTURAL_AI_RESIDUE_BLOCKLIST.has(patternId);
}

export function classifyPatternResidueKind(patternId: string): AntiAIPatternResidueKind {
  return STYLE_CONFLICT_PATTERN_IDS.has(patternId) ? "style_conflict" : "structural_ai_residue";
}
