/**
 * EXTERNAL-KB-3 — 外挂蒸馏知识库（结构化 Craft Pattern Card，生产默认关闭）。
 *
 * 第一性原理：外部知识的价值是可迁移的「因果机制」，不是剧情事实，也不是表达模仿。
 * 因此本模块只消费结构化卡片，**不消费任何原文片段**：
 * - 卡片落位 data/external-distilled/slices.json，单条 = 1 个场景判断 +
 *   结构化标签（scene_function / beat / pressure_type / decision_tradeoff / cost_type / state_delta）；
 * - 检索键由 ChapterIntent 派生（deriveStructuredRetrievalKey），不拼接长散文；
 * - 检索顺序 = 硬过滤（scene_type / avoid_when）→ 结构化准入（≥2 个独立维度命中且至少一个主维度
 *   + 绝对最低分）→ 结构化主排序 → 字面相似只做 tie-break → 可选 margin 观察 → 无合格候选返回空；
 * - 生产默认只交付 1 条主 advisory（EXTERNAL_KB_PRODUCTION_TOP_K），进入 ContextPackage 的 P4 参考槽
 *   （无指令权，canAffectHardGate=false），带 sourceRef 供 trace 回放；
 * - 由 PINOVEL_EXTERNAL_KB=1 打开，缺省关闭；关闭时不读取任何文件、不产生任何条目。
 *
 * 空结果优先：结构化 key 无法派生、或没有任何卡片达到准入条件时，返回空选集并写审计字段，
 * 不用「章节阶段兜底」把零相关卡片塞进 prompt（那会让模型看到与本章无关的战斗/日常建议）。
 *
 * 原文范文（PINOVEL_EXTERNAL_EXCERPTS）是隔离评测专用通道：只有评测代码显式传 allowExcerpts=true
 * 才生效；生产入口永不传，即使部署环境误设该变量也只留痕忽略。生产永久不注入外部小说原文，
 * 包含 ≤120 字的短 span（短 span 仍会隐性影响句法节奏、词汇与情节联想）。
 *
 * 相关性算法与 V0 审计脚本（audit_retrieval.py）保持一致的部分是「去空白 + 字符二元组 + 余弦」，
 * 只用于结构化准入之后的 tie-break，保证实验可复现。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logHarnessEvent } from "../../utils/harness-logger.js";

/** 打开外挂知识库的环境开关。 */
export const EXTERNAL_KB_ENV_FLAG = "PINOVEL_EXTERNAL_KB";
/** 卡片相对仓库根目录的落位路径。 */
export const EXTERNAL_KB_RELATIVE_PATH = "data/external-distilled/slices.json";
/** 单次注入上限：条数与单条字数（3 是评测对照臂上限，生产只用 1 条）。 */
export const EXTERNAL_KB_TOP_K = 3;
/** 生产默认只交付 1 条主机制卡（评审结论：每个事件 1 张主卡 + 至多 1 张互补卡）。 */
export const EXTERNAL_KB_PRODUCTION_TOP_K = 1;
export const EXTERNAL_SLICE_MAX_CHARS = 520;
/** 相关性阈值：低于该值的候选丢弃并记录（不静默注入低相关判断）。 */
export const EXTERNAL_KB_DEFAULT_MIN_SCORE = 0.08;
/** 内容相关性下限（content 模式入选前提，不是排序加成）。 */
export const EXTERNAL_KB_CONTENT_MIN_SCORE = 0.08;
/**
 * 结构化准入：至少 2 个独立结构维度命中（评审：Top-1 相对比例不足以保证质量，
 * 需要「至少两个独立结构维度命中」+ 绝对最低分，margin 只作消歧辅助）。
 */
export const EXTERNAL_KB_MIN_STRUCTURED_HITS = 2;
/**
 * 结构化准入还要求命中至少一个「主维度」（scene_function / beat）。
 * 理由：pressure_type + cost_type 这类通用维度在同类题材里几乎恒命中，
 * 只靠它们会让所有规则副本卡片都达到 2 维门槛，等于没有筛选。
 */
export const EXTERNAL_KB_REQUIRE_PRIMARY_DIMENSION = true;
/** 结构化得分绝对下限：低于该值即使 2 维命中也不入选。 */
export const EXTERNAL_KB_STRUCTURAL_MIN_SCORE = 0.3;
/** 字面相似只在结构化主排序后做 tie-break（评审建议 20–30%，此处取 20%，待离线校准）。 */
export const EXTERNAL_KB_LITERAL_WEIGHT = 0.2;
/**
 * 结构化维度权重（仅在已过准入的候选之间排序，不构成准入资格）。
 * 主维度（场景功能/节拍）回答「何时、为何使用」，压力/权衡/代价/状态变化回答「机制如何运作」。
 */
export const EXTERNAL_KB_STRUCTURED_WEIGHTS = {
  sceneFunction: 0.30,
  beat: 0.20,
  pressureType: 0.22,
  decisionTradeoff: 0.18,
  costType: 0.12,
  stateDelta: 0.12,
  readerEffect: 0.10,
} as const;
/**
 * content 模式（无结构化 key 时的兼容路径）加权：目标情绪命中 +0.25、章节阶段精确匹配 +0.15。
 * 只用于隔离评测/历史调用；生产入口始终传结构化 key。
 */
export const EXTERNAL_KB_EMOTION_BOOST = 0.25;
export const EXTERNAL_KB_PHASE_BOOST = 0.15;
/**
 * 实验对照通道（V2 B/C 臂）：直接注入「可仿写原文范文」。
 * 只用于验证「范文是否伤害自然度」这一命题，实验结束即删除，不进入生产。
 * 该通道只能由隔离评测代码显式传 `allowExcerpts: true` 打开；
 * 生产入口永不传，因此仅设置环境变量不会让生产收到原文范文（会被忽略并写运行日志）。
 */
