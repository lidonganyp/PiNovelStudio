/**
 * PiNovelStudio - chapter quality contract types.
 *
 * A quality contract is the compact, traceable bridge between external replay
 * evidence and Stage 2 event generation. It describes required story deltas
 * without carrying reference prose into the generation prompt.
 */

export type QualityDeltaKey =
  | "stateDelta"
  | "evidenceDelta"
  | "choiceDelta"
  | "riskDelta"
  | "expectationDelta"
  | "hookMovement"
  | "readerNeedToContinue";

export type QualityContractRequiredDeltas = Record<QualityDeltaKey, boolean>;

export interface QualityContractEventRequirement {
  eventId: string;
  eventName: string;
  eventType: string;
  narrativeBeat: string;
  conflictLevel: number;
  requiredDeltas: QualityDeltaKey[];
  rationale: string;
}

export interface QualityContractValidatedRuleInput {
  id: string;
  sceneType?: string;
  appliesWhen?: string[];
  craftMove?: string;
  mustDo?: string[];
  avoid?: string[];
  evidence?: {
    source?: string;
    sampleSize?: number;
    validatedWinRate?: number;
    confidence?: number;
  };
}

export interface QualityContractEventInput {
  id?: string;
  name?: string;
  type?: string;
  narrativeBeat?: string;
  conflictLevel?: number;
  contentPoints?: string[];
  effects?: string[];
  hooks?: string[];
  location?: string;
  characters?: string[];
}

export interface QualityContractStyleTargets {
  dialogueRatio?: number;
}

export interface QualityContractDialoguePlan {
  targetRatio: number;
  dialogueBearingEventIds: string[];
  minDialogueMarksPerEvent: number;
  minDialogueRatioPerEvent: number;
  minChapterDialogueRatioForStage2: number;
  totalDialogueMarkBudget: number;
  reason: string;
  // R46: Event-level dialogue allocations
  eventAllocations?: Record<string, {
    eventId: string;
    weightCategory: "high" | "medium" | "low";
    targetRatio: number;
    minDialogueRatio: number;
    targetDialogueMarks: number;
    minDialogueMarks: number;
    dialogueMustAdvance?: string[];
    dialogueFunction?: "information" | "risk" | "decision" | "relationship" | "mixed";
    reason: string;
  }>;
}

export interface QualityContractCompilerInput {
  chapterNumber: number;
  genre?: string;
  outlineIntent?: unknown;
  narrativeState?: unknown;
  readerExpectationTask?: unknown;
  events?: QualityContractEventInput[];
  validatedRules?: QualityContractValidatedRuleInput[];
  styleTargets?: QualityContractStyleTargets;
}

export interface QualityContract {
  schemaVersion: 1;
  chapterNumber: number;
  chapterGoal: string;
  requiredDeltas: QualityContractRequiredDeltas;
  forbiddenFailures: string[];
  eventRequirements: QualityContractEventRequirement[];
  styleTargets?: QualityContractStyleTargets;
  dialoguePlan?: QualityContractDialoguePlan;
  activeValidatedRuleIds: string[];
  evidence: {
    genre?: string;
    outlineIntentKeywords: string[];
    readerExpectationSignals: string[];
    validatedRuleCount: number;
  };
  createdAt: string;
}

export interface QualityContractTrace {
  schemaVersion: 1;
  chapterNumber: number;
  chapterGoal: string;
  requiredDeltas: Partial<QualityContractRequiredDeltas>;
  forbiddenFailures: string[];
  eventRequirements: Array<Pick<QualityContractEventRequirement, "eventId" | "requiredDeltas" | "rationale">>;
  /**
   * P40-T01-B 新增：dialogueRatio 来源标记，trace 直接可见。
   *
   * 由 Stage 1.8 调用 formatQualityContractForTrace 时传入，便于人工验收/replay
   * 时一眼确认 dialoguePlan 的 targetRatio 来自哪个来源（workspace-local/shared/config-style-overrides/fallback）。
   * 缺失表示旧版记录或 loadQualityContractStyleTargets 未返回 source。
   */
  dialogueTargetSource?: "workspace-local" | "shared" | "config-style-overrides" | "fallback";
  /**
   * P40-T01-B: 从 Pick 改为完整透传 QualityContractDialoguePlan，含 R46 eventAllocations。
   *
   * 旧版用 Pick 排除 eventAllocations 是为了控制 trace 体积，但导致 P40 微小节
   * 编译（compileMicroSectionPlans）无法从 trace chapterContract 拿到事件级对话预算
   * 分配，必须重新编译。改为完整透传后：
   *   - trace 体积增加可接受（eventAllocations 最多 8 个事件 × 7 字段）
   *   - replay 工具（eval/replay-runner.ts readPlannedDialogueEventIds）仍按
   *     dialogueBearingEventIds 读取，向后兼容
   *   - 下游 Stage 2 / P40 micro-section-plan.ts 可直接从 dag.enhancements.qualityContract
   *     或 trace chapterContract 读取 eventAllocations
   */
  dialoguePlan?: QualityContractDialoguePlan;
  activeValidatedRuleIds: string[];
}
