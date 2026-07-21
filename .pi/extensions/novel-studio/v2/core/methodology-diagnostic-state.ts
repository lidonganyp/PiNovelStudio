/**
 * MethodologyDiagnosticState - compact read-only state for post-raw diagnosis.
 *
 * This loader never writes, normalizes, or repairs workspace files. Its output
 * is advisory evidence only and must not be injected into the raw writer prompt.
 *
 * P1-5（2026-07-21）：新增 advisorySignals 字段，消费 3 个新源（reader-feedback /
 * return-chapter-provenance / chapter-progression-contracts）。
 * P2-8：SOURCES / readJsonSource / 类型拆到 methodology-diagnostic-sources.ts，
 * 新源消费逻辑拆到 methodology-diagnostic-advisory.ts，本文件保持在 800 行以下。
 */

import {
  clampInteger,
  encodeRefComponent,
  finiteNumber,
  isDefined,
  isRecord,
  recordArray,
  recordValue,
  stringArray,
  stringValue,
  uniqueStrings,
} from "./methodology-diagnostic-utils.js";
import {
  SOURCES,
  readJsonSource,
  unavailableReason,
  type DiagnosticSourceAvailability,
  type DiagnosticSourceId,
  type DiagnosticSourceStatus,
  type ReadJsonResult,
} from "./methodology-diagnostic-sources.js";
import {
  assessFatigueSeverity,
  buildClimaxOpportunity,
  buildOverdueAlerts,
  buildStagnation,
  type EnsembleClimaxOpportunity,
  type OverdueAlertEntry,
  type StagnationAssessment,
} from "./methodology-diagnostic-derived.js";
import {
  buildAdvisorySignals,
  type AdvisorySignalsDiagnosticContext,
} from "./methodology-diagnostic-advisory.js";
import { parseOpenArc, parsePendingForeshadow } from "./methodology-diagnostic-closure.js";

// Re-export for backward compat (other modules import these from here).
export type {
  AdvisorySignalsDiagnosticContext,
} from "./methodology-diagnostic-advisory.js";
export type {
  DiagnosticSourceAvailability,
  DiagnosticSourceId,
  DiagnosticSourceStatus,
  ReadJsonResult,
} from "./methodology-diagnostic-sources.js";
export type { EnsembleClimaxOpportunity, OverdueAlertEntry, StagnationAssessment } from "./methodology-diagnostic-derived.js";

export type DiagnosticContextStatus = "available" | "unavailable";

