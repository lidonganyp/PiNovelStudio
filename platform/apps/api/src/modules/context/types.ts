/**
 * Workbench 聊天与正式生成共用的上下文 / 动作契约。
 */
export const ASSISTANT_ACTIONS = [
  'plan_story_outline',
  'plan_chapter',
  'query_project',
  'generate_chapter',
] as const;

export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

export const ARTIFACT_TYPES = [
  'story_outline',
  'chapter_seed',
  'query_answer',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ACTION_ARTIFACT_WHITELIST: Record<AssistantAction, readonly ArtifactType[]> = {
  plan_story_outline: ['story_outline', 'query_answer'],
  plan_chapter: ['chapter_seed', 'query_answer'],
  query_project: ['query_answer'],
  generate_chapter: ['chapter_seed', 'query_answer'],
};

export interface AssistantRequest {
  content: string;
  /** 缺省 = auto 模式：由规划模型根据用户消息自行判断动作。 */
  action?: AssistantAction;
  chapterNumber?: number;
  confirmGeneration?: boolean;
  stewardAction?: 'apply_and_generate' | 'save_draft' | 'cancel' | 'revise';
  proposalId?: string;
  sourceVersion?: string;
  confirmedFields?: string[];
  proposalEdits?: Array<{ field: string; value: string }>;
}

export interface AssistantArtifactRecord {
  type: ArtifactType;
  id?: string | number;
  version?: number;
  saved: boolean;
}

export interface GenerationRequestView {
  chapterNumber: number;
  jobId: string;
  publicEntry: 'novel_generate_chapter';
}

export type FailureSeverity = 'preflight' | 'recoverable' | 'hard' | 'fatal';

export interface FailureEnvelope {
  stage: string;
  gate: string;
  code: string;
  severity: FailureSeverity;
  reason: string;
  evidence?: unknown;
  recoverable: boolean;
  retryPlan?: string;
  userActionRequired?: string[];
  fixInstructions?: string[];
}

export type AssistantSseType =
  | 'delta'
  | 'artifact'
  | 'job_submitted'
  | 'steward'
  | 'failure'
  | 'done';

export interface PreviousChapterContinuation {
  chapterNumber: number;
  endingState: string;
  lastSceneSummary: string;
  changedCharacters: string[];
  unresolvedPromises: string[];
  tailExcerpt?: string;
  sourceChapterHash: string;
}

export interface EvidenceSpan {
  chapterNumber: number;
  offset: number;
  length: number;
  hash: string;
  purpose: string;
  text: string;
  tokenCount: number;
}

export type ContextBlockName =
  | 'creativeConstitution'
  | 'worldbuilding'
  | 'storyOutline'
  | 'currentChapterOutline'
  | 'chapterSeed'
  | 'characterStates'
  | 'canonState'
  | 'promiseLedger'
  | 'patternMemory'
  | 'previousChapterContinuation'
  | 'styleProfile'
  | 'selectedEvidenceSpans';

export interface ContextBlockManifest {
  name: ContextBlockName;
  sourceType: string;
  sourceId?: string | number;
  sourceVersion?: number;
  sourceHash?: string;
  authorConfirmed: boolean;
  tokenBudget: number;
  tokensUsed: number;
  included: boolean;
  omittedReason?: string;
}

export interface ContextManifest {
  totalTokenBudget: number;
  totalTokensUsed: number;
  blocks: ContextBlockManifest[];
  previousChapterContinuation?: PreviousChapterContinuation;
  selectedEvidenceSpans: EvidenceSpan[];
}

export const DEFAULT_BLOCK_TOKEN_BUDGETS: Record<ContextBlockName, number> = {
  creativeConstitution: 2000,
  worldbuilding: 2000,
  storyOutline: 4000,
  currentChapterOutline: 1000,
  chapterSeed: 2000,
  characterStates: 3000,
  canonState: 2000,
  promiseLedger: 1000,
  patternMemory: 1000,
  previousChapterContinuation: 800,
  styleProfile: 1500,
  selectedEvidenceSpans: 2000,
};

export const DEFAULT_TOTAL_TOKEN_BUDGET = 16_000;
export const MAX_EVIDENCE_SPANS = 3;
export const MAX_EVIDENCE_SPAN_CHARS = 400;
