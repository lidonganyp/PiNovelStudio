/**
 * PiNovelStudio — 弧线注册表 (Arc Registry)
 *
 * 跨角色统一弧线追踪系统，ClosureTracker 的核心数据源。
 * 支持五类弧线：primary/secondary/relational/world/debt
 *
 * 核心能力：
 * - 弧线状态机追踪（idle→opened→in_progress→climaxed→resolved/abandoned）
 * - 多弧线收束时序约束（#C-01 ~ #C-04）
 * - 外部引用完整性验证（RI-01 ~ RI-05）
 * - 多结局分支版本化（version_closures）
 *
 * 规则来源：
 * - #246-#250: 收尾五类型分类学
 * - #251-#254: 多弧线收束时序约束
 * - #255-#263: 节奏法则与伏笔清仓
 * - 追补方向1: arc-registry.json 完整 Schema 标准化
 */

// ============================================================================
// 基础类型定义
// ============================================================================

/** 弧线类型（五类） */
export type ArcType = "primary" | "secondary" | "relational" | "world" | "debt";

/** 弧线优先级 */
export type ArcPriority = "P0" | "P1" | "P2" | "P3" | "P4";

/** 弧线状态机状态 */
export type ArcStatus =
  | "idle"           // 初始状态，尚未激活
  | "opened"         // 已开立，弧线开始
  | "in_progress"    // 进行中，正在推进
  | "climaxed"      // 已达高峰
  | "resolved"       // 已解决/闭合
  | "abandoned";    // 已废弃（仅允许部分类型）

/** 收尾类型 */
export type ClosureType = "fulfilling" | "open" | "reversal" | "circular" | "tragedy";

/** 章节窗口 */
export interface ChapterWindow {
  earliestChapter: number;
  latestChapter: number;
  hardDeadline: boolean;
}

/** 闭合触发器 */
export interface ClosureTrigger {
  type: "choice" | "event" | "revelation" | "climax";
  description: string;
  mustBeSelfInitiated: boolean;
  triggerChapter?: number;
}

/** 情感载荷 */
export interface EmotionalPayload {
  type: "catharsis" | "satisfaction" | "bittersweet" | "hope" | "melancholy";
  intensity: number; // 0-1
  targetEmotions: string[];
}

/** 弧线主题 */
export interface ArcSubject {
  characterId: string;
  theme: string;
  coreConflict: string;
}

/** 多结局版本闭合信息 */
export interface ArcVersionClosure {
  versionId: string;
  closureChapter: number;
  closureDetails: string;
  emotionalOutcome: EmotionalPayload;
  notes?: string;
}

/** 外部引用 */
export interface ExternalRef {
  targetType: "character" | "world" | "debt" | "detail";
  targetId: string;
  refType: "depends_on" | "triggers" | "references";
}

/** 弧线依赖 */
export interface ArcDependency {
  dependsOn: string;           // 依赖的弧线 ID
  dependencyType: "precedes" | "requires" | "excludes";
  description: string;
}

/** 里程碑 */
export interface ArcMilestone {
  id: string;
  name: string;
  description: string;
  targetChapter: number;
  status: "pending" | "reached" | "skipped";
  reachedChapter?: number;
}

/** 伏笔等级 */
export type ForeshadowLevel = "A" | "B" | "C";

/** 待唤回伏笔 */
export interface PendingForeshadow {
  id: string;
  description: string;
  level: ForeshadowLevel;
  plantedChapter: number;
  targetChapter: number;
  recallMethod: "explanation" | "plot" | "dialogue" | "imagery";
  recallChapter?: number;
  recalled: boolean;
}

// ============================================================================
// 弧线核心类型
// ============================================================================

/**
 * 弧线 (Arc)
 *
 * 五类弧线共享同一 Schema，通过 arc_type 字段分叉约束。
 * 核心追踪逻辑（状态机、依赖、里程碑）是同构的。
 */
export interface Arc {
  /** 弧线唯一标识 */
  arc_id: string;

  /** 弧线名称（人类可读） */
  name: string;

  /** 弧线类型 */
  arc_type: ArcType;

  /** 优先级 */
  priority: ArcPriority;

  /** 弧线主题 */
  subject: ArcSubject;

  /** 核心问题（弧线要回答的问题） */
  core_question: string;

  /** 错误信念（主角/角色持有的错误观点） */
  false_belief?: string;

  /** 抵达的真相 */
  truth_arrived_at?: string;

  /** 当前状态 */
  status: ArcStatus;

  /** 开立章节 */
  chapter_opened: number | null;

  /** 高峰章节 */
  chapter_climaxed: number | null;

  /** 闭合章节 */
  chapter_closed: number | null;

  /** 预期闭合窗口 */
  expected_closure_window: ChapterWindow;

  /** 闭合触发器 */
  closure_trigger: ClosureTrigger;