export interface DeclaredGenreDiagnosticContext {
  status: DiagnosticContextStatus;
  genre: string | null;
  subGenres: string[];
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface ExpectationDiagnosticEntry {
  expectationId: string;
  description: string;
  status: string;
  targetReaderExperience: string | null;
  delayReason: string | null;
  sourceChapter: string;
  sourceRefs: string[];
  /**
   * REM 生命周期字段（EXPECTATION-LEDGER-1，2026-07-21）：
   * 用于 buildOverdueAlerts 计算逾期程度，不再只依赖 status=delayed/escalated。
   */
  createdChapter: string | null;
  lastAdvancedChapter: string | null;
  lastFulfilledChapter: string | null;
  /**
   * 独立逾期窗口（章节号）。
   * - earliest/optimal/latest 为 null 表示无约束/未指定。
   * - latest 非空时，chapterNumber > latest 视为逾期（red），
   *   chapterNumber >= latest - YELLOW_WINDOW 视为临近期（yellow）。
   */
  overdueWindow: {
    earliest: number | null;
    optimal: number | null;
    latest: number | null;
  } | null;
  relatedArcIds: string[];
  relatedCharacterIds: string[];
  relatedForeshadowIds: string[];
}

export interface PromiseDiagnosticEntry {
  promiseId: string;
  description: string;
  status: string;
  currentHeat: number | null;
  sourceChapter: string;
  sourceRefs: string[];
}

export interface PatternDiagnosticEntry {
  patternId: string;
  patternType: string;
  description: string;
  occurrenceCount: number | null;
  sourceChapter: string;
  sourceRefs: string[];
}

export interface FatigueDiagnosticContext {
  recentPatterns: string[];
  consecutiveSameType: number | null;
  recentHookTypes: string[];
  recentSceneTypes: string[];
  recentEmotionPeaks: string[];
  cooldownPeriods: Record<string, number>;
  horrorTechniques: string[];
  consecutiveSameHorrorTechnique: number | null;
  unresolvedExpectationCount: number | null;
  chaptersSinceLastPeak: number | null;
  lastPayoffChapter: number | null;
  /** Derived advisory severity — summarises repetition pressure for the judge. */
  severity: "none" | "mild" | "moderate" | "severe";
  severitySignals: string[];
  sourceRefs: string[];
}

export interface SerialDiagnosticState {
  status: DiagnosticContextStatus;
  expectations: ExpectationDiagnosticEntry[];
  promises: PromiseDiagnosticEntry[];
  patterns: PatternDiagnosticEntry[];
  fatigue: FatigueDiagnosticContext;
  /** Derived: REM overdue alerts (yellow/red) — advisory signal for the judge. */
  overdueAlerts: OverdueAlertEntry[];
  /** Derived: consecutive stagnation assessment — advisory signal for the judge. */
  stagnation: StagnationAssessment;
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface WorldRevealVersionDiagnostic {
  depth: string;
  content: string;
  chapter: number;
  sourceRef: string;
}

export interface WorldRevealItemDiagnostic {
  itemId: string;
  name: string;
  type: string;
  status: string;
  actualChapter: number | null;
  earliestChapter: number | null;
  optimalChapter: number | null;
  latestChapter: number | null;
  hardDependencies: string[];
  softDependencies: string[];
  revealVersions: WorldRevealVersionDiagnostic[];
  sourceRef: string;
}

export interface WorldRevelationDiagnosticContext {
  status: DiagnosticContextStatus;
  items: WorldRevealItemDiagnostic[];
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface RelationshipDiagnosticEntry {
  relationshipId: string;
  state: string | null;
  lastInteractionChapter: number | null;
  pendingTension: string | null;
  sourceRef: string;
}

export interface EnsembleFocusDiagnosticEntry {
  chapter: number;
  character: string;
  sourceRefs: string[];
}

export interface EnsembleDiagnosticContext {
  status: DiagnosticContextStatus;
  relationships: RelationshipDiagnosticEntry[];
  focusHistory: EnsembleFocusDiagnosticEntry[];
  /** Derived: multi-line convergence climax opportunity — advisory signal. */
  climaxOpportunity: EnsembleClimaxOpportunity;
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface OpenArcDiagnosticEntry {
  arcId: string;
  name: string;
  arcType: string;
  priority: string;
  status: string;
  coreQuestion: string;
  chapterOpened: number | null;
  expectedClosureWindow: Record<string, number | null> | null;
  sourceRef: string;
}

export interface PendingForeshadowDiagnosticEntry {
  foreshadowId: string;
  description: string;
  level: string | null;
  chapterPlanted: number | null;
  expectedRecallWindow: Record<string, number | null> | null;
  sourceRef: string;
}

export interface ClosureDiagnosticContext {
  status: DiagnosticContextStatus;
  openArcs: OpenArcDiagnosticEntry[];
  pendingForeshadows: PendingForeshadowDiagnosticEntry[];
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface MethodologyDiagnosticState {
  schemaVersion: "methodology-diagnostic-state-v1";
  chapterNumber: number;
  advisoryOnly: true;
  canEnterRawPrompt: false;
  canDirectlyAuthorizeCandidate: false;
  sources: DiagnosticSourceAvailability[];
  declaredGenre: DeclaredGenreDiagnosticContext;
  serialState: SerialDiagnosticState;
  worldRevelation: WorldRevelationDiagnosticContext;
  ensemble: EnsembleDiagnosticContext;
  closure: ClosureDiagnosticContext;
  /**
   * P1-5（2026-07-21）：advisory signals from reader feedback, return chapter
   * provenance, and chapter progression contracts. advisory-only — never enters
   * raw prompt, never authorizes candidates.
   */
  advisorySignals: AdvisorySignalsDiagnosticContext;
}

export interface LoadMethodologyDiagnosticStateInput {
  workspacePath?: string;
  chapterNumber: number;
  maxEntriesPerContext?: number;
}

export class MethodologyDiagnosticStateLoader {
  load(input: LoadMethodologyDiagnosticStateInput): MethodologyDiagnosticState {
    const chapterNumber = Math.max(1, Math.trunc(input.chapterNumber));
    const maxEntries = clampInteger(input.maxEntriesPerContext ?? 12, 1, 50);
    const loaded = new Map<DiagnosticSourceId, ReadJsonResult>();

    for (const source of SOURCES) {
      loaded.set(source.sourceId, readJsonSource(input.workspacePath, source));
    }

    const config = loaded.get("config")!;
    const stateStore = loaded.get("narrative_state_store")!;
    const narrativeState = loaded.get("narrative_state")!;
    const fatigueState = loaded.get("fatigue_state")!;
    const worldItems = loaded.get("world_items")!;
    const arcRegistry = loaded.get("arc_registry")!;
    // P1-5（2026-07-21）：3 个新 advisory 源
    const readerFeedback = loaded.get("reader_feedback")!;
    const returnChapterProvenance = loaded.get("return_chapter_provenance")!;
    const progressionContracts = loaded.get("chapter_progression_contracts")!;

    const declaredGenre = buildDeclaredGenre(config);
    const baseSerialState = buildSerialState(stateStore, narrativeState, fatigueState, chapterNumber, maxEntries);
    const worldRevelation = buildWorldRevelation(worldItems, chapterNumber, maxEntries);
    const baseEnsemble = buildEnsemble(narrativeState, chapterNumber, maxEntries);
    const closure = buildClosure(arcRegistry, maxEntries, chapterNumber);

    // Derived advisory assessments — computed from base contexts, never enter
    // raw prompt, never authorize candidates. They only give the post-raw judge
    // compact, span-referenced cross-chapter pressure signals.
    const overdueAlerts = buildOverdueAlerts(baseSerialState, closure, chapterNumber);
    const stagnation = buildStagnation(baseSerialState, closure);
    const fatigueSeverity = assessFatigueSeverity(baseSerialState.fatigue);
    const climaxOpportunity = buildClimaxOpportunity(baseEnsemble, closure, baseSerialState, chapterNumber);
    // P1-5（2026-07-21）：3 个新源的 advisory 信号
    const advisorySignals = buildAdvisorySignals(
      readerFeedback,
      returnChapterProvenance,
      progressionContracts,
      chapterNumber,
      maxEntries,
    );

    return {
      schemaVersion: "methodology-diagnostic-state-v1",
      chapterNumber,
      advisoryOnly: true,
      canEnterRawPrompt: false,
      canDirectlyAuthorizeCandidate: false,
      sources: SOURCES.map((source) => loaded.get(source.sourceId)!.source),
      declaredGenre,
      serialState: {
        ...baseSerialState,
        overdueAlerts,
        stagnation,
        fatigue: { ...baseSerialState.fatigue, ...fatigueSeverity },
      },
      worldRevelation,
      ensemble: { ...baseEnsemble, climaxOpportunity },
      closure,
      advisorySignals,
    };
  }
}

export function createMethodologyDiagnosticStateLoader(): MethodologyDiagnosticStateLoader {
  return new MethodologyDiagnosticStateLoader();
}

export function collectMethodologyDiagnosticSourceRefs(
  state: MethodologyDiagnosticState,
): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const e of value) visit(e); return; }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "sourceRef" && typeof entry === "string" && entry.trim()) {
        refs.add(entry.trim());
      } else if (key === "sourceRefs" && Array.isArray(entry)) {
        for (const ref of entry) if (typeof ref === "string" && ref.trim()) refs.add(ref.trim());
      } else {
        visit(entry);
      }
    }
  };
  visit({
    declaredGenre: state.declaredGenre,
    serialState: state.serialState,
    worldRevelation: state.worldRevelation,
    ensemble: state.ensemble,
    closure: state.closure,
    advisorySignals: state.advisorySignals,
  });
  return [...refs].sort();
}

