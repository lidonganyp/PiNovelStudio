/**
 * ChapterIntentBuilder — 章节意图构建器（Phase 1，计划 §4.3）
 *
 * ChapterIntent 是创作方向，不是章纲或句子清单。它告诉模型"本章要达成什么读者体验"，
 * 不规定句子怎么写。
 *
 * 输入：CreativeConstitution + 章节种子派生结构 + 长期状态快照
 * 输出：ChapterIntent，所有字段带 sourceRefs 追溯到 seed/constitution/state
 *
 * 设计原则：
 * - 创作方向，非句式清单
 * - inviolableFacts 合并 worldConstraint.immutableFacts + constitution.forbiddenDrift
 * - sourceRefs 必须可追溯到具体来源
 */

import type { CreativeConstitution } from "./creative-constitution.js";
import type { NarrativeStateStore } from "./final-state-commit.js";
// P4 M3 修复（2026-07-23）：type-only import，编译期擦除，无运行时耦合。
// ChapterIntent.overduePressure 与 ChapterIntentInput.overdueAlerts 复用 post-raw
// 通道的 OverdueAlertEntry 形状，供 pre-write 把逾期期待 pass-through 给 writer。
import type { OverdueAlertEntry } from "./methodology-diagnostic-derived.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface ChapterIntent {
  chapterFunction: string;
  overallPlotDirection?: string[];
  previousState?: string[];
  characterMotivations?: Array<{ character: string; motivation: string }>;
  foreshadowing?: string[];
  causalRelations?: string[];
  endingTarget?: string[];
  authorEventSummaries?: string[];
  authorMustInclude?: string[];
  authorStateChanges?: string[];
  readerExperience: string[];
  currentPressure: string[];
  meaningfulChoices: string[];
  promisesToAdvance: string[];
  possibleEndPressure: string[];
  relevantCharacters: string[];
  inviolableFacts: string[];
  sourceRefs: string[];
  // ── INTENT-1 最小完整章卡：8 个新字段（可选，向后兼容现有 stub intent） ──
  /** 2. 具体交付：本章必须交付给读者的具体内容（场景/事件/信息释放/情绪落点） */
  concreteDelivery?: string[];
  /** 3. 焦点角色目标：本章焦点角色（≤3）的具体目标 */
  focusCharacterGoals?: Array<{ character: string; goal: string }>;
  /** 4. 阻力：阻止焦点角色达成目标的具体阻力（人/环境/内心/信息） */
  resistance?: string[];
  /** 5. 选择与代价：本章焦点角色面临的选择及代价 */
  choicesAndCosts?: Array<{ choice: string; cost: string }>;
  /** 6. 预期不可逆变化：本章预期造成的不可逆状态变化 */
  expectedIrreversibleChange?: string[];
  /** 7. 本章选中的承诺：从 openPromises 中选中本章推进的承诺（≤3）。
   *  修复轮：原 promiseAdvancementActions 用 `action: "推进：{description}"` 冒充具体行动方案；
   *  改为 selectedPromisesToAdvance，只记录选中承诺的描述，不伪造推进动作。 */
  selectedPromisesToAdvance?: Array<{ promiseId: string; description: string }>;
  /**
   * EXPECTATION-LEDGER-1：本章选中的读者期待（≤3）。
   * 从 openExpectations 中选中本章推进/升级/检视的期待。
   * 与 selectedPromisesToAdvance 区别：期待关注读者体验目标（targetReaderExperience）。
   * 只记录选中期待的描述与目标体验，不伪造推进动作。
   */
  selectedExpectationsToAdvance?: Array<{
    expectationId: string;
    description: string;
    targetReaderExperience?: string;
  }>;
  /** 8. 因果章末压力：章末必须建立的因果性压力（有因果链，非随机钩子） */
  causalEndPressure?: string[];
  /** 9. 事实与人物知识禁区：事实硬约束 + 角色知识边界（谁知道什么不知道什么） */
  factAndCharacterKnowledgeForbiddenZones?: string[];
  /** INTENT-1：每字段的来源追溯（字段名 → sourceRef 列表），供 trace 审计 */
  fieldSourceRefs?: Record<string, string[]>;
  /**
   * P4 M3 修复（2026-07-23）：写前逾期压力（来自 LongTermStateSnapshot.overdueAlerts）。
   * 告知 writer 模型哪些读者期待已逾期或临近逾期，引导本章推进/升级/检视。
   * 仅作写前提示，不强制改文、不阻断生成（事实硬门 / 文学软诊断原则）。
   */
  overduePressure?: OverdueAlertEntry[];
  /**
   * INTENT-COMPLETENESS-1：标记当前为空的关键字段名（focusCharacterGoals /
   * choicesAndCosts / expectedIrreversibleChange / selectedPromisesToAdvance /
   * causalEndPressure）。
   *
   * 设计原则（计划 §4.3 + 任务清单 P1-1）：
   * - 普通生成模式：under-specified 不阻断，但必须明确标记，让调用方/trace 可见
   * - evalMode（B3/B4）+ under-specified 关键字段：阻断评测，提示补充种子源
   * - 只列空关键字段，不列非空字段（fieldSourceRefs 仍追踪实际贡献来源）
   */
  underSpecifiedFields?: string[];
}

