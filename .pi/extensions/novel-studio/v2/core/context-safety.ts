/**
 * CONTEXT-SAFETY-1 — 硬约束分层、上下文预算与可回源裁剪。
 *
 * PROMPT-INJECTION-TRUST-ARCHITECTURE-1：
 * - ConstraintManifestItem 扩展 trustClass/authority/expiry/canPromote/contentHash
 * - 与 ContextPackage 分槽编译协作；P0/P1 仍不可静默丢弃
 */

import { createHash } from "node:crypto";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { CompiledContext } from "./types.js";
import type {
  Authority,
  ContentSlot,
  ExpiryPolicy,
  TrustClass,
} from "./trust/trust-types.js";
import {
  asReferenceMaterial,
  buildContextPackage,
  type ContextPackage,
} from "./trust/context-package.js";
import { emitTrustAuditEvent } from "./trust/trust-audit.js";
// 拉入信任架构公共 barrel，确保生产闭包包含全部 trust 模块（Eval/编排器可直接 import dist）
import "./trust/index.js";

export type ConstraintPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface ConstraintManifestItem {
  id: string;
  priority: ConstraintPriority;
  kind: string;
  content: string;
  sourceRefs: string[];
  estimatedTokens: number;
  origin: { area: "intent" | "context"; field: string; key?: string };
  /** 信任层（PROMPT-INJECTION-TRUST-ARCHITECTURE-1） */
  trustClass?: TrustClass;
  /** 权限类别 */
  authority?: Authority;
  /** 上下文槽位 */
  slot?: ContentSlot;
  /** 过期策略 */
  expiry?: ExpiryPolicy;
  /** 是否允许晋级 */
  canPromote?: boolean;
  /** 内容 hash */
  contentHash?: string;
  /** 结构化来源引用（扩展） */
  structuredSourceRefs?: Array<{ kind: string; id?: string; locator?: string }>;
}

export interface ConstraintManifest {
  schema: "pinovel.constraint-manifest";
  version: "1.0";
  manifestId: string;
  manifestHash: string;
  items: ConstraintManifestItem[];
}

export interface ContextBudgetEntry {
  id: string;
  priority: ConstraintPriority;
  estimatedTokens: number;
  sourceRefs: string[];
  reason?: string;
}

export interface ContextBudgetReport {
  manifestHash: string;
  modelWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  estimatedOriginalTokens: number;
  estimatedRetainedTokens: number;
  recompileAttempts: number;
  retained: ContextBudgetEntry[];
  dropped: ContextBudgetEntry[];
  merged: Array<ContextBudgetEntry & { mergedIds: string[] }>;
  conflicted: Array<{ ids: string[]; contents: string[]; sourceRefs: string[] }>;
  truncated: ContextBudgetEntry[];
}

export interface ContextSafetyCompileInput {
  manifest: ConstraintManifest;
  intent: ChapterIntent;
  context: CompiledContext;
  modelWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
}

export interface ContextSafetyResult {
  ok: boolean;
  blockReason?: "protected_context_overflow" | "hard_constraint_conflict" | "context_overflow";
  manifest: ConstraintManifest;
  workingIntent: ChapterIntent;
  workingContext: CompiledContext;
  report: ContextBudgetReport;
}

function inferTrustForPriority(
  priority: ConstraintPriority,
  kind: string,
): { trustClass: TrustClass; authority: Authority; slot: ContentSlot; canPromote: boolean } {
  if (priority === "P0") {
    if (kind === "canon" || kind.startsWith("long_term")) {
      return {
        trustClass: "committed_state",
        authority: "hard_constraint",
        slot: "COMMITTED_STATE",
        canPromote: false,
      };
    }
    if (kind === "forbidden_drift" || kind === "world_rule") {
      return {
        trustClass: "author_authority",
        authority: "hard_constraint",
        slot: kind === "world_rule" ? "IMMUTABLE_FACTS" : "AUTHOR_CONTRACT",
        canPromote: false,
      };
    }
    return {
      trustClass: "author_authority",
      authority: "hard_constraint",
      slot: "IMMUTABLE_FACTS",
      canPromote: false,
    };
  }
  if (priority === "P1") {
    return {
      trustClass: "author_authority",
      authority: "hard_constraint",
      slot: "AUTHOR_CONTRACT",
      canPromote: false,
    };
  }
  if (priority === "P4" || kind === "style_advisory" || kind === "candidate_experience") {
    return {
      trustClass: "retrieved_reference",
      authority: "reference_only",
      slot: "REFERENCE_MATERIAL",
      canPromote: false,
    };
  }
  return {
    trustClass: "retrieved_reference",
    authority: kind === "world_reference" ? "reference_only" : "soft_guidance",
    slot: "REFERENCE_MATERIAL",
    canPromote: false,
  };
}