export const EXTERNAL_EXCERPTS_ENV_FLAG = "PINOVEL_EXTERNAL_EXCERPTS";
export const EXTERNAL_EXCERPT_PATHS = {
  good: "data/external-distilled/excerpts-good.json",
  bad: "data/external-distilled/excerpts-bad.json",
} as const;

/** 一条蒸馏卡片：可迁移的因果机制 + 结构化检索标签，不含原文。 */
export interface ExternalDistilledSlice {
  id: string;
  scene_type: string;
  chapter_phase?: string;
  emotion_target?: ReadonlyArray<string>;
  narrative_function?: string;
  style_tags?: ReadonlyArray<string>;
  rule: string;
  anti_pattern?: string;
  applicable_when?: ReadonlyArray<string>;
  avoid_when?: ReadonlyArray<string>;
  /** 场景功能（枚举）：回答「这张卡描述哪一类场景」。 */
  scene_function?: string;
  /** 节拍（枚举）：回答「这发生在场景的哪一步」。 */
  beat?: string;
  /** 压力类型（枚举）：机制的第一环。 */
  pressure_type?: string;
  /** 决策权衡（枚举）：机制的第二环。 */
  decision_tradeoff?: string;
  /** 可见代价（枚举数组）。 */
  cost_type?: ReadonlyArray<string>;
  /** 状态变化（枚举数组）：选择前后发生了什么可判定的变化。 */
  state_delta?: ReadonlyArray<string>;
  source?: string;
  confidence?: string;
}

/**
 * 结构化检索键：由 ChapterIntent 派生，不拼接长散文、不取专名。
 * 只表达「场景功能 / 节拍 / 压力 / 权衡 / 代价 / 状态变化」，与卡片的抽象层一致。
 */
export interface ExternalRetrievalKey {
  sceneFunction: string | null;
  beat: string | null;
  pressureType: string | null;
  decisionTradeoff: string | null;
  costType: string[];
  stateDelta: string[];
  /** 读者效果（目标情绪），只作弱信号，不参与准入计数。 */
  readerEffect: string[];
}

/** 与 ChapterIntent 对齐的最小输入形状（刻意不 import，保持模块可独立测试）。 */
export interface ExternalIntentLike {
  chapterFunction?: string | null;
  currentPressure?: ReadonlyArray<string> | null;
  readerExperience?: ReadonlyArray<string> | null;
  authorEventSummaries?: ReadonlyArray<string> | null;
  authorMustInclude?: ReadonlyArray<string> | null;
  selectedPromisesToAdvance?: ReadonlyArray<{ description?: string | null }> | null;
  meaningfulChoices?: ReadonlyArray<string> | null;
  choicesAndCosts?: ReadonlyArray<{ choice?: string | null; cost?: string | null }> | null;
  resistance?: ReadonlyArray<string> | null;
  expectedIrreversibleChange?: ReadonlyArray<string> | null;
  causalEndPressure?: ReadonlyArray<string> | null;
  authorStateChanges?: ReadonlyArray<string> | null;
}

export interface ExternalKnowledgeLoadResult {
  ok: boolean;
  slices: ExternalDistilledSlice[];
  path: string;
  error: string | null;
}

/** 检索输入：结构化 key 存在时走结构化准入；缺省时退回历史 content 模式（隔离评测/兼容）。 */
export interface ExternalKnowledgeRetrievalInput {
  slices: ReadonlyArray<ExternalDistilledSlice>;
  query: string;
  sceneType?: string | null;
  emotionTargets?: ReadonlyArray<string> | null;
  chapterPhase?: string | null;
  topK?: number;
  minScore?: number;
  contentMinScore?: number;
  /**
   * 结构化检索键。**只要该字段出现（含 null）就走结构化模式**；完全不传才是 content 模式。
   * 生产入口必须传 deriveStructuredRetrievalKey(intent) 的结果。
   */
  retrievalKey?: ExternalRetrievalKey | null;
}

export interface ExternalKnowledgeDeliveredItem {
  id: string;
  content: string;
  sourceRef: string;
  score: number;
  /** 字面相关性（字符二元组余弦），仅用于 tie-break，不构成准入。 */
  literalScore: number;
  /** 结构化得分（命中维度加权和）。 */
  structuredScore: number;
  /** content 模式的历史加权（情绪/阶段）；结构化模式恒为 0。 */
  boostScore: number;
  /** 命中的独立结构维度数（不含 readerEffect）。 */
  structuredHits: number;
  /** 命中的维度名，写 trace 供人工核对「为什么它被选中」。 */
  matchedDimensions: string[];
}

/**
 * 检索报告：开关状态、池子规模、硬过滤/准入/阈值丢弃记录。
 * 写入 trace，供人工确认「没有静默丢弃、也没有整库注入」。
 */
export interface ExternalKnowledgeReport {
  enabled: boolean;
  /** 通道模式：生产为 slices；excerpts_* 仅 V2 实验对照臂使用。 */
  mode: "slices" | "excerpts_good" | "excerpts_bad";
  sourcePath: string | null;
  poolSize: number;
  afterHardFilter: number;
  scoredCount: number;
  deliveredIds: string[];
  /** 已过准入、但被阈值或 Top-K 条数挡下的候选。 */
  droppedIds: string[];
  droppedByHardFilterIds: string[];
  /** content 模式下未达到内容相关性下限的候选。 */
  droppedByRelevanceIds: string[];
  /** 结构化模式下未达到准入条件的候选（维度不足/主维度缺失/绝对分不足）。 */
  droppedByStructuredAdmissionIds: string[];
  /** 选集依据：structured=结构化准入；content=历史字面模式；none=空结果。 */
  selectionMode: "structured" | "content" | "none";
  /** 本次使用的结构化检索键（null 表示未用/无法派生）。 */
  retrievalKey: ExternalRetrievalKey | null;
  /** 每个候选命中的独立结构维度数。 */
  structuredHitsById: Record<string, number>;
  /** Top-1 与 Top-2 的排序分差（消歧辅助，不作为入选硬门）。 */
  marginGap: number | null;
  minScore: number;
  contentMinScore: number;
  sceneType: string | null;
  topK: number;
  queryPreview: string;
  emotionTargets: string[];
  chapterPhase: string | null;
  skippedReason: string | null;
  degradedReason: string | null;
}

