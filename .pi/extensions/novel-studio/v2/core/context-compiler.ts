/**
 * V2 ContextCompiler — 上下文编译器（P1，Phase 1 分层改造）
 *
 * 目标：解决百万字上下文不跑偏，但不替模型写剧情。
 *
 * 设计原则（规格 P1 + Phase 1 计划 §3）：
 * - 每条上下文必须可追溯来源文件/行或结构化 source id
 * - 不生成剧情
 * - 不塞机械写作指令（如"你必须每段……"）
 * - 分层：事实、作品宪法、长期状态、风格参考、候选经验
 * - 缺关键事实时返回 diagnostic，不直接补写
 *
 * 实现：包装 legacy ChapterSeedBuilder，从 ChapterSeed 派生 CompiledContext，
 * 外加作品宪法（CreativeConstitution）、长期状态（NarrativeStateStore）、
 * 风格资料与 runtime rules。CompiledContext 是只读事实集合，不含任何写作指令。
 */

import { createHash } from "crypto";
import type {
  CompiledContext,
  ConstitutionSnapshot,
  ContextFact,
  CharacterStateFact,
  OpenLoopFact,
  WorldRuleFact,
  StyleReference,
  SourceMapEntry,
  Diagnostic,
  LongTermStateSnapshot,
  BridgeContext,
} from "./types.js";
import {
  loadWorkspace,
  loadChapterSeed,
  loadStyleProfile,
  loadRuntimeRules,
  type WorkspaceBundle,
} from "../adapters/legacy-workspace-adapter.js";
import type { ChapterSeed } from "../../craft/chapter-seed-types.js";
import { loadCreativeConstitution } from "./creative-constitution.js";
import { loadStateStore } from "./final-state-commit.js";
import { backfillAcceptedChapterState } from "./historical-state-backfill.js";
import { retrieveNarrativeContext } from "./context-retrieval.js";

// ============================================================================
// ContextCompiler 入参/出参
// ============================================================================

export interface ContextCompileInput {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  projectRoot: string;
}

export interface ContextCompileResult {
  context: CompiledContext;
  diagnostics: Diagnostic[];
  sourceSeed: ChapterSeed;
  contextHash: string;
}

// ============================================================================
// 派生函数：ChapterSeed → CompiledContext 各字段
// ============================================================================

function deriveCharacterStates(seed: ChapterSeed): CharacterStateFact[] {
  return (seed.characters ?? []).map((c) => ({
    characterId: c.name,
    name: c.name,
    state: {
      role: c.role,
      mentality: c.mentality,
      recentAction: c.recentAction,
      pendingTension: c.pendingTension,
      aliases: c.aliases,
      narrativeProfile: c.narrativeProfile,
    },
    sourceIds: [`character:${c.name}`, ...(c.narrativeProfile?.sourceId ? [c.narrativeProfile.sourceId] : [])],
  }));
}

function deriveWorldRules(seed: ChapterSeed): WorldRuleFact[] {
  const wc = seed.worldConstraint;
  const rules: WorldRuleFact[] = [
    {
      id: "world:genre",
      description: `${wc.genre}${wc.subGenres?.length ? " / " + wc.subGenres.join("/") : ""}`,
      type: "genre",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    },
  ];
  if (wc.powerSystem) {
    rules.push({
      id: "world:power_system",
      description: wc.powerSystem,
      type: "power_system",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    });
  }
  (wc.immutableFacts ?? []).forEach((f, i) => {
    rules.push({
      id: `world:immutable:${i}`,
      description: f,
      type: "immutable_fact",
      affectedCharacters: [],
      sourceIds: ["config.json"],
    });
  });
  return rules;
}

