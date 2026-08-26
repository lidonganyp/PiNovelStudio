/**
 * 助手动作校验：显式 action 决定可保存的 artifact，marker 不能单独触发写库或生成。
 * action 缺省 = auto 模式：动作由规划模型判断（见 planner-envelope），落库仍走白名单。
 */
import {
  ACTION_ARTIFACT_WHITELIST,
  ASSISTANT_ACTIONS,
  type ArtifactType,
  type AssistantAction,
  type AssistantRequest,
  type ContinuationMode,
  type TargetWordRange,
} from './types';
import {
  FAILURE_CODES,
  FailureHttpException,
  makeFailure,
} from './failure-envelope';

const STEWARD_ACTIONS = ['apply_and_generate', 'save_draft', 'cancel', 'revise'] as const;

export function isAssistantAction(value: unknown): value is AssistantAction {
  return typeof value === 'string' && (ASSISTANT_ACTIONS as readonly string[]).includes(value);
}

export function parseAssistantRequest(input: {
  content?: unknown;
  action?: unknown;
  chapterNumber?: unknown;
  confirmGeneration?: unknown;
  continuationMode?: unknown;
  targetWordCount?: unknown;
  stewardAction?: unknown;
  proposalId?: unknown;
  sourceVersion?: unknown;
  confirmedFields?: unknown;
  proposalEdits?: unknown;
}): AssistantRequest {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.illegalAction,
      severity: 'preflight',
      reason: '请输入要发送的内容',
      recoverable: false,
      userActionRequired: ['填写对话内容'],
    }));
  }
  if (input.action !== undefined && !isAssistantAction(input.action)) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.illegalAction,
      severity: 'preflight',
      reason: '动作必须是：全书规划、章节规划、资料查询或生成正文之一',
      recoverable: false,
      userActionRequired: ['检查助手动作参数'],
    }));
  }
  const chapterNumber = parseOptionalChapterNumber(input.chapterNumber);
  const confirmGeneration = input.confirmGeneration === true;
  const continuationMode = input.continuationMode === 'append' || input.continuationMode === 'replace'
    ? input.continuationMode as ContinuationMode
    : undefined;
  if (input.continuationMode !== undefined && continuationMode === undefined) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.illegalAction,
      severity: 'preflight',
      reason: '续写模式无效',
      recoverable: false,
      userActionRequired: ['continuationMode 只能是 append 或 replace'],
    }));
  }
  const targetWordCount = input.targetWordCount === undefined
    ? inferTargetWordCount(content)
    : parseTargetWordRange(input.targetWordCount);
  if (
    (input.action === 'plan_chapter' || input.action === 'generate_chapter') &&
    chapterNumber === undefined
  ) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.missingChapterNumber,
      severity: 'preflight',
      reason: '章节规划或正文生成必须指定章节号',
      recoverable: false,
      userActionRequired: ['填写章节号'],
    }));
  }
  if (input.action === 'generate_chapter' && !confirmGeneration) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.generate',
      gate: 'confirm',
      code: FAILURE_CODES.generationUnconfirmed,
      severity: 'preflight',
      reason: '生成正文需要明确确认，不会因聊天文本自动提交',
      recoverable: false,
      userActionRequired: ['勾选确认生成'],
    }));
  }
  const stewardAction = typeof input.stewardAction === 'string' ? input.stewardAction : undefined;
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : undefined;
  const sourceVersion = typeof input.sourceVersion === 'string' ? input.sourceVersion : undefined;
  if (input.stewardAction !== undefined
    && (stewardAction === undefined || !(STEWARD_ACTIONS as readonly string[]).includes(stewardAction))) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.illegalAction,
      severity: 'preflight',
      reason: '补齐方案动作无效，请重新打开当前方案后操作',
      recoverable: false,
      userActionRequired: ['重新获取补齐方案'],
    }));
  }
  if (stewardAction !== undefined && (!proposalId?.trim() || !sourceVersion?.trim())) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.illegalAction,
      severity: 'preflight',
      reason: '补齐方案动作必须绑定方案 ID 和资料版本',
      recoverable: false,
      userActionRequired: ['重新获取补齐方案后再操作'],
    }));
  }
  const confirmedFields = Array.isArray(input.confirmedFields)
    ? input.confirmedFields.filter((item): item is string => typeof item === 'string')
    : undefined;
  const proposalEdits = Array.isArray(input.proposalEdits)
    ? input.proposalEdits.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as { field?: unknown; value?: unknown };
        return typeof row.field === 'string' && typeof row.value === 'string'
          ? [{ field: row.field, value: row.value }]
          : [];
      })
    : undefined;
  return {
    content,
    action: input.action as AssistantRequest['action'],
    chapterNumber,
    confirmGeneration,
    continuationMode,
    targetWordCount,
    stewardAction: stewardAction as AssistantRequest['stewardAction'],
    proposalId,
    sourceVersion,
    confirmedFields,
    proposalEdits,
  };
}

/**
 * Parse a final whole-chapter target from natural language. A unit is
 * mandatory so chapter numbers and dates cannot be mistaken for word counts.
 */
export function inferTargetWordCount(content: string): TargetWordRange | undefined {
  const match = content.match(
    /([1-9][0-9]{2,5})\s*(?:[-~～—至到]\s*([1-9][0-9]{2,5})\s*)?(?:个)?(?:字|字符|汉字)/u,
  );
  if (!match) return undefined;
  const first = Number.parseInt(match[1], 10);
  const second = match[2] ? Number.parseInt(match[2], 10) : undefined;
  if (second !== undefined) {
    return parseTargetWordRange({
      min: Math.min(first, second),
      max: Math.max(first, second),
    });
  }
  return parseTargetWordRange({
    min: first,
    max: Math.ceil((first * 11) / 10),
  });
}

function parseTargetWordRange(value: unknown): TargetWordRange {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { min?: unknown; max?: unknown }
    : {};
  const min = typeof row.min === 'number' ? row.min : Number.NaN;
  const max = typeof row.max === 'number' ? row.max : Number.NaN;
  if (
    !Number.isSafeInteger(min)
    || !Number.isSafeInteger(max)
    || min < 100
    || max > 100_000
    || min > max
  ) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.illegalAction,
      severity: 'preflight',
      reason: '目标字数必须是 100 至 100000 之间且最小值不大于最大值的整数范围',
      recoverable: false,
      userActionRequired: ['检查本章目标字数'],
    }));
  }
  return { min, max };
}

export function assertArtifactAllowed(
  action: AssistantAction,
  artifactType: ArtifactType,
): void {
  if (!ACTION_ARTIFACT_WHITELIST[action].includes(artifactType)) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.artifact',
      gate: 'action_whitelist',
      code: FAILURE_CODES.artifactActionMismatch,
      severity: 'preflight',
      reason: `当前动作不允许保存${artifactLabel(artifactType)}`,
      recoverable: false,
      evidence: { action, artifactType },
      userActionRequired: ['改选对应动作后再保存'],
    }));
  }
}

export function artifactLabel(type: ArtifactType): string {
  if (type === 'story_outline') return '全书大纲';
  if (type === 'chapter_seed') return '章节种子';
  return '查询结果';
}

function parseOptionalChapterNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(number) || number < 1) {
    throw new FailureHttpException(makeFailure({
      stage: 'assistant.action',
      gate: 'request_schema',
      code: FAILURE_CODES.missingChapterNumber,
      severity: 'preflight',
      reason: '章节号必须是大于 0 的整数',
      recoverable: false,
    }));
  }
  return number;
}
