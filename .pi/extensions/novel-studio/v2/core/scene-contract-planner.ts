/**
 * V2 SceneContractPlanner — 场景契约规划（P3）
 *
 * 目标（规格 P3）：给强模型"大目标和边界"，不是小学生式步骤约束。
 *
 * 设计原则：
 * - 每个事件/场景生成契约
 * - 契约只定义读者体验、事实边界、质量杠杆
 * - 禁止写机械指标（如"对白比例必须 34%"）—— qualityLevers 正则扫描禁数字+比例
 * - 动作/救援类强调空间清楚、动作连续、风险递增、角色选择
 * - 群像类强调角色功能分化和群体压力
 * - 对话类强调潜台词、信息差、关系筹码
 * - 悬疑发现类强调证据新意、误导、信息增量
 * - 契约能引用 CraftJudgmentLibrary 的 judgment id
 *
 * 实现：从 CompiledContext 的 candidateAnchors + intent 派生 SceneContract[]。
 * 每个 SceneContract 的 relevantJudgments 来自 CraftJudgmentLibrary。
 */

import type {
  SceneContract,
  SceneType,
  CompiledContext,
} from "./types.js";
import type {
  ChapterSeed,
  CandidateAnchor,
} from "../../craft/chapter-seed-types.js";
import type { CraftJudgmentLibrary } from "./craft-judgment-library.js";

// ============================================================================
// SceneType 关键词表（用于从 anchor description 推断场景类型）
// ============================================================================

const SCENE_KEYWORDS: Record<SceneType, string[]> = {
  rescue: [
    "救", "水下", "沉", "溺", "窒息", "暗流", "水面炸开", "消失前",
    "险", "拖", "拉扯", "气泡", "闷响", "胸口", "危机", "护送",
  ],
  combat: [
    "战", "斗", "切", "杀", "攻", "异能", "枪", "鳞片", "血",
    "震荡", "低吼", "硝烟", "震动", "击", "妖兽", "鬼物", "阵法",
  ],
  revelation: [
    "发现", "真相", "揭示", "证据", "线索", "明白了", "原来是",
    "破局", "关键", "裂缝", "渗出", "红点", "底下的沟",
  ],
  emotion: [
    "沉默", "关心", "目光", "心痛", "情绪", "眼神", "低声",
    "收紧", "松", "静", "释然", "爽", "悲",
  ],
  ensemble: [
    "众人", "队员", "领队", "群体", "战队", "队友", "黑玫瑰",
    "战狼", "研究员", "陈锋", "赵明远",
  ],
  cliffhanger: [
    "钩子", "未知", "危险来临", "红点", "又近了", "不再是",
    "也许不是", "追的", "三粒",
  ],
  dialogue: [
    "说", "问", "答", "道", "低声", "开口", "对话", "询问",
  ],
  transition: [
    "清晨", "车内", "车窗", "城市灯光", "回到", "离开", "前往", "转场",
  ],
};

// ============================================================================
// SceneType 推断
// ============================================================================

function scoreSceneType(description: string, sceneType: SceneType): number {
  const keywords = SCENE_KEYWORDS[sceneType];
  let score = 0;
  const lower = description.toLowerCase();
  for (const kw of keywords) {
    if (description.includes(kw) || lower.includes(kw.toLowerCase())) {
      score += 1;
    }
  }
  return score;
}

function inferSceneType(anchor: CandidateAnchor): SceneType {
  const desc = anchor.description ?? "";
  let bestType: SceneType = "transition";
  let bestScore = 0;
  for (const st of Object.keys(SCENE_KEYWORDS) as SceneType[]) {
    const score = scoreSceneType(desc, st);
    if (score > bestScore) {
      bestScore = score;
      bestType = st;
    }
  }
  // 情绪/认知 channel 兜底
  if (bestScore === 0) {
    if (anchor.channel === "emotional") return "emotion";
    if (anchor.channel === "cognitive") return "revelation";
    return "transition";
  }
  return bestType;
}

// ============================================================================
// Anchor 聚类：按推断的 sceneType 分组
// ============================================================================

interface AnchorGroup {
  sceneType: SceneType;
  anchors: CandidateAnchor[];
}

function groupAnchorsBySceneType(anchors: CandidateAnchor[]): AnchorGroup[] {
  const groups = new Map<SceneType, CandidateAnchor[]>();
  for (const anchor of anchors) {
    const st = inferSceneType(anchor);
    const list = groups.get(st) ?? [];
    list.push(anchor);
    groups.set(st, list);
  }
  // 按锚点数降序，保留有锚点的组
  return Array.from(groups.entries())
    .map(([sceneType, list]) => ({ sceneType, anchors: list }))
    .sort((a, b) => b.anchors.length - a.anchors.length);
}