function deriveOpenLoops(seed: ChapterSeed): OpenLoopFact[] {
  const loops: OpenLoopFact[] = [];
  const cp = seed.currentPressure;
  (cp.pendingForeshadowing ?? []).forEach((f) => {
    loops.push({
      id: `foreshadow:${f.id}`,
      description: f.description,
      openedAt: f.level ?? "unknown",
      urgency: 0.6,
      sourceIds: ["arc-registry.json"],
    });
  });
  (cp.openArcs ?? []).forEach((a) => {
    loops.push({
      id: `arc:${a.arcId}`,
      description: a.name + (a.coreQuestion ? `（核心问题：${a.coreQuestion}）` : ""),
      openedAt: a.priority ?? "unknown",
      urgency: 0.7,
      sourceIds: ["arc-registry.json"],
    });
  });
  (cp.pendingCosts ?? []).forEach((c, i) => {
    loops.push({
      id: `cost:${i}`,
      description: `${c.action} → ${c.cost}`,
      openedAt: c.chapterIncurred != null ? `ch${c.chapterIncurred}` : "unknown",
      urgency: 0.4,
      sourceIds: ["narrative-state.json"],
    });
  });
  (seed.unsettledDetails ?? []).forEach((d) => {
    loops.push({
      id: `unsettled:${d.id}`,
      description: `${d.type}: ${d.description}`,
      openedAt: d.chapterId,
      urgency: 0.5,
      sourceIds: ["unsettled-details.json"],
    });
  });
  return loops;
}

function deriveFacts(seed: ChapterSeed): ContextFact[] {
  const facts: ContextFact[] = [];
  const pc = seed.previousChapterContinuation;
  if (pc.available) {
    facts.push({
      id: "fact:prev_continuation",
      content:
        `前章末事件：${pc.lastEventSummary ?? "未知"}（${pc.lastEventId ?? "?"}）；` +
        `结尾情绪：${pc.endingEmotion ?? "未知"}；` +
        `开放钩子：${(pc.openHooks ?? []).join(" / ") || "无"}；` +
        `未解张力：${(pc.unresolvedTensions ?? []).join(" / ") || "无"}；` +
        `新登场角色：${(pc.introducedCharacters ?? []).join(" / ") || "无"}`,
      sourceIds: pc.sourceIds ?? ["series/skeleton.json"],
      kind: "fact",
    });
  }
  const hd = seed.highLevelDirection;
  if (hd.available) {
    if (hd.backgroundNotes?.length) {
      facts.push({
        id: "fact:high_level_background",
        content: `高层背景：${hd.backgroundNotes.join("；")}`,
        sourceIds: ["series/outline.md"],
        kind: "suggestion",
      });
    }
    (hd.immutableFacts ?? []).forEach((f, i) => {
      facts.push({
        id: `fact:immutable:${i}`,
        content: f,
        sourceIds: ["series/outline.md"],
        kind: "fact",
      });
    });
  }
  const intent = seed.intent;
  if (intent) {
    facts.push({
      id: "fact:chapter_intent",
      content:
        `本章意图：${intent.primary}（主题：${intent.chapterTheme}）；` +
        `目标情绪：${intent.targetEmotions.join("、") || "未指定"}；` +
        `关键词：${intent.keywords.join("、") || "无"}`,
      sourceIds: ["chapter-seed-builder"],
      kind: "suggestion",
    });
  }
  return facts;
}

/**
 * REAL-QUALITY-4：从 previousChapterContinuation 派生结构化 bridgeContext。
 * 与 deriveFacts 中的 fact:prev_continuation 同源，但 bridgeContext 是独立字段，
 * 供 buildRawPrompt 渲染为不可跳过的"前章悬置状态"block，不参与 facts.slice(0,10) 截断。
 */
function deriveBridgeContext(seed: ChapterSeed): BridgeContext | null {
  const pc = seed.previousChapterContinuation;
  if (!pc || !pc.available) return null;
  return {
    available: true,
    lastEventSummary: pc.lastEventSummary,
    lastEventId: pc.lastEventId,
    endingEmotion: pc.endingEmotion,
    openHooks: [...(pc.openHooks ?? [])],
    unresolvedTensions: [...(pc.unresolvedTensions ?? [])],
    introducedCharacters: [...(pc.introducedCharacters ?? [])],
    sourceIds: pc.sourceIds ?? ["series/skeleton.json"],
  };
}

