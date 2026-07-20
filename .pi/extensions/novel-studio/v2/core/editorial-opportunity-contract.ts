/**
 * Editorial opportunity structured contract and post-raw methodology prompt.
 *
 * This module owns model-visible schema, Chinese/internal enum mapping, parsing,
 * and the single schema-repair prompt. It never calls a model or edits prose.
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { EditorialOpportunityType } from "./editorial-hypothesis.js";
import type { EditorialOpportunityAdvisory } from "./editorial-opportunity-advisory.js";
import type { VoiceFingerprintInput } from "./dialogue-craft-compiler.js";
import type {
  CompiledContext,
  ConstitutionSnapshot,
  LongTermStateSnapshot,
} from "./types.js";
import type {
  CraftPhenomenonDomain,
  CraftPhenomenonObservationInput,
  CraftPhenomenonStatus,
} from "./craft-phenomenon-report.js";
import { localizeLlmText } from "../../utils/llm-language-guard.js";

export interface OpportunityDiagnosticSignal {
  opportunityType: EditorialOpportunityType;
  triggered: boolean;
  reason: string;
}

export interface ParsedOpportunity {
  opportunityType: EditorialOpportunityType;
  craftDomain?: CraftPhenomenonDomain;
  diagnosis: string;
  evidenceExcerpt: string;
  expectedReaderGain: string;
  damageRisks: string[];
  confidence: number;
}

export interface ParsedOpportunityVerdict {
  opportunities: ParsedOpportunity[];
  craftObservations: CraftPhenomenonObservationInput[];
  noOpReason: string | null;
}

export interface OpportunityPromptInput {
  rawText: string;
  intent: ChapterIntent;
  scannedSignals: OpportunityDiagnosticSignal[];
  longTermState: LongTermStateSnapshot | null;
  constitution: ConstitutionSnapshot | null;
  context?: CompiledContext;
  voiceFingerprints?: VoiceFingerprintInput[];
  previousEmotionState?: string | null;
  craftAdvisory?: EditorialOpportunityAdvisory;
}

const VALID_OPPORTUNITY_TYPES = new Set<string>([
  "reader_payoff",
  "character_choice",
  "relationship_progress",
  "information_dramatization",
  "promise_advancement",
  "ensemble_function",
  "chapter_end_pressure",
  "voice_and_naturalness",
]);

const OPPORTUNITY_TYPE_LABELS: Readonly<Record<EditorialOpportunityType, string>> = {
  chapter_end_pressure: "章末压力",
  character_choice: "人物选择",
  voice_and_naturalness: "声音与自然度",
  reader_payoff: "读者回报",
  promise_advancement: "承诺推进",
  information_dramatization: "信息戏剧化",
  ensemble_function: "群像功能",
  relationship_progress: "关系进展",
};

const OPPORTUNITY_LABEL_TO_TYPE = new Map(
  Object.entries(OPPORTUNITY_TYPE_LABELS).map(([type, label]) => [label, type as EditorialOpportunityType]),
);

const CRAFT_DOMAIN_LABEL_TO_DOMAIN = new Map<string, CraftPhenomenonDomain>([
  ["对话工艺", "dialogue"],
  ["节奏与高潮", "rhythm_and_climax"],
  ["连载预期", "expectation_and_serial"],
  ["类型契约", "genre_contract"],
  ["配角功能", "supporting_characters"],
  ["世界观揭示", "world_revelation"],
  ["群像编排", "ensemble"],
  ["收尾闭合", "ending_and_closure"],
  ["章节推进", "chapter_progression"],
  ["跨章健康", "cross_chapter_health"],
]);

const INTERNAL_CRAFT_DOMAINS = new Set<string>([
  "dialogue",
  "rhythm_and_climax",
  "expectation_and_serial",
  "genre_contract",
  "supporting_characters",
  "world_revelation",
  "ensemble",
  "ending_and_closure",
  "chapter_progression",
  "cross_chapter_health",
]);

const OPPORTUNITY_SYSTEM_PROMPT = `你是证据驱动的中文长篇小说编辑。先理解本章，再判断是否值得生成编辑候选。方法论只帮助诊断，不是正文模板。

按章节相关性检查以下工艺域，不要求每章全部适用：
- 对话工艺：对话是否经历建立、升级和变化；是否改变信息、关系、目标或权力；角色声音是否同质；标签是否遮蔽动作。
- 节奏与高潮：冲突、信息与情绪是否发生有效变化；高潮是否有铺垫、引爆与余震；后果是否被人物承受。
- 连载预期：旧承诺是否推进或兑现；新问题是否由本章因果产生；是否存在预期疲劳、转移失败或回流章断联。
- 类型契约：当前主类型承诺是否得到阅读回报；恐怖的规律与主动选择、升级的路径与代价、言情的关系变化、推理的信息公平是否出现可定位偏差。
- 配角功能：配角是否承担镜像、信息、情感、障碍、补位、主题或读者代理功能；是否功能过载或无铺垫消失。
- 世界观揭示：世界信息是否按需要渐进揭示；是否存在信息倾倒、依赖缺失、释放版本错位或设定没有影响人物选择。
- 群像编排：焦点是否清晰；非焦点角色是否以有信息的行动存在；多线交汇和高潮余波是否改变关系格局。
- 收尾闭合：结尾是否回应本章因果；收尾阶段是否有伏笔遗漏、新坑、异常加速、角色失序、情感铺垫缺失或回落段缺失。
- 章节推进：从章初到章末，情节、信息、人物、世界、因果哪些真实变化；不能用词频或固定总分替代状态差。
- 跨章健康：结合长期状态检查预期超载、爽感通胀、连续停滞、人物失真、逻辑崩塌、情感断裂、模式疲劳；证据不足时只能标为不确定或不适用。

工艺现象规则：
- 状态只能是已观察、不确定、不适用。
- 已观察和不确定必须引用原始正文中逐字一致的连续片段；不适用的证据原文必须为空。
- 现象只描述观察与读者影响，不给分，不判通过，不直接下改写命令。

编辑机会规则：
- 只在存在明确、可引用正文片段证明的高价值机会时返回；没有明显整体收益就返回零个机会。
- 每个机会只解决一个主要问题，必须说明读者收益、损伤风险和所属工艺域。
- 最多两个互不冲突的机会。本地扫描可能误报，不能单独授权候选。
- 机会类型只能是：章末压力、人物选择、声音与自然度、读者回报、承诺推进、信息戏剧化、群像功能、关系进展。

只输出一个严格结构化对象，不要代码块或解释：
{
  "工艺现象": [{
    "工艺领域": "上述十个中文工艺域之一",
    "状态": "已观察|不确定|不适用",
    "现象": "具体观察",
    "证据原文": "逐字原文；不适用时为空字符串",
    "读者影响": "该现象可能怎样影响阅读",
    "置信度": 0.0
  }],
  "编辑机会": [{
    "机会类型": "上述八种中文类型之一",
    "工艺领域": "上述十个中文工艺域之一",
    "问题诊断": "具体问题",
    "证据原文": "逐字原文",
    "预期收益": "候选可能带来的读者收益",
    "损伤风险": ["至少一条可能损伤"],
    "置信度": 0.0
  }],
  "无操作原因": "无机会时说明原因；有机会时为空值"
}`;

const OPPORTUNITY_SCHEMA_REPAIR_SYSTEM_PROMPT = `你只负责修复结构化输出。不要重新评价正文，不要增加、删除或改写诊断内容。把输入转换为指定结构；无法恢复的条目丢弃。只输出结构化对象。`;

export function parseOpportunityVerdict(text: string): ParsedOpportunityVerdict | null {
  if (!text?.trim()) return null;
  try {
    const json = extractJsonObject(text);
    if (!json) return null;
    const obj = JSON.parse(json) as Record<string, unknown>;
    const rawOpportunities = obj.opportunities ?? obj["编辑机会"];
    if (rawOpportunities !== undefined && !Array.isArray(rawOpportunities)) return null;

    const opportunities: ParsedOpportunity[] = [];
    for (const item of Array.isArray(rawOpportunities) ? rawOpportunities : []) {
      const parsed = parseOpportunity(item);
      if (parsed) opportunities.push(parsed);
    }

    const noOpReasonValue = obj.noOpReason ?? obj["无操作原因"];
    const noOpReason = typeof noOpReasonValue === "string" && noOpReasonValue.trim()
      ? noOpReasonValue
      : null;
    return {
      opportunities,
      craftObservations: parseCraftObservations(obj),
      noOpReason,
    };
  } catch {
    return null;
  }
}

export function buildOpportunityPrompt(input: OpportunityPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const parts: string[] = ["【本章意图】"];
  const { intent } = input;
  if (intent.chapterFunction) parts.push(`功能：${intent.chapterFunction}`);
  if (intent.readerExperience.length) parts.push(`读者体验目标：${intent.readerExperience.join("、")}`);
  if (intent.currentPressure.length) parts.push(`当前压力：${intent.currentPressure.join("；")}`);
  if (intent.relevantCharacters.length) parts.push(`相关角色：${intent.relevantCharacters.join("、")}`);
  if (intent.inviolableFacts.length) parts.push(`不可破坏事实：${intent.inviolableFacts.join("；")}`);
  if (input.constitution) parts.push(`【作品承诺（诊断参照）】\n${truncateJson(input.constitution, 3000)}`);
  if (input.longTermState) parts.push(`【长期叙事状态（仅用于跨章诊断）】\n${truncateJson(input.longTermState, 6000)}`);
  if (input.context) {
    parts.push(`【本章相关故事状态（仅用于诊断）】\n${truncateJson({
      facts: input.context.facts,
      characterStates: input.context.characterStates,
      openLoops: input.context.openLoops,
      worldRules: input.context.worldRules,
      bridgeContext: input.context.bridgeContext,
    }, 7000)}`);
  }
  if (input.voiceFingerprints?.length) {
    parts.push(`【已接受文本的角色声音证据（仅用于漂移诊断）】\n${truncateJson(input.voiceFingerprints, 4000)}`);
  }
  if (input.previousEmotionState?.trim()) parts.push(`【前章已接受情绪落点】\n${input.previousEmotionState.trim()}`);

  const triggered = input.scannedSignals.filter((signal) => signal.triggered);
  if (triggered.length) {
    parts.push("【本地扫描证据（仅供参考，可能误报）】");
    for (const signal of triggered) {
      parts.push(`- ${OPPORTUNITY_TYPE_LABELS[signal.opportunityType]}：${signal.reason}`);
    }
  } else {
    parts.push("【本地扫描证据】无信号触发");
  }
  if (input.craftAdvisory?.promptBlock) parts.push(input.craftAdvisory.promptBlock);
  parts.push("【原始正文】", "---", input.rawText, "---");
  parts.push("请基于原始正文实际质量判断是否存在值得生成编辑候选的机会，只输出严格的结构化数据。");
  return {
    systemPrompt: localizeLlmText(OPPORTUNITY_SYSTEM_PROMPT),
    userPrompt: localizeLlmText(parts.join("\n\n")),
  };
}

export function buildOpportunitySchemaRepairPrompt(invalidOutput: string): {
  systemPrompt: string;
  userPrompt: string;
} {
  return {
    systemPrompt: localizeLlmText(OPPORTUNITY_SCHEMA_REPAIR_SYSTEM_PROMPT),
    userPrompt: localizeLlmText(
      `目标结构：\n${OPPORTUNITY_SYSTEM_PROMPT.slice(OPPORTUNITY_SYSTEM_PROMPT.indexOf("只输出一个严格结构化对象"))}\n\n待修复输出：\n${invalidOutput.slice(0, 12000)}`,
    ),
  };
}

function parseOpportunity(item: unknown): ParsedOpportunity | null {
  if (typeof item !== "object" || item === null) return null;
  const value = item as Record<string, unknown>;
  const rawType = value.opportunityType ?? value["机会类型"];
  const opportunityType = typeof rawType === "string"
    ? OPPORTUNITY_LABEL_TO_TYPE.get(rawType) ?? rawType
    : null;
  if (typeof opportunityType !== "string" || !VALID_OPPORTUNITY_TYPES.has(opportunityType)) return null;
  const diagnosis = value.diagnosis ?? value["问题诊断"];
  const evidenceExcerpt = value.evidenceExcerpt ?? value["证据原文"];
  const expectedReaderGain = value.expectedReaderGain ?? value["预期收益"];
  if (typeof diagnosis !== "string" || typeof evidenceExcerpt !== "string" || typeof expectedReaderGain !== "string") return null;
  const risks = value.damageRisks ?? value["损伤风险"];
  const rawConfidence = value.confidence ?? value["置信度"];
  const confidence = typeof rawConfidence === "number" ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;
  const rawDomain = value.craftDomain ?? value["工艺领域"];
  const craftDomain = typeof rawDomain === "string" ? parseCraftPhenomenonDomain(rawDomain) : null;
  return {
    opportunityType: opportunityType as EditorialOpportunityType,
    ...(craftDomain ? { craftDomain } : {}),
    diagnosis,
    evidenceExcerpt,
    expectedReaderGain,
    damageRisks: Array.isArray(risks) ? risks.filter((risk): risk is string => typeof risk === "string") : [],
    confidence,
  };
}

function parseCraftObservations(obj: Record<string, unknown>): CraftPhenomenonObservationInput[] {
  const raw = obj.craftPhenomena ?? obj["工艺现象"];
  if (!Array.isArray(raw)) return [];
  const observations: CraftPhenomenonObservationInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    const rawDomain = value.domain ?? value["工艺领域"];
    const rawStatus = value.status ?? value["状态"];
    const domain = typeof rawDomain === "string" ? parseCraftPhenomenonDomain(rawDomain) : null;
    const status = typeof rawStatus === "string" ? parseCraftPhenomenonStatus(rawStatus) : null;
    const phenomenon = value.phenomenon ?? value["现象"];
    const readerImpact = value.readerImpact ?? value["读者影响"];
    const evidenceExcerpt = value.evidenceExcerpt ?? value["证据原文"];
    const confidence = value.confidence ?? value["置信度"];
    if (!domain || !status || typeof phenomenon !== "string" || !phenomenon.trim()) continue;
    if (typeof readerImpact !== "string" || !readerImpact.trim()) continue;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) continue;
    observations.push({
      domain,
      status,
      phenomenon,
      readerImpact,
      ...(typeof evidenceExcerpt === "string" && evidenceExcerpt.trim() ? { evidenceExcerpt } : {}),
      confidence,
    });
  }
  return observations;
}

function parseCraftPhenomenonDomain(value: string): CraftPhenomenonDomain | null {
  if (INTERNAL_CRAFT_DOMAINS.has(value)) return value as CraftPhenomenonDomain;
  return CRAFT_DOMAIN_LABEL_TO_DOMAIN.get(value) ?? null;
}

function parseCraftPhenomenonStatus(value: string): CraftPhenomenonStatus | null {
  if (value === "observed" || value === "已观察") return "observed";
  if (value === "uncertain" || value === "不确定") return "uncertain";
  if (value === "not_applicable" || value === "不适用") return "not_applicable";
  return null;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : null;
}

function truncateJson(value: unknown, maxLength: number): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength)}...`;
}

