/**
 * GenreContractCompiler — 类型读者承诺编译与只读履约证据（GENRE-CONTRACT-1，计划 §6.3）
 *
 * 目标：在 raw 生成前，从 worldRules（声明类型）+ driftGenre（TypeRouter advisory）+
 * ConstitutionSnapshot.genrePromises（作品级承诺）+ 清洗后的本地类型承诺 dataset
 * 编译出"本章相关类型承诺"的 compact block，让 raw prompt 能看到：
 *   1. 声明类型与漂移类型（可追溯）
 *   2. 本章激活的承诺（constitution 默认激活 + type-dataset 命中激活）
 *   3. 只读履约证据（advisory，不构成 hard block）
 *
 * 核心不变量（GENRE-CONTRACT-1 任务书）：
 * - 声明类型与漂移类型可追溯（sourceRef 指向 config / type-router advisory）。
 * - 本章只激活相关承诺（constitution.genrePromises 默认激活；type-dataset 按本章功能命中激活）。
 * - 未满足只产生 advisory/hypothesis，不构成 hard block。
 * - 世界硬事实仍由 P0 管理（本编译器不接管 immutable_fact，与 WorldPresentationContext 互不重叠）。
 * - 类型识别失败回退 config 声明或空 advisory，不阻断统一主链路。
 * - 不调用 LLM；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 *
 * Dormant guard 兼容性：
 * - 本模块不得 import 或调用 dormant engine 的工厂/检测/卡片生成函数
 *   （tests/type-contract-engine-dormant-guard.test.mjs 守护）。
 * - 不直接复用 craft/type-contract-engine.ts 的 DEFAULT_TYPE_CONTRACTS 数据（含
 *   成长弧光/角色弧光/角色性格偏离等翻译腔术语，接入主链路前必须清洗）。
 * - 本模块自带清洗后的本地 dataset，不依赖 dormant engine。
 *
 * 确定性本地编译：零 LLM 调用，纯结构化字段映射。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { WorldRuleFact, ConstitutionSnapshot } from "./types.js";

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条类型承诺 compact 条目。
 */
export interface GenreContractEntry {
  /** 承诺 id，如 "constitution:0" 或 "type-dataset:玄幻:0" */
  promiseId: string;
  /** 承诺描述 */
  description: string;
  /**
   * 来源：
   * - "constitution"：作品级承诺（constitution.genrePromises），每章默认激活
   * - "type-dataset"：类型模板承诺（本模块自带清洗后的 dataset），按本章功能命中激活
   */
  source: "constitution" | "type-dataset";
  /** 本章是否激活：constitution 默认 true；type-dataset 需命中本章功能/读者体验/具体交付 */
  chapterActivated: boolean;
  /** 激活/未激活原因（可解释） */
  relevanceReason: string;
  /**
   * 只读履约证据状态（advisory，不构成 hard block）：
   * - "unverified"：本章正文尚未生成，无法判定履约（默认）
   * - "on_track"：本章功能命中 promise 关键词，方向一致
   * - "partial"：部分命中（保留枚举供后续增强）
   * 本编译器在 raw 生成前调用，fulfillmentEvidence 仅记录方向一致性，不判成败。
   */
  fulfillmentEvidence: "unverified" | "on_track" | "partial";
  /** 来源引用，如 "constitution:genrePromises" 或 "type-dataset:玄幻" */
  sourceRef: string;
  /** 置信度 [0,1]：constitution 0.7；type-dataset 0.5（模板，未作品级确认） */
  confidence: number;
}

/**
 * 本章类型承诺编译结果。
 * 写入 stageResults.genreContract 供 trace 审计。
 */