// ============================================================================
// Phase 1 分层：作品宪法快照与长期状态快照
// ============================================================================

/**
 * 从 CreativeConstitution 派生只读快照。无宪法文件时返回 null（不阻断）。
 */
function deriveConstitution(
  workspaceId: string,
  projectRoot: string
): ConstitutionSnapshot | null {
  const constitution = loadCreativeConstitution(workspaceId, projectRoot);
  if (!constitution) return null;
  return {
    workIdentity: constitution.workIdentity,
    readerPromise: [...constitution.readerPromise],
    genrePromises: [...constitution.genrePromises],
    protagonistCoreConflict: constitution.protagonistCoreConflict,
    thematicQuestions: [...constitution.thematicQuestions],
    aestheticDirection: [...constitution.aestheticDirection],
    forbiddenDrift: [...constitution.forbiddenDrift],
    sourceIds: ["creative-constitution.json"],
  };
}

/**
 * 从 NarrativeStateStore 派生只读快照。无状态文件时返回 null（不阻断）。
 * 候选生成期间只读快照，写入延迟到 final selection 之后（FinalStateCommit）。
 */
function deriveLongTermState(
  workspaceId: string,
  projectRoot: string,
  chapterNumber: number,
  seed: ChapterSeed,
): LongTermStateSnapshot | null {
  backfillAcceptedChapterState({
    workspaceId,
    projectRoot,
    beforeChapterNumber: chapterNumber,
  });
  const store = loadStateStore(workspaceId, projectRoot);
  // 空状态文件视为无快照（避免向候选注入空噪音）
  // P2 闭环修复：同时检查 planned 字段——若仅有 planned 条目（无权威状态），
  // 仍需返回快照以暴露前序章节的计划意图供连续性参考。
  const isEmpty =
    store.canon.length === 0 &&
    store.character.length === 0 &&
    store.promise.length === 0 &&
    store.pattern.length === 0 &&
    (store.planned ?? []).length === 0;
  if (isEmpty) return null;
  const explicitCharacters = seed.authorChapterContract?.relevantCharacters?.length
    ? seed.authorChapterContract.relevantCharacters
    : (seed.explicitEventCharacters ?? []).flatMap((entry) => entry.characters);
  const evidenceText = [
    ...(seed.authorChapterContract?.eventSummaries ?? []),
    ...(seed.authorChapterContract?.mustInclude ?? []),
    ...(seed.authorChapterContract?.foreshadowing ?? []),
    ...(seed.currentPressure?.pendingForeshadowing ?? []).map((entry) => entry.description),
    ...(seed.currentPressure?.openArcs ?? []).flatMap((entry) => [entry.name, entry.coreQuestion ?? ""]),
    ...(seed.previousChapterContinuation?.introducedCharacters ?? []),
  ].join("\n");
  const evidenceMatchedCharacters = (seed.characters ?? [])
    .filter((entry) => evidenceText.includes(entry.name) || (entry.aliases ?? []).some((alias) => evidenceText.includes(alias)))
    .map((entry) => entry.name);
  const relevantCharacters = [...new Set([
    ...explicitCharacters,
    ...(seed.previousChapterContinuation?.introducedCharacters ?? []),
    ...evidenceMatchedCharacters,
  ])];
  const totalStateEntries =
    store.canon.length + store.character.length + store.promise.length
    + store.pattern.length + (store.expectation?.length ?? 0);
  const retrieval = retrieveNarrativeContext({
    chapterNumber,
    relevantCharacters,
    selectedPromiseIds: (seed.currentPressure?.pendingForeshadowing ?? []).map((entry) => entry.id),
    // P3 H2：当前选中伏笔同时强制保留——它们既要高分（+120）也要免 itemLimit 强制纳入，
    // 避免 100+ 章积累大量高分条目时把本章应推进的关键伏笔挤出 workingSet。
    forcedRecallIds: (seed.currentPressure?.pendingForeshadowing ?? []).map((entry) => entry.id),
    keywords: [
      seed.intent?.primary ?? "",
      seed.intent?.chapterTheme ?? "",
      ...(seed.intent?.keywords ?? []),
      ...(seed.currentPressure?.openArcs ?? []).map((entry) => entry.name),
    ].filter(Boolean),
    state: store,
    maxItems: computeMaxItems(totalStateEntries),
  });
  return {
    canon: retrieval.workingSet.canon.map((e) => ({
      id: e.id,
      fact: e.fact,
      category: e.category,
      sourceChapter: e.sourceChapter,
    })),
    character: retrieval.workingSet.character.map((e) => ({
      id: e.id,
      characterId: e.characterId,
      field: e.field,
      value: e.value,
      sourceChapter: e.sourceChapter,
    })),
    promise: retrieval.workingSet.promise.map((e) => ({
      id: e.id,
      promiseId: e.promiseId,
      description: e.description,
      status: e.status,
      currentHeat: e.currentHeat,
      sourceChapter: e.sourceChapter,
    })),
    pattern: retrieval.workingSet.pattern.map((e) => ({
      id: e.id,
      patternType: e.patternType,
      description: e.description,
      occurrenceCount: e.occurrenceCount,
      sourceChapter: e.sourceChapter,
    })),
    // FUTURE-STATE-ISOLATION-1：expectation 同样经过 retrieveNarrativeContext 过滤
    expectation: (retrieval.workingSet.expectation ?? []).map((e) => ({
      id: e.id,
      expectationId: e.expectationId,
      description: e.description,
      expectationType: e.expectationType,
      targetReaderExperience: e.targetReaderExperience,
      delayReason: e.delayReason,
      status: e.status,
      sourceChapter: e.sourceChapter,
      sourceRef: e.sourceRef,
    })),
    lastCommittedChapter: store.lastCommittedChapter,
    sourceIds: ["narrative-state-store.json"],
    retrievalReport: retrieval.report,
    promptItems: retrieval.promptItems,
    // P4 M3：pre-write overdue alerts，由 retrieveNarrativeContext 从 eligible 派生。
    overdueAlerts: retrieval.overdueAlerts,
    // P2 闭环修复：Phase 3D 计划状态（PlannedState）全量暴露。
    // 计划状态不经过 retrieveNarrativeContext 过滤（总量有限，需让下一章完整看到
    // 前序意图）。verified/verificationOutcome 帮助下游判断计划是否被正文实际兑现。
    planned: (store.planned ?? []).map((e) => ({
      id: e.id,
      plannedKind: e.plannedKind,
      plannedContent: e.plannedContent,
      plannedSource: e.plannedSource,
      plannedField: e.plannedField,
      sourceChapter: e.sourceChapter,
      verified: e.verified,
      verificationOutcome: e.verificationOutcome,
    })),
  };
}

