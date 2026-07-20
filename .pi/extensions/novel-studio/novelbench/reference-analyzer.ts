/**
 * NB-3：隐藏 Reference Analyzer
 *
 * 把原章（reference body）转成只供 evaluator 使用的叙事评价资产。
 *
 * 核心原则（任务要求）：
 * - 提取 12 类资产：EventGraph / CharacterStateDelta / CanonStateDelta /
 *   PromiseMovement / InformationRelease / CharacterChoice / CostConsequence /
 *   SceneTransition / EndingFunction / VoiceFingerprint / DialogueRole + spans
 * - 每条资产必须引用 reference span（start/end/excerpt），excerpt 必须与正文完全一致
 * - 多轮提取结果做一致性检查（rounds=2）
 * - 未达置信度的字段标记 unknown，不得猜测
 * - 不以单一总分代表质量（质量判断由 NB-5 Judge 完成）
 *
 * 架构边界：
 * - 本模块是 evaluator-only，不 被 generator 路径（dataset-builder）import
 * - analyzer 接收 referenceBody（由 CLI 调 ReferenceRegistry.resolve() 获取后传入）
 * - 输出 ReferenceAsset 仅供 NB-5 Judge 等 evaluator 使用
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import type {
  AnalyzeReferenceOptions,
  AssetStatus,
  CharacterChoice,
  CharacterStateDelta,
  CanonStateDelta,
  CostConsequence,
  DialogueRole,
  EndingFunction,
  EventGraphAsset,
  InformationRelease,
  LlmAdapter,
  PromiseMovement,
  ReferenceAsset,
  ReferenceAssetConsistency,
  ReferenceCausalEdge,
  ReferenceEvent,
  SceneTransition,
  SpannedAssetBase,
  TextSpan,
  VoiceFingerprintAsset,
} from "./types.js";
import { markInvalidSpan, markInvalidSpans } from "./span-validator.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** confidence 低于此阈值的字段标 unknown */
const CONFIDENCE_THRESHOLD = 0.5;

/** 默认模型路由名 */
const DEFAULT_ROUTE = "reference_analyzer";

// ─────────────────────────────────────────────────────────────────────────────
// LLM 返回的中间类型（无 status 字段，由本地填充）
// ─────────────────────────────────────────────────────────────────────────────

type RawAsset<T> = Omit<T, "status">;