export function createConstraintManifest(input: {
  intent: ChapterIntent;
  context: CompiledContext;
}): ConstraintManifest {
  const items: ConstraintManifestItem[] = [];
  const add = (
    id: string,
    priority: ConstraintPriority,
    kind: string,
    content: string,
    sourceRefs: string[],
    origin: ConstraintManifestItem["origin"],
  ): void => {
    if (!content?.trim()) return;
    const trimmed = content.trim();
    const trust = inferTrustForPriority(priority, kind);
    const contentHash = createHash("sha256").update(trimmed, "utf8").digest("hex");
    items.push({
      id,
      priority,
      kind,
      content: trimmed,
      sourceRefs,
      estimatedTokens: estimateTokens(trimmed),
      origin,
      trustClass: trust.trustClass,
      authority: trust.authority,
      slot: trust.slot,
      expiry: { kind: "never" },
      canPromote: trust.canPromote,
      contentHash,
      structuredSourceRefs: sourceRefs.map((ref) => ({
        kind: "other",
        id: ref,
        locator: ref,
      })),
    });
  };

  input.intent.inviolableFacts.forEach((content, index) =>
    add(`p0:intent:fact:${index}`, "P0", "hard_fact", content, input.intent.sourceRefs, { area: "intent", field: "inviolableFacts", key: String(index) }));
  (input.intent.factAndCharacterKnowledgeForbiddenZones ?? []).forEach((content, index) =>
    add(`p0:intent:knowledge:${index}`, "P0", "knowledge_boundary", content, input.intent.sourceRefs, { area: "intent", field: "factAndCharacterKnowledgeForbiddenZones", key: String(index) }));
  input.context.worldRules.filter((rule) => rule.type === "immutable_fact").forEach((rule) =>
    add(`p0:world:${rule.id}`, "P0", "world_rule", rule.description, rule.sourceIds, { area: "context", field: "worldRules", key: rule.id }));
  (input.context.constitution?.forbiddenDrift ?? []).forEach((content, index) =>
    add(`p0:constitution:${index}`, "P0", "forbidden_drift", content, input.context.constitution?.sourceIds ?? [], { area: "context", field: "constitution", key: String(index) }));
  (input.context.longTermState?.canon ?? []).forEach((entry) =>
    add(`p0:canon:${entry.id}`, "P0", "canon", entry.fact, [entry.sourceChapter], { area: "context", field: "longTermState.canon", key: entry.id }));

  const relevantCharacters = new Set(input.intent.relevantCharacters ?? []);
  const selectedPromiseIds = new Set((input.intent.selectedPromisesToAdvance ?? []).map((entry) => entry.promiseId));
  const selectedForeshadowing = input.intent.foreshadowing ?? [];
  const loopSelected = (id: string, description: string): boolean =>
    selectedPromiseIds.has(id.replace(/^foreshadow:/u, "")) || selectedForeshadowing.some((entry) =>
      entry.includes(id.replace(/^foreshadow:/u, "")) || entry.includes(description) || description.includes(entry));

  input.context.characterStates.forEach((entry) => {
    const priority: ConstraintPriority = relevantCharacters.has(entry.name) ? "P1" : "P3";
    add(`${priority.toLowerCase()}:character:${entry.characterId}`, priority, "character_state", `${entry.name}:${JSON.stringify(entry.state)}`, entry.sourceIds, { area: "context", field: "characterStates", key: entry.characterId });
  });
  input.context.openLoops.forEach((entry) => {
    const priority: ConstraintPriority = loopSelected(entry.id, entry.description) ? "P1" : "P3";
    add(`${priority.toLowerCase()}:loop:${entry.id}`, priority, "open_loop", entry.description, entry.sourceIds, { area: "context", field: "openLoops", key: entry.id });
  });
  (input.context.longTermState?.character ?? []).forEach((entry) => {
    const priority: ConstraintPriority = relevantCharacters.has(entry.characterId) ? "P1" : "P3";
    add(`${priority.toLowerCase()}:state-character:${entry.id}`, priority, "long_term_character", `${entry.characterId}.${entry.field}=${entry.value}`, [entry.sourceChapter], { area: "context", field: "longTermState.character", key: entry.id });
  });
  (input.context.longTermState?.promise ?? []).forEach((entry) => {
    const priority: ConstraintPriority = loopSelected(entry.promiseId, entry.description) ? "P1" : "P3";
    add(`${priority.toLowerCase()}:promise:${entry.id}`, priority, "promise", `${entry.description}:${entry.status}`, [entry.sourceChapter], { area: "context", field: "longTermState.promise", key: entry.id });
  });

  add("p1:chapter-function", "P1", "chapter_intent", input.intent.chapterFunction, input.intent.sourceRefs, { area: "intent", field: "chapterFunction" });
  const addIntentList = (field: string, values: string[], priority: ConstraintPriority = "P1"): void => {
    values.forEach((content, index) => add(`${priority.toLowerCase()}:${field}:${index}`, priority, "chapter_direction", content, input.intent.sourceRefs, { area: "intent", field, key: String(index) }));
  };
  addIntentList("overallPlotDirection", input.intent.overallPlotDirection ?? []);
  addIntentList("previousState", input.intent.previousState ?? []);
  addIntentList("characterMotivations", (input.intent.characterMotivations ?? []).map((entry) => `${entry.character}:${entry.motivation}`));
  addIntentList("foreshadowing", input.intent.foreshadowing ?? []);
  addIntentList("causalRelations", input.intent.causalRelations ?? []);
  addIntentList("endingTarget", input.intent.endingTarget ?? []);
  addIntentList("authorEventSummaries", input.intent.authorEventSummaries ?? []);
  addIntentList("authorMustInclude", input.intent.authorMustInclude ?? []);
  addIntentList("authorStateChanges", input.intent.authorStateChanges ?? []);
  addIntentList("readerExperience", input.intent.readerExperience, "P2");
  addIntentList("currentPressure", input.intent.currentPressure, "P2");
  addIntentList("concreteDelivery", input.intent.concreteDelivery ?? [], "P2");
  addIntentList("resistance", input.intent.resistance ?? [], "P1");
  addIntentList("expectedIrreversibleChange", input.intent.expectedIrreversibleChange ?? [], "P3");
  addIntentList("causalEndPressure", input.intent.causalEndPressure ?? [], "P2");
  addIntentList(
    "focusCharacterGoals",
    (input.intent.focusCharacterGoals ?? []).map((entry) => `${entry.character}:${entry.goal}`),
  );
  addIntentList(
    "choicesAndCosts",
    (input.intent.choicesAndCosts ?? []).map((entry) => `${entry.choice}→${entry.cost}`),
  );
  addIntentList(
    "selectedExpectationsToAdvance",
    (input.intent.selectedExpectationsToAdvance ?? []).map((entry) => entry.description),
  );
  addIntentList("meaningfulChoices", input.intent.meaningfulChoices ?? [], "P2");

  const bridge = input.context.bridgeContext;
  if (bridge?.available) {
    const bridgeRefs = bridge.sourceIds?.length ? bridge.sourceIds : ["bridgeContext"];
    if (bridge.lastEventSummary) {
      add("p1:bridge:last-event", "P1", "bridge_last_event", `前章最后事件：${bridge.lastEventSummary}`, bridgeRefs, { area: "context", field: "bridgeContext", key: "lastEventSummary" });
    }
    if (bridge.endingEmotion) {
      add("p2:bridge:emotion", "P2", "bridge_emotion", `前章结尾情绪：${bridge.endingEmotion}`, bridgeRefs, { area: "context", field: "bridgeContext", key: "endingEmotion" });
    }
    (bridge.openHooks ?? []).forEach((hook, index) =>
      add(`p1:bridge:hook:${index}`, "P1", "bridge_hook", `开放钩子（本章必须承接）：${hook}`, bridgeRefs, { area: "context", field: "bridgeContext", key: `openHook:${index}` }));
    (bridge.unresolvedTensions ?? []).forEach((tension, index) =>
      add(`p1:bridge:tension:${index}`, "P1", "bridge_tension", `未解张力（本章必须回应）：${tension}`, bridgeRefs, { area: "context", field: "bridgeContext", key: `tension:${index}` }));
    if ((bridge.introducedCharacters ?? []).length > 0) {
      add("p2:bridge:characters", "P2", "bridge_characters", `前章引入角色：${bridge.introducedCharacters.join("、")}`, bridgeRefs, { area: "context", field: "bridgeContext", key: "introducedCharacters" });
    }
  }

  input.context.facts.forEach((entry) => {
    const priority: ConstraintPriority = entry.kind === "candidate_experience" ? "P4" : "P3";
    add(`${priority.toLowerCase()}:fact:${entry.id}`, priority, entry.kind, entry.content, entry.sourceIds, { area: "context", field: "facts", key: entry.id });
  });
  input.context.worldRules.filter((rule) => rule.type !== "immutable_fact").forEach((rule) =>
    add(`p3:world:${rule.id}`, "P3", "world_reference", rule.description, rule.sourceIds, { area: "context", field: "worldRules", key: rule.id }));
  input.context.styleReferences.forEach((entry) =>
    add(`p4:style:${entry.id}`, "P4", "style_advisory", entry.content, entry.sourceIds, { area: "context", field: "styleReferences", key: entry.id }));

  const manifestHash = hash(items.map(({ id, priority, content, sourceRefs, contentHash: ch }) => ({ id, priority, content, sourceRefs, contentHash: ch })));
  return {
    schema: "pinovel.constraint-manifest",
    version: "1.0",
    manifestId: `constraint-manifest:${manifestHash.slice(0, 16)}`,
    manifestHash,
    items,
  };
}