function buildSourceMap(seed: ChapterSeed, stylePath?: string, rulesPath?: string): SourceMapEntry[] {
  const entries: SourceMapEntry[] = [
    { sourceId: "config.json", sourceType: "config", path: "config.json" },
    { sourceId: "skeleton.json", sourceType: "skeleton", path: "skeleton.json" },
    { sourceId: "arc-registry.json", sourceType: "foreshadow", path: "arc-registry.json" },
    { sourceId: "narrative-state.json", sourceType: "config", path: "narrative-state.json" },
    { sourceId: "unsettled-details.json", sourceType: "detail_ledger", path: "unsettled-details.json" },
    { sourceId: "chapter-seed-builder", sourceType: "config", path: "craft/chapter-seed-builder.ts" },
  ];
  (seed.characters ?? []).forEach((c) => {
    entries.push({
      sourceId: `character:${c.name}`,
      sourceType: "character",
      path: `characters/${c.name}.md`,
    });
  });
  if (stylePath) {
    entries.push({ sourceId: "style:fingerprint", sourceType: "style", path: stylePath });
  }
  if (rulesPath) {
    entries.push({ sourceId: "runtime_rules", sourceType: "runtime_rule", path: rulesPath });
  }
  const hd = seed.highLevelDirection;
  if (hd?.available) {
    entries.push({ sourceId: "series/outline.md", sourceType: "foreshadow", path: "series/outline.md" });
  }
  for (const sourceId of seed.authorChapterContract?.sourceIds ?? []) {
    if (!entries.some((entry) => entry.sourceId === sourceId)) {
      entries.push({ sourceId, sourceType: "foreshadow", path: sourceId });
    }
  }
  for (const sourceId of seed.previousChapterContinuation?.sourceIds ?? []) {
    if (!entries.some((entry) => entry.sourceId === sourceId)) {
      entries.push({
        sourceId,
        sourceType: sourceId.startsWith("chapters/") ? "chapter" : "skeleton",
        path: sourceId,
      });
    }
  }
  return entries;
}

