/**
 * AuthorStyleStrategyRegistry — 作者风格优化策略注册表（Phase 4B，计划 §4B）
 *
 * 定义作者风格优化阶段的可调策略 arm，供 ContextualStrategySelector Thompson Sampling
 * 选择 0-2 个策略，注入到 AuthorStyleOptimizer.optimize() 调用中。
 *
 * 与 editorial-strategy-registry.ts 的区别：
 * - EditorialStrategyRegistry：editorial 候选生成阶段（Phase 4 judge），策略是"为什么产 editorial 候选"
 * - AuthorStyleStrategyRegistry：作者风格优化阶段（Phase 3 stage3），策略是"如何调整风格优化参数"
 *
 * 设计原则（计划 §4B & project_memory 约束）：
 * - 策略信誉按 modelVersion 隔离（旧模型经验不限制新模型能力）
 * - 0-2 个策略：不固定多候选；采样值低于阈值的不选（保留探索，但不强凑数）
 * - 用户修改少 = 正收益（win）；用户修改多 = 负收益（loss）
 * - 生产 agentic_style 流不再跳过 strategy outcome 记录
 * - 不直接修改系统 prompt、作品宪法核心字段、硬门禁和世界事实
 *
 * 初始策略 arm（Phase 4B MVP）：
 * 1. guidance_reduction：缩减风格指导注入比例（让模型更自由发挥）
 * 2. voice_emphasis：在 prompt 中追加人物声音一致性强调块
 * 3. rhythm_adjustment：在 prompt 中追加段落节奏调整提示块
 */

import type { EditorialStrategyDef } from "../core/editorial-strategy-registry.js";
import { createContextualStrategySelector } from "./contextual-strategy-selector.js";
import type { StrategyPolicyStore } from "./strategy-policy-store.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * 作者风格优化策略定义。
 *
 * 与 EditorialStrategyDef 形状兼容（便于复用 ContextualStrategySelector），
 * 但 opportunityType 固定为 "author_style"，且新增 params 字段携带策略参数。
 */
export interface AuthorStyleStrategyDef {
  strategyId: string;
  /** 固定为 "author_style"（与 editorial 候选策略区分） */
  opportunityType: "author_style";
  /** 策略标签（用于 trace 审计） */
  label: string;
  /** 策略目标说明（用于 trace 审计，不进入 prompt） */
  objective: string;
  /** 策略参数（由 optimizer 消费） */
  params: AuthorStyleStrategyParams;
  /**
   * 是否仅收集证据不参与在线采样（candidateOnly=true 时）。
   * 新策略默认 candidateOnly=true，等离线证据达标后才准入 active。
   */
  candidateOnly?: boolean;
}

/** 策略参数（由 optimizer 消费） */
export interface AuthorStyleStrategyParams {
  /**
   * 风格指导缩减比例（0-1）。
   * - undefined：不缩减（默认行为，使用完整指导）
   * - 0.6：只保留 60% 指导（按 MAX_GUIDANCE_ITEMS 上限再砍）
   * - 0.3：只保留 30% 指导（更激进的缩减）
   *
   * 与 AuthorStyleOptimizationInput.reducedGuidanceRatio 对齐。
   */
  reducedGuidanceRatio?: number;

  /**
   * 人物声音强调块（追加到 prompt，非替换）。
   * 若提供，optimizer 在 prompt 中追加此块。
   */
  voiceEmphasisBlock?: string;

  /**
   * 段落节奏调整块（追加到 prompt，非替换）。
   * 若提供，optimizer 在 prompt 中追加此块。
   */
  rhythmAdjustmentBlock?: string;
}

/** 选中的策略集合（传给 optimizer） */
export interface AuthorStyleStrategySelection {
  /** 选中的策略定义（0-2 个） */
  selected: AuthorStyleStrategyDef[];
  /** 未准入策略：不采样，但记录在 trace 中（供审计） */
  staticFallback: AuthorStyleStrategyDef[];
  /** 采样详情（每个策略的 alpha/beta/sampled/selected） */
  samples: Array<{
    strategyId: string;
    alpha: number;
    beta: number;
    sampled: number;
    status: string;
    selected: boolean;
  }>;
  /** 未选原因（供可解释性） */
  notes: string[];
  /**
   * USER-FEEDBACK-EVIDENCE-PIPELINE-1：实际暴露快照。
   * 供 orchestrator/trace/反馈归因使用；不是全部采样结果。
   */
  exposureSnapshot: {
    strategyIds: string[];
    strategyBundleId: string;
    selectedCount: number;
  };
}