export interface GenreContractContext {
  /** 声明类型（来自 config.json 经 worldRules.type=genre 派生），无则 null */
  declaredGenre: string | null;
  /** 声明类型 sourceRef，如 "context.worldRules:world:genre" */
  declaredGenreSourceRef: string;
  /** 漂移类型（来自 TypeRouter advisory），无则 null */
  driftGenre: string | null;
  /** 漂移类型 sourceRef，如 "type-router:chapter-scan:ch17" */
  driftGenreSourceRef: string | null;
  /** 声明 vs 漂移：driftGenre 非空且不等于 declaredGenre 时为 true */
  genreDriftDetected: boolean;
  /** 本章类型承诺条目（constitution + type-dataset 命中项） */
  entries: GenreContractEntry[];
  /** 来源汇总（去重） */
  sourceRefs: string[];
  /** raw prompt 是否实际消费了该 compact block */
  consumedByRawPrompt: boolean;
  /** 空状态原因（不得静默，必须写明） */
  emptyReason?: string;
}

/**
 * 编译输入：从 orchestrator 传入的 worldRules + constitution + intent + driftGenre。
 */
export interface GenreContractCompileInput {
  intent: ChapterIntent;
  /** CompiledContext.worldRules，从中提取 type="genre" 的声明类型 */
  worldRules: WorldRuleFact[];
  /** ConstitutionSnapshot，无宪法文件时为 null */
  constitution: ConstitutionSnapshot | null;
  /**
   * 漂移类型（TypeRouter advisory，软识别）。
   * L0 阶段 TypeRouter 未接入主链路，调用方可传 null。
   */
  driftGenre: string | null;
  /** 漂移类型 sourceRef（TypeRouter 调用 evidence），driftGenre 为 null 时忽略 */
  driftGenreSourceRef?: string | null;
}

/**
 * 编译输出：GenreContractContext + 格式化后的 prompt block（空时 null）。
 */
export interface GenreContractCompileResult {
  genreContractContext: GenreContractContext;
  /** 格式化后的"本章类型承诺"prompt 区块；entries 为空且无 declaredGenre 时返回 null */
  promptBlock: string | null;
}

// ============================================================================
// 清洗后的本地类型承诺 dataset
// ============================================================================
//
// 设计说明：
// - 不复用 craft/type-contract-engine.ts 的 DEFAULT_TYPE_CONTRACTS（dormant，含翻译腔术语）。
// - 本 dataset 经过清洗：去除 成长弧光/角色弧光/OOC/openingHookTypes 等翻译腔；
//   去除 openingHookTypes / score / contractAdherence 等机械指标字段。
// - 只保留"读者因为该类型来看这本书的核心承诺"——一句话契约 + reader promises 列表。
// - 覆盖常见类型；未知类型不伪造（返回空 entries，写 emptyReason）。
//
// 关键词字段用于本章激活匹配：当 intent.chapterFunction / readerExperience /
// concreteDelivery 包含任一关键词时，该 promise 标记 chapterActivated=true。
// 关键词保守选择，避免误激活（如"推理"只激活悬疑的推理相关 promise）。

interface GenrePromiseTemplate {
  /** 一句话契约（作品级目标，非机械指标） */
  oneLineContract: string;
  /** 类型读者承诺列表（清洗后，无翻译腔术语） */
  readerPromises: Array<{ description: string; activationKeywords: string[] }>;
}