/**
 * P3 H2 修复（2026-07-23）：按状态总量动态缩放 maxItems，不再硬编码 24。
 *
 * 100+ 章小说积累数百条状态时，固定 24 上限会丢失关键远章伏笔/角色状态。
 * 公式：Math.min(48, Math.max(24, floor(total / 4)))
 * - 下限 24：小 state 保留原行为，避免 token 浪费
 * - 上限 48：500+ 条状态本应放大到 125，封顶控制 token 成本（≈2x 原 24）
 *
 * 导出供 unit test 验证公式边界（tests/context-retrieval-must-recall.test.mjs）。
 */
export function computeMaxItems(totalEntries: number): number {
  const safeTotal = Math.max(0, Math.floor(totalEntries));
  return Math.min(48, Math.max(24, Math.floor(safeTotal / 4)));
}

function computeContextHash(context: CompiledContext): string {
  // 稳定序列化：按 id 排序后 hash，避免数组顺序影响
  const stable = {
    facts: [...context.facts].sort((a, b) => a.id.localeCompare(b.id)).map((f) => ({ id: f.id, content: f.content })),
    characterStates: [...context.characterStates].sort((a, b) => a.characterId.localeCompare(b.characterId)).map((c) => ({ id: c.characterId })),
    openLoops: [...context.openLoops].sort((a, b) => a.id.localeCompare(b.id)).map((l) => ({ id: l.id, desc: l.description })),
    worldRules: [...context.worldRules].sort((a, b) => a.id.localeCompare(b.id)).map((w) => ({ id: w.id, desc: w.description })),
    // Phase 1：宪法与长期状态纳入 hash，使内容变化可被检测
    constitution: context.constitution
      ? {
          workIdentity: context.constitution.workIdentity,
          readerPromise: [...context.constitution.readerPromise].sort(),
          genrePromises: [...context.constitution.genrePromises].sort(),
          protagonistCoreConflict: context.constitution.protagonistCoreConflict,
          thematicQuestions: [...context.constitution.thematicQuestions].sort(),
          forbiddenDrift: [...context.constitution.forbiddenDrift].sort(),
        }
      : null,
    longTermState: context.longTermState
      ? {
          canon: [...context.longTermState.canon].sort((a, b) => a.id.localeCompare(b.id)).map((e) => e.id),
          character: [...context.longTermState.character].sort((a, b) => a.id.localeCompare(b.id)).map((e) => e.id),
          promise: [...context.longTermState.promise].sort((a, b) => a.id.localeCompare(b.id)).map((e) => e.id),
          pattern: [...context.longTermState.pattern].sort((a, b) => a.id.localeCompare(b.id)).map((e) => e.id),
          lastCommittedChapter: context.longTermState.lastCommittedChapter ?? null,
        }
      : null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

// ============================================================================
// 关键事实缺失诊断
// ============================================================================

function checkMissingCriticalFacts(seed: ChapterSeed, chapterNumber: number): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (!seed.characters || seed.characters.length === 0) {
    diags.push({
      id: "diag:missing_characters",
      source: "context_compiler",
      severity: "hard",
      domain: "continuity",
      evidence: "ChapterSeed.characters 为空，无法保证角色一致性",
    });
  }
  if (!seed.worldConstraint?.immutableFacts?.length) {
    diags.push({
      id: "diag:missing_immutable_facts",
      source: "context_compiler",
      severity: "review",
      domain: "worldbuilding",
      evidence: "ChapterSeed.worldConstraint.immutableFacts 为空，世界观硬约束缺失",
    });
  }
  if (chapterNumber > 1 && !seed.previousChapterContinuation?.available) {
    diags.push({
      id: "diag:missing_prev_continuation",
      source: "context_compiler",
      severity: "hard",
      domain: "continuity",
      evidence: `第 ${chapterNumber} 章但 previousChapterContinuation.available=false，前章承接缺失`,
    });
  }
  if (!seed.authorChapterContract?.chapterFunction && !seed.intent?.primary) {
    diags.push({
      id: "diag:missing_intent",
      source: "context_compiler",
      severity: "review",
      domain: "scene_continuity",
      evidence: "ChapterSeed.intent.primary 为空，本章意图不明",
    });
  }
  return diags;
}

// ============================================================================
// ContextCompiler 类
// ============================================================================

export class ContextCompiler {
  compile(input: ContextCompileInput): ContextCompileResult {
    const bundle: WorkspaceBundle = loadWorkspace(input.workspaceId, input.projectRoot);
    const { seed, warnings } = loadChapterSeed(bundle, input.chapterNumber, input.chapterId);

    const characterStates = deriveCharacterStates(seed);
    const worldRules = deriveWorldRules(seed);
    const openLoops = deriveOpenLoops(seed);
    const facts = deriveFacts(seed);
    const bridgeContext = deriveBridgeContext(seed);

    // 风格资料
    const styleEntries: StyleReference[] = [];
    const styleProfile = loadStyleProfile(bundle, input.projectRoot);
    if (styleProfile) {
      styleEntries.push({
        id: styleProfile.id,
        kind: "fingerprint",
        content: styleProfile.content,
        sourceIds: ["style:fingerprint"],
      });
    }

    // runtime rules（候选经验，不强制执行）
    const rules = loadRuntimeRules(input.projectRoot);
    if (rules.length > 0) {
      facts.push({
        id: "fact:runtime_rules",
        content: `已加载 ${rules.length} 条 runtime craft rules（候选经验，status=${rules[0].status}），仅作为 context_hint，不强制执行`,
        sourceIds: ["runtime_rules"],
        kind: "candidate_experience",
      });
    }

    // 把 warnings 转为 info diagnostic（保留但不阻断）
    const warningDiags: Diagnostic[] = warnings.map((w, i) => ({
      id: `diag:seed_warning:${i}`,
      source: "chapter_seed_builder",
      severity: "info",
      domain: "continuity",
      evidence: w,
    }));

    const missingDiags = checkMissingCriticalFacts(seed, input.chapterNumber);

    const sourceMap = buildSourceMap(
      seed,
      styleProfile?.sourcePath,
      rules.length > 0 ? "data/runtime/validated-craft-rules.json" : undefined
    );

    // Phase 1 分层：作品宪法 + 长期状态（只读快照，缺失不阻断）
    const constitution = deriveConstitution(input.workspaceId, input.projectRoot);
    const longTermState = deriveLongTermState(input.workspaceId, input.projectRoot, input.chapterNumber, seed);
    if (constitution) {
      sourceMap.push({
        sourceId: "creative-constitution.json",
        sourceType: "config",
        path: `workspaces/${input.workspaceId}/creative-constitution.json`,
      });
    }
    if (longTermState) {
      sourceMap.push({
        sourceId: "narrative-state-store.json",
        sourceType: "config",
        path: `workspaces/${input.workspaceId}/narrative-state-store.json`,
      });
    }

    const context: CompiledContext = {
      facts,
      characterStates,
      openLoops,
      worldRules,
      styleReferences: styleEntries,
      sourceMap,
      constitution,
      longTermState,
      bridgeContext,
    };

    const contextHash = computeContextHash(context);

    return {
      context,
      diagnostics: [...warningDiags, ...missingDiags],
      sourceSeed: seed,
      contextHash,
    };
  }
}

export function createContextCompiler(): ContextCompiler {
  return new ContextCompiler();
}