function buildDeclaredGenre(source: ReadJsonResult): DeclaredGenreDiagnosticContext {
  const genre = stringValue(source.value?.genre);
  const subGenres = stringArray(source.value?.subGenres, 12);
  const sourceRefs = [
    ...(genre ? ["config.json#genre"] : []),
    ...(subGenres.length > 0 ? ["config.json#subGenres"] : []),
  ];
  return {
    status: genre || subGenres.length > 0 ? "available" : "unavailable",
    genre,
    subGenres,
    sourceRefs,
    emptyReason: genre || subGenres.length > 0
      ? null
      : unavailableReason(source, "declared_genre_not_found"),
  };
}

function buildSerialState(
  stateStore: ReadJsonResult,
  narrativeState: ReadJsonResult,
  fatigueState: ReadJsonResult,
  chapterNumber: number,
  maxEntries: number,
): SerialDiagnosticState {
  const expectations = recordArray(stateStore.value?.expectation)
    .filter((entry) => isPriorStateEntry(entry, chapterNumber))
    .map(parseExpectation)
    .filter(isDefined)
    .slice(0, maxEntries);
  const promises = recordArray(stateStore.value?.promise)
    .filter((entry) => isPriorStateEntry(entry, chapterNumber))
    .map(parsePromise)
    .filter(isDefined)
    .slice(0, maxEntries);
  const patterns = recordArray(stateStore.value?.pattern)
    .filter((entry) => isPriorStateEntry(entry, chapterNumber))
    .map(parsePattern)
    .filter(isDefined)
    .slice(0, maxEntries);
  const fatigue = parseFatigue(narrativeState, fatigueState, chapterNumber);
  const available = [stateStore, narrativeState, fatigueState]
    .some((entry) => entry.source.status === "available");
  const sourceRefs = uniqueStrings([
    ...expectations.flatMap((entry) => entry.sourceRefs),
    ...promises.flatMap((entry) => entry.sourceRefs),
    ...patterns.flatMap((entry) => entry.sourceRefs),
    ...fatigue.sourceRefs,
  ]);
  return {
    status: available ? "available" : "unavailable",
    expectations,
    promises,
    patterns,
    fatigue,
    overdueAlerts: [],
    stagnation: {
      detected: false,
      chaptersSinceLastPeak: fatigue.chaptersSinceLastPeak,
      stagnantArcIds: [],
      sourceRefs: [],
      emptyReason: "not_computed",
    },
    sourceRefs,
    emptyReason: available ? null : "serial_sources_missing_or_malformed",
  };
}