export interface ExternalKnowledgeSelection {
  items: ExternalKnowledgeDeliveredItem[];
  report: ExternalKnowledgeReport;
}

export function isExternalKnowledgeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[EXTERNAL_KB_ENV_FLAG] === "1";
}

/** 读取蒸馏卡片；任何读取/解析失败都返回 ok=false，由调用方记录降级原因（不阻断生成）。 */
export function loadExternalDistilledSlices(
  projectRoot: string,
): ExternalKnowledgeLoadResult {
  const path = join(projectRoot, EXTERNAL_KB_RELATIVE_PATH);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { ok: false, slices: [], path, error: "slices_root_not_array" };
    }
    const slices: ExternalDistilledSlice[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const rule = typeof record.rule === "string" ? record.rule.trim() : "";
      const sceneType = typeof record.scene_type === "string" ? record.scene_type.trim() : "";
      if (!id || !rule || !sceneType) continue;
      slices.push({
        id,
        scene_type: sceneType,
        chapter_phase: asString(record.chapter_phase),
        emotion_target: asStringArray(record.emotion_target),
        narrative_function: asString(record.narrative_function),
        style_tags: asStringArray(record.style_tags),
        scene_function: asString(record.scene_function),
        beat: asString(record.beat),
        pressure_type: asString(record.pressure_type),
        decision_tradeoff: asString(record.decision_tradeoff),
        cost_type: asStringArray(record.cost_type),
        state_delta: asStringArray(record.state_delta),
        rule,
        anti_pattern: asString(record.anti_pattern),
        applicable_when: asStringArray(record.applicable_when),
        avoid_when: asStringArray(record.avoid_when),
        source: asString(record.source),
        confidence: asString(record.confidence),
      });
    }
    return { ok: true, slices, path, error: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, slices: [], path, error: message };
  }
}

/** 由 ChapterIntent 派生检索查询（只取方向性字段，不取角色名等专名）。 */
export function buildExternalKnowledgeQuery(intent: ExternalIntentLike | null | undefined): string {
  if (!intent) return "";
  const parts: string[] = [];
  if (intent.chapterFunction) parts.push(intent.chapterFunction);
  parts.push(...(intent.currentPressure ?? []));
  parts.push(...(intent.readerExperience ?? []));
  parts.push(...(intent.authorEventSummaries ?? []));
  parts.push(...(intent.authorMustInclude ?? []));
  for (const promise of intent.selectedPromisesToAdvance ?? []) {
    if (promise?.description) parts.push(promise.description);
  }
  return parts.filter((part): part is string => Boolean(part?.trim())).join(" ").trim();
}

// ============================================================================
// 结构化检索键派生（关键词映射，确定性、可测；不是内容推断）
// ============================================================================

function joinText(parts: ReadonlyArray<string | null | undefined> | null | undefined): string {
  return (parts ?? []).filter((part): part is string => Boolean(part?.trim())).join("；");
}

interface KeywordRule {
  value: string;
  pattern: RegExp;
}

function firstRuleMatch(text: string, rules: ReadonlyArray<KeywordRule>): string | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.value;
  }
  return null;
}

function collectRuleMatches(text: string, rules: ReadonlyArray<KeywordRule>): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(text) && !out.includes(rule.value)) out.push(rule.value);
  }
  return out;
}

const SCENE_FUNCTION_RULES: ReadonlyArray<KeywordRule> = [
  { value: "boundary_test", pattern: /试探|验证|测试|边界/ },
  { value: "rule_exploitation", pattern: /漏洞|钻空|钻字眼|歧义|规则文本/ },
  { value: "rule_reveal", pattern: /新规则|规则显形|规则未明示|规则出现|副本/ },
  { value: "world_reveal", pattern: /世界观|设定|体系|分级/ },
  { value: "info_asymmetry", pattern: /信息差|猜疑|内鬼|隐瞒/ },
  { value: "info_reveal", pattern: /线索|真相|调查|揭示/ },
  { value: "deduction", pattern: /推演|推断|推理|分析/ },
  { value: "horror_anomaly", pattern: /恐怖|惊悚|反常|尸体|诡异/ },
  { value: "cost_payment", pattern: /代价|损耗|牺牲|付出/ },
  { value: "team_pressure", pattern: /团队|队友|群像|恐慌/ },
  { value: "hook_close", pattern: /章末|收束|钩子|悬念/ },
  { value: "relationship_shift", pattern: /关系|情感|信任|背叛/ },
  { value: "combat_approach", pattern: /战斗|交锋|对抗|追杀|厮杀/ },
];

const BEAT_RULES: ReadonlyArray<KeywordRule> = [
  { value: "test", pattern: /试探|验证|测试/ },
  { value: "close", pattern: /章末|收束|收尾|钩子/ },
  { value: "reversal", pattern: /反转|翻盘|逆袭|漏洞/ },
  { value: "reveal", pattern: /揭示|真相|线索|暴露|发现/ },
  { value: "payoff", pattern: /兑现|代价|结果|收获/ },
  { value: "escalation", pattern: /升级|加压|恶化|失控|追杀/ },
  { value: "setup", pattern: /首次|开场|进入|建立|交代/ },
];

const PRESSURE_RULES: ReadonlyArray<KeywordRule> = [
  { value: "environmental_rule", pattern: /规则|禁忌|违反|污染/ },
  { value: "information_gap", pattern: /信息差|不知道|隐瞒|猜疑|内鬼/ },
  { value: "hostile_presence", pattern: /敌人|追杀|入侵|对抗|怪物/ },
  { value: "resource_scarcity", pattern: /资源|道具|损耗|不够|余量/ },
  { value: "moral_dilemma", pattern: /牺牲|抉择|两难/ },
  { value: "time_pressure", pattern: /时间|紧迫|倒计时|来不及/ },
  { value: "relationship_conflict", pattern: /队友|背叛|信任|关系/ },
];

