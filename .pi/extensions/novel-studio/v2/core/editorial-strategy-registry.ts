/**
 * EditorialStrategyRegistry — 编辑策略注册表（Phase 3，计划 §Phase 3）
 *
 * 把"编辑机会类型 → 具体可执行的编辑策略"显式化。
 *
 * 设计原则（计划 §Phase 3 + §4.4）：
 * - 每个策略有稳定 strategyId，供候选生成、裁判与 Phase 6 在线学习引用
 * - 每个策略绑定一个 opportunityType（EditorialOpportunityType），不跨类型复用
 * - 策略携带 promptGuidance（编辑型措辞，无机械指标）与 inviolableGuard
 *   （候选生成时注入，确保候选不改变不可侵犯事实）
 * - 策略是"方向 + 切入角度"，不是"必须逐条覆盖的清单"
 * - 策略本身不含胜负判定；胜负由 Phase 4 LLM pairwise judge 决定
 *
 * 与旧 EditorialPlan.variantStrategies 的区别：
 * - 旧 variantStrategies 是固定 4-5 个策略，无论 raw 是否有编辑机会都全部生成
 * - 新 registry 是"按需查询"：只有 EditorialOpportunityJudge 识别出机会后，
 *   才从 registry 取对应策略生成 0-2 个候选
 */

import type { EditorialOpportunityType, EditorialHypothesis } from "./editorial-hypothesis.js";

// ============================================================================
// 策略定义
// ============================================================================

export interface EditorialStrategyDef {
  /** 稳定策略 id，供候选 editorialStrategy 字段与 Phase 6 学习引用 */
  strategyId: string;
  /** 该策略可处理的编辑机会类型 */
  opportunityType: EditorialOpportunityType;
  /** 编辑焦点（编辑型描述，非控制清单） */
  focus: string;
  /** 切入角度提示 */
  angle: string;
  /** 注入候选 prompt 的写作指导（编辑型，无机械指标词） */
  promptGuidance: string;
  /** 候选生成时注入的不可侵犯事实守卫（来自 ChapterIntent.inviolableFacts 的运行时补充） */
  inviolableGuardNote: string;
}

// ============================================================================
// 默认策略集（一个 opportunityType 一个策略，保持聚焦）
// ============================================================================