// ============================================================================
// 默认策略 arm（Phase 4B MVP）
// ============================================================================

/**
 * 默认作者风格优化策略集。
 *
 * 所有策略初始 status 由 StrategyPolicyStore 决定（首次 getReputation 返回 candidate）。
 * candidate 策略不参与在线采样，但通过 staticFallback 保留路径，便于离线评估准入。
 *
 * 新策略的 alpha/beta 由 StrategyPolicyStore 的弱先验 Beta(1,1) 起步。
 */
export const DEFAULT_AUTHOR_STYLE_STRATEGIES: AuthorStyleStrategyDef[] = [
  {
    strategyId: "guidance_reduction",
    opportunityType: "author_style",
    label: "缩减风格指导",
    objective:
      "缩减风格指导注入比例，让模型在风格档案约束下有更多自由发挥空间。假设：过载的风格指导可能压制模型自然语感。",
    params: {
      // 缩减到 60%（保留主体指导，砍掉尾部细节）
      reducedGuidanceRatio: 0.6,
    },
  },
  {
    strategyId: "voice_emphasis",
    opportunityType: "author_style",
    label: "人物声音强调",
    objective:
      "在 prompt 中追加人物声音一致性强调块，强化角色语气、用词习惯、口头禅的延续。假设：显式声音强调改善角色辨识度。",
    params: {
      voiceEmphasisBlock:
        "【人物声音一致性】请确保本章各角色的对白与叙述视角符合其既定语气、用词习惯与口头禅。角色的语气变化应反映其当前情绪与处境，但核心语言习惯保持延续。",
    },
  },
  {
    strategyId: "rhythm_adjustment",
    opportunityType: "author_style",
    label: "段落节奏调整",
    objective:
      "在 prompt 中追加段落节奏调整提示块，引导模型避免机械等长段落。假设：节奏提示改善阅读节拍。",
    params: {
      rhythmAdjustmentBlock:
        "【段落节奏】请避免段落机械等长。战斗/冲突场景可用短促段落加快节奏；铺垫/沉思场景可用较长段落承载细节。段落长度应服务于叙事节奏，而非固定配额。",
    },
  },
];

// ============================================================================
// 策略选择（复用 ContextualStrategySelector）
// ============================================================================

/**
 * 把 AuthorStyleStrategyDef 转换为 EditorialStrategyDef 形状，
 * 以便复用 ContextualStrategySelector（其接口设计为 EditorialStrategyDef）。
 *
 * 保留 strategyId / opportunityType，丢弃 params（由本模块在选中后重新映射回来）。
 */
function toEditorialShape(def: AuthorStyleStrategyDef): EditorialStrategyDef {
  return {
    strategyId: def.strategyId,
    // 用 "reader_payoff" 作为占位 opportunityType（ContextualStrategySelector
    // 不依赖此字段；它只看 strategyId 和 reputation）
    opportunityType: "reader_payoff" as any,
    label: def.label,
    objective: def.objective,
    ...(def.candidateOnly === true ? { candidateOnly: true as const } : {}),
  };
}

/**
 * 选择作者风格优化策略。
 *
 * 复用 ContextualStrategySelector 进行 Thompson Sampling。
 * 选择逻辑：
 * 1. 把 AuthorStyleStrategyDef 列表转换为 EditorialStrategyDef 形状
 * 2. 调用 ContextualStrategySelector.select
 * 3. 把选中的 strategyId 映射回 AuthorStyleStrategyDef
 *
 * @param candidates 候选策略集（默认 DEFAULT_AUTHOR_STYLE_STRATEGIES）
 * @param modelVersion 当前模型版本键
 * @param policyStore 策略信誉存储
 * @param seed 随机种子（可复现）
 */