const TRADEOFF_RULES: ReadonlyArray<KeywordRule> = [
  { value: "information_advantage_for_risk", pattern: /隐瞒|不说|藏|装作|示弱|误导/ },
  { value: "short_term_safety_for_information", pattern: /换取|交换|交易|以[^。；]{0,8}换|拿[^。；]{0,8}换/ },
  { value: "safety_for_advantage", pattern: /冒险|强行|硬闯|赌/ },
  { value: "individual_for_team", pattern: /牺牲|舍|放弃/ },
  { value: "immediate_for_long_term", pattern: /退让|妥协|让出/ },
];

const COST_RULES: ReadonlyArray<KeywordRule> = [
  { value: "rule_trigger_risk", pattern: /死亡|触发|违反|禁忌/ },
  { value: "exposure_risk", pattern: /暴露|身份|被看见/ },
  { value: "physical_injury", pattern: /受伤|流血|残/ },
  { value: "resource_loss", pattern: /资源|道具|损耗|余量|消耗/ },
  { value: "relationship_damage", pattern: /关系|信任|背叛|队友/ },
  { value: "reputation_loss", pattern: /名声|声誉|面子/ },
  { value: "time_loss", pattern: /时间|延误|错过/ },
];

const STATE_DELTA_RULES: ReadonlyArray<KeywordRule> = [
  { value: "information_up", pattern: /信息|知道|线索|真相|规则/ },
  { value: "risk_up", pattern: /风险|危险|暴露|失控/ },
  { value: "threat_up", pattern: /威胁[^。；]{0,4}(升|升级|加深)|更危险/ },
  { value: "resource_down", pattern: /资源[^。；]{0,4}(耗|减|少)|耗尽/ },
  { value: "relationship_shift", pattern: /关系|信任|背叛/ },
  { value: "position_up", pattern: /地位|优势|主动/ },
];

/** 泛化标签不参与匹配：它们在所有卡片/所有章节里都成立，等于没有信息。 */
const GENERIC_KEY_VALUES = new Set([
  "general",
  "development",
  "general_pressure",
  "general_tradeoff",
]);

/**
 * 从 ChapterIntent 派生结构化检索键。纯关键词映射、确定性、无 LLM 调用。
 * 无法识别的字段留 null / 空数组 —— 由调用方按「空结果优先」处理，不得凭空补默认值。
 */
export function deriveStructuredRetrievalKey(
  intent: ExternalIntentLike | null | undefined,
): ExternalRetrievalKey {
  if (!intent) {
    return {
      sceneFunction: null,
      beat: null,
      pressureType: null,
      decisionTradeoff: null,
      costType: [],
      stateDelta: [],
      readerEffect: [],
    };
  }
  // sceneFunction 分两层派生：优先用作者声明的「本章功能」；该字段派生不出时，退化为
  // 作者事件摘要 + 必须包含项（两者都是作者写前契约的组成，不是内容推断）。
  // 两层都派生不出则留 null，由「空结果优先」处理，不补默认值。
  const sceneText = joinText([intent.chapterFunction]);
  const sceneFallbackText = joinText([
    ...(intent.authorEventSummaries ?? []),
    ...(intent.authorMustInclude ?? []),
  ]);
  const beatText = joinText([
    intent.chapterFunction,
    ...(intent.resistance ?? []),
    ...(intent.causalEndPressure ?? []),
  ]);
  // 压力只取压力/阻力字段，不掺 chapterFunction，避免「进入副本」把一切都判成规则压力。
  const pressureText = joinText([
    ...(intent.currentPressure ?? []),
    ...(intent.resistance ?? []),
    ...(intent.causalEndPressure ?? []),
  ]);
  const choiceText = joinText([
    ...(intent.meaningfulChoices ?? []),
    ...(intent.choicesAndCosts ?? []).map((entry) =>
      [entry.choice, entry.cost].filter(Boolean).join("；"),
    ),
  ]);
  const costText = joinText([
    ...(intent.choicesAndCosts ?? []).map((entry) => entry.cost),
    ...(intent.expectedIrreversibleChange ?? []),
    ...(intent.resistance ?? []),
  ]);
  const deltaText = joinText([
    ...(intent.expectedIrreversibleChange ?? []),
    ...(intent.causalEndPressure ?? []),
    ...(intent.authorStateChanges ?? []),
  ]);
  return {
    sceneFunction:
      firstRuleMatch(sceneText, SCENE_FUNCTION_RULES)
      ?? firstRuleMatch(sceneFallbackText, SCENE_FUNCTION_RULES),
    beat: firstRuleMatch(beatText, BEAT_RULES),
    pressureType: firstRuleMatch(pressureText, PRESSURE_RULES),
    decisionTradeoff: firstRuleMatch(choiceText, TRADEOFF_RULES),
    costType: collectRuleMatches(costText, COST_RULES),
    stateDelta: collectRuleMatches(deltaText, STATE_DELTA_RULES),
    readerEffect: splitEmotions(intent.readerExperience),
  };
}

/** 结构化 key 是否含至少一个可用维度（全空时直接空结果）。 */
export function isStructuredKeyEmpty(key: ExternalRetrievalKey | null): boolean {
  if (!key) return true;
  return !key.sceneFunction
    && !key.beat
    && !key.pressureType
    && !key.decisionTradeoff
    && key.costType.length === 0
    && key.stateDelta.length === 0;
}

/** 渲染进入 P4 参考槽的一条判断文本（去掉原文可仿写成分，只留判据）。 */
export function renderSliceAdvisory(slice: ExternalDistilledSlice): string {
  const segments: string[] = [slice.rule];
  if (slice.anti_pattern?.trim()) segments.push(`反模式：${slice.anti_pattern.trim()}`);
  if (slice.applicable_when?.length) {
    segments.push(`适用：${slice.applicable_when.join("、")}`);
  }
  const text = segments.join("；");
  return text.length > EXTERNAL_SLICE_MAX_CHARS
    ? `${text.slice(0, EXTERNAL_SLICE_MAX_CHARS - 1)}…`
    : text;
}