  /** 里程碑列表 */
  milestones: ArcMilestone[];

  /** 依赖关系 */
  dependencies: ArcDependency[];

  /** 外部引用 */
  external_refs: ExternalRef[];

  /** 情感载荷 */
  emotional_payload: EmotionalPayload;

  /** 收尾类型约束 */
  closure_type_constraint?: ClosureType;

  /** 多结局版本闭合（预留） */
  version_closures?: Record<string, ArcVersionClosure>;

  /** 废弃原因（仅当 status=abandoned 时） */
  abandoned_reason?: string;

  /** 元数据 */
  metadata: {
    createdAt: string;
    updatedAt: string;
    notes?: string;
  };
}

// ============================================================================
// ArcRegistry 主类型
// ============================================================================

export interface ArcRegistry {
  /** 弧线列表 */
  arcs: Arc[];

  /** 伏笔待唤回队列 */
  pending_foreshadows: PendingForeshadow[];

  /** 全局配置 */
  config: {
    totalChapters: number;
    currentChapter: number;
    closureType: ClosureType;
    version?: string;
  };

  /** 最后更新时间 */
  lastUpdated: string;
}

// ============================================================================
// 状态机验证
// ============================================================================

/** 合法状态流转 */
const LEGAL_TRANSITIONS: Record<ArcStatus, ArcStatus[]> = {
  idle: ["opened"],
  opened: ["in_progress"],
  in_progress: ["climaxed"],
  climaxed: ["resolved", "abandoned"],
  resolved: [],           // 终态，不可流转
  abandoned: [],          // 终态，不可流转
};

/** 禁止废弃的弧线类型 */
export const FORBIDDEN_ABANDON_TYPES: ArcType[] = ["primary", "world"];

/**
 * 验证状态流转是否合法
 * @param currentStatus 当前状态
 * @param targetStatus 目标状态
 * @param arcType 弧线类型
 * @returns 是否合法
 */
export function isLegalTransition(
  currentStatus: ArcStatus,
  targetStatus: ArcStatus,
  arcType: ArcType
): boolean {
  // 检查基础流转
  if (!LEGAL_TRANSITIONS[currentStatus].includes(targetStatus)) {
    return false;
  }

  // 检查禁止废弃规则
  if (targetStatus === "abandoned" && FORBIDDEN_ABANDON_TYPES.includes(arcType)) {
    return false;
  }

  return true;
}

/**
 * 获取当前可用的目标状态
 * @param currentStatus 当前状态
 * @param arcType 弧线类型
 * @returns 可用的目标状态列表
 */
export function getAvailableTransitions(
  currentStatus: ArcStatus,
  arcType: ArcType
): ArcStatus[] {
  const transitions = LEGAL_TRANSITIONS[currentStatus] || [];
  if (currentStatus === "climaxed" && FORBIDDEN_ABANDON_TYPES.includes(arcType)) {
    return transitions.filter((t) => t !== "abandoned");
  }
  return transitions;
}

// ============================================================================
// 闭合优先级矩阵（规则 #251-254）
// ============================================================================

/**
 * 弧线类型对应的闭合优先级
 * P0 = 最高优先级，必须最后闭合
 */
export const CLOSURE_PRIORITY_MATRIX: Record<ArcType, ArcPriority> = {
  primary: "P0",
  secondary: "P1",
  relational: "P1",
  world: "P2",
  debt: "P3",
};

/**
 * 各优先级对应的闭合时间窗口（倒数章节数）
 * 数值表示：距离终局的章数
 */
export const CLOSURE_WINDOW_MATRIX: Record<ArcPriority, { earliest: number; latest: number }> = {
  P0: { earliest: 3, latest: 1 },  // 主角弧：倒数3-1章
  P1: { earliest: 5, latest: 3 },  // 核心配角弧：倒数5-3章
  P2: { earliest: 8, latest: 5 }, // 世界观弧：倒数8-5章
  P3: { earliest: 10, latest: 3 }, // 次要配角弧：倒数10-3章
  P4: { earliest: 15, latest: 0 }, // 低权重债务：倒数15章前
};

/**
 * 检查弧线是否在预期窗口内闭合
 * @param arc 弧线
 * @param totalChapters 全书章节数
 * @param currentChapter 当前章节数
 * @returns 检查结果
 */
export function checkClosureWindow(
  arc: Arc,
  totalChapters: number,
  currentChapter: number
): {
  isOnTime: boolean;
  isEarly: boolean;
  isLate: boolean;
  windowStart: number;
  windowEnd: number;
  daysFromDeadline: number;
} {
  const priority = arc.priority;
  const window = CLOSURE_WINDOW_MATRIX[priority];

  // 计算窗口的绝对章节号
  const windowStart = totalChapters - window.earliest;
  const windowEnd = totalChapters - window.latest;

  const isOnTime = currentChapter >= windowStart && currentChapter <= windowEnd;
  const isEarly = currentChapter < windowStart;
  const isLate = currentChapter > windowEnd;

  return {
    isOnTime,
    isEarly,
    isLate,
    windowStart,
    windowEnd,
    daysFromDeadline: windowEnd - currentChapter,
  };
}

