/**
 * JudgePromptBuilder — LLM 文学裁判 prompt 构建器（Phase 4，计划 §Phase 4 + §5）
 *
 * 构建匿名 A/B 比较 prompt，让 LLM 直接比较两个候选的文学胜负。
 *
 * 设计原则（计划 §5 裁判协议）：
 * - 候选匿名为 A/B，不暴露模型/route/raw/amplified 身份
 * - 顺序随机化（由 AnonymousMapping 决定，本 builder 只渲染）
 * - 不允许绝对打分决定胜负，必须直接比较
 * - 所有负面判断必须引用正文 span（位置 + 原文片段）
 * - 允许 tie/uncertain，默认保留 raw
 * - 结构化 JSON verdict 输出
 *
 * 本模块只构建 prompt 与解析 LLM 输出，不调用 LLM（调用在 pairwise-literary-judge.ts）。
 */

import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { ConstitutionSnapshot, TextSpan } from "./types.js";
import type {
  AnonymousMapping,
  DecisiveReason,
  JudgeConfidence,
  JudgeVerdict,
  JudgeWinner,
  ReaderExperiencePreference,
  ReaderExperienceVerdict,
} from "./judge-types.js";
import { localizeLlmText, restoreLlmExcerpt } from "../../utils/llm-language-guard.js";

// ============================================================================
// 输入/输出类型
// ============================================================================

export interface JudgePromptInput {
  /** 候选 A 正文（已按 mapping 匿名化） */
  candidateAText: string;
  /** 候选 B 正文（已按 mapping 匿名化） */
  candidateBText: string;
  /** 匿名映射（决定谁是 A 谁是 B） */
  mapping: AnonymousMapping;
  /** 章节意图（提供比较维度参考，非控制清单） */
  intent: ChapterIntent;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
}

export interface JudgePromptResult {
  systemPrompt: string;
  userPrompt: string;
  constitutionConsumedFields: string[];
}

// ============================================================================
// System Prompt
// ============================================================================

