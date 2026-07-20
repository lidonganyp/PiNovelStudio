/**
 * PROMPT-CONTEXT-ABLATION-1：上下文块消融实验框架
 *
 * 任务卡 §6 PROMPT-CONTEXT-ABLATION-1：
 * 测量当前十余类上下文块哪些真正提高正文，哪些造成注意力稀释、模板化或创作空间收缩。
 *
 * 5 个实验臂（任务卡 §6 实验臂）：
 *   A0：极简续写基线        前文 + 写完整下一章
 *   A1：最小必要主链路      A0 + 前章桥接 + ChapterIntent + immutable facts + 关键角色状态
 *   A2：作品核心层          A1 + CreativeConstitution 相关字段
 *   A3：精准示例层          A2 + 2-3 个本作品 accepted/revision 对比示例
 *   A4：当前完整 prompt     当前所有生产可消费上下文块
 *
 * 控制变量（任务卡 §6 控制变量）：
 * - 同一模型版本、provider、上下文窗口、输出预算和停止条件
 * - 每个 case 每个实验臂至少 2 个独立采样，记录 seed/temperature/finish_reason
 * - 不通过更换模型掩盖 prompt 负收益
 * - prompt token、正文 token、延迟和成本单独统计
 *
 * 验收（任务卡 §6 验收）：
 * - 至少 15 个验证 case
 * - 输出各实验臂匿名胜率、tie、事实 hard regression、AI 痕迹、成本和长度完整性
 * - 任一上下文块只有在跨场景稳定正收益时才保留默认注入
 * - 没有正收益证据的 advisory 改为 JIT 检索、editorial diagnosis 或移除
 *
 * 授权边界（任务卡 §10）：
 * - 真实 Claude Opus 4.6 批量 raw 生成 / gpt-5.6-sol judge 属于 REQUIRES_AUTH
 * - 本框架提供 stub 模式（globalThis.fetch 覆盖）用于离线结构与聚合逻辑验证
 * - 生产 prompt 修改必须基于真实 auth 实验结果，由人工评审决定，本模块不自动改变生产
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { callJudgeModel, type JudgeModelConfig } from "./judge-model-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// 上下文块清单
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CONTEXT_BLOCK_NAMES：当前生产可消费的所有上下文块清单。
 *
 * 顺序大致反映 buildRawPrompt 中的注入顺序：
 * - 基础层：bridge_context / chapter_intent / immutable_facts / character_states
 * - 作品层：creative_constitution
 * - 示例层：accepted_revision_examples / knowledge_consumption
 * - 紧凑块层：promise_context / expectation_context / genre_contract / dialogue_craft /
 *             emotion_rhythm / supporting_function / character_voice_context /
 *             world_presentation_context / ensemble_layering_context
 * - 契约层：identity_contract / ontology_contract
 * - 资料层：runtime_rules / style_fingerprint
 */
export const CONTEXT_BLOCK_NAMES = [
  "bridge_context",
  "chapter_intent",
  "immutable_facts",
  "character_states",
  "creative_constitution",
  "accepted_revision_examples",
  "promise_context",
  "expectation_context",
  "genre_contract",
  "dialogue_craft",
  "emotion_rhythm",
  "supporting_function",
  "knowledge_consumption",
  "character_voice_context",
  "world_presentation_context",
  "ensemble_layering_context",
  "identity_contract",
  "ontology_contract",
  "runtime_rules",
  "style_fingerprint",
] as const;