export function selectAuthorStyleStrategies(input: {
  candidates?: AuthorStyleStrategyDef[];
  modelVersion: string;
  policyStore: StrategyPolicyStore;
  seed?: number;
}): AuthorStyleStrategySelection {
  const {
    candidates = DEFAULT_AUTHOR_STYLE_STRATEGIES,
    modelVersion,
    policyStore,
    seed,
  } = input;

  // 复用 ContextualStrategySelector
  const selector = createContextualStrategySelector();

  const editorialShaped = candidates.map(toEditorialShape);
  const selection = selector.select({
    candidates: editorialShaped,
    modelVersion,
    policyStore,
    seed,
  });

  // 把选中的 strategyId 映射回 AuthorStyleStrategyDef
  const selectedIds = new Set(selection.selected.map((s) => s.strategyId));
  const selectedAuthorStyle = candidates.filter((c) => selectedIds.has(c.strategyId));
  const staticFallbackIds = new Set(selection.staticFallback.map((s) => s.strategyId));
  const staticFallbackAuthorStyle = candidates.filter((c) => staticFallbackIds.has(c.strategyId));

  return {
    selected: selectedAuthorStyle,
    staticFallback: staticFallbackAuthorStyle,
    samples: selection.samples,
    notes: selection.notes,
    exposureSnapshot: selection.exposureSnapshot,
  };
}

// ============================================================================
// 策略参数合并
// ============================================================================

/**
 * 把选中的策略参数合并为一个 AuthorStyleStrategyParams 对象。
 *
 * 合并规则：
 * - reducedGuidanceRatio：取所有选中策略中的最小值（更激进的缩减胜出）
 * - voiceEmphasisBlock：拼接所有选中策略的块（用换行分隔）
 * - rhythmAdjustmentBlock：拼接所有选中策略的块（用换行分隔）
 *
 * 若选中 0 个策略，返回空对象（optimizer 使用默认行为）。
 */
export function mergeStrategyParams(
  selected: AuthorStyleStrategyDef[],
): AuthorStyleStrategyParams {
  const result: AuthorStyleStrategyParams = {};

  const ratios = selected
    .map((s) => s.params.reducedGuidanceRatio)
    .filter((r): r is number => typeof r === "number");
  if (ratios.length > 0) {
    result.reducedGuidanceRatio = Math.min(...ratios);
  }

  const voiceBlocks = selected
    .map((s) => s.params.voiceEmphasisBlock)
    .filter((b): b is string => typeof b === "string" && b.length > 0);
  if (voiceBlocks.length > 0) {
    result.voiceEmphasisBlock = voiceBlocks.join("\n\n");
  }

  const rhythmBlocks = selected
    .map((s) => s.params.rhythmAdjustmentBlock)
    .filter((b): b is string => typeof b === "string" && b.length > 0);
  if (rhythmBlocks.length > 0) {
    result.rhythmAdjustmentBlock = rhythmBlocks.join("\n\n");
  }

  return result;
}

// ============================================================================
// 策略上下文（用于 outcome 记录）
// ============================================================================

/**
 * 构造策略上下文（用于 OutcomeRecorder / UserFeedbackIngestor）。
 *
 * 当用户提交反馈时，调用方使用此上下文定位 strategyId + modelVersion。
 * 一个章节生成可能选中 0-2 个策略；每个策略独立记录 outcome。
 */
export interface AuthorStyleStrategyContext {
  sourceChapter: string;
  modelVersion: string;
  /** 选中的策略 id 列表（0-2 个） */
  strategyIds: string[];
  /** 编辑机会类型固定为 "author_style" */
  opportunityType: "author_style";
}

export function buildAuthorStyleStrategyContext(input: {
  sourceChapter: string;
  modelVersion: string;
  selected: AuthorStyleStrategyDef[];
}): AuthorStyleStrategyContext {
  return {
    sourceChapter: input.sourceChapter,
    modelVersion: input.modelVersion,
    strategyIds: input.selected.map((s) => s.strategyId),
    opportunityType: "author_style",
  };
}
