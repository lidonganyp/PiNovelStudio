/**
 * AuthorStyleOptimizer — 对 NovelOS Agentic 初稿执行作品专属作者风格整章优化。
 *
 * 只消费风格档案中的定性指导，不把段长百分位、对白比例等统计值变成机械配额。
 * 输出仍须保留原有事件、人物关系、事实与知识边界，由编排器继续执行确定性门禁。
 */

import type { ModelGenerateFn, ModelGenerateInput } from "../adapters/legacy-model-route-adapter.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import { resolveEditorialCandidateRoute } from "./editorial-candidate-generator.js";
import { auditPrompt } from "./prompt-constraint-audit.js";
import type {
  Candidate,
  CompiledContext,
  ConstitutionSnapshot,
  StyleReference,
} from "./types.js";
import type { WriterPromptProfile } from "./model-prompt-adapter.js";

const STYLE_SYSTEM_PROMPT = `你是中文长篇小说的作者风格编辑。请在不改变故事事实、事件因果、人物关系、知识边界和章末压力的前提下，把完整初稿优化成指定作者的稳定写作风格。

风格档案只提供定性参考，历史统计不得转成正文配额。你可以重组表达，但不能删改关键事件，也不能补写档案、解释或分析。只输出优化后的完整章节正文。`;

const MAX_GUIDANCE_ITEMS = 12;
const MAX_GUIDANCE_CHARS = 1600;
const DEFAULT_TIMEOUT_MS = 600000;

export interface AuthorStyleOptimizationInput {
  sourceCandidate: Candidate;
  chapterNumber: number;
  intent: ChapterIntent;
  context: CompiledContext;
  constitution: ConstitutionSnapshot | null;
  writerPromptProfile?: WriterPromptProfile;
  modelGenerate: ModelGenerateFn;
  timeoutMs?: number;
}

export interface AuthorStyleOptimizationResult {
  candidate: Candidate | null;
  failureReason: string | null;
  styleProfileLoaded: boolean;
  styleGuidanceConsumed: boolean;
  styleReferenceIds: string[];
  guidanceCount: number;
}

interface ParsedStyleGuidance {
  referenceIds: string[];
  guidance: string[];
}

function parseStyleReference(reference: StyleReference): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(reference.content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
}

export function collectAuthorStyleGuidance(
  context: CompiledContext,
  relevantCharacters: string[],
): ParsedStyleGuidance {
  const referenceIds: string[] = [];
  const guidance: string[] = [];

  for (const reference of context.styleReferences.filter((entry) => entry.kind === "fingerprint")) {
    const payload = parseStyleReference(reference);
    if (!payload) continue;
    referenceIds.push(reference.id);
    guidance.push(...stringList(payload.editorialGuidance).map((item) => `[通用] ${item}`));

    const voices = payload.characterVoiceGuidance;
    if (voices && typeof voices === "object" && !Array.isArray(voices)) {
      const voiceMap = voices as Record<string, unknown>;
      for (const character of relevantCharacters) {
        guidance.push(...stringList(voiceMap[character]).map((item) => `[${character}] ${item}`));
      }
    }
  }

  const uniqueGuidance = [...new Set(guidance)]
    .slice(0, MAX_GUIDANCE_ITEMS)
    .reduce<string[]>((items, item) => {
      const nextLength = [...items, item].join("\n").length;
      return nextLength <= MAX_GUIDANCE_CHARS ? [...items, item] : items;
    }, []);

  return { referenceIds: [...new Set(referenceIds)], guidance: uniqueGuidance };
}

function buildUserPrompt(input: AuthorStyleOptimizationInput, guidance: ParsedStyleGuidance): string {
  const parts = [
    `请优化第 ${input.chapterNumber} 章完整正文。`,
    `【NovelOS Agentic 初稿】\n${input.sourceCandidate.text}`,
    `【作者风格档案（定性指导）】\n${guidance.guidance.map((item) => `- ${item}`).join("\n")}`,
  ];
  if (input.intent.inviolableFacts.length > 0) {
    parts.push(`【不可改变的事实】\n${input.intent.inviolableFacts.map((item) => `- ${item}`).join("\n")}`);
  }
  const forbiddenZones = input.intent.factAndCharacterKnowledgeForbiddenZones ?? [];
  if (forbiddenZones.length > 0) {
    parts.push(`【人物知识与事实禁区】\n${forbiddenZones.map((item) => `- ${item}`).join("\n")}`);
  }
  if (input.constitution?.forbiddenDrift.length) {
    parts.push(`【作品禁止漂移】\n${input.constitution.forbiddenDrift.map((item) => `- ${item}`).join("\n")}`);
  }
  parts.push("保留初稿中的关键事件、因果顺序、人物行动结果与章末压力。只输出优化后的完整正文。");
  return parts.join("\n\n");
}

export class AuthorStyleOptimizer {
  async optimize(input: AuthorStyleOptimizationInput): Promise<AuthorStyleOptimizationResult> {
    const styleGuidance = collectAuthorStyleGuidance(input.context, input.intent.relevantCharacters);
    if (styleGuidance.referenceIds.length === 0 || styleGuidance.guidance.length === 0) {
      return {
        candidate: null,
        failureReason: "作者风格档案缺失或没有可消费的定性指导",
        styleProfileLoaded: styleGuidance.referenceIds.length > 0,
        styleGuidanceConsumed: false,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
      };
    }

    const userPrompt = buildUserPrompt(input, styleGuidance);
    const promptProfile = auditPrompt(STYLE_SYSTEM_PROMPT, userPrompt);
    if (promptProfile.type === "control") {
      return {
        candidate: null,
        failureReason: "作者风格优化 prompt 被审计为机械控制型",
        styleProfileLoaded: true,
        styleGuidanceConsumed: false,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
      };
    }

    const route = resolveEditorialCandidateRoute(input.writerPromptProfile);
    const modelInput: ModelGenerateInput = {
      route,
      systemPrompt: STYLE_SYSTEM_PROMPT,
      userPrompt,
      kind: "author_style_optimization",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      promptProfile: input.writerPromptProfile,
    };

    try {
      const output = await input.modelGenerate(modelInput);
      if (!output.text?.trim()) {
        return {
          candidate: null,
          failureReason: "作者风格优化返回空文本",
          styleProfileLoaded: true,
          styleGuidanceConsumed: true,
          styleReferenceIds: styleGuidance.referenceIds,
          guidanceCount: styleGuidance.guidance.length,
        };
      }
      return {
        candidate: {
          id: `candidate:author_style:${input.sourceCandidate.id}`,
          text: output.text,
          kind: "editorial_amplified",
          model: output.model,
          route: output.route,
          contextHash: input.sourceCandidate.contextHash,
          generatedAt: new Date().toISOString(),
          durationMs: output.durationMs,
          promptProfile,
          sourceCandidateId: input.sourceCandidate.id,
          editorialStrategy: "author_style_full_chapter" as Candidate["editorialStrategy"],
          ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
          ...(output.maxTokens !== undefined ? { maxTokens: output.maxTokens } : {}),
        },
        failureReason: null,
        styleProfileLoaded: true,
        styleGuidanceConsumed: true,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
      };
    } catch (error: unknown) {
      return {
        candidate: null,
        failureReason: error instanceof Error ? error.message : String(error),
        styleProfileLoaded: true,
        styleGuidanceConsumed: true,
        styleReferenceIds: styleGuidance.referenceIds,
        guidanceCount: styleGuidance.guidance.length,
      };
    }
  }
}

export function createAuthorStyleOptimizer(): AuthorStyleOptimizer {
  return new AuthorStyleOptimizer();
}
