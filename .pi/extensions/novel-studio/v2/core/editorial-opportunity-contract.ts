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
import type { MethodologyDiagnosticState } from "./methodology-diagnostic-state.js";
import { localizeLlmText } from "../../utils/llm-language-guard.js";

export interface OpportunityDiagnosticSignal {
  opportunityType: EditorialOpportunityType;
  triggered: boolean;
  reason: string;
}

export interface ParsedOpportunity {
  opportunityType: EditorialOpportunityType;
  craftDomain: CraftPhenomenonDomain;
  diagnosis: string;
  evidenceExcerpt: string;
  expectedReaderGain: string;
  damageRisks: string[];
  contextEvidenceRefs: string[];
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
  /** Read-only accepted-state evidence for post-raw diagnosis only. */
  methodologyDiagnosticState?: MethodologyDiagnosticState;
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

const TOP_LEVEL_KEYS = new Set([
  "craftPhenomena", "工艺现象",
  "opportunities", "编辑机会",
  "noOpReason", "无操作原因",
]);

const OPPORTUNITY_KEYS = new Set([
  "opportunityType", "机会类型",
  "craftDomain", "工艺领域",
  "diagnosis", "问题诊断",
  "evidenceExcerpt", "证据原文",
  "expectedReaderGain", "预期收益",
  "damageRisks", "损伤风险",
  "contextEvidenceRefs", "状态证据引用",
  "confidence", "置信度",
]);

const CRAFT_OBSERVATION_KEYS = new Set([
  "domain", "工艺领域",
  "status", "状态",
  "phenomenon", "现象",
  "evidenceExcerpt", "证据原文",
  "contextEvidenceRefs", "状态证据引用",
  "readerImpact", "读者影响",
  "confidence", "置信度",
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
- 跨章健康的已观察或不确定现象还必须引用提供给你的状态证据引用；不得编造引用。
- 现象只描述观察与读者影响，不给分，不判通过，不直接下改写命令。

编辑机会规则：
- 只在存在明确、可引用正文片段证明的高价值机会时返回；没有明显整体收益就返回零个机会。
- 每个机会只解决一个主要问题，必须说明读者收益、损伤风险和所属工艺域。
- 跨章健康机会必须引用提供给你的状态证据引用；其他机会可为空数组。
- 最多两个互不冲突的机会。本地扫描可能误报，不能单独授权候选。
- 机会类型只能是：章末压力、人物选择、声音与自然度、读者回报、承诺推进、信息戏剧化、群像功能、关系进展。

只输出一个严格结构化对象，不要代码块或解释：
{
  "工艺现象": [{
    "工艺领域": "上述十个中文工艺域之一",
    "状态": "已观察|不确定|不适用",
    "现象": "具体观察",
    "证据原文": "逐字原文；不适用时为空字符串",
    "状态证据引用": ["跨章健康时至少一条；其他工艺域可为空"],
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
    "状态证据引用": ["跨章健康时至少一条；其他工艺域可为空"],
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
    const parsedJson = JSON.parse(json) as unknown;
    if (!isRecord(parsedJson) || !hasOnlyKeys(parsedJson, TOP_LEVEL_KEYS)) return null;
    const obj = parsedJson;
    const rawCraftPhenomena = readAliasedValue(obj, "craftPhenomena", "工艺现象");
    const rawOpportunities = readAliasedValue(obj, "opportunities", "编辑机会");
    const noOpReasonValue = readAliasedValue(obj, "noOpReason", "无操作原因");
    if (!rawCraftPhenomena.found || !Array.isArray(rawCraftPhenomena.value)) return null;
    if (!rawOpportunities.found || !Array.isArray(rawOpportunities.value)) return null;
    if (!noOpReasonValue.found || (noOpReasonValue.value !== null && typeof noOpReasonValue.value !== "string")) {
      return null;
    }

    const opportunities: ParsedOpportunity[] = [];
    if (rawOpportunities.value.length > 2) return null;
    for (const item of rawOpportunities.value) {
      const parsed = parseOpportunity(item);
      if (!parsed) return null;
      opportunities.push(parsed);
    }

    const craftObservations = parseCraftObservations(rawCraftPhenomena.value as unknown[]);
    if (!craftObservations) return null;
    const noOpReason = typeof noOpReasonValue.value === "string" && noOpReasonValue.value.trim()
      ? noOpReasonValue.value
      : null;
    if (opportunities.length === 0 && noOpReason === null) return null;
    if (opportunities.length > 0 && noOpReason !== null) return null;
    return {
      opportunities,
      craftObservations,
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
  if (input.methodologyDiagnosticState) {
    parts.push(
      `【跨章诊断状态（methodology-diagnostic-state-v1，仅用于 raw 后诊断）】\n${truncateJson(buildMethodologyPromptPayload(input.methodologyDiagnosticState), 9000)}`,
    );
  }

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
  const localizedUserPrompt = localizeLlmText(parts.join("\n\n"));
  const localizedSchemaId = localizeLlmText("methodology-diagnostic-state-v1");
  return {
    systemPrompt: localizeLlmText(OPPORTUNITY_SYSTEM_PROMPT),
    userPrompt: localizedUserPrompt.replaceAll(
      localizedSchemaId,
      "methodology-diagnostic-state-v1",
    ),
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
  if (!isRecord(item) || !hasOnlyKeys(item, OPPORTUNITY_KEYS)) return null;
  const value = item;
  const rawType = readAliasedValue(value, "opportunityType", "机会类型");
  if (!rawType.found) return null;
  const opportunityType = typeof rawType.value === "string"
    ? OPPORTUNITY_LABEL_TO_TYPE.get(rawType.value) ?? rawType.value
    : null;
  if (typeof opportunityType !== "string" || !VALID_OPPORTUNITY_TYPES.has(opportunityType)) return null;
  const diagnosis = readAliasedValue(value, "diagnosis", "问题诊断");
  const evidenceExcerpt = readAliasedValue(value, "evidenceExcerpt", "证据原文");
  const expectedReaderGain = readAliasedValue(value, "expectedReaderGain", "预期收益");
  const risks = readAliasedValue(value, "damageRisks", "损伤风险");
  const contextEvidenceRefs = readOptionalAliasedStringArray(
    value,
    "contextEvidenceRefs",
    "状态证据引用",
  );
  const rawConfidence = readAliasedValue(value, "confidence", "置信度");
  const rawDomain = readAliasedValue(value, "craftDomain", "工艺领域");
  if (!diagnosis.found || typeof diagnosis.value !== "string" || !diagnosis.value.trim()) return null;
  if (!evidenceExcerpt.found || typeof evidenceExcerpt.value !== "string" || !evidenceExcerpt.value.trim()) return null;
  if (!expectedReaderGain.found || typeof expectedReaderGain.value !== "string" || !expectedReaderGain.value.trim()) return null;
  if (!risks.found || !isNonEmptyStringArray(risks.value)) return null;
  if (!contextEvidenceRefs.valid) return null;
  if (!rawConfidence.found || !isConfidence(rawConfidence.value)) return null;
  if (!rawDomain.found || typeof rawDomain.value !== "string") return null;
  const craftDomain = typeof rawDomain.value === "string"
    ? parseCraftPhenomenonDomain(rawDomain.value)
    : null;
  if (!craftDomain) return null;
  if (craftDomain === "cross_chapter_health" && contextEvidenceRefs.value.length === 0) return null;
  return {
    opportunityType: opportunityType as EditorialOpportunityType,
    craftDomain,
    diagnosis: diagnosis.value.trim(),
    evidenceExcerpt: evidenceExcerpt.value.trim(),
    expectedReaderGain: expectedReaderGain.value.trim(),
    damageRisks: risks.value.map((risk) => risk.trim()),
    contextEvidenceRefs: contextEvidenceRefs.value,
    confidence: rawConfidence.value,
  };
}

function parseCraftObservations(raw: unknown[]): CraftPhenomenonObservationInput[] | null {
  const observations: CraftPhenomenonObservationInput[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !hasOnlyKeys(item, CRAFT_OBSERVATION_KEYS)) return null;
    const rawDomain = readAliasedValue(item, "domain", "工艺领域");
    const rawStatus = readAliasedValue(item, "status", "状态");
    const phenomenon = readAliasedValue(item, "phenomenon", "现象");
    const readerImpact = readAliasedValue(item, "readerImpact", "读者影响");
    const evidenceExcerpt = readAliasedValue(item, "evidenceExcerpt", "证据原文");
    const contextEvidenceRefs = readOptionalAliasedStringArray(
      item,
      "contextEvidenceRefs",
      "状态证据引用",
    );
    const confidence = readAliasedValue(item, "confidence", "置信度");
    if (!rawDomain.found || typeof rawDomain.value !== "string") return null;
    if (!rawStatus.found || typeof rawStatus.value !== "string") return null;
    const domain = parseCraftPhenomenonDomain(rawDomain.value);
    const status = parseCraftPhenomenonStatus(rawStatus.value);
    if (!domain || !status) return null;
    if (!phenomenon.found || typeof phenomenon.value !== "string" || !phenomenon.value.trim()) return null;
    if (!readerImpact.found || typeof readerImpact.value !== "string" || !readerImpact.value.trim()) return null;
    if (!evidenceExcerpt.found || typeof evidenceExcerpt.value !== "string") return null;
    if (status === "not_applicable" ? evidenceExcerpt.value.trim() : !evidenceExcerpt.value.trim()) return null;
    if (!contextEvidenceRefs.valid) return null;
    if (status === "not_applicable" && contextEvidenceRefs.value.length > 0) return null;
    if (domain === "cross_chapter_health" && status !== "not_applicable"
      && contextEvidenceRefs.value.length === 0) return null;
    if (!confidence.found || !isConfidence(confidence.value)) return null;
    observations.push({
      domain,
      status,
      phenomenon: phenomenon.value.trim(),
      readerImpact: readerImpact.value.trim(),
      ...(evidenceExcerpt.value.trim() ? { evidenceExcerpt: evidenceExcerpt.value.trim() } : {}),
      ...(contextEvidenceRefs.value.length > 0
        ? { contextEvidenceRefs: contextEvidenceRefs.value }
        : {}),
      confidence: confidence.value,
    });
  }
  return observations;
}

function readOptionalAliasedStringArray(
  value: Record<string, unknown>,
  englishKey: string,
  chineseKey: string,
): { valid: boolean; value: string[] } {
  const hasEnglish = Object.prototype.hasOwnProperty.call(value, englishKey);
  const hasChinese = Object.prototype.hasOwnProperty.call(value, chineseKey);
  if (hasEnglish && hasChinese) return { valid: false, value: [] };
  if (!hasEnglish && !hasChinese) return { valid: true, value: [] };
  const raw = hasEnglish ? value[englishKey] : value[chineseKey];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return { valid: false, value: [] };
  }
  return {
    valid: true,
    value: [...new Set(raw.map((entry) => (entry as string).trim()))],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function readAliasedValue(
  value: Record<string, unknown>,
  englishKey: string,
  chineseKey: string,
): { found: boolean; value: unknown } {
  const hasEnglish = Object.prototype.hasOwnProperty.call(value, englishKey);
  const hasChinese = Object.prototype.hasOwnProperty.call(value, chineseKey);
  if (hasEnglish === hasChinese) return { found: false, value: undefined };
  return { found: true, value: hasEnglish ? value[englishKey] : value[chineseKey] };
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
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

function buildMethodologyPromptPayload(state: MethodologyDiagnosticState): unknown {
  const { overdueAlerts, stagnation, fatigue, ...serialDetails } = state.serialState;
  const { climaxOpportunity, ...ensembleDetails } = state.ensemble;
  return {
    schemaVersion: state.schemaVersion,
    chapterNumber: state.chapterNumber,
    advisoryOnly: state.advisoryOnly,
    canEnterRawPrompt: state.canEnterRawPrompt,
    canDirectlyAuthorizeCandidate: state.canDirectlyAuthorizeCandidate,
    derivedSignals: {
      overdueAlerts,
      stagnation,
      fatigue: {
        severity: fatigue.severity,
        severitySignals: fatigue.severitySignals,
        sourceRefs: fatigue.sourceRefs,
      },
      climaxOpportunity,
    },
    declaredGenre: state.declaredGenre,
    serialState: { ...serialDetails, fatigue },
    worldRevelation: state.worldRevelation,
    ensemble: ensembleDetails,
    closure: state.closure,
    sources: state.sources,
  };
}