/**
 * 将 ConstraintManifest 编译为分槽 ContextPackage。
 * 风格/历史/检索类条目强制 REFERENCE_MATERIAL，无指令权。
 * 注入短语不会提升信任层。
 */
export function compileConstraintManifestToContextPackage(
  manifest: ConstraintManifest,
): { ok: boolean; package?: ContextPackage; errors: string[] } {
  const items = manifest.items.map((item) => {
    const trust = inferTrustForPriority(item.priority, item.kind);
    // 强制：P3/P4 与 style 一律 reference
    if (
      item.priority === "P4" ||
      item.priority === "P3" ||
      item.priority === "P2" ||
      item.kind === "style_advisory" ||
      item.kind === "candidate_experience" ||
      item.kind === "world_reference"
    ) {
      return asReferenceMaterial({
        id: item.id,
        content: item.content,
        sourceRefs: item.sourceRefs.map((ref) => ({
          kind: "other" as const,
          id: ref,
          locator: ref,
        })),
        purpose: "reference_only_no_instruction_authority",
      });
    }
    return {
      id: item.id,
      content: item.content,
      slot: item.slot ?? trust.slot,
      trustClass: item.trustClass ?? trust.trustClass,
      authority: item.authority ?? trust.authority,
      canPromote: item.canPromote ?? false,
      expiry: item.expiry ?? ({ kind: "never" } as ExpiryPolicy),
      purpose: `constraint:${item.kind}`,
      priority: item.priority,
      kind: item.kind,
      sourceRefs: item.sourceRefs.map((ref) => ({
        kind: "other" as const,
        id: ref,
        locator: ref,
      })),
    };
  });

  const result = buildContextPackage({ items });
  emitTrustAuditEvent({
    decisionType: "context_compile",
    allowed: result.ok,
    reason: result.ok
      ? `ContextPackage 编译成功 manifest=${manifest.manifestHash.slice(0, 12)}`
      : `ContextPackage 编译阻断：${result.errors.join("; ")}`,
    hashes: {
      manifestHash: manifest.manifestHash,
      contextHash: result.package.contextHash,
    },
    evidence: {
      blockReason: result.blockReason,
      itemCount: manifest.items.length,
    },
  });
  return {
    ok: result.ok,
    package: result.package,
    errors: result.errors,
  };
}