// ============================================================================
// 机械指标检测（禁用）—— 分层审计：只 hard block 明确机械指标
// ============================================================================
//
// prompt audit 分层（2026-07-09 第五轮起）：
// 原 pattern 含 `比例.*?\d+\s*%` 和 `必须.*?\d+\s*%` 两个过于宽泛的分支，
// 会误杀含百分比的事实边界约束（如"保留绝大多数主角行动词"这类定性保真指令），
// 导致 scene_contract 候选被误判 control → comparator 不执行。
//
// 分层原则：
//   - 机械指标/对白比例/段落长度 → 仍 hard block（control 型）
//   - 事实边界/行动保真/连续性保真 → 不视为 control
//
// 百分比本身不是机械指标，只有"对白比例必须 XX%"才是。因此去掉宽泛的
// `比例.*?\d+\s*%` / `必须.*?\d+\s*%`，只保留明确机械指标关键词 + 上下文精准匹配。
//
// P44 重构附注：原 rawStage2 派生的行动词保留百分比约束已从 SceneContract 完全剥离
// （amplified 改为编辑意图驱动），但本审计正则的分层精度仍保留，防止任何
// 含百分比/计数的事实约束被误判 control。

const MECHANICAL_METRIC_PATTERN =
  /对白比例|对话比例|段落长度必须|每段.*?\d+\s*字|\d+\s*%\s*对白|字数必须.*?\d+/;

export function containsMechanicalMetric(text: string): boolean {
  return MECHANICAL_METRIC_PATTERN.test(text);
}

// ============================================================================
// 场景契约字段生成模板
// ============================================================================

const SCENE_READER_PAYOFF: Record<SceneType, string[]> = {
  rescue: [
    "空间清楚，读者能跟着角色走完救援路径",
    "动作连续，风险递增，每一步都有代价",
    "主角选择有重量，不可逆",
  ],
  combat: [
    "战斗节奏有起伏，不是流水账",
    "攻防转换有信息差",
    "主角能力边界清晰",
  ],
  revelation: [
    "证据新意，不是读者早就猜到的",
    "有误导与反转空间",
    "信息增量绑定行动",
  ],
  emotion: [
    "情绪有压抑-释放曲线",
    "承诺的情绪落地",
    "情绪转折有触发事件",
  ],
  ensemble: [
    "角色功能分化，群体反应有层次",
    "群体压力推动主角选择",
    "次要角色有锚点，不是背景板",
  ],
  cliffhanger: [
    "钩子有因果，绑定本章证据",
    "钩子有信息增量",
    "钩子具体不空泛",
  ],
  dialogue: [
    "对白有潜台词、试探、隐瞒",
    "信息差推动关系变化",
    "对白承载关系筹码",
  ],
  transition: [
    "转场有过门，不跳转",
    "转场承载信息或情绪变化",
    "转场服务读者体验",
  ],
};

const SCENE_MUST_AVOID: Record<SceneType, string[]> = {
  rescue: [
    "空间跳跃，读者跟不上救援路径",
    "动作断裂，风险不递增",
    "主角选择无代价",
    "机械指标（如对白比例必须 XX%）",
  ],
  combat: [
    "战斗流水账",
    "能力越界",
    "机械指标",
  ],
  revelation: [
    "假兑现，用模糊代词跳过信息",
    "证据无新意",
    "说明书式信息倾倒",
  ],
  emotion: [
    "情绪承诺未兑现",
    "情绪转折无触发",
    "机械指标",
  ],
  ensemble: [
    "众人震惊等无层次群体反应",
    "角色轮流说话但功能重复",
    "机械指标（含对白比例）",
  ],
  cliffhanger: [
    "空泛'危险即将来临'",
    "钩子无前文铺垫",
    "机械指标",
  ],
  dialogue: [
    "对白只报信息",
    "对白无人物立场差异",
    "短指令式对白堆砌",
    "机械对白比例指标",
  ],
  transition: [
    "无过门跳转",
    "转场无功能",
    "机械指标",
  ],
};

// ============================================================================
// 场景类型专属质量杠杆（P5 新增）
// ============================================================================

/**
 * 每种场景类型的专属质量杠杆（editorial 文本，无机械指标）。
 *
 * 替代旧 buildContract 从 applicableJudgments.positiveCriteria 派生的通用逻辑。
 * 旧逻辑对所有场景类型用同一组 judgment.positiveCriteria，无法区分"战斗需要空间连续"
 * 与"群像需要角色功能分化"。P5 按场景类型给出针对性杠杆。
 *
 * 来源：用户 P5 规格的 5 类场景杠杆 + 扩展到全部 8 种 SceneType。
 */
