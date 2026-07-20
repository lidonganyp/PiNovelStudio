/**
 * V2 CraftJudgmentLibrary — 小说判断资产库（P2）
 *
 * 目标（规格 P2）：把现有项目文档里的小说判断结构化，不丢掉群像、情节、细节标准。
 *
 * 设计原则：
 * - 现有文档判断默认 evidenceLevel="doc_claim"
 * - 只有 replay 正收益后才能升级为 replay_validated（由 P9 ReplayPromotion 处理）
 * - evaluationUse="hard_block" 仅允许事实连续性类判断（本库仅 scene_continuity）
 * - generationUse="scene_contract" 的判断可被 SceneContractPlanner 引用
 * - generationUse="forbidden_damage" 的判断用于声明不可破坏的红线
 *
 * 9 个判断维度（对应规格 P2 的 9 条判断要点）：
 *   群像 / 期待兑现·情节推进 / 信息释放 / 情绪兑现 / 悬念钩子 /
 *   人物主动性 / 对话潜台词 / 场景功能·事实连续性 / 世界观 / 风格自然度
 *
 * 注：类型枚举 CraftDomain 有 10 个值，本库录入 10 条判断（一域一条），
 *     覆盖规格 9 条要点（payoff 域同时覆盖"情节推进"与"期待兑现"两条）。
 */

import type {
  CraftJudgment,
  CraftDomain,
  CraftEvidenceLevel,
  CraftEvaluationUse,
  CraftGenerationUse,
} from "./types.js";

// ============================================================================
// 默认值常量
// ============================================================================

/** 现有文档判断的默认证据等级（规格 P2 要求） */
export const DEFAULT_EVIDENCE_LEVEL: CraftEvidenceLevel = "doc_claim";

/** 唯一允许 hard_block 的 domain（规格 P2：仅事实连续性类） */
export const HARD_BLOCK_DOMAIN: CraftDomain = "scene_continuity";

// ============================================================================
// 10 维度判断资产
// ============================================================================