export function compileContextSafety(input: ContextSafetyCompileInput): ContextSafetyResult {
  const inputBudgetTokens = Math.max(0, input.modelWindowTokens - input.outputReserveTokens - input.safetyMarginTokens);
  const { retained: deduped, merged } = mergeDuplicates(input.manifest.items);
  const conflicted = findProtectedConflicts(deduped);
  const report: ContextBudgetReport = {
    manifestHash: input.manifest.manifestHash,
    modelWindowTokens: input.modelWindowTokens,
    outputReserveTokens: input.outputReserveTokens,
    safetyMarginTokens: input.safetyMarginTokens,
    inputBudgetTokens,
    estimatedOriginalTokens: input.manifest.items.reduce((sum, item) => sum + item.estimatedTokens, 0),
    estimatedRetainedTokens: 0,
    recompileAttempts: 0,
    retained: [],
    dropped: [],
    merged,
    conflicted,
    truncated: [],
  };
  if (conflicted.length > 0) {
    report.retained = deduped.map(toBudgetEntry);
    report.estimatedRetainedTokens = sumTokens(deduped);
    return blocked("hard_constraint_conflict", input, report, deduped);
  }

  const protectedItems = deduped.filter((item) => item.priority === "P0" || item.priority === "P1");
  if (sumTokens(protectedItems) > inputBudgetTokens) {
    report.retained = protectedItems.map(toBudgetEntry);
    report.estimatedRetainedTokens = sumTokens(protectedItems);
    return blocked("protected_context_overflow", input, report, protectedItems);
  }

  const retained = [...deduped];
  if (sumTokens(retained) > inputBudgetTokens) {
    report.recompileAttempts = 1;
    for (const priority of ["P4", "P3", "P2"] as ConstraintPriority[]) {
      for (let index = retained.length - 1; index >= 0 && sumTokens(retained) > inputBudgetTokens; index -= 1) {
        if (retained[index].priority !== priority) continue;
        const [removed] = retained.splice(index, 1);
        report.dropped.push({ ...toBudgetEntry(removed), reason: `budget_drop_${priority}` });
      }
    }
  }
  report.retained = retained.map(toBudgetEntry);
  report.estimatedRetainedTokens = sumTokens(retained);
  if (report.estimatedRetainedTokens > inputBudgetTokens) {
    return blocked("context_overflow", input, report, retained);
  }
  const working = buildWorkingInputs(input.intent, input.context, retained);
  return { ok: true, manifest: input.manifest, workingIntent: working.intent, workingContext: working.context, report };
}