/**
 * 调用方从 ChapterSeed / CompiledContext 派生的结构化输入。
 * 刻意不直接依赖 novel-studio 的 ChapterSeed 类型，保持本模块可独立测试。
 */
export interface ChapterIntentInput {
  chapterNumber: number;
  intentPrimary?: string;
  chapterTheme?: string;
  targetEmotions: string[];
  characters: Array<{ name: string; role?: string; mentality?: string; recentAction?: string; pendingTension?: string }>;
  immutableFacts: string[];
  openPromises: Array<{ id: string; description: string }>;
  /**
   * EXPECTATION-LEDGER-1：本章可用的读者期待（来自 seed / state）。
   * builder 从中选中本章推进的期待（≤3），写入 selectedExpectationsToAdvance。
   */
  openExpectations?: Array<{
    expectationId: string;
    description: string;
    targetReaderExperience?: string;
  }>;
  openArcs: Array<{ arcId: string; name: string; coreQuestion?: string }>;
  currentPressureSummary: string[];
  prevContinuationAvailable: boolean;
  /** INTENT-1：本章未结账的代价（来自 seed.currentPressure.pendingCosts），用于派生选择与代价/不可逆变化 */
  pendingCosts?: Array<{ action: string; cost: string; chapterIncurred?: number }>;
  choicesAndCosts?: Array<{ choice: string; cost: string }>;
  expectedIrreversibleChange?: string[];
  causalEndPressure?: string[];
  authorChapterContract?: {
    available?: boolean;
    chapterFunction?: string;
    readerExperience?: string[];
    currentPressure?: string[];
    focusCharacterGoals?: Array<{ character: string; goal: string }>;
    resistance?: string[];
    choicesAndCosts?: Array<{ choice: string; cost: string }>;
    expectedIrreversibleChange?: string[];
    causalEndPressure?: string[];
    eventSummaries: string[];
    mustInclude: string[];
    stateChanges: string[];
    foreshadowing: string[];
    causalRelations: string[];
    endingTarget?: string;
    relevantCharacters: string[];
    characterMotivations: Array<{ character: string; motivation: string }>;
    sourceIds: string[];
  };
  overallPlotDirection?: string[];
  previousState?: string[];
  /**
   * P4 M3：写前 overdue alerts（来自 CompiledContext.longTermState.overdueAlerts）。
   * builder 直接 pass-through 到 intent.overduePressure，不重新计算。
   */
  overdueAlerts?: OverdueAlertEntry[];
}

export interface ChapterIntentBuildResult {
  intent: ChapterIntent;
  warnings: string[];
}

// ============================================================================
// Builder
// ============================================================================