// ============================================================================
// 弧线类型字段约束（追补方向1）
// ============================================================================

/** 弧线类型字段差异表 */
export const ARC_TYPE_CONSTRAINTS: Record<ArcType, {
  coreQuestionRequired: boolean;
  falseBeliefRecommended: boolean;
  selfInitiatedRequired: boolean;
  canBeAbandoned: boolean;
  priorityRange: ArcPriority[];
}> = {
  primary: {
    coreQuestionRequired: true,
    falseBeliefRecommended: true,
    selfInitiatedRequired: true,
    canBeAbandoned: false,
    priorityRange: ["P0"],
  },
  secondary: {
    coreQuestionRequired: true,
    falseBeliefRecommended: false,
    selfInitiatedRequired: false,
    canBeAbandoned: true,
    priorityRange: ["P1", "P2", "P3"],
  },
  relational: {
    coreQuestionRequired: true,
    falseBeliefRecommended: false,
    selfInitiatedRequired: false,
    canBeAbandoned: true,
    priorityRange: ["P1", "P2", "P3"],
  },
  world: {
    coreQuestionRequired: true,
    falseBeliefRecommended: false,
    selfInitiatedRequired: false,
    canBeAbandoned: false,
    priorityRange: ["P1", "P2"],
  },
  debt: {
    coreQuestionRequired: true,
    falseBeliefRecommended: false,
    selfInitiatedRequired: false,
    canBeAbandoned: true,
    priorityRange: ["P0", "P1", "P2", "P3", "P4"],
  },
};

// ============================================================================
// 外部引用完整性规则（RI-01 ~ RI-05）
// ============================================================================

/**
 * 验证外部引用完整性
 * @param arc 弧线
 * @param characterRegistry 角色注册表（ID 列表）
 * @param worldRegistry 世界注册表（ID 列表）
 * @param debtRegistry 债务注册表（ID 列表）
 * @param detailRegistry 细节注册表（ID 列表）
 * @returns 验证结果
 */