const DEFAULT_STRATEGIES: EditorialStrategyDef[] = [
  {
    strategyId: "reader_payoff_strengthen",
    opportunityType: "reader_payoff",
    focus: "把 raw 中被轻描淡写的承诺兑现做成有重量的落点",
    angle: "找到承诺被提及但未给代价/反应的位置，补上读者等待的情绪落点",
    promptGuidance:
      "本章 raw 已提到某个读者在等待的承诺/兑现，但落点过轻。请在重写时让这个兑现带上可见的代价或情绪反应，让读者感到'等到了'。",
    inviolableGuardNote: "不得改变已兑现承诺的事实结果，只可强化其呈现重量",
  },
  {
    strategyId: "character_agency_focus",
    opportunityType: "character_choice",
    focus: "让主角在关键节点做有重量、带不可逆后果的主动选择",
    angle: "把被动的感知/反应改写为主角的决策序列，行动带后果",
    promptGuidance:
      "本章 raw 中主角的主动行动偏稀疏，存在用感知/反应替代选择的段落。请在重写时让主角做出一个带不可逆后果的主动选择，而非被动响应。",
    inviolableGuardNote: "不得改变主角已确立的核心动机与世界事实",
  },
  {
    strategyId: "relationship_progress_focus",
    opportunityType: "relationship_progress",
    focus: "用一个具体场景推进人物关系的质变",
    angle: "把关系状态陈述改写为带冲突或让步的具体互动",
    promptGuidance:
      "本章 raw 中某段人物关系只是状态陈述，缺少质变互动。请在重写时用一个具体场景（冲突、让步或共识）推进这段关系，而非仅描述关系现状。",
    inviolableGuardNote: "不得改变已确立的关系基线与人物身份",
  },
  {
    strategyId: "information_dramatization_focus",
    opportunityType: "information_dramatization",
    focus: "把信息倾泻段落戏剧化为带张力的场景",
    angle: "把大段说明拆进人物反应、提问与冲突中释放",
    promptGuidance:
      "本章 raw 存在大段信息倾泻（说明性段落堆砌）。请在重写时把这些信息拆进人物反应、提问与冲突中释放，避免一段纯说明压住节奏。",
    inviolableGuardNote: "不得改变信息本身的事实内容，只可改变其释放方式",
  },
  {
    strategyId: "promise_advancement_focus",
    opportunityType: "promise_advancement",
    focus: "推进一个停滞过久的开放伏笔/弧线",
    angle: "让停滞的伏笔在本章产生可感知的进展，不必兑现",
    promptGuidance:
      "本章 raw 未推进某个已停滞较久的开放伏笔/弧线。请在重写时让这个伏笔产生可感知的进展（哪怕只是抛出新线索），不必在本章兑现。",
    inviolableGuardNote: "不得关闭尚未到兑现时点的伏笔，不得伪造伏笔结果",
  },
  {
    strategyId: "ensemble_function_focus",
    opportunityType: "ensemble_function",
    focus: "让次要角色承担一个有锚点的叙事功能",
    angle: "把群像背景化处理改写为某个次要角色的功能性反应",
    promptGuidance:
      "本章 raw 中次要角色功能扁平、缺少锚点。请在重写时让某个次要角色承担一个明确的叙事功能（质疑、泄密、阻拦、见证等），并给其一个可识别的反应锚点。",
    inviolableGuardNote: "不得新增未在角色档案中建立的角色",
  },
  {
    strategyId: "chapter_end_pressure_focus",
    opportunityType: "chapter_end_pressure",
    focus: "把章末弱钩子改写为有牵引力的新问题或压力",
    angle: "在结尾抛回一个读者会追问的问题或施加新压力",
    promptGuidance:
      "本章 raw 的章末钩子偏弱（末段缺少牵引力）。请在重写结尾时抛回一个读者会追问的问题或施加一个新压力，避免平淡收尾。",
    inviolableGuardNote: "不得在本章兑现尚未到时点的承诺，不得伪造下一章不存在的事实",
  },
  {
    strategyId: "voice_and_naturalness_focus",
    opportunityType: "voice_and_naturalness",
    focus: "清除 AI 腔与感知侵蚀，让语言回到母语自然",
    angle: "把翻译腔/感知替代词改写为具体动作与感官细节",
    promptGuidance:
      "本章 raw 存在 AI 腔特征词或感知侵蚀词（用感知替代主角主动行动）。请在重写时把这些词改写为具体动作与感官细节，让中文回到母语自然。",
    inviolableGuardNote: "不得改变事实内容，只可改变语言呈现",
  },
];

// ============================================================================
// EditorialStrategyRegistry
// ============================================================================

export class EditorialStrategyRegistry {
  private strategies: Map<string, EditorialStrategyDef> = new Map();
  private byOpportunity: Map<EditorialOpportunityType, EditorialStrategyDef[]> = new Map();

  constructor(strategies: EditorialStrategyDef[] = DEFAULT_STRATEGIES) {
    for (const s of strategies) {
      this.register(s);
    }
  }

  register(strategy: EditorialStrategyDef): void {
    this.strategies.set(strategy.strategyId, strategy);
    const list = this.byOpportunity.get(strategy.opportunityType) ?? [];
    list.push(strategy);
    this.byOpportunity.set(strategy.opportunityType, list);
  }

  getStrategy(strategyId: string): EditorialStrategyDef | undefined {
    return this.strategies.get(strategyId);
  }

  listStrategies(): EditorialStrategyDef[] {
    return Array.from(this.strategies.values());
  }

  strategiesForOpportunity(opportunityType: EditorialOpportunityType): EditorialStrategyDef[] {
    return this.byOpportunity.get(opportunityType) ?? [];
  }

  /**
   * 为 hypothesis 选取首选策略。
   *
   * 选取规则：取该 opportunityType 下注册的第一个策略。
   * 若无对应策略，返回 null（调用方应跳过该 hypothesis）。
   *
   * 单策略映射保持"一个候选一个主假设"的聚焦原则；Phase 6 在线学习
   * 可在策略层引入变体，但 Phase 3 保持一对一。
   */
  pickStrategyForHypothesis(h: EditorialHypothesis): EditorialStrategyDef | null {
    const list = this.strategiesForOpportunity(h.opportunityType);
    return list.length > 0 ? list[0] : null;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createEditorialStrategyRegistry(): EditorialStrategyRegistry {
  return new EditorialStrategyRegistry();
}