const CLEANED_GENRE_PROMISES: Record<string, GenrePromiseTemplate> = {
  "玄幻": {
    oneLineContract: "弱者逆袭，天道酬勤，热血与智谋并存的升级之路",
    readerPromises: [
      {
        description: "升级体系稳定推进，不中途崩塌或前后矛盾",
        activationKeywords: ["升级", "突破", "进阶", "境界", "修炼"],
      },
      {
        description: "战斗场景有智谋博弈，不靠无脑外挂",
        activationKeywords: ["战斗", "对决", "厮杀", "交战", "搏斗", "智谋"],
      },
      {
        description: "敌人智商在线，不突然掉线",
        activationKeywords: ["敌人", "对手", "反派", "boss", "BOSS"],
      },
    ],
  },
  "都市": {
    oneLineContract: "现实共鸣与理想实现的平衡，代入感极强的都市传奇",
    readerPromises: [
      {
        description: "都市背景真实可代入，不脱离现实逻辑",
        activationKeywords: ["都市", "城市", "职场", "街道", "写字楼", "公司"],
      },
      {
        description: "主角目标明确，行动有合理动机",
        activationKeywords: ["目标", "目的", "计划", "梦想", "追求"],
      },
    ],
  },
  "修仙": {
    oneLineContract: "追寻大道，长生路上的磨砺与超脱",
    readerPromises: [
      {
        description: "修炼体系自洽，境界划分清晰",
        activationKeywords: ["修炼", "境界", "金丹", "元婴", "飞升", "道心"],
      },
      {
        description: "因果报应生效，不无代价获取顶级资源",
        activationKeywords: ["因果", "代价", "资源", "机遇"],
      },
    ],
  },
  "科幻": {
    oneLineContract: "基于逻辑的幻想，探索未知的科学浪漫",
    readerPromises: [
      {
        description: "科幻设定尊重基本物理定律或给出明确解释",
        activationKeywords: ["科技", "飞船", "AI", "量子", "星际", "科幻"],
      },
      {
        description: "科技树前后逻辑自洽，不沦为魔法替代品",
        activationKeywords: ["科技树", "技术", "科技"],
      },
    ],
  },
  "悬疑": {
    oneLineContract: "真相层层剥开，逻辑严密的智力挑战",
    readerPromises: [
      {
        description: "核心谜题有铺垫，不凭空出现",
        activationKeywords: ["谜题", "谜", "真相", "秘密", "线索"],
      },
      {
        description: "线索可推理，不靠主角灵感或天降证据",
        activationKeywords: ["推理", "线索", "证据", "嫌疑", "调查"],
      },
      {
        description: "结局能自圆其说，不烂尾",
        activationKeywords: ["结局", "真相", "解密", "结案"],
      },
    ],
  },
  "言情": {
    oneLineContract: "情感细腻真挚，角色成长与爱情并行",
    readerPromises: [
      {
        description: "感情发展有合理动机，不强行倒贴",
        activationKeywords: ["感情", "心动", "喜欢", "暧昧", "告白", "情感"],
      },
      {
        description: "角色内心有戏，不止甜宠桥段",
        activationKeywords: ["内心", "心境", "情感", "心理"],
      },
    ],
  },
  "历史": {
    oneLineContract: "尊重历史脉络，在真实与虚构间找到平衡",
    readerPromises: [
      {
        description: "尊重历史常识，不严重歪曲重要历史人物",
        activationKeywords: ["历史", "朝代", "皇帝", "将军", "王朝", "宫廷"],
      },
      {
        description: "时代特色鲜明，不过度现代化思维",
        activationKeywords: ["时代", "朝代", "市井", "江湖", "战争"],
      },
    ],
  },
  "奇幻": {
    oneLineContract: "世界观构建完整，魔法与冒险的史诗感",
    readerPromises: [
      {
        description: "世界观自洽，设定不矛盾",
        activationKeywords: ["世界观", "魔法", "异世界", "神殿", "设定"],
      },
      {
        description: "魔法体系有基本规则，不万能解",
        activationKeywords: ["魔法", "异能", "规则", "代价"],
      },
    ],
  },
  "都市异能": {
    oneLineContract: "都市背景下的超能力应用，普通人与非凡的碰撞",
    readerPromises: [
      {
        description: "异能使用有代价/限制，不万能解",
        activationKeywords: ["异能", "超能力", "代价", "限制", "觉醒"],
      },
      {
        description: "异能者暴露后有后果，不无影响",
        activationKeywords: ["暴露", "异能者", "组织", "对抗"],
      },
    ],
  },
  "穿越": {
    oneLineContract: "跨时空的视角碰撞，新世界的新生存",
    readerPromises: [
      {
        description: "穿越设定清晰，不立即无敌",
        activationKeywords: ["穿越", "古代", "现代", "异世", "新世界"],
      },
      {
        description: "现代知识改变历史有代价或副作用",
        activationKeywords: ["现代知识", "历史", "代价", "副作用"],
      },
    ],
  },
  "系统": {
    oneLineContract: "任务驱动下的成长，边游戏边现实",
    readerPromises: [
      {
        description: "系统任务与世界观自洽，不脱节",
        activationKeywords: ["系统", "任务", "面板", "奖励", "惩罚"],
      },
      {
        description: "系统不取代角色决策，主角仍是行动主体",
        activationKeywords: ["决策", "主角", "选择", "判断"],
      },
    ],
  },
  "同人": {
    oneLineContract: "在原作基础上的合理延伸，尊重与创新的平衡",
    readerPromises: [
      {
        description: "尊重原作设定，不严重违背",
        activationKeywords: ["原作", "设定", "世界", "角色"],
      },
      {
        description: "原作角色性格一致，不无理由偏离原作设定",
        activationKeywords: ["角色", "性格", "人物"],
      },
    ],
  },
};