const JUDGE_SYSTEM_PROMPT = `你是顶尖网文文学裁判。你的任务是直接比较两个匿名候选正文甲与乙的文学胜负，不暴露任何身份信息。

裁判原则：
- 直接比较，不做绝对打分。不要给甲或乙单独打分后再比大小，必须直接说出哪个更好。
- 所有负面判断必须引用正文片段：给出起点、终点与原文，否则判断无效。
- 允许平局或无法判断。当两者质量接近或都存在问题导致无法清晰分出胜负时，判平局。
- 默认保留基线：如果你无法清晰判断某个候选明显更优，判平局。
- 使用八维直接比较，不计算总分：中文原生语感、人物声音与行为可信度、目标-阻力-选择-结果、情绪推进与兑现、信息释放、场景细节与沉浸、章末因果压力、世界观和连续性。
- 不可破坏事实：若某候选改变了已确立的世界事实或前章承接，这是硬伤。

裁判主判层（高于结构工整度）：
- 中文原生语感、小说语感、场景沉浸感是主判层。先判断读者是否像在读自然成立的中文小说，人物、感官、动作与语气是否把读者留在场内。
- 结构完整、验证步骤、因果说明属于辅助证据，不能自动压过读者体验。验证步骤更多本身不是文学优势；只有新增步骤真正增强悬念、人物或沉浸时才计为优势。
- 解释得更清楚不等于写得更好。直接替读者命名情绪、总结规则、解释技法或复述已由场景表达的结论，应视为可能破坏小说语感与沉浸的风险。
- 不要把分析报告式的严密、显式因果说明或信息数量，当成中文小说质量的代理指标。若一方中文感、小说语感和场景沉浸明显更强，且没有事实硬伤，结构更繁复的另一方不得仅凭“更完整”胜出。
- 先完成独立的八维读者体验判决，再分析事实风险，并给出读者第一选择。
- 总胜者必须与“读者第一选择”一致，除非该候选存在明确事实硬伤；若因事实硬伤改判，必须在事实风险中引用具体正文证据。不得用结构完整度推翻读者第一选择。

裁判校准规则一（篇幅与明确胜出门槛审慎）：
- 审慎对待篇幅差异：如果一候选明显比另一候选长（增加了内容/场景/铺垫），必须判断增加的内容是否真正提升了读者体验。增加篇幅本身不是优势--可能拖慢节奏、稀释张力、增加读者负担。只有当增加的内容在读者体验上有明确且无争议的收益时，才算该候选的优势。
- 节奏与简洁性是独立维度：更紧凑、更快入场、更少冗余的候选在节奏上有真实优势，即使它"少了内容"。不要因为一候选"内容更多/更丰富"就认为它更好。
- 对于开篇/引入性质的内容，节奏简洁和快速入场尤其重要；冗长铺垫是减分项，不是加分项。
- 判明确胜出必须谨慎：只有当一个候选在关键维度上明显且无争议地优于另一个时才判明确胜出。判定前，先问自己：另一个候选是否有任何被牺牲的优点？如果有合理的反向论据，应判轻微胜出或平局。
- 当一候选因增加内容而变长时，对它的胜出尤其要审慎：优先判轻微胜出以触发反向复判，让复判确认增加的内容确实值得。

输出要求：只输出一段结构化数据，不要附加解释。结构如下：
{
  "胜者": "甲" | "乙" | "平局",
  "置信程度": "明确" | "轻微" | "不确定",
  "读者体验判决": {
    "首选阅读候选": "甲" | "乙" | "平局",
    "中文原生语感": "甲" | "乙" | "平局",
    "人物声音与行为可信度": "甲" | "乙" | "平局",
    "目标-阻力-选择-结果": "甲" | "乙" | "平局",
    "情绪推进与兑现": "甲" | "乙" | "平局",
    "信息释放": "甲" | "乙" | "平局",
    "场景细节与沉浸": "甲" | "乙" | "平局",
    "章末因果压力": "甲" | "乙" | "平局",
    "世界观和连续性": "甲" | "乙" | "平局",
    "说明": "从普通中文小说读者体验出发的简短理由"
  },
  "决定性理由": [
    {
      "比较维度": "比较维度名",
      "较优候选": "甲" | "乙" | "均不",
      "甲方证据": [{"起点": 数字, "终点": 数字, "原文": "原文片段"}],
      "乙方证据": [{"起点": 数字, "终点": 数字, "原文": "原文片段"}],
      "说明": "为什么这个候选在这个维度更优或更差"
    }
  ],
  "事实风险": ["事实风险描述，需引用正文片段"],
  "退化风险": ["退化风险描述，需引用正文片段"],
  "宪法对齐": "两候选对作品宪法的对齐情况"
}

规则：
- 胜者为甲或乙时，决定性理由至少 1 条，且被判定更差一方的证据必须非空。
- 胜者为平局时，置信程度通常为轻微或不确定；决定性理由可为空或较优候选为均不。
- 甲方证据和乙方证据的起点、终点是相对各自候选正文的字符位置，从 0 开始。
- 不允许只说某方更好而不引用具体正文片段。`;

// ============================================================================
// Prompt 构建
// ============================================================================

export function buildJudgePrompt(input: JudgePromptInput): JudgePromptResult {
  const { candidateAText, candidateBText, intent, constitution } = input;

  const userParts: string[] = [];

  userParts.push("请比较以下两个匿名候选正文的文学胜负。");

  // 章节意图（方向参考，非控制清单）
  userParts.push(buildIntentBlock(intent, constitution));

  // 候选 A
  userParts.push("【候选甲】");
  userParts.push(candidateAText);
  userParts.push(`（候选甲总字符数：${candidateAText.length}）`);

  // 候选 B
  userParts.push("【候选乙】");
  userParts.push(candidateBText);
  userParts.push(`（候选乙总字符数：${candidateBText.length}）`);

  // 提示规则
  userParts.push(
    "请直接比较甲与乙。甲方证据的起点和终点相对候选甲正文位置，乙方证据相对候选乙正文位置。所有负面判断必须引用正文片段。"
  );

  return {
    systemPrompt: localizeLlmText(JUDGE_SYSTEM_PROMPT),
    userPrompt: localizeLlmText(userParts.join("\n\n")),
    constitutionConsumedFields: getJudgeConstitutionConsumedFields(constitution),
  };
}