export class ChapterIntentBuilder {
  build(
    input: ChapterIntentInput,
    constitution: CreativeConstitution | null,
    state: NarrativeStateStore | null
  ): ChapterIntentBuildResult {
    const warnings: string[] = [];
    const sourceRefs: string[] = ["chapter-seed"];

    // chapterFunction：优先 seed.intent.primary，否则从 constitution 推断
    const authorContract = input.authorChapterContract;
    let chapterFunction = authorContract?.chapterFunction ?? input.intentPrimary ?? "";
    if (!chapterFunction) {
      chapterFunction = constitution?.protagonistCoreConflict
        ? `推进核心冲突：${constitution.protagonistCoreConflict}`
        : "未指定本章功能";
      if (!input.intentPrimary) warnings.push("ChapterSeed.intent.primary 缺失，chapterFunction 降级");
    } else if (authorContract?.chapterFunction) {
      sourceRefs.push(...authorContract.sourceIds);
    } else {
      sourceRefs.push("chapter-seed:intent");
    }

    // readerExperience：constitution.readerPromise + 目标情绪
    const readerExperience: string[] = [];
    if (authorContract?.readerExperience?.length) {
      readerExperience.push(...authorContract.readerExperience);
      sourceRefs.push(...authorContract.sourceIds);
    }
    if (constitution?.readerPromise?.length) {
      readerExperience.push(...constitution.readerPromise);
      sourceRefs.push("creative-constitution:readerPromise");
    }
    if (input.targetEmotions.length) {
      readerExperience.push(`目标情绪：${input.targetEmotions.join("、")}`);
      sourceRefs.push("chapter-seed:intent.targetEmotions");
    }
    if (readerExperience.length === 0) {
      readerExperience.push("未指定明确读者体验目标");
      warnings.push("readerExperience 为空，constitution.readerPromise 与 targetEmotions 均缺失");
    }

    // currentPressure
    const currentPressure = dedupe([
      ...(authorContract?.currentPressure ?? []),
      ...input.currentPressureSummary,
    ]);
    if (currentPressure.length) sourceRefs.push("chapter-seed:currentPressure");

    // meaningfulChoices：从开放弧线的 coreQuestion 派生
    const meaningfulChoices: string[] = input.openArcs
      .filter((a) => a.coreQuestion)
      .map((a) => `${a.name}：${a.coreQuestion}`);
    if (meaningfulChoices.length) sourceRefs.push("chapter-seed:openArcs");

    // promisesToAdvance：开放伏笔 + 长期状态中的 open promise
    const promisesToAdvance: string[] = input.openPromises.map(
      (p) => `${p.id}：${p.description}`
    );
    if (promisesToAdvance.length) sourceRefs.push("chapter-seed:openPromises");
    if (state?.promise?.length) {
      const openPromises = state.promise.filter((p) => p.status === "open" || p.status === "advancing");
      openPromises.forEach((p) => {
        const label = `${p.promiseId}：${p.description}`;
        if (!promisesToAdvance.includes(label)) promisesToAdvance.push(label);
      });
      if (openPromises.length) sourceRefs.push("narrative-state:promise");
    }

    // possibleEndPressure：constitution 的 thematicQuestions 提供章末可施加的压力方向
    const possibleEndPressure: string[] = [];
    if (constitution?.thematicQuestions?.length) {
      possibleEndPressure.push(
        ...constitution.thematicQuestions.map((q) => `可借章末抛回问题：${q}`)
      );
      sourceRefs.push("creative-constitution:thematicQuestions");
    }

    // relevantCharacters：死亡角色仍由 immutable facts / characterStates 提供历史事实，
    // 但不得进入 active 出场、声音或群像层次上下文，否则 prompt 会把其解释为本章参与者。
    const deceasedCharacters = input.characters.filter(
      (character) => character.role?.trim().toLowerCase() === "deceased"
    );
    const activeCharacters = input.characters
      .filter((character) => character.role?.trim().toLowerCase() !== "deceased");
    const activeCharacterNames = new Set(activeCharacters.map((character) => character.name));
    const authorRelevantCharacters = (authorContract?.relevantCharacters ?? [])
      .filter((name) => activeCharacterNames.has(name));
    const relevanceText = [
      chapterFunction,
      ...(input.overallPlotDirection ?? []),
      ...(input.previousState ?? []),
      ...input.currentPressureSummary,
      ...input.openPromises.map((promise) => promise.description),
      ...input.openArcs.flatMap((arc) => [arc.name, arc.coreQuestion ?? ""]),
    ].join("\n");
    const signalMatchedCharacters = activeCharacters
      .filter((character) => relevanceText.includes(character.name))
      .map((character) => character.name);
    const protagonistCharacters = activeCharacters
      .filter((character) => /^(?:protagonist|main|主角)$/iu.test(character.role?.trim() ?? ""))
      .map((character) => character.name);
    const conservativeFallback = protagonistCharacters.length > 0
      ? protagonistCharacters
      : activeCharacters.slice(0, 1).map((character) => character.name);
    const relevantCharacters = authorRelevantCharacters.length > 0
      ? dedupe(authorRelevantCharacters)
      : dedupe([...conservativeFallback, ...signalMatchedCharacters]);
    if (authorRelevantCharacters.length > 0) {
      sourceRefs.push(...(authorContract?.sourceIds ?? []));
    } else if (relevantCharacters.length > 0) {
      sourceRefs.push("chapter-seed:characters", "chapter-seed:relevance-signals");
    }
    if (deceasedCharacters.length > 0) {
      warnings.push(
        `已从 active relevantCharacters 排除死亡角色：${deceasedCharacters.map((character) => character.name).join("、")}；历史事实仍由 immutable facts / characterStates 保留`
      );
    }
    const deceasedTimelineBoundaries = deceasedCharacters.map(
      (character) => `${character.name}已死亡；不得作为当前时间线的在场行动者；如在回忆、记录或幻觉中出现，必须明确标记其非当前时线。`
    );

    // inviolableFacts：world immutableFacts + constitution.forbiddenDrift
    const inviolableFacts = [...input.immutableFacts];
    if (inviolableFacts.length) sourceRefs.push("chapter-seed:immutableFacts");
    for (const boundary of deceasedTimelineBoundaries) {
      if (!inviolableFacts.includes(boundary)) inviolableFacts.push(boundary);
    }
    if (deceasedTimelineBoundaries.length > 0) sourceRefs.push("chapter-seed:characters.deceased");
    if (constitution?.forbiddenDrift?.length) {
      constitution.forbiddenDrift.forEach((f) => {
        if (!inviolableFacts.includes(f)) inviolableFacts.push(f);
      });
      sourceRefs.push("creative-constitution:forbiddenDrift");
    }

    // 前章承接缺失警告
    if (input.chapterNumber > 1 && !input.prevContinuationAvailable) {
      warnings.push(`第 ${input.chapterNumber} 章但 prevContinuation 不可用，连续性风险`);
    }

    // ── INTENT-1：8 个新字段（最小完整章卡），每项带 fieldSourceRefs ──
    const fieldSourceRefs: Record<string, string[]> = {};

    // 2. concreteDelivery 具体交付：本章必须交付给读者的具体内容
    //    来源：seed.intent（primary/theme/targetEmotions）+ constitution.readerPromise
    //    选择性：只取本章 intent 派生的交付项，不灌入全域知识
    //    修复轮：fieldSourceRefs 动态追踪实际贡献来源，不笼统声称两源均参与。
    const concreteDelivery: string[] = [
      ...(authorContract?.eventSummaries ?? []),
      ...(authorContract?.mustInclude ?? []),
      ...(authorContract?.stateChanges ?? []),
    ];
    const concreteDeliverySources: string[] = [];
    if (concreteDelivery.length > 0) {
      concreteDeliverySources.push(...(authorContract?.sourceIds ?? []));
    }
    if (chapterFunction && chapterFunction !== "未指定本章功能") {
      concreteDelivery.push(`推进本章功能：${chapterFunction}`);
      // INTENT-HOLD-1 blocker 2：chapterFunction 来自 seed.intent.primary 或
      // constitution.protagonistCoreConflict 降级。intent 贡献时记 chapter-seed:intent；
      // constitution 降级时必须记 creative-constitution:protagonistCoreConflict，
      // 否则 concreteDelivery 非空但 fieldSourceRefs.concreteDelivery 为空数组，
      // 无法证明真实来源（违反"只记录实际贡献来源"的不变量）。
      if (input.intentPrimary) {
        concreteDeliverySources.push("chapter-seed:intent");
      } else if (constitution?.protagonistCoreConflict) {
        concreteDeliverySources.push("creative-constitution:protagonistCoreConflict");
      }
    }
    if (input.chapterTheme) {
      concreteDelivery.push(`落地章节主题：${input.chapterTheme}`);
      concreteDeliverySources.push("chapter-seed:intent.chapterTheme");
    }
    if (input.targetEmotions.length) {
      concreteDelivery.push(`释放目标情绪：${input.targetEmotions.join("、")}`);
      concreteDeliverySources.push("chapter-seed:intent.targetEmotions");
    }
    if (constitution?.readerPromise?.length) {
      concreteDelivery.push(`兑现读者承诺：${constitution.readerPromise.join("；")}`);
      concreteDeliverySources.push("creative-constitution:readerPromise");
    }
    if (concreteDelivery.length === 0) {
      warnings.push("concreteDelivery 为空：intent.primary/chapterTheme/targetEmotions/readerPromise 均缺失，本章交付方向不明");
    } else {
      fieldSourceRefs.concreteDelivery = dedupe(concreteDeliverySources);
    }

    // 3. focusCharacterGoals 焦点角色目标：≤3 个焦点角色的具体目标
    //    修复轮：ChapterSeed.characters 无 goal 字段（只有 mentality/recentAction/
    //    pendingTension/role），这些都是状态/动作/身份，不是角色目标。不伪造目标。
    //    只有输入存在明确目标证据时才生成 goal；当前 schema 无可靠 goal 字段 → 空 + warning。
    const focusCharacterGoals: Array<{ character: string; goal: string }> = [
      ...(authorContract?.focusCharacterGoals ?? []),
    ].filter((entry) => relevantCharacters.includes(entry.character)).slice(0, 3);
    if (focusCharacterGoals.length > 0) {
      fieldSourceRefs.focusCharacterGoals = authorContract?.sourceIds ?? [];
    } else {
      warnings.push("focusCharacterGoals 为空：ChapterSeed.characters 无 goal 字段，pendingTension/recentAction/mentality/role 均非角色目标，不伪造");
    }

    // 4. resistance 阻力：阻止焦点角色达成目标的具体阻力
    //    来源：currentPressureSummary + protagonistCoreConflict + openArcs 的 coreQuestion
    //    修复轮：fieldSourceRefs 动态追踪实际贡献来源。
    const resistance: string[] = [];
    const resistanceSources: string[] = [];
    if (authorContract?.resistance?.length) {
      resistance.push(...authorContract.resistance);
      resistanceSources.push(...authorContract.sourceIds);
    }
    if (input.currentPressureSummary.length) {
      resistance.push(...input.currentPressureSummary);
      resistanceSources.push("chapter-seed:currentPressure");
    }
    if (constitution?.protagonistCoreConflict) {
      resistance.push(`核心冲突阻力：${constitution.protagonistCoreConflict}`);
      resistanceSources.push("creative-constitution:protagonistCoreConflict");
    }
    const openArcsWithQuestion = input.openArcs.filter((a) => a.coreQuestion);
    if (openArcsWithQuestion.length) {
      openArcsWithQuestion.forEach((a) => resistance.push(`${a.name} 阻力：${a.coreQuestion}`));
      resistanceSources.push("chapter-seed:openArcs");
    }
    if (resistance.length === 0) {
      warnings.push("resistance 为空：currentPressure/protagonistCoreConflict/openArcs 均缺失，阻力不明");
    } else {
      fieldSourceRefs.resistance = dedupe(resistanceSources);
    }

    // 5. choicesAndCosts 选择与代价：本章焦点角色面临的选择及代价
    //    来源：seed.pendingCosts（action/cost 直接复用）
    //    修复轮：openArcs.coreQuestion 不能自动生成虚构代价"推进该弧线的代价（待正文落实）"。
    //    没有明确 cost 证据时不生成该条目，只记录 warning。
    const choicesAndCosts: Array<{ choice: string; cost: string }> = [];
    if (authorContract?.choicesAndCosts?.length) {
      choicesAndCosts.push(...authorContract.choicesAndCosts);
      fieldSourceRefs.choicesAndCosts = authorContract.sourceIds;
    } else if (input.choicesAndCosts?.length) {
      choicesAndCosts.push(...input.choicesAndCosts);
      fieldSourceRefs.choicesAndCosts = ["chapter-seed:intent.choicesAndCosts"];
    } else if (input.pendingCosts?.length) {
      for (const pc of input.pendingCosts) {
        choicesAndCosts.push({ choice: pc.action, cost: pc.cost });
      }
      fieldSourceRefs.choicesAndCosts = ["chapter-seed:pendingCosts"];
    }
    if (choicesAndCosts.length === 0) {
      warnings.push("choicesAndCosts 为空：pendingCosts 缺失，openArcs.coreQuestion 无明确 cost 证据不生成虚构代价");
    }

    // 6. expectedIrreversibleChange 预期不可逆变化
    //    修复轮：pendingCosts 无 irreversible 标志，pending cost 不自动等于"预期不可逆变化"。
    //    只有来源明确声明不可逆或现有结构能可靠证明时才生成；不追加"（不可逆）"制造新事实。
    //    当前 schema 无可靠不可逆证据 → 空 + warning，不记录 fieldSourceRefs。
    const expectedIrreversibleChange = dedupe([
      ...(authorContract?.expectedIrreversibleChange ?? []),
      ...(input.expectedIrreversibleChange ?? []),
    ]);
    if (expectedIrreversibleChange.length > 0) {
      fieldSourceRefs.expectedIrreversibleChange = authorContract?.expectedIrreversibleChange?.length
        ? authorContract.sourceIds
        : ["chapter-seed:intent.expectedIrreversibleChange"];
    } else {
      warnings.push("expectedIrreversibleChange 为空：未提供显式 ChapterSeed 契约，不从 pendingCosts 推断不可逆变化");
    }
    // 空字段不记录 fieldSourceRefs

    // 7. selectedPromisesToAdvance 本章选中的承诺：≤3
    //    来源：seed.openPromises + state.promise（open/advancing），按 promiseId 交集
    //    选择性：只取 seed 当前压力涉及的 promise（不全量灌入 state 所有 open promise）
    //    修复轮：promise description 不等于具体"推进动作"。原 promiseAdvancementActions 用
    //    `action: "推进：{description}"` 冒充行动方案；改为 selectedPromisesToAdvance，
    //    只记录选中承诺的 description，不伪造推进动作。
    const seedPromiseIds = new Set(input.openPromises.map((p) => p.id));
    const statePromisesMatched = (state?.promise ?? [])
      .filter((p) => (p.status === "open" || p.status === "advancing") && seedPromiseIds.has(p.promiseId))
      .sort((a, b) => (b.currentHeat ?? 0) - (a.currentHeat ?? 0));
    // INTENT-HOLD-1 blocker 1：长期状态中已 fulfilled/broken 的 promiseId 不得
    // 在 seed.openPromises fallback 路径被重新选入。state 存在但匹配项已 fulfilled 时，
    // 上述 statePromisesMatched 已过滤；fallback 仍可能把 seed 中已在 state fulfilled
    // 的 promiseId 选回 → 必须排除，避免把已兑现承诺当作"本章选中承诺"写入 raw prompt。
    const stateFulfilledPromiseIds = new Set(
      (state?.promise ?? [])
        .filter((p) => p.status !== "open" && p.status !== "advancing")
        .map((p) => p.promiseId)
    );
    const authorForeshadowing = authorContract?.foreshadowing ?? [];
    const isAuthorSelectedPromise = (promiseId: string, description: string): boolean =>
      authorForeshadowing.length === 0 || authorForeshadowing.some((entry) =>
        entry.includes(promiseId) || entry.includes(description) || description.includes(entry));
    const selectedPromisesToAdvance: Array<{ promiseId: string; description: string }> = [];
    for (const p of statePromisesMatched) {
      if (selectedPromisesToAdvance.length >= 3) break;
      if (!isAuthorSelectedPromise(p.promiseId, p.description)) continue;
      selectedPromisesToAdvance.push({ promiseId: p.promiseId, description: p.description });
    }
    // state 缺失/无匹配 open+advancing 时退回 seed.openPromises（仍受 ≤3 上限约束），
    // 但必须跳过 state 中已 fulfilled/broken 的 promiseId，避免重选已兑现承诺。
    // state 为 null 时 stateFulfilledPromiseIds 为空集，fallback 行为保持不变。
    if (selectedPromisesToAdvance.length === 0) {
      for (const p of input.openPromises) {
        if (selectedPromisesToAdvance.length >= 3) break;
        if (stateFulfilledPromiseIds.has(p.id)) continue;
        if (!isAuthorSelectedPromise(p.id, p.description)) continue;
        selectedPromisesToAdvance.push({ promiseId: p.id, description: p.description });
      }
    }
    // 旧 workspace 的 ledger 可能尚未使用章卡里的 HOOK-* 标识。章卡明确声明的
    // 伏笔本身就是本章选中项；无 ledger 匹配时保守保留最多 3 条，不推断推进动作。
    if (selectedPromisesToAdvance.length === 0 && authorForeshadowing.length > 0) {
      authorForeshadowing.slice(0, 3).forEach((description, index) => {
        selectedPromisesToAdvance.push({
          promiseId: `author-chapter-${input.chapterNumber}-${index + 1}`,
          description,
        });
      });
    }
    if (selectedPromisesToAdvance.length === 0) {
      warnings.push("selectedPromisesToAdvance 为空：openPromises 与 state.promise 均缺失，无选中承诺");
    } else {
      const usedAuthorFallback = selectedPromisesToAdvance.some((entry) =>
        entry.promiseId.startsWith(`author-chapter-${input.chapterNumber}-`));
      fieldSourceRefs.selectedPromisesToAdvance = usedAuthorFallback
        ? (authorContract?.sourceIds ?? [])
        : (statePromisesMatched.length > 0
            ? ["chapter-seed:openPromises", "narrative-state:promise"]
            : ["chapter-seed:openPromises"]);
    }

    // EXPECTATION-LEDGER-1：selectedExpectationsToAdvance 本章选中的读者期待（≤3）
    //    来源：seed.openExpectations + state.expectation（open/advanced/delayed/escalated），按 expectationId 交集
    //    选择性：只取 seed 当前压力涉及的 expectation（不全量灌入 state 所有 expectation）
    //    与 promise 区别：期待状态含 escalated/delayed，且不排除 fulfilled（编译器降级为 inspect）
    //    fulfilled 期待仍可选中作为历史背景检视，由 ExpectationContextCompiler 决定 expectedAction=inspect。
    const seedExpectationIds = new Set((input.openExpectations ?? []).map((e) => e.expectationId));
    const stateExpectationsMatched = (state?.expectation ?? [])
      .filter((e) => seedExpectationIds.has(e.expectationId))
      .sort((a, b) => {
        // escalated 优先，其次 delayed，其次 open/advanced，最后 fulfilled
        const rank = (s: string): number => {
          if (s === "escalated") return 4;
          if (s === "delayed") return 3;
          if (s === "open" || s === "advanced") return 2;
          if (s === "fulfilled") return 1;
          return 0;
        };
        return rank(b.status) - rank(a.status);
      });
    const selectedExpectationsToAdvance: Array<{
      expectationId: string;
      description: string;
      targetReaderExperience?: string;
    }> = [];
    for (const e of stateExpectationsMatched) {
      if (selectedExpectationsToAdvance.length >= 3) break;
      selectedExpectationsToAdvance.push({
        expectationId: e.expectationId,
        description: e.description,
        targetReaderExperience: e.targetReaderExperience,
      });
    }
    // state 缺失/无匹配时退回 seed.openExpectations（仍受 ≤3 上限约束）
    if (selectedExpectationsToAdvance.length === 0) {
      for (const e of input.openExpectations ?? []) {
        if (selectedExpectationsToAdvance.length >= 3) break;
        selectedExpectationsToAdvance.push({
          expectationId: e.expectationId,
          description: e.description,
          targetReaderExperience: e.targetReaderExperience,
        });
      }
    }
    if (selectedExpectationsToAdvance.length === 0) {
      // 不警告：期待为空是正常状态（非每章都有选中期待），由 ExpectationContextCompiler 写 emptyReason
    } else {
      fieldSourceRefs.selectedExpectationsToAdvance = stateExpectationsMatched.length > 0
        ? ["chapter-seed:openExpectations", "narrative-state:expectation"]
        : ["chapter-seed:openExpectations"];
    }

    // 8. causalEndPressure 因果章末压力：章末必须建立的因果性压力
    //    修复轮：thematicQuestion 或"某开放弧尚未闭合"不自动等于因果章末压力。
    //    只有 seed/currentPressure 中存在明确因果压力证据时才生成。
    //    当前 ChapterIntentInput schema 无明确因果压力字段（currentPressureSummary 是通用压力，
    //    非"必须建立的章末因果"）→ 空 + warning，不把通用主题问题改写成必须建立的章末因果。
    const causalEndPressure = dedupe([
      ...(authorContract?.causalEndPressure ?? []),
      ...(authorContract?.endingTarget ? [authorContract.endingTarget] : []),
      ...(input.causalEndPressure ?? []),
    ]);
    if (causalEndPressure.length > 0) {
      fieldSourceRefs.causalEndPressure = ["chapter-seed:intent.causalEndPressure"];
    } else {
      warnings.push("causalEndPressure 为空：未提供显式 ChapterSeed 契约，不从主题或通用压力推断章末因果");
    }
    // 空字段不记录 fieldSourceRefs

    // 9. factAndCharacterKnowledgeForbiddenZones 事实与人物知识禁区
    //    修复轮：mentality 是心理状态，不是人物知识边界。删除由 mentality 派生
    //    "不得违反其知识边界"的逻辑。本轮只用 immutableFacts + constitution.forbiddenDrift；
    //    没有明确角色已知/未知事实字段则不生成角色知识禁区。
    const factAndCharacterKnowledgeForbiddenZones: string[] = [];
    const fzSources: string[] = [];
    if (input.immutableFacts.length) {
      factAndCharacterKnowledgeForbiddenZones.push(...input.immutableFacts);
      fzSources.push("chapter-seed:immutableFacts");
    }
    for (const boundary of deceasedTimelineBoundaries) {
      if (!factAndCharacterKnowledgeForbiddenZones.includes(boundary)) {
        factAndCharacterKnowledgeForbiddenZones.push(boundary);
      }
    }
    if (deceasedTimelineBoundaries.length > 0) {
      fzSources.push("chapter-seed:characters.deceased");
    }
    if (constitution?.forbiddenDrift?.length) {
      constitution.forbiddenDrift.forEach((f) => {
        if (!factAndCharacterKnowledgeForbiddenZones.includes(f)) {
          factAndCharacterKnowledgeForbiddenZones.push(f);
        }
      });
      fzSources.push("creative-constitution:forbiddenDrift");
    }
    if (factAndCharacterKnowledgeForbiddenZones.length === 0) {
      warnings.push("factAndCharacterKnowledgeForbiddenZones 为空：immutableFacts/forbiddenDrift 均缺失，禁区不明");
    } else {
      fieldSourceRefs.factAndCharacterKnowledgeForbiddenZones = dedupe(fzSources);
    }

    // chapterFunction 的 fieldSourceRefs
    //    修复轮：seed 和 constitution 均缺失时不得声称来自 constitution。
    //    只有实际贡献的来源才记录；双缺失（"未指定本章功能"）不记录 fieldSourceRefs。
    if (authorContract?.chapterFunction) {
      fieldSourceRefs.chapterFunction = authorContract.sourceIds;
    } else if (input.intentPrimary) {
      fieldSourceRefs.chapterFunction = ["chapter-seed:intent"];
    } else if (constitution?.protagonistCoreConflict) {
      fieldSourceRefs.chapterFunction = ["creative-constitution:protagonistCoreConflict"];
    }
    // 双缺失时不记录 fieldSourceRefs.chapterFunction

    // INTENT-COMPLETENESS-1：计算 underSpecifiedFields
    // 只列入当前为空的关键字段（5 个关键字段）；非空字段不列入。
    // 普通生成模式不阻断（under-specified 仅作标记），evalMode + 关键字段为空时阻断。
    const underSpecifiedFields: string[] = [];
    if (focusCharacterGoals.length === 0) underSpecifiedFields.push("focusCharacterGoals");
    if (choicesAndCosts.length === 0) underSpecifiedFields.push("choicesAndCosts");
    if (expectedIrreversibleChange.length === 0) underSpecifiedFields.push("expectedIrreversibleChange");
    if (selectedPromisesToAdvance.length === 0) underSpecifiedFields.push("selectedPromisesToAdvance");
    if (causalEndPressure.length === 0) underSpecifiedFields.push("causalEndPressure");

    const intent: ChapterIntent = {
      chapterFunction,
      overallPlotDirection: dedupe(input.overallPlotDirection ?? []),
      previousState: dedupe(input.previousState ?? []),
      characterMotivations: authorContract?.characterMotivations ?? [],
      foreshadowing: authorContract?.foreshadowing ?? [],
      causalRelations: authorContract?.causalRelations ?? [],
      endingTarget: authorContract?.endingTarget ? [authorContract.endingTarget] : [],
      authorEventSummaries: authorContract?.eventSummaries ?? [],
      authorMustInclude: authorContract?.mustInclude ?? [],
      authorStateChanges: authorContract?.stateChanges ?? [],
      readerExperience,
      currentPressure,
      meaningfulChoices,
      promisesToAdvance,
      possibleEndPressure,
      relevantCharacters,
      inviolableFacts,
      sourceRefs: dedupe(sourceRefs),
      concreteDelivery,
      focusCharacterGoals,
      resistance,
      choicesAndCosts,
      expectedIrreversibleChange,
      selectedPromisesToAdvance,
      selectedExpectationsToAdvance,
      causalEndPressure,
      factAndCharacterKnowledgeForbiddenZones,
      fieldSourceRefs,
      underSpecifiedFields,
      // P4 M3：pass-through 写前 overdue alerts（不重新计算，避免双重计算与潜在不一致）。
      overduePressure: input.overdueAlerts ?? [],
    };

    return { intent, warnings };
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

export function createChapterIntentBuilder(): ChapterIntentBuilder {
  return new ChapterIntentBuilder();
}