// ============================================================================
// 常量
// ============================================================================

/** constitution 来源于作品宪法，高置信度 */
const CONFIDENCE_CONSTITUTION = 0.7;
/** type-dataset 是模板（未作品级确认），中等置信度 */
const CONFIDENCE_TYPE_DATASET = 0.5;

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译本章类型承诺与只读履约证据。
 *
 * 编译规则（保守）：
 * 1. declaredGenre：从 worldRules 中找 type="genre" 的规则，取其 description。
 *    无则 declaredGenre=null（不伪造）。
 * 2. driftGenre：直接采用入参（TypeRouter advisory）。null 表示无 advisory。
 * 3. genreDriftDetected：driftGenre 非空且与 declaredGenre 不相等时为 true。
 * 4. entries：
 *    a. constitution.genrePromises → source="constitution", chapterActivated=true（作品级默认激活）
 *    b. type-dataset promises for declaredGenre → source="type-dataset"
 *    c. type-dataset promises for driftGenre（若与 declaredGenre 不同且在 dataset 中）
 *    d. type-dataset 激活判定：activationKeywords 命中 intent.chapterFunction /
 *       readerExperience / concreteDelivery 任一 → chapterActivated=true
 * 5. 空（无 declaredGenre + 无 driftGenre + 无 constitution + 无 type-dataset 命中）
 *    → emptyReason + promptBlock=null，不伪造。
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileGenreContract(
  input: GenreContractCompileInput
): GenreContractCompileResult {
  const { intent, worldRules, constitution, driftGenre, driftGenreSourceRef } = input;

  // 1. 提取 declaredGenre
  const genreRule = worldRules.find((r) => r.type === "genre");
  const declaredGenre = genreRule?.description ?? null;
  const declaredGenreSourceRef = genreRule
    ? `context.worldRules:${genreRule.id}`
    : "";

  // 2. driftGenre
  const resolvedDriftGenre = driftGenre?.trim() || null;
  const resolvedDriftSourceRef = resolvedDriftGenre
    ? driftGenreSourceRef ?? "type-router:advisory"
    : null;

  // 3. genreDriftDetected
  const genreDriftDetected =
    resolvedDriftGenre !== null &&
    declaredGenre !== null &&
    resolvedDriftGenre !== declaredGenre &&
    !declaredGenre.includes(resolvedDriftGenre) &&
    !resolvedDriftGenre.includes(declaredGenre);

  // 4. 构建 entries
  const entries: GenreContractEntry[] = [];
  const sourceRefSet = new Set<string>();
  if (declaredGenreSourceRef) sourceRefSet.add(declaredGenreSourceRef);
  if (resolvedDriftSourceRef) sourceRefSet.add(resolvedDriftSourceRef);

  // 4a. constitution.genrePromises
  const genrePromises = constitution?.genrePromises ?? [];
  genrePromises.forEach((promise, idx) => {
    entries.push({
      promiseId: `constitution:${idx}`,
      description: promise,
      source: "constitution",
      chapterActivated: true,
      relevanceReason: "作品级类型承诺，每章默认激活（来自 constitution.genrePromises）",
      fulfillmentEvidence: "unverified",
      sourceRef: "constitution:genrePromises",
      confidence: CONFIDENCE_CONSTITUTION,
    });
    sourceRefSet.add("constitution:genrePromises");
  });

  // 4b/4c. type-dataset promises for declaredGenre + driftGenre
  const genresToScan = new Set<string>();
  if (declaredGenre) {
    // declaredGenre 可能是"玄幻 / 修仙"格式，取主类型 + 子类型
    for (const part of declaredGenre.split(/[\/／]/)) {
      const trimmed = part.trim();
      if (trimmed) genresToScan.add(trimmed);
    }
  }
  if (resolvedDriftGenre) {
    genresToScan.add(resolvedDriftGenre);
  }

  // 本章功能/体验/交付的合并文本，用于关键词命中
  const chapterText = [
    intent.chapterFunction ?? "",
    ...(intent.readerExperience ?? []),
    ...(intent.concreteDelivery ?? []),
  ].join("\n");

  for (const genre of genresToScan) {
    const template = CLEANED_GENRE_PROMISES[genre];
    if (!template) continue; // 未知类型不伪造
    template.readerPromises.forEach((promise, idx) => {
      const activated = promise.activationKeywords.some((kw) =>
        chapterText.includes(kw),
      );
      entries.push({
        promiseId: `type-dataset:${genre}:${idx}`,
        description: promise.description,
        source: "type-dataset",
        chapterActivated: activated,
        relevanceReason: activated
          ? `类型模板承诺命中本章关键词（${genre}），方向一致`
          : `类型模板承诺（${genre}）未命中本章关键词，仅作背景`,
        // 写前只能证明“本章方向相关”，不能证明正文已经履约。
        fulfillmentEvidence: "unverified",
        sourceRef: `type-dataset:${genre}`,
        confidence: CONFIDENCE_TYPE_DATASET,
      });
      sourceRefSet.add(`type-dataset:${genre}`);
    });
  }

  // 5. 空状态处理：不得静默
  if (entries.length === 0 && !declaredGenre && !resolvedDriftGenre) {
    const emptyReason = deriveEmptyReason(worldRules, constitution, declaredGenre);
    const ctx: GenreContractContext = {
      declaredGenre: null,
      declaredGenreSourceRef: "",
      driftGenre: null,
      driftGenreSourceRef: null,
      genreDriftDetected: false,
      entries: [],
      sourceRefs: Array.from(sourceRefSet),
      consumedByRawPrompt: false,
      emptyReason,
    };
    return { genreContractContext: ctx, promptBlock: null };
  }

  // 有 declaredGenre 或 driftGenre 但无 entries（类型不在 dataset 且无 constitution）
  if (entries.length === 0) {
    const emptyReason = deriveEmptyReason(worldRules, constitution, declaredGenre);
    const ctx: GenreContractContext = {
      declaredGenre,
      declaredGenreSourceRef,
      driftGenre: resolvedDriftGenre,
      driftGenreSourceRef: resolvedDriftSourceRef,
      genreDriftDetected,
      entries: [],
      sourceRefs: Array.from(sourceRefSet),
      consumedByRawPrompt: false,
      emptyReason,
    };
    return { genreContractContext: ctx, promptBlock: null };
  }

  const ctx: GenreContractContext = {
    declaredGenre,
    declaredGenreSourceRef,
    driftGenre: resolvedDriftGenre,
    driftGenreSourceRef: resolvedDriftSourceRef,
    genreDriftDetected,
    entries,
    sourceRefs: Array.from(sourceRefSet),
    consumedByRawPrompt: false,
  };

  const promptBlock = formatGenreContractPromptBlock(ctx);
  return { genreContractContext: ctx, promptBlock };
}