/**
 * 硬过滤：scene_type 不匹配、或查询文本命中该卡片的 avoid_when 条件时排除。
 * avoid_when 是自然语言条件，按标点切词后做短语包含判断（≥3 字），保证确定性可测。
 */
function passesHardFilter(
  slice: ExternalDistilledSlice,
  normalizedQuery: string,
  sceneType: string | null,
): boolean {
  if (sceneType && slice.scene_type !== sceneType) return false;
  for (const condition of slice.avoid_when ?? []) {
    for (const phrase of splitConditions(condition)) {
      if (phrase.length >= 3 && normalizedQuery.includes(phrase)) return false;
    }
  }
  return true;
}

function splitConditions(condition: string): string[] {
  return condition
    .split(/[、，,;；。：:\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function bigramCounts(text: string): Map<string, number> {
  const normalized = normalizeText(text);
  const counts = new Map<string, number>();
  for (let i = 0; i < normalized.length - 1; i++) {
    const gram = normalized.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [gram, value] of a) {
    const other = b.get(gram);
    if (other) dot += value * other;
  }
  if (dot === 0) return 0;
  let normA = 0;
  for (const value of a.values()) normA += value * value;
  let normB = 0;
  for (const value of b.values()) normB += value * value;
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function sliceSearchText(slice: ExternalDistilledSlice): string {
  return [
    slice.narrative_function ?? "",
    slice.rule,
    slice.anti_pattern ?? "",
    (slice.style_tags ?? []).join(" "),
    (slice.applicable_when ?? []).join(" "),
    (slice.avoid_when ?? []).join(" "),
    (slice.emotion_target ?? []).join(" "),
    slice.scene_type,
  ].join(" ");
}

/** 章节阶段（用于与卡片的 chapter_phase 对齐；"any" 表示通用判断，不参与阶段加分）。 */
export type ExternalChapterPhase = "opening" | "middle" | "climax" | "ending";

/**
 * 从章节号 + 章节功能文本派生阶段。
 * 只做关键词判定，不做内容推断：收束词优先，其次高潮词，再按章号判定开篇。
 */
export function deriveChapterPhase(input: {
  chapterNumber?: number | null;
  chapterFunction?: string | null;
}): ExternalChapterPhase {
  const chapterFunction = input.chapterFunction ?? "";
  if (/收束|收尾|章末|扫尾|结束/.test(chapterFunction)) return "ending";
  if (/高潮|爆发|决战|收网/.test(chapterFunction)) return "climax";
  if (input.chapterNumber === 1) return "opening";
  return "middle";
}

/** 情绪目标拆分：ChapterIntent 的 readerExperience 可能是「目标情绪：好奇、温馨」这类合并串。 */
function splitEmotions(targets: ReadonlyArray<string> | null | undefined): string[] {
  const out: string[] = [];
  for (const target of targets ?? []) {
    for (const part of target.split(/[、，,;；/／]+/)) {
      const trimmed = part.replace(/^目标情绪[：:]/u, "").trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** 情绪命中：双向包含且长度 ≥2（避免「爽」命中「反爽」这类单字误配）。 */
function emotionHit(
  sliceEmotions: ReadonlyArray<string> | undefined,
  targetEmotions: ReadonlyArray<string>,
): boolean {
  if (!sliceEmotions?.length || !targetEmotions.length) return false;
  for (const sliceEmotion of sliceEmotions) {
    if (sliceEmotion.trim().length < 2) continue;
    for (const target of targetEmotions) {
      if (target.length < 2) continue;
      if (sliceEmotion.includes(target) || target.includes(sliceEmotion)) return true;
    }
  }
  return false;
}

function emotionBoost(
  sliceEmotions: ReadonlyArray<string> | undefined,
  targetEmotions: ReadonlyArray<string>,
): number {
  return emotionHit(sliceEmotions, targetEmotions) ? EXTERNAL_KB_EMOTION_BOOST : 0;
}

/** 阶段加分：只对精确匹配生效；"any" 与空值不加分。 */
function phaseBoost(
  slicePhase: string | undefined,
  chapterPhase: string | null,
): number {
  if (!chapterPhase || !slicePhase) return 0;
  return slicePhase === chapterPhase ? EXTERNAL_KB_PHASE_BOOST : 0;
}

function overlap(values: ReadonlyArray<string> | undefined, targets: ReadonlyArray<string>): string[] {
  if (!values?.length || !targets.length) return [];
  return [...new Set(values.filter((value) => targets.includes(value)))]
    .filter((value) => !GENERIC_KEY_VALUES.has(value));
}

interface StructuredMatchResult {
  matchedDimensions: string[];
  structuredHits: number;
  structuredScore: number;
  hasPrimaryDimension: boolean;
}

/**
 * 结构化匹配：逐维度做枚举精确匹配 / 数组交集。
 * 独立维度计数不含 readerEffect（情绪是弱信号，不能单独构成准入）。
 */
function structuredMatch(
  slice: ExternalDistilledSlice,
  key: ExternalRetrievalKey,
): StructuredMatchResult {
  const matchedDimensions: string[] = [];
  let score = 0;
  const matchSingle = (
    dimension: keyof typeof EXTERNAL_KB_STRUCTURED_WEIGHTS,
    keyValue: string | null,
    sliceValue: string | undefined,
  ): boolean => {
    if (!keyValue || GENERIC_KEY_VALUES.has(keyValue)) return false;
    if (!sliceValue || sliceValue !== keyValue) return false;
    matchedDimensions.push(dimension);
    score += EXTERNAL_KB_STRUCTURED_WEIGHTS[dimension];
    return true;
  };
  const sceneHit = matchSingle("sceneFunction", key.sceneFunction, slice.scene_function);
  const beatHit = matchSingle("beat", key.beat, slice.beat);
  matchSingle("pressureType", key.pressureType, slice.pressure_type);
  matchSingle("decisionTradeoff", key.decisionTradeoff, slice.decision_tradeoff);
  if (overlap(slice.cost_type, key.costType).length > 0) {
    matchedDimensions.push("costType");
    score += EXTERNAL_KB_STRUCTURED_WEIGHTS.costType;
  }
  if (overlap(slice.state_delta, key.stateDelta).length > 0) {
    matchedDimensions.push("stateDelta");
    score += EXTERNAL_KB_STRUCTURED_WEIGHTS.stateDelta;
  }
  if (emotionHit(slice.emotion_target, key.readerEffect)) {
    matchedDimensions.push("readerEffect");
    score += EXTERNAL_KB_STRUCTURED_WEIGHTS.readerEffect;
  }
  const structuredHits = matchedDimensions.filter(
    (dimension) => dimension !== "readerEffect",
  ).length;
  return {
    matchedDimensions,
    structuredHits,
    structuredScore: score,
    hasPrimaryDimension: sceneHit || beatHit,
  };
}

/**
 * 结构化准入：抽查结论的硬要求。
 * - 至少 EXTERNAL_KB_MIN_STRUCTURED_HITS 个独立维度命中；
 * - 至少一个主维度（sceneFunction / beat）命中；
 * - 结构化得分达到 EXTERNAL_KB_STRUCTURAL_MIN_SCORE；
 * - 未命中 avoid_when（已在硬过滤阶段排除）。
 * readerEffect / 通用标签不参与准入。
 */
export function passesStructuredAdmission(match: StructuredMatchResult): boolean {
  if (match.structuredHits < EXTERNAL_KB_MIN_STRUCTURED_HITS) return false;
  if (EXTERNAL_KB_REQUIRE_PRIMARY_DIMENSION && !match.hasPrimaryDimension) return false;
  return match.structuredScore >= EXTERNAL_KB_STRUCTURAL_MIN_SCORE;
}

function makeReportBase(
  input: ExternalKnowledgeRetrievalInput,
  minScore: number,
  contentMinScore: number,
): ExternalKnowledgeReport {
  return {
    enabled: true,
    mode: "slices",
    sourcePath: null,
    poolSize: input.slices.length,
    afterHardFilter: 0,
    scoredCount: 0,
    deliveredIds: [],
    droppedIds: [],
    droppedByHardFilterIds: [],
    droppedByRelevanceIds: [],
    droppedByStructuredAdmissionIds: [],
    selectionMode: "none",
    retrievalKey: null,
    structuredHitsById: {},
    marginGap: null,
    minScore,
    contentMinScore,
    sceneType: input.sceneType ?? null,
    topK: input.topK ?? EXTERNAL_KB_TOP_K,
    queryPreview: normalizeText(input.query ?? "").slice(0, 80),
    emotionTargets: splitEmotions(input.emotionTargets),
    chapterPhase: input.chapterPhase ?? null,
    skippedReason: null,
    degradedReason: null,
  };
}

/** 结构化模式：硬过滤 → 结构化准入 → 结构化主排序 + 字面 tie-break → Top-K。 */
function retrieveStructured(
  input: ExternalKnowledgeRetrievalInput,
  report: ExternalKnowledgeReport,
  key: ExternalRetrievalKey,
  normalizedQuery: string,
): ExternalKnowledgeSelection {
  report.retrievalKey = key;
  const pool = input.slices.filter((slice) => {
    const passed = passesHardFilter(slice, normalizedQuery, report.sceneType);
    if (!passed) report.droppedByHardFilterIds.push(slice.id);
    return passed;
  });
  report.afterHardFilter = pool.length;
  if (isStructuredKeyEmpty(key)) {
    // 空 key 也要留痕：所有通过硬过滤的候选都因「无法派生结构化键」被排除，不得静默丢弃。
    report.skippedReason = "structured_key_empty";
    for (const slice of pool) report.droppedByStructuredAdmissionIds.push(slice.id);
    return { items: [], report };
  }
  const queryVector = bigramCounts(normalizedQuery);
  const scored = pool.map((slice) => {
    const literalScore = cosine(queryVector, bigramCounts(sliceSearchText(slice)));
    const match = structuredMatch(slice, key);
    report.structuredHitsById[slice.id] = match.structuredHits;
    return {
      slice,
      literalScore,
      match,
      admissible: passesStructuredAdmission(match),
      // 结构化为主，字面只做 tie-break（权重 20%，待离线校准）。
      score: match.structuredScore + literalScore * EXTERNAL_KB_LITERAL_WEIGHT,
    };
  });
  report.scoredCount = scored.length;
  scored.sort((a, b) => (b.score - a.score) || a.slice.id.localeCompare(b.slice.id));

  const admitted = scored
    .filter((entry) => entry.admissible && entry.score >= report.minScore)
    .slice(0, report.topK);
  if (admitted.length > 0) report.selectionMode = "structured";
  // margin 只做消歧观察：不因 margin 小就丢弃，也不因 margin 大就放行。
  if (admitted.length >= 2) {
    report.marginGap = Number((admitted[0].score - admitted[1].score).toFixed(4));
  }
  const selectedIds = new Set(admitted.map((entry) => entry.slice.id));
  for (const entry of scored) {
    if (selectedIds.has(entry.slice.id)) continue;
    if (entry.admissible) report.droppedIds.push(entry.slice.id);
    else report.droppedByStructuredAdmissionIds.push(entry.slice.id);
  }
  const items: ExternalKnowledgeDeliveredItem[] = admitted.map((entry) => ({
    id: entry.slice.id,
    content: renderSliceAdvisory(entry.slice),
    sourceRef: `${EXTERNAL_KB_RELATIVE_PATH}#${entry.slice.id}`,
    score: Number(entry.score.toFixed(4)),
    literalScore: Number(entry.literalScore.toFixed(4)),
    structuredScore: Number(entry.match.structuredScore.toFixed(4)),
    boostScore: 0,
    structuredHits: entry.match.structuredHits,
    matchedDimensions: entry.match.matchedDimensions,
  }));
  report.deliveredIds = items.map((item) => item.id);
  return { items, report };
}

/** content 模式（历史兼容/隔离评测）：硬过滤 → 字面相关性准入 → 加权 → 阈值 → Top-K。 */
function retrieveContent(
  input: ExternalKnowledgeRetrievalInput,
  report: ExternalKnowledgeReport,
  normalizedQuery: string,
): ExternalKnowledgeSelection {
  const pool = input.slices.filter((slice) => {
    const passed = passesHardFilter(slice, normalizedQuery, report.sceneType);
    if (!passed) report.droppedByHardFilterIds.push(slice.id);
    return passed;
  });
  report.afterHardFilter = pool.length;
  const queryVector = bigramCounts(normalizedQuery);
  const scored = pool
    .map((slice) => {
      const literalScore = cosine(queryVector, bigramCounts(sliceSearchText(slice)));
      const sceneCompatible = report.sceneType !== null && slice.scene_type === report.sceneType;
      const eligible = literalScore >= report.contentMinScore || sceneCompatible;
      const boostScore = emotionBoost(slice.emotion_target, report.emotionTargets)
        + phaseBoost(slice.chapter_phase, report.chapterPhase);
      return { slice, literalScore, boostScore, eligible, score: literalScore + boostScore };
    })
    .sort((a, b) => (b.score - a.score) || a.slice.id.localeCompare(b.slice.id));
  report.scoredCount = scored.length;
  const selected = scored
    .filter((entry) => entry.eligible && entry.score >= report.minScore)
    .slice(0, report.topK);
  if (selected.length > 0) report.selectionMode = "content";
  const selectedIds = new Set(selected.map((entry) => entry.slice.id));
  for (const entry of scored) {
    if (selectedIds.has(entry.slice.id)) continue;
    if (entry.eligible) report.droppedIds.push(entry.slice.id);
    else report.droppedByRelevanceIds.push(entry.slice.id);
  }
  const items: ExternalKnowledgeDeliveredItem[] = selected.map((entry) => ({
    id: entry.slice.id,
    content: renderSliceAdvisory(entry.slice),
    sourceRef: `${EXTERNAL_KB_RELATIVE_PATH}#${entry.slice.id}`,
    score: Number(entry.score.toFixed(4)),
    literalScore: Number(entry.literalScore.toFixed(4)),
    structuredScore: 0,
    boostScore: Number(entry.boostScore.toFixed(4)),
    structuredHits: 0,
    matchedDimensions: [],
  }));
  report.deliveredIds = items.map((item) => item.id);
  return { items, report };
}

/**
 * 检索入口。
 * - 传了 `retrievalKey`（含 null）→ 结构化模式：空 key、无准入候选一律返回空；
 * - 完全不传 `retrievalKey` → content 模式（历史字面算法，仅隔离评测/兼容用）。
 * 同分按 id 升序，保证确定性。
 */
export function retrieveExternalDistilledSlices(
  input: ExternalKnowledgeRetrievalInput,
): ExternalKnowledgeSelection {
  const minScore = input.minScore ?? EXTERNAL_KB_DEFAULT_MIN_SCORE;
  const contentMinScore = input.contentMinScore ?? EXTERNAL_KB_CONTENT_MIN_SCORE;
  const report = makeReportBase(input, minScore, contentMinScore);
  const normalizedQuery = normalizeText(input.query ?? "");
  if (!normalizedQuery) {
    report.skippedReason = "empty_query";
    return { items: [], report };
  }
  if (input.retrievalKey !== undefined) {
    // null 视作「无法派生结构化键」：仍执行硬过滤并留痕，然后返回空。
    const key: ExternalRetrievalKey = input.retrievalKey ?? {
      sceneFunction: null,
      beat: null,
      pressureType: null,
      decisionTradeoff: null,
      costType: [],
      stateDelta: [],
      readerEffect: [],
    };
    return retrieveStructured(input, report, key, normalizedQuery);
  }
  return retrieveContent(input, report, normalizedQuery);
}

export interface ExternalKnowledgeSelectionOptions {
  projectRoot: string;
  query: string;
  sceneType?: string | null;
  emotionTargets?: ReadonlyArray<string> | null;
  chapterPhase?: string | null;
  /**
   * 结构化检索键。生产入口必须传 deriveStructuredRetrievalKey(intent) 的结果；
   * 只有隔离评测/历史兼容调用才完全不传（退回 content 字面模式）。
   */
  retrievalKey?: ExternalRetrievalKey | null;
  /** 本次交付上限；生产传 EXTERNAL_KB_PRODUCTION_TOP_K=1。 */
  topK?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * 原文范文实验通道（PINOVEL_EXTERNAL_EXCERPTS），默认 false。
   * 生产入口永不传：仅设置环境变量不会开启原文通道，会被忽略并写一条 warn 运行日志留痕。
   * 只有隔离评测入口可显式传 true。
   */
  allowExcerpts?: boolean;
}

export function isExternalExcerptMode(
  env: NodeJS.ProcessEnv = process.env,
): "good" | "bad" | null {
  const value = env[EXTERNAL_EXCERPTS_ENV_FLAG];
  return value === "good" || value === "bad" ? value : null;
}

/**
 * 实验对照通道用的「可仿写原文范文」：把范文转成与卡片同形的检索条目，
 * 使 B/C 臂与 D 臂共享同一检索/预算/注入路径（≤3 条 × ≤520 字），只差在内容形态。
 */
function loadExternalExcerpts(
  projectRoot: string,
  quality: "good" | "bad",
): ExternalKnowledgeLoadResult {
  const path = join(projectRoot, EXTERNAL_EXCERPT_PATHS[quality]);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) {
      return { ok: false, slices: [], path, error: "excerpts_root_not_array" };
    }
    const slices: ExternalDistilledSlice[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!id || !text) continue;
      slices.push({
        id: `excerpt-${id}`,
        scene_type: "rule_dungeon",
        rule: text,
        source: asString(record.source),
      });
    }
    return { ok: true, slices, path, error: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, slices: [], path, error: message };
  }
}

/**
 * 统一入口：开关关闭 → 返回 null（不读文件、零副作用）；
 * 开关打开但读取失败 → 返回带 degradedReason 的空选集，由调用方写入 trace。
 * 原文范文通道只在 `allowExcerpts === true` 时生效（隔离评测专用）；
 * 生产入口永不传该选项，因此仅设置 PINOVEL_EXTERNAL_EXCERPTS 不会开启原文通道，
 * 会写一条 warn 运行日志留痕后按普通卡片通道处理（卡片开关也关则返回 null）。
 */
export function buildExternalKnowledgeSelection(
  options: ExternalKnowledgeSelectionOptions,
): ExternalKnowledgeSelection | null {
  const env = options.env ?? process.env;
  const excerptRequested = isExternalExcerptMode(env);
  const slicesEnabled = isExternalKnowledgeEnabled(env);
  const excerptAllowed = options.allowExcerpts === true;
  if (excerptRequested && !excerptAllowed) {
    // 误配置只留痕，不阻断生成；生产不读取原文数据集，也不产出 excerpts_* 条目。
    logHarnessEvent("warn", "external_excerpts_ignored", {
      stage: "external_knowledge_base",
      severity: "warning",
      reason:
        "原文范文通道仅限隔离评测（allowExcerpts=true）；生产入口忽略 PINOVEL_EXTERNAL_EXCERPTS。",
      excerptMode: excerptRequested,
    });
  }
  const excerptQuality = excerptAllowed ? excerptRequested : null;
  if (!excerptQuality && !slicesEnabled) return null;
  const mode: ExternalKnowledgeReport["mode"] = excerptQuality
    ? excerptQuality === "good" ? "excerpts_good" : "excerpts_bad"
    : "slices";
  const loaded = excerptQuality
    ? loadExternalExcerpts(options.projectRoot, excerptQuality)
    : loadExternalDistilledSlices(options.projectRoot);
  if (!loaded.ok) {
    return {
      items: [],
      report: {
        enabled: true,
        mode,
        sourcePath: loaded.path,
        poolSize: 0,
        afterHardFilter: 0,
        scoredCount: 0,
        deliveredIds: [],
        droppedIds: [],
        droppedByHardFilterIds: [],
        droppedByRelevanceIds: [],
        droppedByStructuredAdmissionIds: [],
        selectionMode: "none",
        retrievalKey: options.retrievalKey ?? null,
        structuredHitsById: {},
        marginGap: null,
        minScore: EXTERNAL_KB_DEFAULT_MIN_SCORE,
        contentMinScore: EXTERNAL_KB_CONTENT_MIN_SCORE,
        sceneType: options.sceneType ?? null,
        topK: options.topK ?? EXTERNAL_KB_TOP_K,
        queryPreview: normalizeText(options.query ?? "").slice(0, 80),
        emotionTargets: splitEmotions(options.emotionTargets),
        chapterPhase: options.chapterPhase ?? null,
        skippedReason: null,
        degradedReason: loaded.error ?? "load_failed",
      },
    };
  }
  if (excerptQuality) {
    // 实验对照臂专用：范文按文件顺序确定性注入前 topK 条，不做相关性阈值。
    // 原因：范文是整段可仿写原文，与「作者契约关键词串」的字面余弦实测 ≈0.0002，
    // 沿用生产阈值会让两条对照臂 100% 零注入、退化成无外挂基线，实验失效。
    // 该分支只为验证「范文是否伤害自然度」，实验结束随通道一并删除。
    const picked = loaded.slices.slice(0, EXTERNAL_KB_TOP_K);
    const dropped = loaded.slices.slice(EXTERNAL_KB_TOP_K);
    return {
      items: picked.map((slice) => ({
        id: slice.id,
        content: slice.rule,
        sourceRef: slice.source ?? `external-excerpt:${slice.id}`,
        score: 0,
        literalScore: 0,
        structuredScore: 0,
        boostScore: 0,
        structuredHits: 0,
        matchedDimensions: [],
      })),
      report: {
        enabled: true,
        mode,
        sourcePath: loaded.path,
        poolSize: loaded.slices.length,
        afterHardFilter: loaded.slices.length,
        scoredCount: loaded.slices.length,
        deliveredIds: picked.map((slice) => slice.id),
        droppedIds: dropped.map((slice) => slice.id),
        droppedByHardFilterIds: [],
        droppedByRelevanceIds: [],
        droppedByStructuredAdmissionIds: [],
        selectionMode: "content",
        retrievalKey: null,
        structuredHitsById: {},
        marginGap: null,
        // 0 表示本臂未启用相关性阈值（与生产卡片通道的 0.08 区分）。
        minScore: 0,
        contentMinScore: 0,
        sceneType: null,
        topK: EXTERNAL_KB_TOP_K,
        queryPreview: normalizeText(options.query ?? "").slice(0, 80),
        emotionTargets: splitEmotions(options.emotionTargets),
        chapterPhase: options.chapterPhase ?? null,
        skippedReason: null,
        degradedReason: null,
      },
    };
  }
  // 生产/普通通道：是否走结构化由「是否传 retrievalKey」决定，不读环境变量。
  const selection = retrieveExternalDistilledSlices({
    slices: loaded.slices,
    query: options.query,
    sceneType: options.sceneType ?? null,
    emotionTargets: options.emotionTargets ?? null,
    chapterPhase: options.chapterPhase ?? null,
    ...(options.retrievalKey !== undefined ? { retrievalKey: options.retrievalKey } : {}),
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
  });
  return {
    items: selection.items,
    report: { ...selection.report, mode, sourcePath: loaded.path },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is string => Boolean(entry));
  return out.length > 0 ? out : undefined;
}
