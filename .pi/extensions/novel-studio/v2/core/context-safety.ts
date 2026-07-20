/**
 * CONTEXT-SAFETY-1 — 硬约束分层、上下文预算与可回源裁剪。
 */

import { createHash } from "node:crypto";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { CompiledContext } from "./types.js";

export type ConstraintPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface ConstraintManifestItem {
  id: string;
  priority: ConstraintPriority;
  kind: string;
  content: string;
  sourceRefs: string[];
  estimatedTokens: number;
  origin: { area: "intent" | "context"; field: string; key?: string };
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
    items.push({ id, priority, kind, content: content.trim(), sourceRefs, estimatedTokens: estimateTokens(content), origin });
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

  input.context.characterStates.forEach((entry) =>
    add(`p1:character:${entry.characterId}`, "P1", "character_state", `${entry.name}:${JSON.stringify(entry.state)}`, entry.sourceIds, { area: "context", field: "characterStates", key: entry.characterId }));
  input.context.openLoops.forEach((entry) =>
    add(`p1:loop:${entry.id}`, "P1", "open_loop", entry.description, entry.sourceIds, { area: "context", field: "openLoops", key: entry.id }));
  (input.context.longTermState?.character ?? []).forEach((entry) =>
    add(`p1:state-character:${entry.id}`, "P1", "long_term_character", `${entry.characterId}.${entry.field}=${entry.value}`, [entry.sourceChapter], { area: "context", field: "longTermState.character", key: entry.id }));
  (input.context.longTermState?.promise ?? []).forEach((entry) =>
    add(`p1:promise:${entry.id}`, "P1", "promise", `${entry.description}:${entry.status}`, [entry.sourceChapter], { area: "context", field: "longTermState.promise", key: entry.id }));

  add("p2:chapter-function", "P2", "chapter_intent", input.intent.chapterFunction, input.intent.sourceRefs, { area: "intent", field: "chapterFunction" });
  const addIntentList = (field: string, values: string[]): void => {
    values.forEach((content, index) => add(`p2:${field}:${index}`, "P2", "chapter_direction", content, input.intent.sourceRefs, { area: "intent", field, key: String(index) }));
  };
  addIntentList("readerExperience", input.intent.readerExperience);
  addIntentList("currentPressure", input.intent.currentPressure);
  addIntentList("concreteDelivery", input.intent.concreteDelivery ?? []);
  addIntentList("resistance", input.intent.resistance ?? []);
  addIntentList("expectedIrreversibleChange", input.intent.expectedIrreversibleChange ?? []);
  addIntentList("causalEndPressure", input.intent.causalEndPressure ?? []);

  input.context.facts.forEach((entry) => {
    const priority: ConstraintPriority = entry.kind === "candidate_experience" ? "P4" : "P3";
    add(`${priority.toLowerCase()}:fact:${entry.id}`, priority, entry.kind, entry.content, entry.sourceIds, { area: "context", field: "facts", key: entry.id });
  });
  input.context.worldRules.filter((rule) => rule.type !== "immutable_fact").forEach((rule) =>
    add(`p3:world:${rule.id}`, "P3", "world_reference", rule.description, rule.sourceIds, { area: "context", field: "worldRules", key: rule.id }));
  input.context.styleReferences.forEach((entry) =>
    add(`p4:style:${entry.id}`, "P4", "style_advisory", entry.content, entry.sourceIds, { area: "context", field: "styleReferences", key: entry.id }));

  const manifestHash = hash(items.map(({ id, priority, content, sourceRefs }) => ({ id, priority, content, sourceRefs })));
  return {
    schema: "pinovel.constraint-manifest",
    version: "1.0",
    manifestId: `constraint-manifest:${manifestHash.slice(0, 16)}`,
    manifestHash,
    items,
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