/**
 * 推导空状态原因（不得静默）。
 */
function deriveEmptyReason(
  worldRules: WorldRuleFact[],
  constitution: ConstitutionSnapshot | null,
  declaredGenre: string | null
): string {
  const hasGenreRule = worldRules.some((r) => r.type === "genre");
  if (!hasGenreRule && !declaredGenre) {
    if (!constitution || !constitution.genrePromises || constitution.genrePromises.length === 0) {
      return "无 worldRules.type=genre 声明类型 + 无 constitution.genrePromises + 无 driftGenre，本章无可用类型承诺数据（不伪造）";
    }
    return "declaredGenre 缺失但 constitution.genrePromises 存在（不应到达此分支，请检查编译逻辑）";
  }
  // declaredGenre 存在但不在本地 dataset
  if (declaredGenre && !constitution?.genrePromises?.length) {
    return `declaredGenre="${declaredGenre}" 不在本地清洗后 dataset 中，且无 constitution.genrePromises；不伪造类型模板承诺`;
  }
  return "类型承诺编译后 entries 为空（异常状态，请检查 declaredGenre/driftGenre/constitution 输入）";
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 GenreContractContext 格式化为 raw prompt 的"本章类型承诺"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 本章类型承诺（声明类型 + 漂移检测 + 本章激活，advisory 非硬门）：
 * 声明类型：玄幻 / 修仙
 * 漂移类型：悬疑（type-router:advisory）—— 类型漂移已检测，请确认本章是否需兼顾
 * - [类型模板·玄幻] 升级体系稳定推进，不中途崩塌或前后矛盾（本章激活）
 * ```
 *
 * entries 为空时仍可能输出 declaredGenre/driftGenre 头（若有）；
 * 全空（无 declaredGenre + 无 driftGenre + 无 entries）时返回 null。
 * 不含 aggregateQualityScore / totalScore / 固定冲突数 / 固定兑现章数等机械指标。
 */
export function formatGenreContractPromptBlock(context: GenreContractContext): string | null {
  if (
    context.entries.length === 0 &&
    !context.declaredGenre &&
    !context.driftGenre
  ) {
    return null;
  }

  const lines: string[] = [];
  lines.push("本章类型承诺（声明类型 + 漂移检测 + 本章激活，advisory 非硬门）：");

  if (context.declaredGenre) {
    lines.push(`声明类型：${context.declaredGenre}`);
  }
  if (context.driftGenre) {
    const driftNote = context.genreDriftDetected
      ? "（类型漂移已检测，请确认本章是否需兼顾）"
      : "（与声明一致）";
    const ref = context.driftGenreSourceRef ?? "type-router:advisory";
    lines.push(`漂移类型：${context.driftGenre}（${ref}）${driftNote}`);
  }

  // constitution.genrePromises 已由 WorldPresentationContext 注入 raw prompt；
  // 这里仅输出本章实际激活的本地类型模板，避免重复和背景条目污染。
  for (const entry of context.entries) {
    if (entry.source !== "type-dataset" || !entry.chapterActivated) continue;
    const tag = `[类型模板·${extractGenreFromSourceRef(entry.sourceRef)}]`;
    lines.push(`- ${tag} ${entry.description}（本章激活）`);
  }

  return lines.join("\n");
}

/** 从 sourceRef "type-dataset:玄幻" 提取类型名 */
function extractGenreFromSourceRef(sourceRef: string): string {
  const parts = sourceRef.split(":");
  return parts[1] ?? parts[0] ?? "";
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped GenreContractContext（用于 hardBlock / raw 生成失败路径）。
 * 与 QUALITY-4/5/6 skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedGenreContract(reason: string): GenreContractContext {
  return {
    declaredGenre: null,
    declaredGenreSourceRef: "",
    driftGenre: null,
    driftGenreSourceRef: null,
    genreDriftDetected: false,
    entries: [],
    sourceRefs: [],
    consumedByRawPrompt: false,
    emptyReason: `skipped: ${reason}`,
  };
}