function parseExpectation(value: Record<string, unknown>): ExpectationDiagnosticEntry | null {
  const expectationId = stringValue(value.expectationId) ?? stringValue(value.id);
  const description = stringValue(value.description);
  const sourceChapter = stringValue(value.sourceChapter);
  if (!expectationId || !description || !sourceChapter) return null;
  return {
    expectationId,
    description,
    status: stringValue(value.status) ?? "unknown",
    targetReaderExperience: stringValue(value.targetReaderExperience),
    delayReason: stringValue(value.delayReason),
    sourceChapter,
    sourceRefs: stateEntrySourceRefs("expectation", expectationId, value.sourceRef),
    // REM 生命周期字段（向后兼容：旧 state store 无这些字段时为 null/空）
    createdChapter: stringValue(value.createdChapter),
    lastAdvancedChapter: stringValue(value.lastAdvancedChapter),
    lastFulfilledChapter: stringValue(value.lastFulfilledChapter),
    overdueWindow: parseOverdueWindow(value.overdueWindow),
    relatedArcIds: stringArrayValue(value.relatedArcIds),
    relatedCharacterIds: stringArrayValue(value.relatedCharacterIds),
    relatedForeshadowIds: stringArrayValue(value.relatedForeshadowIds),
  };
}

/**
 * 解析 overdueWindow 字段（向后兼容：旧 state store 无此字段时返回 null）。
 * 字段格式：{ earliest: number|null, optimal: number|null, latest: number|null }
 */
function parseOverdueWindow(value: unknown): {
  earliest: number | null;
  optimal: number | null;
  latest: number | null;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    earliest: finiteNumber(record.earliest),
    optimal: finiteNumber(record.optimal),
    latest: finiteNumber(record.latest),
  };
}

/**
 * 安全解析字符串数组字段（向后兼容：缺失或类型不匹配时返回空数组）。
 */
function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : null))
    .filter((v): v is string => v !== null && v.length > 0);
}