const SCENE_QUALITY_LEVERS: Record<SceneType, string[]> = {
  rescue: [
    "空间连续，读者能跟着走完救援路径，不跳转",
    "动作因果递进，每一步风险源于上一步结果",
    "主角主动选择有代价，不可逆",
  ],
  combat: [
    "空间连续，攻防位置清楚",
    "动作因果，每次交锋改变局面",
    "风险递增，主角能力边界清晰",
  ],
  revelation: [
    "信息在行动中释放，不做说明书式倾倒",
    "证据新意，绑定本章具体细节",
    "主角主动追查，不是被动接收信息",
  ],
  emotion: [
    "情绪由动作承载，不直白解释心理",
    "情绪转折有触发事件，不是无源转折",
    "承诺的情绪在本场落地",
  ],
  ensemble: [
    "角色功能分化，每人有独立动作线",
    "群体反应有层次，不是众人震惊/沉默",
    "次要角色有锚点动作，不当背景板",
  ],
  cliffhanger: [
    "钩子绑定本章具体证据，有信息增量",
    "钩子具体不空泛，不用'危险即将来临'",
    "钩子留情绪余韵或信息悬念",
  ],
  dialogue: [
    "对白有潜台词、试探、隐瞒",
    "信息差推动关系变化",
    "对白承载关系筹码，不只报信息",
  ],
  transition: [
    "场景过门清楚，不跳转",
    "转场承载状态变化或信息推进",
    "转场牵引下一章，有钩子功能",
  ],
};

// ============================================================================
// 场景类型连续性保真重点（P5 新增）
// ============================================================================

/**
 * 每种场景类型必须保留的连续性要素（用于 mustPreserve 强化）。
 *
 * Phase B 根因：amplified 退化来自 perceptionErosion（"觉得/意识到"替代行动）。
 * continuityFocus 让 contract 显式要求保留主角主动行动与空间连续性，
 * 而非靠模糊的 mustPreserve anchor 截取。
 */
const SCENE_CONTINUITY_FOCUS: Record<SceneType, string[]> = {
  rescue: ["救援路径的空间锚点", "主角主动出手/抓住/拖拽的行动词"],
  combat: ["战斗空间位置", "主角攻防动作词", "能力边界证据"],
  revelation: ["证据出现的具体位置", "主角追查的行动词"],
  emotion: ["情绪触发事件", "主角的动作或对白承载情绪"],
  ensemble: ["每个次要角色的锚点动作", "主角在群体中的位置"],
  cliffhanger: ["钩子绑定的本章具体证据", "主角末句行动或发现"],
  dialogue: ["对白双方立场差异", "主角的对白动作"],
  transition: ["过门的空间/时间标记", "主角的状态变化"],
};

// ============================================================================
// SceneContractPlanner 类
// ============================================================================

export interface SceneContractPlanInput {
  context: CompiledContext;
  library: CraftJudgmentLibrary;
  /** 可选：直接传 ChapterSeed（优先使用，避免从 facts 反解） */
  seed?: ChapterSeed;
  /** 可选：覆盖默认 sceneId 前缀 */
  sceneIdPrefix?: string;
}

export interface SceneContractPlanResult {
  contracts: SceneContract[];
  /** 推断过程中是否有 anchor 命中机械指标（用于审计） */
  warnings: string[];
}

export class SceneContractPlanner {
  plan(input: SceneContractPlanInput): SceneContractPlanResult {
    const { context, library } = input;
    const prefix = input.sceneIdPrefix ?? "scene";
    const warnings: string[] = [];

    // 优先用 seed.candidateAnchors（结构化），否则从 context.facts 反解
    const anchors = input.seed?.candidateAnchors ?? extractAnchorsFromContext(context);

    const groups = groupAnchorsBySceneType(anchors);

    const contracts: SceneContract[] = groups.map((group, idx) => {
      const sceneId = `${prefix}:${idx + 1}:${group.sceneType}`;
      const contract = this.buildContract(sceneId, group.sceneType, group.anchors, library);
      // 审计：契约字段不得含机械指标
      const allText = [
        ...contract.readerPayoff,
        ...contract.mustPreserve,
        ...contract.mustAvoid,
        ...contract.qualityLevers,
      ].join("\n");
      if (containsMechanicalMetric(allText)) {
        warnings.push(
          `${sceneId} 契约字段命中机械指标正则，已剔除`
        );
        contract.qualityLevers = contract.qualityLevers.filter(
          (l) => !containsMechanicalMetric(l)
        );
        contract.mustAvoid = contract.mustAvoid.filter(
          (l) => !containsMechanicalMetric(l)
        );
      }
      return contract;
    });

    return { contracts, warnings };
  }

