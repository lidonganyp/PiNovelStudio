/**
 * PiNovelStudio — 类型档案共享类型与归一化工具（中性层）。
 *
 * 迁移自 agents/type-router.ts（CRAFT-AGENT-DEPENDENCY-UNTANGLE-1）：
 * 这些类型与 normalizeNovelType/normalizeTypeMode 是纯数据定义，被 craft 层
 * （type-profile-manager、anti-ai-detector、emotion-metronome 等）与 agents 层
 * （type-router、narrator、world-presenter）共用。放在 agents/ 会导致 craft 模块
 * 反向依赖 agents/。本中性层让 craft 层直接引用，agents/type-router 改为 re-export
 * 以保持对现有导入者的向后兼容。
 *
 * 规则 #516-#520、#547-#555
 */

/** 网文类型枚举 */
export type NovelType = "power_fantasy" | "mystery" | "romance" | "xianxia";

/** 复合类型模式 */
export type TypeMode = "single" | "composite";

const NOVEL_TYPE_ALIAS_MAP: Record<string, NovelType> = {
  power_fantasy: "power_fantasy",
  powerfantasy: "power_fantasy",
  urban_power: "power_fantasy",
  face_slapping: "power_fantasy",
  mystery: "mystery",
  suspense: "mystery",
  suspense_horror: "mystery",
  horror: "mystery",
  thriller: "mystery",
  supernatural: "mystery",
  urban_supernatural: "mystery",
  weird: "mystery",
  romance: "romance",
  romantic: "romance",
  love_story: "romance",
  xianxia: "xianxia",
  fantasy_cultivation: "xianxia",
  cultivation: "xianxia",
};

export function normalizeNovelType(value: unknown): NovelType | null {
  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  const direct = NOVEL_TYPE_ALIAS_MAP[lower];
  if (direct) {
    return direct;
  }

  if (
    lower.includes("suspense") ||
    lower.includes("horror") ||
    lower.includes("thriller") ||
    lower.includes("supernatural") ||
    lower.includes("mystery") ||
    raw.includes("悬疑") ||
    raw.includes("灵异") ||
    raw.includes("恐怖") ||
    raw.includes("惊悚") ||
    raw.includes("诡异") ||
    raw.includes("推理") ||
    raw.includes("探案")
  ) {
    return "mystery";
  }

  if (
    lower.includes("romance") ||
    lower.includes("love") ||
    raw.includes("言情") ||
    raw.includes("甜文") ||
    raw.includes("恋爱")
  ) {
    return "romance";
  }

  if (
    lower.includes("xianxia") ||
    lower.includes("cultivation") ||
    raw.includes("玄幻") ||
    raw.includes("修仙") ||
    raw.includes("仙侠")
  ) {
    return "xianxia";
  }

  if (
    lower.includes("power") ||
    lower.includes("urban") ||
    raw.includes("爽文") ||
    raw.includes("都市") ||
    raw.includes("战神")
  ) {
    return "power_fantasy";
  }

  return null;
}

export function normalizeTypeMode(value: unknown, secondaryType: NovelType | null): TypeMode {
  if (!secondaryType || typeof value !== "string") {
    return "single";
  }

  const lower = value.trim().toLowerCase();
  return ["composite", "hybrid", "mixed", "blend", "dual"].includes(lower)
    ? "composite"
    : "single";
}

/** 类型推断来源 */
export type InferenceSource = "config_declaration" | "content_inference" | "drift_detection" | "human_override";

/** 漂移状态 */
export type DriftStatus = "stable" | "drifting" | "rebalancing";

/** 情绪曲线模板类型 */
export type EmotionCurveTemplate = "sawtooth_rising" | "undercurrent" | "wave_advance" | "staircase";

/** 钩子模板类型 */
export interface HookTemplate {
  id: string;
  name: string;
  description: string;
  triggerPosition: string;
}

/** 类型元数据 */
export interface TypeProfileMetadata {
  schema_version: string;
  primary_type: NovelType;
  secondary_type: NovelType | null;
  type_mode: TypeMode;
  confidence: number;
  inference_source: InferenceSource[];
  human_override: boolean;
  drift_status: DriftStatus;
  created_at: string;
  updated_at: string;
  workspace_id: string;
}

/** 单个 Agent 的类型化参数 */
export interface AgentTypeParams {
  dialogue_ratio?: number;
  action_density?: string;
  sentence_length?: number;
  hook_frequency?: string;
  emotion_baseline?: number;
  /**
   * P42 语义澄清：anti_ai_threshold 用于收紧 Stage 8 AntiAI 密度门槛或调整检测权重，
   * 不能放宽 2% 硬上限（classifyAntiAIQualityGate 用 Math.min(profileThreshold, 0.02)）。
   * 取值 < 0.02 会收紧；>= 0.02 被 0.02 硬上限覆盖，仅影响检测/提示策略。
   * 原"悬疑可放宽阈值"的语义已废止。
   */
  anti_ai_threshold?: number;
  detail_tracking?: string;
  setting_weight?: number;
  emotional_weight?: number;
  world_presentation_density?: number;
  adjective_density?: number;
  ensemble_scene_frequency?: string;
  stagnation_trigger?: number;
  climax_standard?: string;
  word_count_range?: [number, number];
  /** 其他自定义参数 */
  [key: string]: unknown;
}

/** Agent 参数集（按 Agent 名称索引） */
export interface AgentParamsMap {
  Narrator?: AgentTypeParams;
  HookScorer?: AgentTypeParams;
  EmotionMetronome?: AgentTypeParams;
  AntiAIDetector?: AgentTypeParams;
  REM?: AgentTypeParams;
  Critic?: AgentTypeParams;
  WorldPresenter?: AgentTypeParams;
  StyleShaper?: AgentTypeParams;
  EnsembleDirector?: AgentTypeParams;
  DetailLedger?: AgentTypeParams;
  MidChapterChecker?: AgentTypeParams;
  ClosureEvaluator?: AgentTypeParams;
  PacingController?: AgentTypeParams;
}

/** 类型配置档案完整结构 */
export interface TypeProfile {
  metadata: TypeProfileMetadata;
  agent_params: AgentParamsMap;
  hook_template_library: Record<NovelType, HookTemplate[]>;
  emotion_curve_templates: Record<EmotionCurveTemplate, {
    description: string;
    parameters: {
      baseline: number;
      peak: number;
      trough: number;
      cycle_length: number;
    };
  }>;

  /**
   * 规则 #541/#542：复合类型混合参数结构
   * - 场景分离 > 参数插值
   */
  merged_params?: {
    primary_weight: number;
    secondary_weight: number;
    scene_split?: Record<string, {
      primary_type: NovelType;
      secondary_type: NovelType;
      mode: "scene_split" | "blend";
      primary_weight?: number;
      secondary_weight?: number;
      description?: string;
    }>;
  };

  /** 预留扩展字段 */
  extensibility?: {
    custom_type_support?: boolean;
    plugin_params?: Record<string, unknown>;
  };
}
