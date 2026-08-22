/**
 * 规划模型结构化输出：生产只接受 JSON envelope，marker 不作为动作控制面。
 */
import { ASSISTANT_ACTIONS, type AssistantAction } from '../context/types';
import { FAILURE_CODES, FailureHttpException, makeFailure } from '../context/failure-envelope';
import { stripGenerateChapterMarker, type ParsedCharacter, type ParsedChapterSeed } from './assistant-markers';

export interface PlannerEnvelope {
  reply: string;
  /** auto 模式下模型判断的动作；显式模式为 undefined。 */
  action?: AssistantAction;
  storyOutline?: string;
  characters?: ParsedCharacter[];
  chapterSeed?: Omit<ParsedChapterSeed, 'chapterNumber'> & { chapterNumber?: number };
}

const ROLE_TYPES = new Set(['protagonist', 'supporting', 'antagonist', 'other']);

/**
 * 解析规划模型输出。
 * @param action 显式动作（沿用请求参数）；undefined = auto 模式，动作由模型输出的 action 字段决定。
 */
export function parsePlannerEnvelope(raw: string, action?: AssistantAction): PlannerEnvelope {
  const json = extractJsonObject(raw);
  if (!json) {
    if (action === 'query_project') {
      return { reply: stripGenerateChapterMarker(raw).trim() || '（无内容）' };
    }
    if (action === undefined) {
      // auto 模式：纯文本回复视为资料查询（闲聊/问答降级，不写库）。
      return { reply: stripGenerateChapterMarker(raw).trim() || '（无内容）', action: 'query_project' };
    }
    throw schemaError('规划结果不是结构化 JSON，未写入作品数据。请重试。');
  }
  const reply = typeof json.reply === 'string' ? stripGenerateChapterMarker(json.reply).trim() : '';
  if (!reply) throw schemaError('结构化输出缺少 reply 字段');

  if (action === undefined) {
    const inferred = json.action;
    if (typeof inferred !== 'string' || !(ASSISTANT_ACTIONS as readonly string[]).includes(inferred)) {
      throw schemaError('结构化输出缺少合法的 action 字段，无法判断意图。请重试。');
    }
    return parseForAction(json, reply, inferred as AssistantAction, true);
  }
  return parseForAction(json, reply, action, false);
}

function parseForAction(
  json: Record<string, unknown>,
  reply: string,
  action: AssistantAction,
  auto: boolean,
): PlannerEnvelope {
  const envelope: PlannerEnvelope = auto ? { reply, action } : { reply };
  if (action === 'plan_story_outline') {
    const outline = typeof json.storyOutline === 'string' ? json.storyOutline.trim() : '';
    if (!outline) throw schemaError('全书规划必须提供 storyOutline');
    envelope.storyOutline = outline;
    envelope.characters = parseCharacters(json.characters);
  }
  if (action === 'plan_chapter') {
    const seed = parseSeed(json.chapterSeed);
    if (!seed) throw schemaError('章节规划必须提供 chapterSeed');
    envelope.chapterSeed = seed;
  }
  if (action === 'generate_chapter') {
    envelope.chapterSeed = parseSeed(json.chapterSeed) ?? undefined;
  }
  return envelope;
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const direct = tryParseObject(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParseObject(candidate.slice(start, end + 1));
  return null;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseCharacters(value: unknown): ParsedCharacter[] {
  if (!Array.isArray(value)) return [];
  const parsed: ParsedCharacter[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    const roleType = typeof row.roleType === 'string' && ROLE_TYPES.has(row.roleType)
      ? row.roleType
      : 'other';
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    parsed.push({ name, roleType, description });
  }
  return parsed;
}

function parseSeed(value: unknown): PlannerEnvelope['chapterSeed'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const intent = typeof row.intent === 'string' ? row.intent.trim() : '';
  const endingGoal = typeof row.endingGoal === 'string' ? row.endingGoal.trim() : '';
  if (!intent && !endingGoal) return null;
  const chapterNumber = typeof row.chapterNumber === 'number' ? row.chapterNumber : undefined;
  return {
    chapterNumber,
    intent,
    mustInclude: typeof row.mustInclude === 'string' ? row.mustInclude : '',
    forbiddenFacts: typeof row.forbiddenFacts === 'string' ? row.forbiddenFacts : '',
    characterMotives: typeof row.characterMotives === 'string' ? row.characterMotives : '',
    promises: typeof row.promises === 'string' ? row.promises : '',
    endingGoal,
  };
}

function schemaError(reason: string): FailureHttpException {
  return new FailureHttpException(makeFailure({
    stage: 'assistant.planner',
    gate: 'planner_schema',
    code: FAILURE_CODES.plannerSchemaInvalid,
    severity: 'recoverable',
    reason,
    recoverable: true,
    retryPlan: 'retry_same_stage',
  }));
}