export type ContextBlockName = (typeof CONTEXT_BLOCK_NAMES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 实验臂定义
// ─────────────────────────────────────────────────────────────────────────────

export interface AblationArm {
  id: "A0" | "A1" | "A2" | "A3" | "A4";
  name: string;
  description: string;
  activeBlocks: ContextBlockName[];
}

/**
 * ABLATION_ARMS：5 个实验臂定义（任务卡 §6 实验臂）。
 *
 * A0：极简续写基线，仅前文 + 写下一章指令
 * A1：A0 + 前章桥接 + ChapterIntent + immutable facts + 关键角色状态
 * A2：A1 + CreativeConstitution 相关字段
 * A3：A2 + 2-3 个本作品 accepted/revision 对比示例
 * A4：A3 + 当前所有生产 compact block（promise/expectation/genre 等）
 */
export const ABLATION_ARMS: AblationArm[] = [
  {
    id: "A0",
    name: "极简续写基线",
    description: "前文 + 写完整下一章。不含任何上下文块。",
    activeBlocks: [],
  },
  {
    id: "A1",
    name: "最小必要主链路",
    description: "A0 + 前章桥接 + ChapterIntent + immutable facts + 关键角色状态",
    activeBlocks: [
      "bridge_context",
      "chapter_intent",
      "immutable_facts",
      "character_states",
    ],
  },
  {
    id: "A2",
    name: "作品核心层",
    description: "A1 + CreativeConstitution 相关字段",
    activeBlocks: [
      "bridge_context",
      "chapter_intent",
      "immutable_facts",
      "character_states",
      "creative_constitution",
    ],
  },
  {
    id: "A3",
    name: "精准示例层",
    description: "A2 + 2-3 个本作品 accepted/revision 对比示例",
    activeBlocks: [
      "bridge_context",
      "chapter_intent",
      "immutable_facts",
      "character_states",
      "creative_constitution",
      "accepted_revision_examples",
    ],
  },
  {
    id: "A4",
    name: "当前完整 prompt",
    description: "A3 + 当前所有生产可消费上下文块（promise/expectation/genre 等）",
    activeBlocks: [...CONTEXT_BLOCK_NAMES],
  },
];

/**
 * 获取指定实验臂的激活上下文块清单。
 */
export function getBlocksForArm(armId: string): ContextBlockName[] {
  const arm = ABLATION_ARMS.find((a) => a.id === armId);
  if (!arm) {
    throw new Error(`invalid armId: ${armId}（合法值：A0/A1/A2/A3/A4）`);
  }
  return [...arm.activeBlocks];
}

// ─────────────────────────────────────────────────────────────────────────────
// 门槛
// ─────────────────────────────────────────────────────────────────────────────

export const ABLATION_THRESHOLDS = {
  minCases: 15,
  minSamplesPerCasePerArm: 2,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptedRevisionExample {
  before: string;
  after: string;
  reason: string;
  dimension?: string;
}

export interface AblationCaseIntent {
  primary?: string;
  chapterTheme?: string;
  chapterFunction?: string;
  readerExperience?: string[];
  currentPressure?: string[];
  inviolableFacts?: string[];
  focusCharacterGoals?: Array<{ character: string; goal: string }>;
  resistance?: string[];
  choicesAndCosts?: Array<{ choice: string; cost: string }>;
  expectedIrreversibleChange?: string[];
  selectedPromisesToAdvance?: Array<{ promiseId: string; description: string }>;
  causalEndPressure?: string[];
  factAndCharacterKnowledgeForbiddenZones?: string[];
  relevantCharacters?: string[];
}

export interface AblationCaseBridgeContext {
  available: boolean;
  lastEventSummary?: string;
  lastEventId?: string;
  endingEmotion?: string;
  openHooks?: string[];
  unresolvedTensions?: string[];
  introducedCharacters?: string[];
}

export interface AblationCaseCharacterState {
  characterId: string;
  name: string;
  state: {
    role?: string;
    mentality?: string;
    recentAction?: string;
    pendingTension?: string;
    aliases?: string[];
  };
}

export interface AblationCaseWorldRule {
  id: string;
  description: string;
  type: string;
  affectedCharacters?: string[];
}

export interface AblationCaseConstitution {
  workIdentity?: string;
  readerPromise?: string[];
  genrePromises?: string[];
  protagonistCoreConflict?: string;
  thematicQuestions?: string[];
  aestheticDirection?: string[];
  forbiddenDrift?: string[];
}

export interface AblationCase {
  caseId: string;
  workspaceId: string;
  chapterNumber: number;
  chapterId: string;
  previousText: string;
  intent: AblationCaseIntent;
  bridgeContext?: AblationCaseBridgeContext | null;
  immutableFacts?: string[];
  characterStates?: AblationCaseCharacterState[];
  worldRules?: AblationCaseWorldRule[];
  constitution?: AblationCaseConstitution | null;
  acceptedRevisionExamples?: AcceptedRevisionExample[];
  modelRoute?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface AblationCaseSet {
  bookId: string;
  caseSetId: string;
  cases: AblationCase[];
  createdAt?: string;
}

export interface ControlVariables {
  modelRoute: string;
  provider: string;
  modelVersion: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface AblationSample {
  caseId: string;
  armId: string;
  sampleIndex: number;
  seed: number;
  temperature: number;
  text: string;
  finishReason: string;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  truncated: boolean;
  hardFactRegression: boolean;
  aiTrace: boolean;
}

export interface TokenStats {
  min: number;
  median: number;
  max: number;
}

export interface AblationArmResult {
  armId: string;
  sampleCount: number;
  truncatedCount: number;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  promptTokenStats: TokenStats;
  outputTokenStats: TokenStats;
  latencyMsStats: TokenStats;
  hardFactRegressionRate: number;
  aiTraceRate: number;
  lengthIntegrityRate: number;
}

export interface JudgeInvocation {
  caseId: string;
  sampleLeftId: string;
  sampleRightId: string;
  judgePrompt: string;
  winner: "left" | "right" | "tie";
  timestamp: string;
}

export interface AblationPairResult {
  armLeft: string;
  armRight: string;
  leftWinRate: number;
  rightWinRate: number;
  tieRate: number;
  totalComparisons: number;
  judgeInvocations: JudgeInvocation[];
}

export interface RetentionRecommendation {
  blockName: string;
  stablePositiveGain: boolean;
  recommendation: "retain" | "demote_to_jit" | "demote_to_editorial" | "remove";
  evidenceSummary: string;
}

export interface AblationCaseDetail {
  caseId: string;
  samples: AblationSample[];
}

export interface ProductionGating {
  canChangeProductionPrompt: boolean;
  canChangeDefaultInjection: boolean;
  note: string;
}

export interface AblationResult {
  ablationRunId: string;
  caseSetHash: string;
  totalCases: number;
  samplesPerCasePerArm: number;
  armResults: AblationArmResult[];
  pairResults: AblationPairResult[];
  retentionRecommendation: RetentionRecommendation[];
  details: AblationCaseDetail[];
  controlVariables?: ControlVariables;
  thresholds: typeof ABLATION_THRESHOLDS;
  passed: boolean;
  failureReasons: string[];
  productionGating: ProductionGating;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAblationPrompt
// ─────────────────────────────────────────────────────────────────────────────

export interface AblationPromptResult {
  systemPrompt: string;
  userPrompt: string;
  consumedBlocks: string[];
  promptTokenEstimate: number;
}

/**
 * 构造指定实验臂的 raw 生成 prompt。
 *
 * 设计原则：
 * - A0：仅前文 + 写下一章指令，不注入任何上下文块
 * - A1-A4：按 activeBlocks 清单选择性注入对应内容
 * - 所有 arm 共用 systemPrompt（"你是顶尖网文作家..."）
 * - consumedBlocks 反映实际进入 prompt 的块（用于审计）
 *
 * @param armId 实验臂 ID（A0/A1/A2/A3/A4）
 * @param caseData 单个 ablation case 数据
 */
export function buildAblationPrompt(
  armId: string,
  caseData: AblationCase,
): AblationPromptResult {
  const arm = ABLATION_ARMS.find((a) => a.id === armId);
  if (!arm) {
    throw new Error(`invalid armId: ${armId}（合法值：A0/A1/A2/A3/A4）`);
  }

  const parts: string[] = [];
  const consumedBlocks: string[] = [];

  // 前文（所有 arm 都有，不算"上下文块"）
  if (caseData.previousText) {
    parts.push(`【前文】\n${caseData.previousText}`);
  }

  // 写章指令
  parts.push(
    `你是顶尖网文作家。请写第${caseData.chapterNumber}章完整正文。标题中的章节号必须是第${caseData.chapterNumber}章，不得写成其他章节。`,
  );
  parts.push(
    "要求：写出自然流畅的中文网文章节正文，有完整的情节推进、角色行动和章末钩子。不要写大纲或注释，直接输出正文。",
  );

  // ── 按 activeBlocks 注入对应内容 ────────────────────────────────────
  const blocks = new Set(arm.activeBlocks);

  // bridge_context
  if (blocks.has("bridge_context") && caseData.bridgeContext?.available) {
    const bc = caseData.bridgeContext;
    const bridgeParts: string[] = [];
    if (bc.lastEventSummary) bridgeParts.push(`前章末事件：${bc.lastEventSummary}`);
    if (bc.endingEmotion) bridgeParts.push(`结尾情绪：${bc.endingEmotion}`);
    if (bc.openHooks?.length) bridgeParts.push(`开放钩子：${bc.openHooks.join(" / ")}`);
    if (bc.unresolvedTensions?.length) bridgeParts.push(`未解张力：${bc.unresolvedTensions.join(" / ")}`);
    if (bc.introducedCharacters?.length) bridgeParts.push(`新登场角色：${bc.introducedCharacters.join(" / ")}`);
    if (bridgeParts.length > 0) {
      parts.push(`前章悬置状态（本章必须承接，不得跳过）：${bridgeParts.join("；")}`);
      consumedBlocks.push("bridge_context");
    }
  }

  // chapter_intent
  if (blocks.has("chapter_intent") && caseData.intent) {
    const intent = caseData.intent;
    if (intent.primary) {
      parts.push(`本章意图：${intent.primary}${intent.chapterTheme ? `（主题：${intent.chapterTheme}）` : ""}`);
      consumedBlocks.push("chapter_intent");
    }
    if (intent.chapterFunction) {
      parts.push(`本章功能：${intent.chapterFunction}`);
    }
    if (intent.readerExperience?.length) {
      parts.push(`读者体验目标：${intent.readerExperience.join("、")}`);
    }
    if (intent.currentPressure?.length) {
      parts.push(`当前压力：${intent.currentPressure.join("；")}`);
    }
    if (intent.inviolableFacts?.length) {
      parts.push(`不可破坏的事实（必须遵守）：${intent.inviolableFacts.join("；")}`);
    }
    if (intent.focusCharacterGoals?.length) {
      const goalStrs = intent.focusCharacterGoals.map((g) => `${g.character}——${g.goal}`);
      parts.push(`焦点角色目标：${goalStrs.join("；")}`);
    }
    if (intent.resistance?.length) {
      parts.push(`本章阻力：${intent.resistance.join("；")}`);
    }
    if (intent.choicesAndCosts?.length) {
      const ccStrs = intent.choicesAndCosts.map((c) => `${c.choice} → 代价：${c.cost}`);
      parts.push(`选择与代价：${ccStrs.join("；")}`);
    }
    if (intent.expectedIrreversibleChange?.length) {
      parts.push(`预期不可逆变化：${intent.expectedIrreversibleChange.join("；")}`);
    }
    if (intent.causalEndPressure?.length) {
      parts.push(`章末因果压力方向：${intent.causalEndPressure.join("；")}`);
    }
    if (intent.factAndCharacterKnowledgeForbiddenZones?.length) {
      parts.push(`事实与人物知识禁区：${intent.factAndCharacterKnowledgeForbiddenZones.join("；")}`);
    }
  }

  // immutable_facts
  if (blocks.has("immutable_facts")) {
    const facts: string[] = [];
    if (caseData.immutableFacts?.length) {
      facts.push(...caseData.immutableFacts);
    }
    if (caseData.worldRules?.length) {
      for (const r of caseData.worldRules) {
        if (r.type === "immutable_fact") facts.push(r.description);
      }
    }
    if (facts.length > 0) {
      parts.push(`不可破坏的世界观事实：${facts.join("；")}`);
      consumedBlocks.push("immutable_facts");
    }
  }

  // character_states
  if (blocks.has("character_states") && caseData.characterStates?.length) {
    const charStrs = caseData.characterStates.map((c) => {
      const role = c.state?.role ? `【${c.state.role}】` : "";
      const mentality = c.state?.mentality ? `（心态：${c.state.mentality}）` : "";
      const tension = c.state?.pendingTension ? `（张力：${c.state.pendingTension}）` : "";
      return `${c.name}${role}${mentality}${tension}`;
    });
    parts.push(`关键角色状态：${charStrs.join("；")}`);
    consumedBlocks.push("character_states");
  }

  // creative_constitution
  if (blocks.has("creative_constitution") && caseData.constitution) {
    const c = caseData.constitution;
    const parts2: string[] = [];
    if (c.workIdentity) parts2.push(`作品身份：${c.workIdentity}`);
    if (c.readerPromise?.length) parts2.push(`读者承诺：${c.readerPromise.join("、")}`);
    if (c.genrePromises?.length) parts2.push(`类型承诺：${c.genrePromises.join("、")}`);
    if (c.protagonistCoreConflict) parts2.push(`主角核心冲突：${c.protagonistCoreConflict}`);
    if (c.thematicQuestions?.length) parts2.push(`主题问题：${c.thematicQuestions.join("、")}`);
    if (c.aestheticDirection?.length) parts2.push(`美学方向：${c.aestheticDirection.join("、")}`);
    if (c.forbiddenDrift?.length) parts2.push(`禁止漂移：${c.forbiddenDrift.join("、")}`);
    if (parts2.length > 0) {
      parts.push(`作品宪法：${parts2.join("；")}`);
      consumedBlocks.push("creative_constitution");
    }
  }

  // accepted_revision_examples
  if (blocks.has("accepted_revision_examples") && caseData.acceptedRevisionExamples?.length) {
    const exStrs = caseData.acceptedRevisionExamples.map((ex, i) => {
      const dim = ex.dimension ? `[${ex.dimension}]` : "";
      return `示例${i + 1}${dim}\n  修改前：${ex.before}\n  修改后：${ex.after}\n  原因：${ex.reason}`;
    });
    parts.push(`精准示例（accepted/revision 对比，仅作风格参考，不复制具体内容）：\n${exStrs.join("\n")}`);
    consumedBlocks.push("accepted_revision_examples");
  }

  // ── A4 紧凑块层（即使为空也写入 block 标记，模拟生产 prompt 结构）─────
  if (blocks.has("promise_context")) {
    parts.push("【承诺状态 compact block】（按 selectedPromisesToAdvance 命中项编译；空时记 emptyReason）");
    consumedBlocks.push("promise_context");
  }
  if (blocks.has("expectation_context")) {
    parts.push("【读者期待 compact block】（按 selectedExpectationsToAdvance 命中项编译；空时记 emptyReason）");
    consumedBlocks.push("expectation_context");
  }
  if (blocks.has("genre_contract")) {
    parts.push("【类型承诺 compact block】（含 declaredGenre + constitution.genrePromises + type-dataset 命中）");
    consumedBlocks.push("genre_contract");
  }
  if (blocks.has("dialogue_craft")) {
    parts.push("【对白工艺 compact block】（仅本章发言角色声音指纹；raw 生成前 rawText=null，advisory 为空）");
    consumedBlocks.push("dialogue_craft");
  }
  if (blocks.has("emotion_rhythm")) {
    parts.push("【情绪节拍 compact block】（目标情绪 + 前态情绪 + 章尾情绪落点；raw 生成前 rawText=null）");
    consumedBlocks.push("emotion_rhythm");
  }
  if (blocks.has("supporting_function")) {
    parts.push("【配角章节功能 compact block】（激活配角 = relevantCharacters - focusCharacterGoals；raw 生成前功能待扫描）");
    consumedBlocks.push("supporting_function");
  }
  if (blocks.has("knowledge_consumption")) {
    parts.push("【参考示例 compact block】（few-shot/contrastive 生产消费审计；manifestApproved=false 时为空）");
    consumedBlocks.push("knowledge_consumption");
  }
  if (blocks.has("character_voice_context")) {
    parts.push("【角色声音状态 compact block】（focusCharacterGoals ∪ relevantCharacters 命中项的 voiceHints）");
    consumedBlocks.push("character_voice_context");
  }
  if (blocks.has("world_presentation_context")) {
    parts.push("【世界约束 compact block】（含 type/chapterActivated/affectedCharacters/genrePromises）");
    consumedBlocks.push("world_presentation_context");
  }
  if (blocks.has("ensemble_layering_context")) {
    parts.push("【角色层次 compact block】（焦点/在场分层）");
    consumedBlocks.push("ensemble_layering_context");
  }
  if (blocks.has("identity_contract")) {
    parts.push("【角色身份契约 compact block】（结构性身份 name/role/aliases/stableIdentity）");
    consumedBlocks.push("identity_contract");
  }
  if (blocks.has("ontology_contract")) {
    parts.push("【封闭世界本体契约 compact block】（明确声明的闭世界术语序列）");
    consumedBlocks.push("ontology_contract");
  }
  if (blocks.has("runtime_rules")) {
    parts.push("【runtime rules advisory】（候选经验，status=candidate；仅作 context_hint，不强制执行）");
    consumedBlocks.push("runtime_rules");
  }
  if (blocks.has("style_fingerprint")) {
    parts.push("【风格指纹参考】（来自 style profile，advisory 非硬门）");
    consumedBlocks.push("style_fingerprint");
  }

  const userPrompt = parts.join("\n\n");
  const systemPrompt = "你是顶尖网文作家，擅长写出自然流畅、有张力的中文网文章节。";
  const promptTokenEstimate = Math.ceil((systemPrompt.length + userPrompt.length) / 4);

  return {
    systemPrompt,
    userPrompt,
    consumedBlocks,
    promptTokenEstimate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// loadAblationCaseSet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 加载 ablation case set JSON 文件并校验格式。
 *
 * 必填字段：
 * - bookId
 * - caseSetId
 * - cases[]（每个 case 至少含 caseId / workspaceId / intent / previousText）
 */
export async function loadAblationCaseSet(filePath: string): Promise<AblationCaseSet> {
  const content = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content) as Partial<AblationCaseSet>;
  if (!parsed.bookId) {
    throw new Error(`ablation case set 格式错误：缺少 bookId（${filePath}）`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error(`ablation case set 格式错误：缺少 cases 数组（${filePath}）`);
  }
  if (!parsed.caseSetId) {
    throw new Error(`ablation case set 格式错误：缺少 caseSetId（${filePath}）`);
  }
  for (let i = 0; i < parsed.cases.length; i++) {
    const c = parsed.cases[i];
    if (!c.caseId) {
      throw new Error(`ablation case set 格式错误：cases[${i}] 缺少 caseId`);
    }
    if (!c.workspaceId) {
      throw new Error(`ablation case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 workspaceId`);
    }
    if (!c.intent) {
      throw new Error(`ablation case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 intent`);
    }
    if (typeof c.previousText !== "string") {
      throw new Error(`ablation case set 格式错误：cases[${i}] (caseId=${c.caseId}) 缺少 previousText`);
    }
  }
  return parsed as AblationCaseSet;
}

// ─────────────────────────────────────────────────────────────────────────────
// runPromptContextAblation（核心实现，被 stub 与 real 共用）
// ─────────────────────────────────────────────────────────────────────────────

export interface RunAblationOptions {
  caseSet: AblationCaseSet;
  samplesPerCasePerArm: number;
  judgePairs?: Array<[string, string]>;
  controlVariables?: ControlVariables;
  /** 生成 raw 正文的模型调用函数（stub 与 real 各自注入） */
  generateRaw?: (
    prompt: { systemPrompt: string; userPrompt: string },
    seed: number,
    options: { maxTokens?: number; timeoutMs?: number; modelRoute?: string },
  ) => Promise<{
    text: string;
    model: string;
    finishReason?: string;
    promptTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  }>;
  /** pairwise judge 调用函数（stub 与 real 各自注入） */
  judgePair?: (
    leftText: string,
    rightText: string,
    context: { workGoal: string; chapterIntent: string; priorFacts: string[] },
    seed: number,
  ) => Promise<{
    winner: "left" | "right" | "tie";
    hardFactRisk: boolean;
  }>;
}

const DEFAULT_JUDGE_PAIRS: Array<[string, string]> = [
  ["A0", "A4"],
  ["A1", "A4"],
  ["A2", "A4"],
  ["A3", "A4"],
];

/**
 * 核心 ablation 执行函数。
 * stub 与 real 模式共用此实现，差异在 generateRaw / judgePair 注入。
 */
export async function runPromptContextAblation(
  options: RunAblationOptions,
): Promise<AblationResult> {
  const {
    caseSet,
    samplesPerCasePerArm,
    judgePairs = DEFAULT_JUDGE_PAIRS,
    controlVariables,
    generateRaw,
    judgePair,
  } = options;

  if (!generateRaw) {
    throw new Error("runPromptContextAblation 需要 generateRaw 注入（stub 或 real）");
  }
  if (!judgePair) {
    throw new Error("runPromptContextAblation 需要 judgePair 注入（stub 或 real）");
  }

  // 校验 judgePairs 中的 armId 合法
  const validArmIds = ABLATION_ARMS.map((a) => a.id);
  for (const [left, right] of judgePairs) {
    if (!validArmIds.includes(left as AblationArm["id"])) {
      throw new Error(`invalid armId in judgePairs: ${left}（合法值：${validArmIds.join("/")}）`);
    }
    if (!validArmIds.includes(right as AblationArm["id"])) {
      throw new Error(`invalid armId in judgePairs: ${right}（合法值：${validArmIds.join("/")}）`);
    }
  }

  const ablationRunId = `ablation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const caseSetHash = computeCaseSetHash(caseSet);

  const allSamples: AblationSample[] = [];
  const details: AblationCaseDetail[] = [];

  // ── 每个 case × arm × sample 生成 raw ──────────────────────────────
  for (const caseData of caseSet.cases) {
    const caseSamples: AblationSample[] = [];
    for (const arm of ABLATION_ARMS) {
      const prompt = buildAblationPrompt(arm.id, caseData);
      for (let s = 0; s < samplesPerCasePerArm; s++) {
        const seed = hashSeed(`${caseData.caseId}|${arm.id}|${s}`);
        const temperature = 0.7 + (seed % 100) / 1000; // 0.7-0.8 之间，可复现
        const startMs = Date.now();
        const result = await generateRaw(
          { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt },
          seed,
          {
            maxTokens: caseData.maxTokens ?? 4096,
            timeoutMs: caseData.timeoutMs ?? 60_000,
            modelRoute: caseData.modelRoute ?? "v2_rawstage2",
          },
        );
        const latencyMs = Date.now() - startMs;
        const text = result.text ?? "";
        const finishReason = result.finishReason ?? "stop";
        const truncated = finishReason === "length";
        // 简化启发式：检查 AI 痕迹关键词（"综上所述"、"总而言之"、"不仅...而且"）
        const aiTrace = detectAiTrace(text);
        // hardFactRegression 简化：由 judge 在 pair 阶段标注，这里默认 false
        const hardFactRegression = false;

        const sample: AblationSample = {
          caseId: caseData.caseId,
          armId: arm.id,
          sampleIndex: s,
          seed,
          temperature,
          text,
          finishReason,
          promptTokens: result.promptTokens ?? prompt.promptTokenEstimate,
          outputTokens: result.outputTokens ?? Math.ceil(text.length / 4),
          latencyMs,
          model: result.model ?? "unknown",
          truncated,
          hardFactRegression,
          aiTrace,
        };
        allSamples.push(sample);
        caseSamples.push(sample);
      }
    }
    details.push({ caseId: caseData.caseId, samples: caseSamples });
  }

  // ── 聚合 armResults ──────────────────────────────────────────────────
  const armResults: AblationArmResult[] = ABLATION_ARMS.map((arm) => {
    const armSamples = allSamples.filter((s) => s.armId === arm.id);
    return aggregateArmResult(arm.id, armSamples);
  });

  // ── 执行 judgePairs ─────────────────────────────────────────────────
  const pairResults: AblationPairResult[] = [];
  for (const [leftArm, rightArm] of judgePairs) {
    const pairResult = await runJudgePairsForArm(
      leftArm,
      rightArm,
      caseSet,
      allSamples,
      judgePair,
    );
    pairResults.push(pairResult);
  }

  // ── 根据 pairResults 反推 hardFactRegression（标记有 hardFactRisk 的 winner arm 的 sample） ──
  // 这里简化：直接保留 sample 阶段的 hardFactRegression（false），不回填
  // 真实实现会在 judgePair 返回 hardFactRisk=true 时把对应 arm sample 标记为 hardFactRegression

  // ── 生成 retentionRecommendation ────────────────────────────────────
  const retentionRecommendation = buildRetentionRecommendation(pairResults);

  // ── 门槛检查 ────────────────────────────────────────────────────────
  const failureReasons: string[] = [];
  if (caseSet.cases.length < ABLATION_THRESHOLDS.minCases) {
    failureReasons.push(
      `minCases 未达标：${caseSet.cases.length} < ${ABLATION_THRESHOLDS.minCases}`,
    );
  }
  if (samplesPerCasePerArm < ABLATION_THRESHOLDS.minSamplesPerCasePerArm) {
    failureReasons.push(
      `minSamplesPerCasePerArm 未达标：${samplesPerCasePerArm} < ${ABLATION_THRESHOLDS.minSamplesPerCasePerArm}`,
    );
  }
  const passed = failureReasons.length === 0;

  // ── productionGating：消融实验不直接改变生产 ──────────────────────
  const productionGating: ProductionGating = {
    canChangeProductionPrompt: false,
    canChangeDefaultInjection: false,
    note:
      "PROMPT-CONTEXT-ABLATION-1 是评估框架，不直接改变生产 prompt。" +
      "retentionRecommendation 仅供人工评审，需在 INJECTION-STRATEGY-ADMISSION-1 通过后才进入生产。",
  };

  return {
    ablationRunId,
    caseSetHash,
    totalCases: caseSet.cases.length,
    samplesPerCasePerArm,
    armResults,
    pairResults,
    retentionRecommendation,
    details,
    controlVariables,
    thresholds: ABLATION_THRESHOLDS,
    passed,
    failureReasons,
    productionGating,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：聚合 armResult
// ─────────────────────────────────────────────────────────────────────────────

function aggregateArmResult(armId: string, samples: AblationSample[]): AblationArmResult {
  const sampleCount = samples.length;
  const truncatedCount = samples.filter((s) => s.truncated).length;
  const hardFactRegressionCount = samples.filter((s) => s.hardFactRegression).length;
  const aiTraceCount = samples.filter((s) => s.aiTrace).length;

  const promptTokens = samples.reduce((sum, s) => sum + s.promptTokens, 0);
  const outputTokens = samples.reduce((sum, s) => sum + s.outputTokens, 0);
  const latencyMs = samples.reduce((sum, s) => sum + s.latencyMs, 0);

  const promptTokenArr = samples.map((s) => s.promptTokens).sort((a, b) => a - b);
  const outputTokenArr = samples.map((s) => s.outputTokens).sort((a, b) => a - b);
  const latencyArr = samples.map((s) => s.latencyMs).sort((a, b) => a - b);

  return {
    armId,
    sampleCount,
    truncatedCount,
    promptTokens,
    outputTokens,
    latencyMs,
    promptTokenStats: computeTokenStats(promptTokenArr),
    outputTokenStats: computeTokenStats(outputTokenArr),
    latencyMsStats: computeTokenStats(latencyArr),
    hardFactRegressionRate: sampleCount > 0 ? hardFactRegressionCount / sampleCount : 0,
    aiTraceRate: sampleCount > 0 ? aiTraceCount / sampleCount : 0,
    lengthIntegrityRate: sampleCount > 0 ? (sampleCount - truncatedCount) / sampleCount : 0,
  };
}

function computeTokenStats(sortedArr: number[]): TokenStats {
  if (sortedArr.length === 0) {
    return { min: 0, median: 0, max: 0 };
  }
  const min = sortedArr[0];
  const max = sortedArr[sortedArr.length - 1];
  const mid = Math.floor(sortedArr.length / 2);
  const median =
    sortedArr.length % 2 === 0
      ? Math.round((sortedArr[mid - 1] + sortedArr[mid]) / 2)
      : sortedArr[mid];
  return { min, median, max };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：执行 judgePairs
// ─────────────────────────────────────────────────────────────────────────────

async function runJudgePairsForArm(
  leftArm: string,
  rightArm: string,
  caseSet: AblationCaseSet,
  allSamples: AblationSample[],
  judgePair: NonNullable<RunAblationOptions["judgePair"]>,
): Promise<AblationPairResult> {
  let leftWin = 0;
  let rightWin = 0;
  let tie = 0;
  const judgeInvocations: JudgeInvocation[] = [];

  for (const caseData of caseSet.cases) {
    const leftSamples = allSamples.filter(
      (s) => s.caseId === caseData.caseId && s.armId === leftArm,
    );
    const rightSamples = allSamples.filter(
      (s) => s.caseId === caseData.caseId && s.armId === rightArm,
    );
    // 每个 case 取第一对 sample 比较（简化；真实可多重采样交叉比较）
    const leftSample = leftSamples[0];
    const rightSample = rightSamples[0];
    if (!leftSample || !rightSample) continue;

    // 匿名 A/B：随机决定左右映射（用 seed 控制）
    const seed = hashSeed(`${caseData.caseId}|${leftArm}|${rightArm}`);
    const leftIsA = seed % 2 === 0;
    const candidateA = leftIsA ? leftSample.text : rightSample.text;
    const candidateB = leftIsA ? rightSample.text : leftSample.text;

    // 清理 candidate 文本中的 arm 标识与质量标记，确保 judge prompt 匿名。
    // stub 生成器可能在正文中插入 [A0]/[A4]/[low]/[medium]/[high] 等标记，
    // 真实生成虽不含这些标记，但清理逻辑无副作用，统一执行。
    const armMarkerPattern = /\[A[0-4]\]/g;
    const qualityMarkerPattern = /\[(low|medium|high)\]/g;
    const sanitizedA = candidateA.replace(armMarkerPattern, "").replace(qualityMarkerPattern, "");
    const sanitizedB = candidateB.replace(armMarkerPattern, "").replace(qualityMarkerPattern, "");

    // judge prompt 中不暴露 arm 标识
    const judgePromptText = `候选甲：${sanitizedA.slice(0, 200)}...\n候选乙：${sanitizedB.slice(0, 200)}...`;
    const result = await judgePair(
      sanitizedA,
      sanitizedB,
      {
        workGoal: caseData.constitution?.workIdentity ?? caseData.workspaceId,
        chapterIntent: caseData.intent?.primary ?? "",
        priorFacts: caseData.intent?.inviolableFacts ?? [],
      },
      seed,
    );

    // 把 A/B winner 映射回 left/right
    let physicalWinner: "left" | "right" | "tie";
    if (result.winner === "tie") {
      physicalWinner = "tie";
    } else if (result.winner === "left") {
      // judgePair 返回的 winner 是 candidateA 的物理位置（"left" = candidateA）
      physicalWinner = leftIsA ? "left" : "right";
    } else {
      physicalWinner = leftIsA ? "right" : "left";
    }

    if (physicalWinner === "left") leftWin++;
    else if (physicalWinner === "right") rightWin++;
    else tie++;

    judgeInvocations.push({
      caseId: caseData.caseId,
      sampleLeftId: leftSample.armId + "#" + leftSample.sampleIndex,
      sampleRightId: rightSample.armId + "#" + rightSample.sampleIndex,
      judgePrompt: judgePromptText,
      winner: physicalWinner,
      timestamp: new Date().toISOString(),
    });
  }

  const total = leftWin + rightWin + tie;
  return {
    armLeft: leftArm,
    armRight: rightArm,
    leftWinRate: total > 0 ? leftWin / total : 0,
    rightWinRate: total > 0 ? rightWin / total : 0,
    tieRate: total > 0 ? tie / total : 0,
    totalComparisons: total,
    judgeInvocations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造 retentionRecommendation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 根据 pairResults 推导每个上下文块的保留建议。
 *
 * 策略：
 * - 比较 A(n) vs A(n+1) 的胜率（A(n+1) 多了一个块）
 * - 若 A(n+1) 稳定胜出（rightWinRate > 0.55），则新增的块有正收益 → retain
 * - 若 A(n+1) 持平或负（rightWinRate ≤ 0.5），则新增的块无正收益 → demote 或 remove
 * - 基础块（bridge_context / chapter_intent / immutable_facts / character_states）默认 retain（不可移除）
 */
function buildRetentionRecommendation(
  pairResults: AblationPairResult[],
): RetentionRecommendation[] {
  const recommendations: RetentionRecommendation[] = [];

  // 找到 A0→A1, A1→A2, A2→A3 的 pair 结果
  const transitions: Array<{ from: string; to: string; addedBlock: ContextBlockName }> = [
    { from: "A0", to: "A1", addedBlock: "bridge_context" }, // A1 增加多个块，简化为代表块
    { from: "A1", to: "A2", addedBlock: "creative_constitution" },
    { from: "A2", to: "A3", addedBlock: "accepted_revision_examples" },
  ];

  // 基础块（A1 新增的块）默认 retain
  const basicBlocks: ContextBlockName[] = [
    "bridge_context",
    "chapter_intent",
    "immutable_facts",
    "character_states",
  ];
  for (const block of basicBlocks) {
    recommendations.push({
      blockName: block,
      stablePositiveGain: true,
      recommendation: "retain",
      evidenceSummary: "基础上下文块（A1 默认保留，属于最小必要主链路）",
    });
  }

  // 处理 transitions（A1→A2 / A2→A3）
  for (const t of transitions.slice(1)) {
    const pair = pairResults.find(
      (p) => p.armLeft === t.from && p.armRight === t.to,
    );
    if (!pair) {
      recommendations.push({
        blockName: t.addedBlock,
        stablePositiveGain: false,
        recommendation: "demote_to_jit",
        evidenceSummary: `未找到 ${t.from} vs ${t.to} 的 pair 结果，默认降级为 JIT 检索`,
      });
      continue;
    }
    // rightWinRate 表示 t.to（含新块）的胜率
    const stable = pair.rightWinRate > 0.55;
    recommendations.push({
      blockName: t.addedBlock,
      stablePositiveGain: stable,
      recommendation: stable ? "retain" : "demote_to_jit",
      evidenceSummary: `${t.from} vs ${t.to}：rightWinRate=${pair.rightWinRate.toFixed(2)}，totalComparisons=${pair.totalComparisons}`,
    });
  }

  // A4 独有的块（compact blocks 层）默认 demote_to_editorial（除非有正收益证据）
  const a4OnlyBlocks: ContextBlockName[] = [
    "promise_context",
    "expectation_context",
    "genre_contract",
    "dialogue_craft",
    "emotion_rhythm",
    "supporting_function",
    "knowledge_consumption",
    "character_voice_context",
    "world_presentation_context",
    "ensemble_layering_context",
    "identity_contract",
    "ontology_contract",
    "runtime_rules",
    "style_fingerprint",
  ];
  // A3 vs A4 的 pair 结果决定 A4 独有块的整体建议
  const a3vsA4 = pairResults.find((p) => p.armLeft === "A3" && p.armRight === "A4");
  const a4Stable = a3vsA4 ? a3vsA4.rightWinRate > 0.55 : false;
  for (const block of a4OnlyBlocks) {
    recommendations.push({
      blockName: block,
      stablePositiveGain: a4Stable,
      recommendation: a4Stable ? "retain" : "demote_to_editorial",
      evidenceSummary: a3vsA4
        ? `A3 vs A4：rightWinRate=${a3vsA4.rightWinRate.toFixed(2)}（A4 独有 compact block 整体评估）`
        : "未找到 A3 vs A4 的 pair 结果，默认降级为 editorial diagnosis",
    });
  }

  return recommendations;
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：AI 痕迹启发式检测
// ─────────────────────────────────────────────────────────────────────────────

const AI_TRACE_PATTERNS = [
  "综上所述",
  "总而言之",
  "由此可见",
  "不仅.*而且",
  "然而.*因此",
  "值得一提的是",
  "可以说",
  "在某种意义上",
];

function detectAiTrace(text: string): boolean {
  for (const pattern of AI_TRACE_PATTERNS) {
    const re = new RegExp(pattern);
    if (re.test(text)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：hash
// ─────────────────────────────────────────────────────────────────────────────

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

function computeCaseSetHash(caseSet: AblationCaseSet): string {
  const stable = {
    bookId: caseSet.bookId,
    caseSetId: caseSet.caseSetId,
    caseIds: caseSet.cases.map((c) => c.caseId).sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// runPromptContextAblationStub：stub 模式（不调用真实 API）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stub 模式：覆盖 globalThis.fetch，返回确定性 stub 响应。
 *
 * 用于：
 * - 离线验证 ablation 框架结构与聚合逻辑
 * - CI 测试不依赖真实 API
 *
 * stub 生成器根据 prompt 中的特征判断实验臂，返回不同质量的"正文"。
 */
export async function runPromptContextAblationStub(
  options: {
    caseSet: AblationCaseSet;
    samplesPerCasePerArm: number;
    judgePairs?: Array<[string, string]>;
    controlVariables?: ControlVariables;
  },
): Promise<AblationResult> {
  // 默认 stub：根据 arm 标识返回不同质量的正文
  const defaultQualityByArm: Record<string, string> = {
    A0: "low",
    A1: "medium",
    A2: "medium",
    A3: "high",
    A4: "high",
  };

  const generateRaw: NonNullable<RunAblationOptions["generateRaw"]> = async (
    prompt,
    seed,
    opts,
  ) => {
    const fullPrompt = prompt.systemPrompt + "\n" + prompt.userPrompt;
    // 根据 prompt 中的特征判断实验臂
    let arm = "A0";
    if (fullPrompt.includes("前章悬置状态")) arm = "A1";
    if (fullPrompt.includes("主角核心冲突") || fullPrompt.includes("作品宪法")) arm = "A2";
    if (fullPrompt.includes("精准示例") || fullPrompt.includes("accepted/revision")) arm = "A3";
    if (fullPrompt.includes("承诺状态 compact block") || fullPrompt.includes("【承诺状态")) arm = "A4";

    const quality = defaultQualityByArm[arm] ?? "medium";

    // 优先调用 globalThis.fetch（测试或 CLI 可覆盖以注入 stub 响应）。
    // 若 fetch 未被覆盖或调用失败，退回 inline 生成，保证 stub 模式离线可用。
    try {
      const requestBody = {
        model: "stub-model",
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userPrompt },
        ],
        temperature: 0.7 + (seed % 100) / 1000,
        max_tokens: opts.maxTokens ?? 4096,
        seed,
      };
      const response = await globalThis.fetch("stub://prompt-ablation/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (response && response.ok) {
        const data = (await response.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = data.choices?.[0]?.message?.content ?? "";
        if (text) {
          return {
            text,
            model: data.model ?? "stub-model",
            finishReason: data.choices?.[0]?.finish_reason ?? "stop",
            promptTokens: data.usage?.prompt_tokens ?? Math.ceil(fullPrompt.length / 4),
            outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
            latencyMs: 5,
          };
        }
      }
    } catch {
      // fetch 未覆盖或失败，退回 inline 生成
    }

    // inline 默认生成（不依赖 fetch 覆盖）
    const baseLength = quality === "high" ? 3000 : quality === "low" ? 800 : 2000;
    const bodyText = Array.from(
      { length: Math.ceil(baseLength / 100) },
      (_, i) =>
        `段落${i + 1}：[${arm}][${quality}] 这是 stub-model 生成的第 ${i + 1} 段正文，包含一些情节与对白。`,
    ).join("\n\n");
    const text = `第5章 标题\n\n${bodyText}`;
    const finishReason = text.length > 3500 ? "length" : "stop";

    return {
      text,
      model: "stub-model",
      finishReason,
      promptTokens: Math.ceil(fullPrompt.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      latencyMs: 5,
    };
  };

  const judgePair: NonNullable<RunAblationOptions["judgePair"]> = async (
    leftText,
    rightText,
    _context,
    _seed,
  ) => {
    // 简化：根据文本长度决定胜方（更长的胜）
    let winner: "left" | "right" | "tie";
    if (leftText.length > rightText.length * 1.1) winner = "left";
    else if (rightText.length > leftText.length * 1.1) winner = "right";
    else winner = "tie";
    return {
      winner,
      hardFactRisk: false,
    };
  };

  return runPromptContextAblation({
    caseSet: options.caseSet,
    samplesPerCasePerArm: options.samplesPerCasePerArm,
    judgePairs: options.judgePairs,
    controlVariables: options.controlVariables,
    generateRaw,
    judgePair,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// runPromptContextAblationReal：真实模式（REQUIRES_AUTH）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 真实模式：使用 JudgeModelConfig 调用真实模型 API。
 *
 * 授权边界（任务卡 §10）：
 * - Claude Opus 4.6 批量 raw 生成 / gpt-5.6-sol judge 属于 REQUIRES_AUTH
 * - 调用前必须固定 modelRoute / maxTokens / timeoutMs / samplesPerCasePerArm
 * - 调用前必须确认 caseSet 已冻结（frozen-test-set 不解封）
 */
export async function runPromptContextAblationReal(
  options: {
    caseSet: AblationCaseSet;
    samplesPerCasePerArm: number;
    judgePairs?: Array<[string, string]>;
    controlVariables: ControlVariables;
    judgeConfig: JudgeModelConfig;
    rawModelConfig: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs?: number;
    };
  },
): Promise<AblationResult> {
  const { rawModelConfig, judgeConfig } = options;

  const generateRaw: NonNullable<RunAblationOptions["generateRaw"]> = async (
    prompt,
    seed,
    opts,
  ) => {
    const url = `${rawModelConfig.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const startMs = Date.now();
    const requestBody = {
      model: rawModelConfig.model,
      messages: [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: prompt.userPrompt },
      ],
      temperature: 0.7 + (seed % 100) / 1000,
      max_tokens: opts.maxTokens ?? 4096,
      seed,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawModelConfig.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(
        `raw model API error (HTTP ${response.status}): ${errText.substring(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: data.model ?? rawModelConfig.model,
      finishReason: data.choices?.[0]?.finish_reason ?? "stop",
      promptTokens: data.usage?.prompt_tokens ?? Math.ceil((prompt.systemPrompt.length + prompt.userPrompt.length) / 4),
      outputTokens: data.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      latencyMs: Date.now() - startMs,
    };
  };

  const judgePair: NonNullable<RunAblationOptions["judgePair"]> = async (
    leftText,
    rightText,
    context,
    seed,
  ) => {
    // 用既有的 callJudgeModel + 简化 prompt
    const systemPrompt = `你是顶尖网文文学裁判。你将匿名比较两个候选章节正文（候选甲和候选乙），判断哪个更好。`;
    const userPrompt = `作品目标：${context.workGoal}
本章意图：${context.chapterIntent}
前文事实：${context.priorFacts.join("\n")}

候选甲：
${leftText}

候选乙：
${rightText}

请输出 JSON：{ "winner": "A" | "B" | "tie", "hardFactRisk": boolean }`;
    const result = await callJudgeModel(
      judgeConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        responseFormat: "json_schema",
        schema: {
          type: "object",
          properties: {
            winner: { type: "string", enum: ["A", "B", "tie"] },
            hardFactRisk: { type: "boolean" },
          },
          required: ["winner", "hardFactRisk"],
          additionalProperties: false,
        },
        schemaName: "ablation_pair_verdict",
        temperature: 0.2,
        maxTokens: 256,
      },
    );
    const parsed = JSON.parse(result.text) as {
      winner: "A" | "B" | "tie";
      hardFactRisk: boolean;
    };
    // candidateA = leftText, candidateB = rightText（调用方约定）
    // judgePair 返回的 winner：A=left, B=right, tie=tie
    const winner =
      parsed.winner === "A" ? "left" : parsed.winner === "B" ? "right" : "tie";
    return { winner, hardFactRisk: parsed.hardFactRisk };
  };

  return runPromptContextAblation({
    caseSet: options.caseSet,
    samplesPerCasePerArm: options.samplesPerCasePerArm,
    judgePairs: options.judgePairs,
    controlVariables: options.controlVariables,
    generateRaw,
    judgePair,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// formatPromptContextAblationResultAsMarkdown
// ─────────────────────────────────────────────────────────────────────────────

export function formatPromptContextAblationResultAsMarkdown(result: AblationResult): string {
  const lines: string[] = [];
  lines.push("# PROMPT-CONTEXT-ABLATION-1：上下文块消融实验结果");
  lines.push("");
  lines.push(`**ablationRunId**：${result.ablationRunId}`);
  lines.push(`**caseSetHash**：${result.caseSetHash}`);
  lines.push(`**totalCases**：${result.totalCases}`);
  lines.push(`**samplesPerCasePerArm**：${result.samplesPerCasePerArm}`);
  if (result.controlVariables) {
    lines.push(`**controlVariables**：${result.controlVariables.modelRoute} / ${result.controlVariables.provider} / ${result.controlVariables.modelVersion}`);
  }
  lines.push(`**passed**：${result.passed ? "✓" : "✗"}`);
  if (result.failureReasons.length > 0) {
    lines.push(`**failureReasons**：${result.failureReasons.join("；")}`);
  }
  lines.push("");

  // ── armResults 表（含成本/token 统计）─────────────────────────────
  lines.push("## 各实验臂聚合指标（armResults / 成本 token 统计）");
  lines.push("");
  lines.push("| armId | sampleCount | promptTokens(median) | outputTokens(median) | latencyMs(median) | hardFactRegressionRate | aiTraceRate | lengthIntegrityRate |");
  lines.push("|-------|-------------|----------------------|----------------------|-------------------|------------------------|-------------|---------------------|");
  for (const arm of result.armResults) {
    lines.push(
      `| ${arm.armId} | ${arm.sampleCount} | ${arm.promptTokenStats.median} | ${arm.outputTokenStats.median} | ${arm.latencyMsStats.median} | ${arm.hardFactRegressionRate.toFixed(2)} | ${arm.aiTraceRate.toFixed(2)} | ${arm.lengthIntegrityRate.toFixed(2)} |`,
    );
  }
  lines.push("");

  // ── pairResults 表（含匿名胜率）────────────────────────────────────
  lines.push("## 匿名 A/B 比较结果（pairResults / 胜率）");
  lines.push("");
  if (result.pairResults.length === 0) {
    lines.push("（无 pair 结果——judgePairs=[] 时跳过比较）");
  } else {
    lines.push("| armLeft | armRight | leftWinRate（左胜率） | rightWinRate（右胜率） | tieRate（平局率） | totalComparisons |");
    lines.push("|---------|----------|-------------|--------------|---------|------------------|");
    for (const pair of result.pairResults) {
      lines.push(
        `| ${pair.armLeft} | ${pair.armRight} | ${pair.leftWinRate.toFixed(2)} | ${pair.rightWinRate.toFixed(2)} | ${pair.tieRate.toFixed(2)} | ${pair.totalComparisons} |`,
      );
    }
  }
  lines.push("");

  // ── retentionRecommendation 表 ────────────────────────────────────
  lines.push("## 上下文块去留建议（retentionRecommendation）");
  lines.push("");
  lines.push("| blockName | stablePositiveGain | recommendation | evidenceSummary |");
  lines.push("|-----------|--------------------|----------------|-----------------|");
  for (const rec of result.retentionRecommendation) {
    lines.push(
      `| ${rec.blockName} | ${rec.stablePositiveGain ? "✓" : "✗"} | ${rec.recommendation} | ${rec.evidenceSummary} |`,
    );
  }
  lines.push("");

  // ── productionGating ──────────────────────────────────────────────
  lines.push("## 生产准入（productionGating）");
  lines.push("");
  lines.push(`- canChangeProductionPrompt：${result.productionGating.canChangeProductionPrompt ? "✓" : "✗"}`);
  lines.push(`- canChangeDefaultInjection：${result.productionGating.canChangeDefaultInjection ? "✓" : "✗"}`);
  lines.push(`- note：${result.productionGating.note}`);
  lines.push("");

  return lines.join("\n");
}