const JUDGMENT_DEFS: Array<Omit<CraftJudgment, "evidenceLevel">> = [
  {
    id: "judgment:ensemble",
    domain: "ensemble",
    appliesTo: ["ensemble", "rescue", "combat", "dialogue"],
    positiveCriteria: [
      "角色功能分化，每个出场角色有独特视角/能力/立场",
      "反应层次分明，不同角色对同一事件的反应有差异",
      "群体压力推动主角选择，而非主角单方面输出",
      "次要角色有名字/身份锚点，不是匿名背景板",
    ],
    negativeSignals: [
      "众人震惊/众人沉默 等无层次群体反应",
      "角色轮流说话但功能重复",
      "群像场景中只有主角有行动，其余角色纯旁观",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:payoff",
    domain: "payoff",
    appliesTo: ["rescue", "combat", "revelation", "emotion", "dialogue"],
    positiveCriteria: [
      "情节推进体现为可见的状态变化/信息变化/风险变化/关系变化",
      "期待兑现不掺水，读者等待的信息被明确给出",
      "状态变化在节拍结束前落地，不只有氛围渲染",
    ],
    negativeSignals: [
      "假兑现：用模糊代词跳过读者等待的信息",
      "整段只有氛围描写，结束时故事状态毫无变化",
      "承诺的揭示被延后或偷换",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:hook",
    domain: "hook",
    appliesTo: ["cliffhanger", "rescue", "revelation"],
    positiveCriteria: [
      "章末钩子与本章已出现的证据/决策/风险变化有因果关系",
      "钩子用本章前面埋过的事实、动作或风险来引爆",
      "钩子带有信息增量，不是空泛警示",
    ],
    negativeSignals: [
      "结尾只说'危险即将来临'这类空话，没有具体指向",
      "凭空冒出危险，钩子无前文铺垫",
      "钩子是情绪口号而非信息钩子",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:info_release",
    domain: "info_release",
    appliesTo: ["revelation", "dialogue", "transition"],
    positiveCriteria: [
      "设定/信息绑定行动、压力或感知释放",
      "新信息让读者明确感觉到自己比之前知道得更多",
      "信息释放与角色选择/风险变化同步",
    ],
    negativeSignals: [
      "说明书式设定倾倒，脱离行动",
      "大段背景介绍打断即时压力",
      "信息释放无场景载体",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:emotion",
    domain: "emotion",
    appliesTo: ["emotion", "rescue", "dialogue", "cliffhanger"],
    positiveCriteria: [
      "压抑情绪后有释放通道",
      "承诺的情绪在本章或邻近章节落地",
      "情绪曲线与情节压力同步起伏",
    ],
    negativeSignals: [
      "情绪承诺未兑现，压力被忽略",
      "情绪转折缺乏触发事件",
      "情绪渲染与情节脱节",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:character_agency",
    domain: "character_agency",
    appliesTo: ["rescue", "combat", "dialogue", "revelation", "cliffhanger"],
    positiveCriteria: [
      "主角有明确选择，且选择有代价",
      "主角行动包含不可逆动作",
      "选择反映角色立场/性格，不是机械执行",
    ],
    negativeSignals: [
      "主角被动应对，无主动决策",
      "选择无代价，可随意反悔",
      "主角行为与角色档案矛盾",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:scene_continuity",
    domain: "scene_continuity",
    appliesTo: ["rescue", "combat", "dialogue", "revelation", "emotion", "transition", "ensemble", "cliffhanger"],
    positiveCriteria: [
      "每场戏服务读者体验，不是机械过场",
      "空间清楚，动作连续，风险递增",
      "场景切换有过门，不跳转",
    ],
    negativeSignals: [
      "线上角色/论坛角色未经入场铺垫直接实体化",
      "医院/住处等空间簇无过门跳转",
      "机械过场，场景无功能",
    ],
    generationUse: "forbidden_damage",
    evaluationUse: "hard_block",
  },
  {
    id: "judgment:dialogue_subtext",
    domain: "dialogue_subtext",
    appliesTo: ["dialogue", "ensemble", "revelation"],
    positiveCriteria: [
      "对白有试探、隐瞒、让步、改口、关系筹码",
      "对白承载潜台词，不只报信息",
      "对白推进关系或信息差",
    ],
    negativeSignals: [
      "对白只是信息传递工具",
      "对白无人物立场差异",
      "短指令式对白堆砌",
    ],
    generationUse: "scene_contract",
    evaluationUse: "comparator",
  },
  {
    id: "judgment:worldbuilding",
    domain: "worldbuilding",
    appliesTo: ["rescue", "combat", "revelation", "transition"],
    positiveCriteria: [
      "世界观一致，不与 config 不可违背事实冲突",
      "力量体系/规则一致",
      "世界观信息融入场景而非独立说明",
    ],
    negativeSignals: [
      "世界观矛盾",
      "力量体系越界",
      "不可违背事实被破坏",
    ],
    generationUse: "context_hint",
    evaluationUse: "diagnostic",
  },
  {
    id: "judgment:style_naturalness",
    domain: "style_naturalness",
    appliesTo: ["rescue", "combat", "dialogue", "revelation", "emotion", "transition", "ensemble", "cliffhanger"],
    positiveCriteria: [
      "中文自然，不像翻译腔/AI 腔",
      "用词符合类型风格指纹",
      "句式节奏有变化，不机械",
    ],
    negativeSignals: [
      "AI 特征词堆砌",
      "翻译腔长句",
      "风格指纹偏差过大",
    ],
    generationUse: "context_hint",
    evaluationUse: "comparator",
  },
];

// ============================================================================
// CraftJudgmentLibrary 类
// ============================================================================

export class CraftJudgmentLibrary {
  private readonly judgments: Map<string, CraftJudgment>;
  private readonly byDomain: Map<CraftDomain, CraftJudgment[]>;

  constructor(evidenceLevel: CraftEvidenceLevel = DEFAULT_EVIDENCE_LEVEL) {
    this.judgments = new Map();
    this.byDomain = new Map();
    for (const def of JUDGMENT_DEFS) {
      const judgment: CraftJudgment = { ...def, evidenceLevel };
      this.judgments.set(judgment.id, judgment);
      const list = this.byDomain.get(judgment.domain) ?? [];
      list.push(judgment);
      this.byDomain.set(judgment.domain, list);
    }
  }

  /** 全部判断 */
  all(): CraftJudgment[] {
    return Array.from(this.judgments.values());
  }

  /** 按 id 查找 */
  getById(id: string): CraftJudgment | undefined {
    return this.judgments.get(id);
  }

  /** 按 domain 查找 */
  getByDomain(domain: CraftDomain): CraftJudgment[] {
    return this.byDomain.get(domain) ?? [];
  }

  /** 按 evaluationUse 过滤（comparator / diagnostic / hard_block） */
  getByEvaluationUse(use: CraftEvaluationUse): CraftJudgment[] {
    return this.all().filter((j) => j.evaluationUse === use);
  }

  /** 按 generationUse 过滤（scene_contract / context_hint / forbidden_damage） */
  getByGenerationUse(use: CraftGenerationUse): CraftJudgment[] {
    return this.all().filter((j) => j.generationUse === use);
  }

  /** 适用于指定 sceneType 的判断 */
  getApplicableForSceneType(sceneType: string): CraftJudgment[] {
    return this.all().filter((j) => j.appliesTo.includes(sceneType));
  }

  /** hard_block 类判断（仅 scene_continuity） */
  getHardBlockJudgments(): CraftJudgment[] {
    return this.getByEvaluationUse("hard_block");
  }

  /**
   * 升级某条判断的 evidenceLevel（由 P9 ReplayPromotion 调用）
   * - 仅允许 doc_claim → tested → replay_validated 单向升级
   * - 降级忽略
   */
  upgradeEvidenceLevel(id: string, newLevel: CraftEvidenceLevel): boolean {
    const judgment = this.judgments.get(id);
    if (!judgment) return false;
    const order: CraftEvidenceLevel[] = ["doc_claim", "tested", "replay_validated"];
    const currentIdx = order.indexOf(judgment.evidenceLevel);
    const newIdx = order.indexOf(newLevel);
    if (newIdx <= currentIdx) return false; // 不降级
    judgment.evidenceLevel = newLevel;
    return true;
  }

  /** 维度数 */
  size(): number {
    return this.judgments.size;
  }
}

let _defaultLibrary: CraftJudgmentLibrary | null = null;

export function getDefaultCraftJudgmentLibrary(): CraftJudgmentLibrary {
  if (!_defaultLibrary) {
    _defaultLibrary = new CraftJudgmentLibrary();
  }
  return _defaultLibrary;
}

export function createCraftJudgmentLibrary(evidenceLevel?: CraftEvidenceLevel): CraftJudgmentLibrary {
  return new CraftJudgmentLibrary(evidenceLevel);
}