  private buildContract(
    sceneId: string,
    sceneType: SceneType,
    anchors: CandidateAnchor[],
    library: CraftJudgmentLibrary,
  ): SceneContract {
    const applicableJudgments = library.getApplicableForSceneType(sceneType);
    const relevantJudgments = applicableJudgments.map((j) => j.id);

    // readerPayoff：场景模板
    const readerPayoff = [...SCENE_READER_PAYOFF[sceneType]];

    // mustPreserve：场景连续性重点 + anchors 关键事实（纯事实边界，无指标配额）
    // P5 改进：旧逻辑仅从 anchors 前 4 条截取，无场景类型针对性；
    // 新逻辑先放 SCENE_CONTINUITY_FOCUS（perceptionErosion 防护），再补 anchor 事实。
    const continuityFocus = SCENE_CONTINUITY_FOCUS[sceneType] ?? [];
    const anchorFacts = anchors
      .slice(0, 4)
      .map((a) => a.description.slice(0, 80))
      .filter((d) => d.trim().length > 0);
    const mustPreserve = [...continuityFocus, ...anchorFacts];

    // continuityAnchors：从 anchors 筛选 visual/auditory/cognitive channel（P5 新增）
    // channel 类型为 sensory 枚举（visual/auditory/tactile/olfactory/gustatory/cognitive/emotional），
    // 无 "spatial"；visual 承载空间布局，auditory 承载环境连续，cognitive 承载事实连续。
    const continuityAnchors = anchors
      .filter((a) => a.channel === "visual" || a.channel === "auditory" || a.channel === "cognitive")
      .slice(0, 5)
      .map((a) => a.description.slice(0, 80))
      .filter((d) => d.trim().length > 0);

    // mustAvoid：场景模板事实/连续性禁令 + 编辑指导（非指标配额）
    // P44 重构：原感知词 mustAvoid 是"用感知词（感到/意识到/注意到/突然明白）替代主角主动行动"，
    //   属生成期指标强控（逼模型围着感知词计数优化）。改为编辑指导——给方向，不卡计数。
    //   保留 SCENE_MUST_AVOID[sceneType]（场景专属事实/连续性禁令，是事实边界不是指标）。
    const mustAvoid = [
      ...SCENE_MUST_AVOID[sceneType],
      "主角的关键决策与代价应以主动动作与后果承载；慎用纯感知词（感到/意识到/注意到/突然明白）替代行动后果",
      "为钩子牺牲主事件细节或空间连续性",
    ];

    // qualityLevers：场景专属杠杆 + judgment.positiveCriteria（定性方向，无数字配额）
    // P5 改进：优先用 SCENE_QUALITY_LEVERS 场景专属表，再限量补充 judgment.positiveCriteria。
    // P44 重构：移除 rawStage2 数据驱动的行动词/感知词命中数配额（机械指标，逼模型优化计数）。
    const qualityLevers: string[] = [...SCENE_QUALITY_LEVERS[sceneType]];
    for (const j of applicableJudgments) {
      if (j.generationUse === "scene_contract" && qualityLevers.length < 8) {
        qualityLevers.push(...j.positiveCriteria.slice(0, 1));
      }
    }
    // 去重 + 限量
    const uniqueLevers = Array.from(new Set(qualityLevers)).slice(0, 8);

    return {
      sceneId,
      sceneType,
      readerPayoff,
      mustPreserve,
      mustAvoid,
      qualityLevers: uniqueLevers,
      relevantJudgments,
      continuityAnchors,
    };
  }
}

/**
 * 从 CompiledContext 提取 candidateAnchors。
 *
 * CompiledContext 把锚点编译进了 facts（id 形如 "fact:anchor:EA1"），
 * 这里反向提取描述。为保持 P1 接口稳定，不直接存 seed 引用。
 */
function extractAnchorsFromContext(context: CompiledContext): CandidateAnchor[] {
  const anchors: CandidateAnchor[] = [];
  for (const fact of context.facts) {
    if (fact.id.startsWith("fact:anchor:")) {
      const anchorId = fact.id.replace("fact:anchor:", "");
      // fact.content 形如 "visual 锚点：xxx（权重 0.85，来源 explicitOutline）"
      const match = fact.content.match(/^(\w+)\s+锚点：(.+?)（权重\s*([\d.]+)，来源\s*(\w+)）$/);
      if (match) {
        anchors.push({
          id: anchorId,
          description: match[2],
          channel: match[1] as CandidateAnchor["channel"],
          weight: parseFloat(match[3]),
          source: match[4] as CandidateAnchor["source"],
        });
      } else {
        // 兜底：用 content 作为 description
        anchors.push({
          id: anchorId,
          description: fact.content,
          channel: "cognitive",
          weight: 0.5,
          source: "previousSkeleton",
        });
      }
    }
  }
  return anchors;
}

export function createSceneContractPlanner(): SceneContractPlanner {
  return new SceneContractPlanner();
}

// ============================================================================
// 公开工具函数（供 P4 CandidateGenerator 审计 prompt 用）
// ============================================================================

export { containsMechanicalMetric as sceneContractContainsMechanicalMetric };