function blocked(blockReason: ContextSafetyResult["blockReason"], input: ContextSafetyCompileInput, report: ContextBudgetReport, retained: ConstraintManifestItem[]): ContextSafetyResult {
  const working = buildWorkingInputs(input.intent, input.context, retained);
  return { ok: false, blockReason, manifest: input.manifest, workingIntent: working.intent, workingContext: working.context, report };
}

function buildWorkingInputs(intent: ChapterIntent, context: CompiledContext, retained: ConstraintManifestItem[]): { intent: ChapterIntent; context: CompiledContext } {
  const keep = new Set(retained.map((item) => item.origin.key ? `${item.origin.field}:${item.origin.key}` : item.origin.field));
  const keepField = (field: string, key?: string): boolean => keep.has(key ? `${field}:${key}` : field) || retained.some((item) => item.origin.field === field);
  return {
    intent: {
      ...intent,
      chapterFunction: keepField("chapterFunction") ? intent.chapterFunction : "",
      overallPlotDirection: (intent.overallPlotDirection ?? []).filter((_, index) => keepField("overallPlotDirection", String(index))),
      previousState: (intent.previousState ?? []).filter((_, index) => keepField("previousState", String(index))),
      characterMotivations: (intent.characterMotivations ?? []).filter((_, index) => keepField("characterMotivations", String(index))),
      foreshadowing: (intent.foreshadowing ?? []).filter((_, index) => keepField("foreshadowing", String(index))),
      causalRelations: (intent.causalRelations ?? []).filter((_, index) => keepField("causalRelations", String(index))),
      endingTarget: (intent.endingTarget ?? []).filter((_, index) => keepField("endingTarget", String(index))),
      authorEventSummaries: (intent.authorEventSummaries ?? []).filter((_, index) => keepField("authorEventSummaries", String(index))),
      authorMustInclude: (intent.authorMustInclude ?? []).filter((_, index) => keepField("authorMustInclude", String(index))),
      authorStateChanges: (intent.authorStateChanges ?? []).filter((_, index) => keepField("authorStateChanges", String(index))),
      readerExperience: intent.readerExperience.filter((_, index) => keepField("readerExperience", String(index))),
      currentPressure: intent.currentPressure.filter((_, index) => keepField("currentPressure", String(index))),
      inviolableFacts: intent.inviolableFacts.filter((_, index) => keepField("inviolableFacts", String(index))),
      concreteDelivery: (intent.concreteDelivery ?? []).filter((_, index) => keepField("concreteDelivery", String(index))),
      resistance: (intent.resistance ?? []).filter((_, index) => keepField("resistance", String(index))),
      expectedIrreversibleChange: (intent.expectedIrreversibleChange ?? []).filter((_, index) => keepField("expectedIrreversibleChange", String(index))),
      causalEndPressure: (intent.causalEndPressure ?? []).filter((_, index) => keepField("causalEndPressure", String(index))),
      factAndCharacterKnowledgeForbiddenZones: (intent.factAndCharacterKnowledgeForbiddenZones ?? []).filter((_, index) => keepField("factAndCharacterKnowledgeForbiddenZones", String(index))),
    },
    context: {
      ...context,
      facts: context.facts.filter((entry) => keepField("facts", entry.id)),
      characterStates: context.characterStates.filter((entry) => keepField("characterStates", entry.characterId)),
      openLoops: context.openLoops.filter((entry) => keepField("openLoops", entry.id)),
      worldRules: context.worldRules.filter((entry) => keepField("worldRules", entry.id)),
      styleReferences: context.styleReferences.filter((entry) => keepField("styleReferences", entry.id)),
    },
  };
}