export function getJudgeConstitutionConsumedFields(
  constitution: ConstitutionSnapshot | null
): string[] {
  if (!constitution) return [];
  const fields: string[] = [];
  if (constitution.protagonistCoreConflict?.trim()) {
    fields.push("constitution.protagonistCoreConflict");
  }
  if (Array.isArray(constitution.readerPromise) && constitution.readerPromise.length > 0) {
    fields.push("constitution.readerPromise");
  }
  return fields;
}

function buildIntentBlock(
  intent: ChapterIntent,
  constitution: ConstitutionSnapshot | null
): string {
  const lines: string[] = ["【本章比较参考（方向，非必须逐条覆盖的清单）】"];
  if (intent.chapterFunction) lines.push(`章节功能：${intent.chapterFunction}`);
  if (intent.readerExperience.length > 0) {
    lines.push(`读者体验目标：${intent.readerExperience.join("、")}`);
  }
  if (intent.inviolableFacts.length > 0) {
    lines.push(`不可破坏事实：${intent.inviolableFacts.join("；")}`);
  }
  if (constitution?.protagonistCoreConflict) {
    lines.push(`主角核心冲突：${constitution.protagonistCoreConflict}`);
  }
  if (constitution?.readerPromise?.length) {
    lines.push(`作品承诺：${constitution.readerPromise.join("；")}`);
  }
  return lines.join("\n");
}

// ============================================================================
// Verdict 解析
// ============================================================================

/**
 * 从 LLM 输出解析 JudgeVerdict。失败返回 null。
 *
 * 处理三种情况：纯 JSON / ```json 代码块 / 含前后说明文字的 JSON。
 * 字段校验：winner/confidence/decisiveReasons 必须合法。
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  if (!text || !text.trim()) return null;
  try {
    const json = extractJson(text);
    if (!json) return null;
    const obj = JSON.parse(json) as Record<string, unknown>;

    const winner = parseWinner(obj.winner ?? obj["胜者"]);
    const confidence = parseConfidence(obj.confidence ?? obj["置信程度"]);
    if (!winner || !confidence) return null;

    const decisiveReasons = parseDecisiveReasons(obj.decisiveReasons ?? obj["决定性理由"]);
    const readerExperience = parseReaderExperience(obj.readerExperience ?? obj["读者体验判决"]);
    const factualRisks = parseStringArray(obj.factualRisks ?? obj["事实风险"]);
    const regressionRisks = parseStringArray(obj.regressionRisks ?? obj["退化风险"]);
    const alignmentValue = obj.constitutionAlignment ?? obj["宪法对齐"];
    const constitutionAlignment =
      typeof alignmentValue === "string" ? alignmentValue : "";

    return {
      winner,
      confidence,
      ...(readerExperience ? { readerExperience } : {}),
      decisiveReasons,
      factualRisks,
      regressionRisks,
      constitutionAlignment,
    };
  } catch {
    return null;
  }
}

function parseReaderExperience(v: unknown): ReaderExperienceVerdict | null {
  if (typeof v !== "object" || v === null) return null;
  const obj = v as Record<string, unknown>;
  const preferredCandidate = parseReaderPreference(obj.preferredCandidate ?? obj["首选阅读候选"]);
  const nativeChinese = parseReaderPreference(obj.nativeChinese ?? obj["中文原生语感"]);
  const characterCredibility = parseReaderPreference(obj.characterCredibility ?? obj["人物声音与行为可信度"]);
  const goalObstacleChoiceResult = parseReaderPreference(obj.goalObstacleChoiceResult ?? obj["目标-阻力-选择-结果"]);
  const emotionalProgression = parseReaderPreference(obj.emotionalProgression ?? obj["情绪推进与兑现"]);
  const informationRelease = parseReaderPreference(obj.informationRelease ?? obj["信息释放"]);
  const sceneImmersion = parseReaderPreference(obj.sceneImmersion ?? obj["场景细节与沉浸"]);
  const causalEndPressure = parseReaderPreference(obj.causalEndPressure ?? obj["章末因果压力"]);
  const worldContinuity = parseReaderPreference(obj.worldContinuity ?? obj["世界观和连续性"]);
  const rationaleValue = obj.rationale ?? obj["说明"];
  const rationale = typeof rationaleValue === "string" ? rationaleValue.trim() : "";
  if (!preferredCandidate || !nativeChinese || !characterCredibility || !goalObstacleChoiceResult ||
      !emotionalProgression || !informationRelease || !sceneImmersion || !causalEndPressure ||
      !worldContinuity || !rationale) return null;
  return {
    preferredCandidate,
    nativeChinese,
    characterCredibility,
    goalObstacleChoiceResult,
    emotionalProgression,
    informationRelease,
    sceneImmersion,
    causalEndPressure,
    worldContinuity,
    rationale,
  };
}

function parseReaderPreference(v: unknown): ReaderExperiencePreference | null {
  if (v === "甲") return "A";
  if (v === "乙") return "B";
  if (v === "平局") return "tie";
  if (v === "A" || v === "B" || v === "tie") return v;
  return null;
}

/** 把模型基于中文化视图返回的证据片段恢复为候选原文。 */
export function restoreJudgeVerdictExcerpts(
  verdict: JudgeVerdict,
  candidateAText: string,
  candidateBText: string,
): JudgeVerdict {
  return {
    ...verdict,
    decisiveReasons: verdict.decisiveReasons.map((reason) => ({
      ...reason,
      evidenceA: restoreSpans(reason.evidenceA, candidateAText),
      evidenceB: restoreSpans(reason.evidenceB, candidateBText),
    })),
  };
}