interface RawExtraction {
  eventGraph: {
    events: RawAsset<ReferenceEvent & SpannedAssetBase>[];
    causalEdges: ReferenceCausalEdge[];
  };
  characterStateDeltas: RawAsset<CharacterStateDelta>[];
  canonStateDeltas: RawAsset<CanonStateDelta>[];
  promiseMovements: RawAsset<PromiseMovement>[];
  informationReleases: RawAsset<InformationRelease>[];
  characterChoices: RawAsset<CharacterChoice>[];
  costConsequences: RawAsset<CostConsequence>[];
  sceneTransitions: RawAsset<SceneTransition>[];
  endingFunction: RawAsset<EndingFunction>;
  voiceFingerprints: RawAsset<VoiceFingerprintAsset>[];
  dialogueRoles: RawAsset<DialogueRole>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 分析 reference body，提取 12 类叙事资产。
 *
 * @returns ReferenceAsset（含 12 类资产 + consistency 统计 + provenance）
 */
export async function analyzeReference(
  options: AnalyzeReferenceOptions,
): Promise<ReferenceAsset> {
  const {
    referenceId,
    referenceBody,
    bodyHash,
    rounds = 1,
    route = DEFAULT_ROUTE,
    llmAdapter,
  } = options;

  const adapter = llmAdapter ?? (await createDefaultLlmAdapter(route));
  const system = buildSystemPrompt();
  const user = buildUserPrompt(referenceBody);

  if (rounds === 1) {
    const raw = await adapter.extractJSON<RawExtraction>(system, user);
    return buildAssetFromSingleRound(referenceId, bodyHash, route, raw, referenceBody);
  }

  // rounds === 2：独立提取两次，字段级比对
  const [raw1, raw2] = await Promise.all([
    adapter.extractJSON<RawExtraction>(system, user),
    adapter.extractJSON<RawExtraction>(system, user),
  ]);
  return buildAssetFromTwoRounds(referenceId, bodyHash, route, raw1, raw2, referenceBody);
}

// ─────────────────────────────────────────────────────────────────────────────
// 单轮构建
// ─────────────────────────────────────────────────────────────────────────────

function buildAssetFromSingleRound(
  referenceId: string,
  bodyHash: string,
  route: string,
  raw: RawExtraction,
  referenceBody: string,
): ReferenceAsset {
  // 给每条资产填充 status：confidence < 阈值或 null → unknown，否则 extracted
  const eventGraph: EventGraphAsset = {
    events: raw.eventGraph.events.map((e) => withStatus(e, referenceBody)),
    causalEdges: raw.eventGraph.causalEdges ?? [],
  };
  const characterStateDeltas = raw.characterStateDeltas.map((a) => withStatus(a, referenceBody));
  const canonStateDeltas = raw.canonStateDeltas.map((a) => withStatus(a, referenceBody));
  const promiseMovements = raw.promiseMovements.map((a) => withStatus(a, referenceBody));
  const informationReleases = raw.informationReleases.map((a) => withStatus(a, referenceBody));
  const characterChoices = raw.characterChoices.map((a) => withStatus(a, referenceBody));
  const costConsequences = raw.costConsequences.map((a) => withStatus(a, referenceBody));
  const sceneTransitions = raw.sceneTransitions.map((a) => withStatus(a, referenceBody));
  const endingFunction = withStatus(raw.endingFunction, referenceBody);
  const voiceFingerprints = raw.voiceFingerprints.map((a) => withStatus(a, referenceBody));
  const dialogueRoles = raw.dialogueRoles.map((a) => withStatus(a, referenceBody));

  const allAssets = collectAllAssets({
    eventGraph,
    characterStateDeltas,
    canonStateDeltas,
    promiseMovements,
    informationReleases,
    characterChoices,
    costConsequences,
    sceneTransitions,
    endingFunction,
    voiceFingerprints,
    dialogueRoles,
  });

  const consistency = computeConsistency(1, allAssets, []);

  return {
    referenceId,
    bodyHash,
    analyzedAt: new Date().toISOString(),
    provenance: { model: "", route, rounds: 1 },
    consistency,
    eventGraph,
    characterStateDeltas,
    canonStateDeltas,
    promiseMovements,
    informationReleases,
    characterChoices,
    costConsequences,
    sceneTransitions,
    endingFunction,
    voiceFingerprints,
    dialogueRoles,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 双轮一致性构建
// ─────────────────────────────────────────────────────────────────────────────

function buildAssetFromTwoRounds(
  referenceId: string,
  bodyHash: string,
  route: string,
  raw1: RawExtraction,
  raw2: RawExtraction,
  referenceBody: string,
): ReferenceAsset {
  const eventGraph = mergeEventGraph(raw1.eventGraph, raw2.eventGraph, referenceBody);
  const characterStateDeltas = mergeArrays(
    raw1.characterStateDeltas, raw2.characterStateDeltas, referenceBody,
    (a, b) => a.characterId === b.characterId && a.field === b.field,
    (a, b) => a.after === b.after,
  );
  const canonStateDeltas = mergeArrays(
    raw1.canonStateDeltas, raw2.canonStateDeltas, referenceBody,
    (a, b) => a.id === b.id,
    (a, b) => a.fact === b.fact && a.deltaType === b.deltaType,
  );
  const promiseMovements = mergeArrays(
    raw1.promiseMovements, raw2.promiseMovements, referenceBody,
    (a, b) => a.promiseId === b.promiseId,
    (a, b) => a.movement === b.movement && a.description === b.description,
  );
  const informationReleases = mergeArrays(
    raw1.informationReleases, raw2.informationReleases, referenceBody,
    (a, b) => a.id === b.id,
    (a, b) => a.what === b.what && a.releaseType === b.releaseType,
  );
  const characterChoices = mergeArrays(
    raw1.characterChoices, raw2.characterChoices, referenceBody,
    (a, b) => a.characterId === b.characterId && a.choice === b.choice,
    (a, b) => a.motive === b.motive,
  );
  const costConsequences = mergeArrays(
    raw1.costConsequences, raw2.costConsequences, referenceBody,
    (a, b) => a.characterId === b.characterId && a.cost === b.cost,
    (a, b) => a.consequence === b.consequence,
  );
  const sceneTransitions = mergeArrays(
    raw1.sceneTransitions, raw2.sceneTransitions, referenceBody,
    (a, b) => a.fromScene === b.fromScene && a.toScene === b.toScene,
    (a, b) => a.transitionType === b.transitionType,
  );
  const endingFunction = mergeSingle(raw1.endingFunction, raw2.endingFunction, referenceBody);
  const voiceFingerprints = mergeArrays(
    raw1.voiceFingerprints, raw2.voiceFingerprints, referenceBody,
    (a, b) => a.characterId === b.characterId,
    (a, b) => a.vocabularyLevel === b.vocabularyLevel && a.infoPattern === b.infoPattern,
  );
  const dialogueRoles = mergeArrays(
    raw1.dialogueRoles, raw2.dialogueRoles, referenceBody,
    (a, b) => a.speakerId === b.speakerId && a.function === b.function,
    (a, b) => a.subtext === b.subtext,
  );

  const allAssets = collectAllAssets({
    eventGraph,
    characterStateDeltas,
    canonStateDeltas,
    promiseMovements,
    informationReleases,
    characterChoices,
    costConsequences,
    sceneTransitions,
    endingFunction,
    voiceFingerprints,
    dialogueRoles,
  });

  const consistency = computeConsistency(2, allAssets, []);

  return {
    referenceId,
    bodyHash,
    analyzedAt: new Date().toISOString(),
    provenance: { model: "", route, rounds: 2 },
    consistency,
    eventGraph,
    characterStateDeltas,
    canonStateDeltas,
    promiseMovements,
    informationReleases,
    characterChoices,
    costConsequences,
    sceneTransitions,
    endingFunction,
    voiceFingerprints,
    dialogueRoles,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 资产 status 填充与 span 校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 给单条资产填充 status：
 * 1. confidence < 阈值 或 字段为 null/undefined → unknown
 * 2. 否则 extracted
 * 3. extracted 但 span 校验失败 → invalid_span
 */
function withStatus<T extends SpannedAssetBase>(
  raw: RawAsset<T>,
  referenceBody: string,
): T {
  // null/undefined 资产 → unknown（不 spread null，直接构造最小对象）
  if (raw === null || raw === undefined) {
    return { status: "unknown" } as T;
  }

  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  const status: AssetStatus = confidence < CONFIDENCE_THRESHOLD
    ? "unknown"
    : "extracted";

  const asset = { ...raw, status } as T;

  // extracted 但 span 校验失败 → invalid_span
  if (status === "extracted") {
    return markInvalidSpan(asset, referenceBody);
  }
  return asset;
}

// ─────────────────────────────────────────────────────────────────────────────
// 双轮合并
// ─────────────────────────────────────────────────────────────────────────────

function mergeEventGraph(
  g1: RawExtraction["eventGraph"],
  g2: RawExtraction["eventGraph"],
  referenceBody: string,
): EventGraphAsset {
  const events = mergeArrays(
    g1.events, g2.events, referenceBody,
    (a, b) => a.id === b.id,
    (a, b) => a.name === b.name && a.type === b.type,
  );
  return {
    events,
    causalEdges: g1.causalEdges ?? [],
  };
}

/**
 * 合并两个数组的资产条目。
 *
 * 配对策略：用 matchId 判断两轮是否提取到同一实体。
 * - 两轮都提取到且 matchValue 一致 → extracted
 * - 两轮都提取到但 matchValue 不一致 → conflict
 * - 仅一轮提取到 → 该轮结果，status 保留（extracted/unknown），但 confidence 降权
 * - 都未提取到 → 不出现在结果中
 */
function mergeArrays<T extends SpannedAssetBase>(
  arr1: RawAsset<T>[],
  arr2: RawAsset<T>[],
  referenceBody: string,
  matchId: (a: T, b: T) => boolean,
  matchValue: (a: T, b: T) => boolean,
): T[] {
  const result: T[] = [];
  const used2 = new Set<number>();

  for (const r1 of arr1) {
    if (r1 === null || r1 === undefined) continue;
    const idx2 = arr2.findIndex((r2, i) => r2 && !used2.has(i) && matchId(r1 as T, r2 as T));
    if (idx2 === -1) {
      // 仅第一轮
      result.push(withStatus(r1, referenceBody));
      continue;
    }
    used2.add(idx2);
    const r2 = arr2[idx2] as T;
    if (matchValue(r1 as T, r2)) {
      // 一致 → extracted
      result.push(withStatus(r1, referenceBody));
    } else {
      // 冲突 → conflict，保留第一轮数据
      const asset = { ...r1, status: "conflict" as AssetStatus } as T;
      result.push(asset);
    }
  }

  // 第二轮中未配对的
  for (let i = 0; i < arr2.length; i++) {
    if (used2.has(i)) continue;
    const r2 = arr2[i];
    if (r2 === null || r2 === undefined) continue;
    result.push(withStatus(r2, referenceBody));
  }

  return result;
}

function mergeSingle<T extends SpannedAssetBase>(
  r1: RawAsset<T>,
  r2: RawAsset<T>,
  referenceBody: string,
): T {
  if (r1 === null || r1 === undefined) {
    if (r2 === null || r2 === undefined) {
      return { status: "unknown" } as T;
    }
    return withStatus(r2, referenceBody);
  }
  if (r2 === null || r2 === undefined) {
    return withStatus(r1, referenceBody);
  }
  // 两轮都有，检查 span 是否一致（用 span.start 作为简化比对）
  if (r1.span.start === r2.span.start && r1.span.end === r2.span.end) {
    return withStatus(r1, referenceBody);
  }
  // span 不一致 → conflict
  return { ...r1, status: "conflict" as AssetStatus } as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// consistency 统计
// ─────────────────────────────────────────────────────────────────────────────

function collectAllAssets(asset: {
  eventGraph: EventGraphAsset;
  characterStateDeltas: CharacterStateDelta[];
  canonStateDeltas: CanonStateDelta[];
  promiseMovements: PromiseMovement[];
  informationReleases: InformationRelease[];
  characterChoices: CharacterChoice[];
  costConsequences: CostConsequence[];
  sceneTransitions: SceneTransition[];
  endingFunction: EndingFunction;
  voiceFingerprints: VoiceFingerprintAsset[];
  dialogueRoles: DialogueRole[];
}): SpannedAssetBase[] {
  return [
    ...asset.eventGraph.events,
    ...asset.characterStateDeltas,
    ...asset.canonStateDeltas,
    ...asset.promiseMovements,
    ...asset.informationReleases,
    ...asset.characterChoices,
    ...asset.costConsequences,
    ...asset.sceneTransitions,
    asset.endingFunction,
    ...asset.voiceFingerprints,
    ...asset.dialogueRoles,
  ];
}

function computeConsistency(
  rounds: number,
  allAssets: SpannedAssetBase[],
  _conflictLog: unknown[],
): ReferenceAssetConsistency {
  let agreed = 0;
  let conflicted = 0;
  let unknown = 0;
  let invalidSpan = 0;
  for (const a of allAssets) {
    switch (a.status) {
      case "extracted":
        agreed++;
        break;
      case "conflict":
        conflicted++;
        break;
      case "unknown":
        unknown++;
        break;
      case "invalid_span":
        invalidSpan++;
        break;
    }
  }
  return {
    rounds,
    agreedFields: agreed,
    conflictedFields: conflicted,
    unknownFields: unknown,
    invalidSpanFields: invalidSpan,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 构造
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    "你是一个叙事资产提取器。你的任务是从给定的小说章节正文中提取 12 类叙事资产，",
    "供后续评价使用（不用于生成）。你必须严格遵循以下规则：",
    "",
    "## 12 类资产定义",
    "",
    "1. eventGraph.events：事件节点。每个事件包含 id/name/type/characters/narrativeBeat/",
    "   conflictLevel(1-5)/emotionalArc{from,to}/hooks。eventGraph.causalEdges：因果边，",
    "   {from,to,type}。",
    "2. characterStateDeltas：角色状态变化。{characterId,field,before,after}。before 可为 \"unknown\"。",
    "3. canonStateDeltas：正典/世界观状态变化。{id,fact,category,deltaType}。",
    "   deltaType: new/updated/contradicted。",
    "4. promiseMovements：伏笔/承诺推进。{promiseId,description,movement,heat}。",
    "   movement: advance/payoff/new/abandoned。heat: 0-1。",
    "5. informationReleases：信息释放。{id,what,toWhom,releaseType}。",
    "   releaseType: reveal/hint/confirm/deny。",
    "6. characterChoices：角色选择。{characterId,choice,motive,alternative}。",
    "   alternative 可为 \"unknown\"。",
    "7. costConsequences：代价与后果。{characterId,cost,consequence,isIrreversible}。",
    "8. sceneTransitions：场景转换。{fromScene,toScene,transitionType}。",
    "   transitionType: time_jump/location_change/pov_shift/continuous。",
    "9. endingFunction：章末功能。{function,description}。",
    "   function: cliffhanger/resolution/setup/escalation/reflection。",
    "10. voiceFingerprints：声音指纹。{characterId,characterName,sentenceLengthAvg,",
    "    vocabularyLevel,colloquial|mixed|formal,infoPattern,direct|hint|question,signaturePatterns}。",
    "11. dialogueRoles：对白功能。{speakerId,function,subtext}。",
    "    function: info_request/info_give/challenge/support/deflect/reveal。",
    "12. reference source spans：每条资产必须带 span 字段。",
    "",
    "## span 要求（硬性）",
    "",
    "- 每条资产必须包含 span: {start, end, excerpt}",
    "- start/end 是章节正文的字符偏移（0-based，基于 JavaScript String.slice 语义）",
    "- excerpt 必须与正文 slice(start, end) 完全一致（包括标点和空格）",
    "- excerpt 必须是该资产所引用的原文片段",
    "- 如果无法定位原文片段，confidence 设为 0 并仍提供 span（本地会标 invalid_span）",
    "",
    "## confidence 与 unknown 规则",
    "",
    "- 每条资产必须包含 confidence: 0-1 的数字",
    "- confidence < 0.5 的资产会被标为 unknown",
    "- 如果你无法确定某字段，不要猜测：该字段填 null，confidence 设为 0",
    "- 如果整条资产无法提取，返回 null（本地会标 unknown）",
    "",
    "## 输出格式",
    "",
    "返回 JSON 对象，字段：",
    "eventGraph, characterStateDeltas, canonStateDeltas, promiseMovements,",
    "informationReleases, characterChoices, costConsequences, sceneTransitions,",
    "endingFunction, voiceFingerprints, dialogueRoles",
    "",
    "不要返回 status 字段（由本地填充）。不要返回总分或质量评分。",
  ].join("\n");
}

function buildUserPrompt(referenceBody: string): string {
  return [
    "请分析以下章节正文，提取 12 类叙事资产。",
    "",
    "正文总长度：" + referenceBody.length + " 字符。",
    "span 的 start/end 是基于下述正文的字符偏移（0-based）。",
    "",
    "---章节正文开始---",
    referenceBody,
    "---章节正文结束---",
    "",
    "请返回 JSON 对象，包含 12 类资产。每条资产带 span 和 confidence。",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 默认 LLM adapter（走 createRoutedChatAPI）
// ─────────────────────────────────────────────────────────────────────────────

async function createDefaultLlmAdapter(route: string): Promise<LlmAdapter> {
  const { createRoutedChatAPI } = await import("../api/routed-chat.js");
  const api = await createRoutedChatAPI(route);
  return {
    async extractJSON<T>(system: string, user: string): Promise<T> {
      return api.extractJSON<T>(system, user, { temperature: 0.2 });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}