function mergeDuplicates(items: ConstraintManifestItem[]): { retained: ConstraintManifestItem[]; merged: Array<ContextBudgetEntry & { mergedIds: string[] }> } {
  const byKey = new Map<string, ConstraintManifestItem>();
  const merged: Array<ContextBudgetEntry & { mergedIds: string[] }> = [];
  for (const item of items) {
    const key = `${item.priority}:${normalize(item.content)}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, { ...item, sourceRefs: [...item.sourceRefs] }); continue; }
    existing.sourceRefs = [...new Set([...existing.sourceRefs, ...item.sourceRefs])];
    let record = merged.find((entry) => entry.id === existing.id);
    if (!record) {
      record = { ...toBudgetEntry(existing), mergedIds: [] };
      merged.push(record);
    }
    record.mergedIds.push(item.id);
    record.sourceRefs = existing.sourceRefs;
  }
  return { retained: [...byKey.values()], merged };
}

function findProtectedConflicts(items: ConstraintManifestItem[]): ContextBudgetReport["conflicted"] {
  const protectedItems = items.filter((item) => item.priority === "P0" || item.priority === "P1");
  const conflicts: ContextBudgetReport["conflicted"] = [];
  for (let leftIndex = 0; leftIndex < protectedItems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < protectedItems.length; rightIndex += 1) {
      const left = protectedItems[leftIndex];
      const right = protectedItems[rightIndex];
      if (!areContradictory(left.content, right.content)) continue;
      conflicts.push({ ids: [left.id, right.id], contents: [left.content, right.content], sourceRefs: [...new Set([...left.sourceRefs, ...right.sourceRefs])] });
    }
  }
  return conflicts;
}

function areContradictory(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return false;
  const stripNegation = (value: string): string => value.replace(/不|未|无|不能|不存在/g, "");
  return stripNegation(a) === stripNegation(b) && (/[不未无]|不存在/.test(a) !== /[不未无]|不存在/.test(b));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。；：、,.!！?？“”"'（）()【】]/g, "");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 2) + 8;
}

function sumTokens(items: ConstraintManifestItem[]): number {
  return items.reduce((sum, item) => sum + item.estimatedTokens, 0);
}

function toBudgetEntry(item: ConstraintManifestItem): ContextBudgetEntry {
  return { id: item.id, priority: item.priority, estimatedTokens: item.estimatedTokens, sourceRefs: [...item.sourceRefs] };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