function restoreSpans(spans: TextSpan[], sourceText: string): TextSpan[] {
  return spans.map((span) => {
    const original = restoreLlmExcerpt(
      sourceText,
      span.start,
      span.end,
      span.excerpt ?? "",
    );
    return original === null ? span : { ...span, excerpt: original };
  });
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{")) return inner;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return null;
}

function parseWinner(v: unknown): JudgeWinner | null {
  if (v === "甲") return "A";
  if (v === "乙") return "B";
  if (v === "平局") return "tie";
  if (v === "A" || v === "B" || v === "tie") return v;
  return null;
}

function parseConfidence(v: unknown): JudgeConfidence | null {
  if (v === "明确") return "clear";
  if (v === "轻微") return "slight";
  if (v === "不确定") return "uncertain";
  if (v === "clear" || v === "slight" || v === "uncertain") return v;
  return null;
}

function parseDecisiveReasons(v: unknown): DecisiveReason[] {
  if (!Array.isArray(v)) return [];
  const result: DecisiveReason[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const rawBetter = obj.betterCandidate ?? obj["较优候选"];
    const better = rawBetter === "甲"
      ? "A"
      : rawBetter === "乙"
        ? "B"
        : rawBetter === "均不"
          ? "neither"
          : rawBetter;
    if (better !== "A" && better !== "B" && better !== "neither") continue;
    const dimensionValue = obj.dimension ?? obj["比较维度"];
    const explanationValue = obj.explanation ?? obj["说明"];
    const dimension = typeof dimensionValue === "string" ? dimensionValue : "";
    const explanation = typeof explanationValue === "string" ? explanationValue : "";
    const evidenceA = parseSpans(obj.evidenceA ?? obj["甲方证据"]);
    const evidenceB = parseSpans(obj.evidenceB ?? obj["乙方证据"]);
    result.push({
      dimension,
      betterCandidate: better,
      evidenceA,
      evidenceB,
      explanation,
    });
  }
  return result;
}

function parseSpans(v: unknown): TextSpan[] {
  if (!Array.isArray(v)) return [];
  const result: TextSpan[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const startValue = obj.start ?? obj["起点"];
    const endValue = obj.end ?? obj["终点"];
    const start = typeof startValue === "number" ? startValue : -1;
    const end = typeof endValue === "number" ? endValue : -1;
    if (start < 0 || end < 0) continue;
    const excerptValue = obj.excerpt ?? obj["原文"];
    const excerpt = typeof excerptValue === "string" ? excerptValue : "";
    result.push({ start, end, excerpt });
  }
  return result;
}

function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.length > 0);
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createJudgePromptBuilder() {
  return {
    build: buildJudgePrompt,
    parse: parseJudgeVerdict,
  };
}
