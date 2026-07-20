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
} from "./judge-types.js";

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
}

// ============================================================================
// System Prompt
// ============================================================================

const JUDGE_SYSTEM_PROMPT = `你是顶尖网文文学裁判。你的任务是直接比较两个匿名候选正文 A 与 B 的文学胜负，不暴露任何身份信息。

裁判原则：
- 直接比较，不做绝对打分。不要给 A 或 B 单独打分后再比大小，必须直接说出哪个更好。
- 所有负面判断必须引用正文 span：给出"位置 start-end"与"原文片段"，否则判断无效。
- 允许 tie（平局）或 uncertain（无法判断）。当两者质量接近或都存在问题导致无法清晰分出胜负时，判 tie。
- 默认保留基线：如果你无法清晰判断某个候选明显更优，判 tie。
- 比较维度参考（非机械清单，不必逐条覆盖）：中文自然度、网文节奏、情节推进、角色能动性、群像层次、读者体验兑现、章末钩子、信息释放、情绪重量、连续性。
- 不可破坏事实：若某候选改变了已确立的世界事实或前章承接，这是硬伤。

JUDGE-CALIBRATION-1（篇幅与 clear 门槛审慎）：
- 审慎对待篇幅差异：如果一候选明显比另一候选长（增加了内容/场景/铺垫），必须判断增加的内容是否真正提升了读者体验。增加篇幅本身不是优势--可能拖慢节奏、稀释张力、增加读者负担。只有当增加的内容在读者体验上有明确且无争议的收益时，才算该候选的优势。
- 节奏与简洁性是独立维度：更紧凑、更快入场、更少冗余的候选在节奏上有真实优势，即使它"少了内容"。不要因为一候选"内容更多/更丰富"就认为它更好。
- 对于开篇/引入性质的内容，节奏简洁和快速入场尤其重要；冗长铺垫是减分项，不是加分项。
- 判 clear 必须谨慎：只有当一个候选在关键维度上明显且无争议地优于另一个时才判 clear。判 clear 前，先问自己：另一个候选是否有任何被牺牲的优点（如更紧凑的节奏、更快的入场、更少的拖沓）？如果有任何合理的反向论据，应判 slight 或 tie，而不是 clear。
- 当一候选因增加内容而变长时，对它的胜出尤其要审慎：优先判 slight（触发反向复判）而非 clear，让反向复判确认增加的内容确实值得。

输出要求：只输出一段 JSON，不要附加解释。JSON 结构：
{
  "winner": "A" | "B" | "tie",
  "confidence": "clear" | "slight" | "uncertain",
  "decisiveReasons": [
    {
      "dimension": "比较维度名",
      "betterCandidate": "A" | "B" | "neither",
      "evidenceA": [{"start": 数字, "end": 数字, "excerpt": "原文片段"}],
      "evidenceB": [{"start": 数字, "end": 数字, "excerpt": "原文片段"}],
      "explanation": "为什么这个候选在这个维度更优/更差"
    }
  ],
  "factualRisks": ["事实风险描述，需引用 span"],
  "regressionRisks": ["退化风险描述，需引用 span"],
  "constitutionAlignment": "两候选对作品宪法的对齐情况"
}

规则：
- winner 为 A 或 B 时，decisiveReasons 至少 1 条，且被判定更差的一方的 evidence 必须非空（引用其问题 span）。
- winner 为 tie 时，confidence 通常为 slight 或 uncertain；decisiveReasons 可为空或 betterCandidate=neither。
- evidenceA/evidenceB 的 start/end 是相对各自候选正文的字符位置（从 0 开始）。
- 不允许只说"A 更好"而不引用具体 span。`;

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
  userParts.push("【候选 A】");
  userParts.push(candidateAText);
  userParts.push(`（候选 A 总字符数：${candidateAText.length}）`);

  // 候选 B
  userParts.push("【候选 B】");
  userParts.push(candidateBText);
  userParts.push(`（候选 B 总字符数：${candidateBText.length}）`);

  // 提示规则
  userParts.push(
    "请直接比较 A 与 B。evidenceA 的 start/end 相对候选 A 正文位置，evidenceB 相对候选 B 正文位置。所有负面判断必须引用 span。"
  );

  return {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt: userParts.join("\n\n"),
  };
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

    const winner = parseWinner(obj.winner);
    const confidence = parseConfidence(obj.confidence);
    if (!winner || !confidence) return null;

    const decisiveReasons = parseDecisiveReasons(obj.decisiveReasons);
    const factualRisks = parseStringArray(obj.factualRisks);
    const regressionRisks = parseStringArray(obj.regressionRisks);
    const constitutionAlignment =
      typeof obj.constitutionAlignment === "string" ? obj.constitutionAlignment : "";

    return {
      winner,
      confidence,
      decisiveReasons,
      factualRisks,
      regressionRisks,
      constitutionAlignment,
    };
  } catch {
    return null;
  }
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
  if (v === "A" || v === "B" || v === "tie") return v;
  return null;
}

function parseConfidence(v: unknown): JudgeConfidence | null {
  if (v === "clear" || v === "slight" || v === "uncertain") return v;
  return null;
}

function parseDecisiveReasons(v: unknown): DecisiveReason[] {
  if (!Array.isArray(v)) return [];
  const result: DecisiveReason[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const better = obj.betterCandidate;
    if (better !== "A" && better !== "B" && better !== "neither") continue;
    const dimension = typeof obj.dimension === "string" ? obj.dimension : "";
    const explanation = typeof obj.explanation === "string" ? obj.explanation : "";
    const evidenceA = parseSpans(obj.evidenceA);
    const evidenceB = parseSpans(obj.evidenceB);
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
    const start = typeof obj.start === "number" ? obj.start : -1;
    const end = typeof obj.end === "number" ? obj.end : -1;
    if (start < 0 || end < 0) continue;
    const excerpt = typeof obj.excerpt === "string" ? obj.excerpt : "";
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