function parsePromise(value: Record<string, unknown>): PromiseDiagnosticEntry | null {
  const promiseId = stringValue(value.promiseId) ?? stringValue(value.id);
  const description = stringValue(value.description);
  const sourceChapter = stringValue(value.sourceChapter);
  if (!promiseId || !description || !sourceChapter) return null;
  return {
    promiseId,
    description,
    status: stringValue(value.status) ?? "unknown",
    currentHeat: finiteNumber(value.currentHeat),
    sourceChapter,
    sourceRefs: stateEntrySourceRefs("promise", promiseId, value.sourceRef),
  };
}

function parsePattern(value: Record<string, unknown>): PatternDiagnosticEntry | null {
  const patternId = stringValue(value.id);
  const description = stringValue(value.description);
  const sourceChapter = stringValue(value.sourceChapter);
  if (!patternId || !description || !sourceChapter) return null;
  return {
    patternId,
    patternType: stringValue(value.patternType) ?? "unknown",
    description,
    occurrenceCount: finiteNumber(value.occurrenceCount),
    sourceChapter,
    sourceRefs: stateEntrySourceRefs("pattern", patternId, value.sourceRef),
  };
}

function stateEntrySourceRefs(kind: string, id: string, sourceRef: unknown): string[] {
  return uniqueStrings([
    `narrative-state-store.json#${kind}:${encodeRefComponent(id)}`,
    ...(stringValue(sourceRef) ? [stringValue(sourceRef)!] : []),
  ]);
}

function parseFatigue(
  narrativeState: ReadJsonResult,
  fatigueState: ReadJsonResult,
  chapterNumber: number,
): FatigueDiagnosticContext {
  const acceptedChapter = finiteNumber(narrativeState.value?.currentChapter);
  if (acceptedChapter === null || acceptedChapter >= chapterNumber) return emptyFatigueContext();
  const fatigueIndicators = recordValue(fatigueState.value?.fatigueIndicators);
  const horrorFatigue = recordValue(narrativeState.value?.horrorFatigue);
  const readerExpectation = recordValue(narrativeState.value?.readerExpectation);
  const cooldownPeriods = numericRecord(fatigueState.value?.cooldownPeriods, 12);
  const sourceRefs: string[] = [];
  if (fatigueState.source.status === "available") sourceRefs.push("series/fatigue-state.json#root");
  if (horrorFatigue) sourceRefs.push("series/narrative-state.json#horrorFatigue");
  if (readerExpectation) sourceRefs.push("series/narrative-state.json#readerExpectation");
  return {
    recentPatterns: stringArray(fatigueState.value?.recentPatterns, 12),
    consecutiveSameType: finiteNumber(fatigueIndicators?.consecutiveSameType),
    recentHookTypes: stringArray(fatigueIndicators?.recentHookTypes, 12),
    recentSceneTypes: stringArray(fatigueIndicators?.recentSceneTypes, 12),
    recentEmotionPeaks: stringArray(fatigueIndicators?.recentEmotionPeaks, 12),
    cooldownPeriods,
    horrorTechniques: stringArray(horrorFatigue?.recentTechniques, 12),
    consecutiveSameHorrorTechnique: finiteNumber(horrorFatigue?.consecutiveSameTechnique),
    unresolvedExpectationCount: finiteNumber(readerExpectation?.unresolvedCount),
    chaptersSinceLastPeak: finiteNumber(readerExpectation?.chaptersSinceLastPeak),
    lastPayoffChapter: finiteNumber(readerExpectation?.lastPayoffChapter),
    severity: "none",
    severitySignals: [],
    sourceRefs,
  };
}

function emptyFatigueContext(): FatigueDiagnosticContext {
  return {
    recentPatterns: [], consecutiveSameType: null, recentHookTypes: [],
    recentSceneTypes: [], recentEmotionPeaks: [], cooldownPeriods: {},
    horrorTechniques: [], consecutiveSameHorrorTechnique: null,
    unresolvedExpectationCount: null, chaptersSinceLastPeak: null,
    lastPayoffChapter: null, severity: "none", severitySignals: [], sourceRefs: [],
  };
}