export function validateExternalRefs(
  arc: Arc,
  characterRegistry: Set<string>,
  worldRegistry: Set<string>,
  debtRegistry: Set<string>,
  detailRegistry: Set<string>
): {
  valid: boolean;
  errors: Array<{ ref: ExternalRef; message: string }>;
} {
  const errors: Array<{ ref: ExternalRef; message: string }> = [];

  for (const ref of arc.external_refs) {
    let exists = false;

    switch (ref.targetType) {
      case "character":
        exists = characterRegistry.has(ref.targetId);
        break;
      case "world":
        exists = worldRegistry.has(ref.targetId);
        break;
      case "debt":
        exists = debtRegistry.has(ref.targetId);
        break;
      case "detail":
        exists = detailRegistry.has(ref.targetId);
        break;
    }

    if (!exists) {
      errors.push({
        ref,
        message: `外部引用失败: ${ref.targetType} "${ref.targetId}" 不存在于注册表中`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// 伏笔等级定义（规则 #258-#260）
// ============================================================================

/**
 * 伏笔唤回时间窗口
 * A级：终局时刻（倒数1-2章）
 * B级：高峰段（倒数5-3章）
 * C级：回落段或更早
 */
export const FORESHADOW_RECALL_WINDOWS: Record<ForeshadowLevel, { earliest: number; latest: number }> = {
  A: { earliest: 2, latest: 1 },
  B: { earliest: 5, latest: 3 },
  C: { earliest: 15, latest: 6 },
};

/**
 * 检查伏笔是否在预期窗口内唤回
 */
export function checkForeshadowRecallWindow(
  foreshadow: PendingForeshadow,
  totalChapters: number,
  currentChapter: number
): {
  isOnTime: boolean;
  isEarly: boolean;
  isLate: boolean;
  windowStart: number;
  windowEnd: number;
} {
  const window = FORESHADOW_RECALL_WINDOWS[foreshadow.level];
  const windowStart = totalChapters - window.earliest;
  const windowEnd = totalChapters - window.latest;

  const isOnTime = currentChapter >= windowStart && currentChapter <= windowEnd;
  const isEarly = currentChapter < windowStart;
  const isLate = currentChapter > windowEnd;

  return {
    isOnTime,
    isEarly,
    isLate,
    windowStart,
    windowEnd,
  };
}

// ============================================================================
// 收尾类型定义（规则 #246-#250）
// ============================================================================

/**
 * 收尾类型元数据
 */
export const CLOSURE_TYPE_METADATA: Record<ClosureType, {
  label: string;
  coreMechanism: string;
  maxRisk: string;
  requiredConditions: string[];
  forbiddenTraps: string[];
}> = {
  fulfilling: {
    label: "圆满型",
    coreMechanism: "主角核心成长弧 + 最强情感线达成 + 外部威胁消除——三轴同时满足",
    maxRisk: "廉价圆满（代价为零）",
    requiredConditions: [
      "主角弧必须 resolved",
      "核心情感线必须 resolved",
      "主线冲突必须 resolved",
      "配角各得其所",
    ],
    forbiddenTraps: [
      "无代价的胜利",
      "强行和解",
      "功能性的配角结局",
    ],
  },
  open: {
    label: "开放型",
    coreMechanism: "情节主线闭合，留有意义性余白——成长后的主角面对新未知",
    maxRisk: "被误读为烂尾",
    requiredConditions: [
      "核心冲突必须解决",
      "开放的是「下一步」非「这一步的结果」",
      "主角成长必须有明确体现",
    ],
    forbiddenTraps: [
      "开放的是核心问题本身",
      "余白无意义",
      "开放显得草率",
    ],
  },
  reversal: {
    label: "反转型",
    coreMechanism: "颠覆读者在最后N章前形成的预期，但反转必须有完整伏笔链",
    maxRisk: "无根反转 / 反转侵蚀积累",
    requiredConditions: [
      "反转必须有伏笔支撑",
      "反转后快速重建情感稳定",
      "反转不能颠覆已积累的情感",
    ],
    forbiddenTraps: [
      "无伏笔的天降反转",
      "为反转而反转",
      "反转破坏角色动机",
    ],
  },
  circular: {
    label: "循环型",
    coreMechanism: "结局呼应开篇，主角「回到原点但已非原来的他/她」",
    maxRisk: "机械复现",
    requiredConditions: [
      "最后场景/意象/台词必须与开篇有明确呼应",
      "呼应必须有情感增量",
      "主角必须有明显变化",
    ],
    forbiddenTraps: [
      "简单重复开篇",
      "变化不够明显",
      "呼应流于形式",
    ],
  },
  tragedy: {
    label: "悲剧收束型",
    coreMechanism: "主角付出不可逆代价，但代价赋予故事意义",
    maxRisk: "无意义悲剧",
    requiredConditions: [
      "悲剧必须有意义——牺牲改变了什么",
      "不能「白死了」",
      "代价必须被认可/理解",
    ],
    forbiddenTraps: [
      "无意义的死亡",
      "随机悲剧",
      "悲剧后无意义延续",
    ],
  },
};

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建新弧线
 */
export function createArc(params: {
  arc_id: string;
  name: string;
  arc_type: ArcType;
  subject: ArcSubject;
  core_question: string;
  chapter_opened: number;
  priority?: ArcPriority;
  false_belief?: string;
  truth_arrived_at?: string;
  closure_type_constraint?: ClosureType;
}): Arc {
  const priority = params.priority || CLOSURE_PRIORITY_MATRIX[params.arc_type];
  const window = CLOSURE_WINDOW_MATRIX[priority];

  return {
    arc_id: params.arc_id,
    name: params.name,
    arc_type: params.arc_type,
    priority,
    subject: params.subject,
    core_question: params.core_question,
    false_belief: params.false_belief,
    truth_arrived_at: params.truth_arrived_at,
    status: "opened",
    chapter_opened: params.chapter_opened,
    chapter_climaxed: null,
    chapter_closed: null,
    expected_closure_window: {
      earliestChapter: params.chapter_opened + 10, // 默认 10 章后开始可闭合
      latestChapter: 999, // 待计算
      hardDeadline: true,
    },
    closure_trigger: {
      type: "choice",
      description: "待定义",
      mustBeSelfInitiated: ARC_TYPE_CONSTRAINTS[params.arc_type].selfInitiatedRequired,
    },
    milestones: [],
    dependencies: [],
    external_refs: [],
    emotional_payload: {
      type: "satisfaction",
      intensity: 0.8,
      targetEmotions: [],
    },
    closure_type_constraint: params.closure_type_constraint,
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 创建空注册表
 */
export function createEmptyRegistry(totalChapters: number, closureType: ClosureType): ArcRegistry {
  return {
    arcs: [],
    pending_foreshadows: [],
    config: {
      totalChapters,
      currentChapter: 1,
      closureType,
      version: "1.0.0",
    },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 创建新伏笔
 */
export function createPendingForeshadow(params: {
  id: string;
  description: string;
  level: ForeshadowLevel;
  plantedChapter: number;
  targetChapter: number;
  recallMethod: PendingForeshadow["recallMethod"];
}): PendingForeshadow {
  return {
    ...params,
    recallChapter: undefined,
    recalled: false,
  };
}