function buildWorldRevelation(
  source: ReadJsonResult,
  chapterNumber: number,
  maxEntries: number,
): WorldRevelationDiagnosticContext {
  if (!source.value) {
    return {
      status: "unavailable",
      items: [],
      sourceRefs: [],
      emptyReason: unavailableReason(source, "world_items_unavailable"),
    };
  }
  const items = recordArray(source.value.items)
    .map((item) => parseWorldItem(item, chapterNumber))
    .filter(isDefined)
    .slice(0, maxEntries);
  return {
    status: "available",
    items,
    sourceRefs: items.map((item) => item.sourceRef),
    emptyReason: items.length === 0 ? "no_world_item_visible_for_chapter" : null,
  };
}

function parseWorldItem(
  value: Record<string, unknown>,
  chapterNumber: number,
): WorldRevealItemDiagnostic | null {
  const itemId = stringValue(value.id);
  const name = stringValue(value.name);
  if (!itemId || !name) return null;
  const actualChapter = finiteNumber(value.actualChapter);
  const earliestChapter = finiteNumber(value.earliestChapter);
  const optimalChapter = finiteNumber(value.optimalChapter);
  const latestChapter = finiteNumber(value.latestChapter);
  const releaseStrategy = recordValue(value.releaseStrategy);
  const forcedChapter = finiteNumber(releaseStrategy?.forcedChapter);
  const revealVersions = recordArray(value.revealVersions)
    .map((version) => parseVisibleRevealVersion(version, itemId, chapterNumber, {
      actualChapter,
      optimalChapter,
      forcedChapter,
    }))
    .filter(isDefined);
  const scheduledNow = actualChapter !== null && actualChapter <= chapterNumber
    || optimalChapter === chapterNumber
    || forcedChapter === chapterNumber
    || earliestChapter !== null && earliestChapter <= chapterNumber
      && latestChapter !== null && chapterNumber <= latestChapter;
  if (!scheduledNow && revealVersions.length === 0) return null;
  const dependencies = recordValue(value.dependencies);
  return {
    itemId,
    name,
    type: stringValue(value.type) ?? "OTHER",
    status: stringValue(value.status) ?? "unknown",
    actualChapter,
    earliestChapter,
    optimalChapter,
    latestChapter,
    hardDependencies: stringArray(dependencies?.hard, 20),
    softDependencies: stringArray(dependencies?.soft, 20),
    revealVersions,
    sourceRef: `series/world-items.json#items:${encodeRefComponent(itemId)}`,
  };
}

function parseVisibleRevealVersion(
  value: Record<string, unknown>,
  itemId: string,
  chapterNumber: number,
  itemSchedule: {
    actualChapter: number | null;
    optimalChapter: number | null;
    forcedChapter: number | null;
  },
): WorldRevealVersionDiagnostic | null {
  if (value.spoilerProtection === true || stringValue(value.explainability) === "never") return null;
  const content = stringValue(value.content);
  const depth = stringValue(value.depth);
  const explicitChapter = finiteNumber(value.chapter);
  const scheduledChapter = explicitChapter
    ?? itemSchedule.actualChapter
    ?? itemSchedule.forcedChapter
    ?? itemSchedule.optimalChapter;
  if (!content || !depth || scheduledChapter === null || scheduledChapter > chapterNumber) return null;
  return {
    depth,
    content,
    chapter: scheduledChapter,
    sourceRef: `series/world-items.json#items:${encodeRefComponent(itemId)}:reveal:${encodeRefComponent(depth)}:ch${scheduledChapter}`,
  };
}

function defaultClimaxOpportunity(emptyReason: string): EnsembleClimaxOpportunity {
  return {
    detected: false,
    convergentArcs: [],
    criticalRelationships: [],
    convergentExpectations: [],
    estimatedWindow: null,
    sourceRefs: [],
    emptyReason,
  };
}

function buildEnsemble(
  source: ReadJsonResult,
  chapterNumber: number,
  maxEntries: number,
): EnsembleDiagnosticContext {
  if (!source.value) {
    return {
      status: "unavailable",
      relationships: [],
      focusHistory: [],
      climaxOpportunity: defaultClimaxOpportunity("not_computed"),
      sourceRefs: [],
      emptyReason: unavailableReason(source, "ensemble_state_unavailable"),
    };
  }
  const acceptedChapter = finiteNumber(source.value.currentChapter);
  if (acceptedChapter === null || acceptedChapter >= chapterNumber) {
    return {
      status: "unavailable",
      relationships: [],
      focusHistory: [],
      climaxOpportunity: defaultClimaxOpportunity("not_computed"),
      sourceRefs: [],
      emptyReason: "narrative_state_not_prior_to_chapter",
    };
  }
  const relationships = Object.entries(recordValue(source.value.relationshipTemperature) ?? {})
    .map(([relationshipId, value]) => parseRelationship(relationshipId, value, chapterNumber))
    .filter(isDefined)
    .slice(0, maxEntries);
  const focusHistory = recordArray(source.value.ensembleFocusHistory ?? source.value.focusHistory)
    .map(parseFocusHistory)
    .filter(isDefined)
    .filter((entry) => entry.chapter < chapterNumber)
    .slice(-maxEntries);
  const sourceRefs = uniqueStrings([
    ...relationships.map((entry) => entry.sourceRef),
    ...focusHistory.flatMap((entry) => entry.sourceRefs),
  ]);
  return {
    status: "available",
    relationships,
    focusHistory,
    climaxOpportunity: defaultClimaxOpportunity("not_computed"),
    sourceRefs,
    emptyReason: sourceRefs.length === 0 ? "no_relationship_or_focus_evidence" : null,
  };
}

function parseRelationship(
  relationshipId: string,
  value: unknown,
  chapterNumber: number,
): RelationshipDiagnosticEntry | null {
  const record = recordValue(value);
  if (!record) return null;
  const lastInteractionChapter = finiteNumber(record.lastInteractionChapter);
  if (lastInteractionChapter !== null && lastInteractionChapter >= chapterNumber) return null;
  return {
    relationshipId,
    state: stringValue(record.state),
    lastInteractionChapter,
    pendingTension: stringValue(record.pendingTension),
    sourceRef: `series/narrative-state.json#relationshipTemperature:${encodeRefComponent(relationshipId)}`,
  };
}

function parseFocusHistory(value: Record<string, unknown>): EnsembleFocusDiagnosticEntry | null {
  const chapter = finiteNumber(value.chapter);
  const character = stringValue(value.character);
  if (chapter === null || !character) return null;
  return {
    chapter,
    character,
    sourceRefs: uniqueStrings([
      `series/narrative-state.json#ensembleFocusHistory:ch${chapter}:${encodeRefComponent(character)}`,
      ...(stringValue(value.sourceRef) ? [stringValue(value.sourceRef)!] : []),
    ]),
  };
}

function buildClosure(
  source: ReadJsonResult,
  maxEntries: number,
  chapterNumber: number,
): ClosureDiagnosticContext {
  if (!source.value) {
    return {
      status: "unavailable",
      openArcs: [],
      pendingForeshadows: [],
      sourceRefs: [],
      emptyReason: unavailableReason(source, "closure_state_unavailable"),
    };
  }
  const openArcs = recordArray(source.value.arcs)
    .map(parseOpenArc)
    .filter(isDefined)
    .filter((entry) => entry.chapterOpened !== null && entry.chapterOpened < chapterNumber)
    .slice(0, maxEntries);
  const pendingForeshadows = recordArray(source.value.pending_foreshadows)
    .map(parsePendingForeshadow)
    .filter(isDefined)
    .filter((entry) => entry.chapterPlanted !== null && entry.chapterPlanted < chapterNumber)
    .slice(0, maxEntries);
  const sourceRefs = [
    ...openArcs.map((entry) => entry.sourceRef),
    ...pendingForeshadows.map((entry) => entry.sourceRef),
  ];
  return {
    status: "available",
    openArcs,
    pendingForeshadows,
    sourceRefs,
    emptyReason: sourceRefs.length === 0 ? "no_open_arc_or_pending_foreshadow" : null,
  };
}

function isPriorStateEntry(value: Record<string, unknown>, chapterNumber: number): boolean {
  const sourceChapter = stringValue(value.sourceChapter);
  const match = sourceChapter?.match(/^ch(\d+)$/u);
  return Boolean(match && Number(match[1]) < chapterNumber);
}

function numericRecord(value: unknown, limit: number): Record<string, number> {
  const record = recordValue(value);
  if (!record) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record).slice(0, limit)) {
    const number = finiteNumber(raw);
    if (number !== null) result[key] = number;
  }
  return result;
}
