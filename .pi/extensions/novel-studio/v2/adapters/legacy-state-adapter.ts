/**
 * Legacy State Adapter（Phase 2，计划 §Phase 2）
 *
 * 桥接 legacy novel-studio 的状态文件到 V2 NarrativeStateStore（Phase 1）。
 *
 * legacy 状态文件：
 * - skeleton.json — 章节骨架（事件序列、角色状态快照）
 * - unsettled-details.json — 未结账细节（DetailLedger）
 * - narrative-state.json — 叙事状态（pendingCosts、角色更新）
 * - arc-registry.json — 伏笔/弧线注册表（PromiseLedger 的 legacy 形态）
 *
 * V2 NarrativeStateStore 四类（Phase 1）：
 * - canon — 世界事实、时间线、地点、实体、能力规则
 * - character — 欲望、恐惧、关系、知识边界、能力代价、未完成选择
 * - promise — 伏笔、读者期待、承诺、预计兑现窗口、当前热度
 * - pattern — 近期重复桥段、意象、句式风险、冲突解决方式、章末钩子类型
 *
 * 设计原则：
 * - 只读加载 legacy 状态，转换为 V2 NarrativeStateStore 快照
 * - 不反向写回 legacy 文件（写入仍由 legacy 工具负责，迁移期共存）
 * - 每条转换后的 entry 带 sourceRef（追溯到 legacy 文件）和 sourceChapter
 * - 置信度：legacy 数据默认 0.7（无显式置信度字段）
 *
 * 迁移期策略：V2 NarrativeStateStore 独立文件（narrative-state-store.json），
 * legacy 文件继续由 legacy 工具维护。本 adapter 提供"从 legacy 导入"能力，
 * 供 V2 在无独立状态文件时回退读取 legacy 状态。
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  NarrativeStateStore,
  CanonEntry,
  CharacterStateEntry,
  PromiseEntry,
  PatternEntry,
} from "../core/final-state-commit.js";
import { STATE_STORE_SCHEMA_VERSION } from "../core/final-state-commit.js";

// ============================================================================
// legacy 文件路径
// ============================================================================

export interface LegacyStatePaths {
  skeletonPath: string;
  unsettledDetailsPath: string;
  narrativeStatePath: string;
  arcRegistryPath: string;
}

export function legacyStatePaths(workspaceId: string, projectRoot: string): LegacyStatePaths {
  const wsDir = join(projectRoot, "workspaces", workspaceId);
  return {
    skeletonPath: join(wsDir, "skeleton.json"),
    unsettledDetailsPath: join(wsDir, "unsettled-details.json"),
    narrativeStatePath: join(wsDir, "narrative-state.json"),
    arcRegistryPath: join(wsDir, "arc-registry.json"),
  };
}

// ============================================================================
// JSON 读取工具
// ============================================================================

function readJsonSafe<T = any>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

const LEGACY_DEFAULT_CONFIDENCE = 0.7;

// ============================================================================
// legacy skeleton.json → V2 canon + character entries
// ============================================================================

interface LegacySkeletonEvent {
  eventId?: string;
  type?: string;
  summary?: string;
  characters?: string[];
  location?: string;
}

interface LegacySkeleton {
  events?: LegacySkeletonEvent[];
  chapterId?: string;
  locations?: string[];
}

function convertSkeleton(
  skeleton: LegacySkeleton | null,
  sourceChapter: string
): { canon: CanonEntry[]; character: CharacterStateEntry[] } {
  const canon: CanonEntry[] = [];
  const character: CharacterStateEntry[] = [];
  if (!skeleton) return { canon, character };

  // 事件序列 → canon timeline entries
  for (const evt of skeleton.events ?? []) {
    if (evt.eventId && evt.summary) {
      canon.push({
        id: `canon:event:${evt.eventId}`,
        kind: "canon",
        fact: evt.summary,
        category: "timeline",
        sourceChapter,
        sourceRef: `skeleton.json#${evt.eventId}`,
        confidence: LEGACY_DEFAULT_CONFIDENCE,
        lastUpdated: new Date().toISOString(),
      });
    }
    // 事件地点 → canon location entries
    if (evt.location) {
      const locId = `canon:location:${evt.location}`;
      if (!canon.some((c) => c.id === locId)) {
        canon.push({
          id: locId,
          kind: "canon",
          fact: `地点：${evt.location}`,
          category: "location",
          sourceChapter,
          sourceRef: `skeleton.json#${evt.eventId ?? "unknown"}`,
          confidence: LEGACY_DEFAULT_CONFIDENCE,
          lastUpdated: new Date().toISOString(),
        });
      }
    }
    // 事件涉及角色 → character entries（标记本章在场）
    for (const charName of evt.characters ?? []) {
      const charId = `character:${charName}:present_at:${evt.eventId ?? "unknown"}`;
      character.push({
        id: charId,
        kind: "character",
        characterId: charName,
        field: "presentAt",
        value: evt.eventId ?? evt.summary ?? "unknown",
        sourceChapter,
        sourceRef: `skeleton.json#${evt.eventId ?? "unknown"}`,
        confidence: LEGACY_DEFAULT_CONFIDENCE,
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  return { canon, character };
}

// ============================================================================
// legacy unsettled-details.json → V2 promise entries
// ============================================================================

interface LegacyUnsettledDetail {
  id: string;
  type: string;
  description: string;
  chapterId?: string;
  status?: string;
}

function convertUnsettledDetails(
  details: LegacyUnsettledDetail[] | null,
  sourceChapter: string
): PromiseEntry[] {
  if (!Array.isArray(details)) return [];
  return details.map((d) => ({
    id: `promise:unsettled:${d.id}`,
    kind: "promise" as const,
    promiseId: d.id,
    description: `${d.type}: ${d.description}`,
    currentHeat: 0.5,
    status: (d.status === "resolved" ? "fulfilled" : "open") as "open" | "advancing" | "fulfilled" | "broken",
    sourceChapter: d.chapterId ?? sourceChapter,
    sourceRef: `unsettled-details.json#${d.id}`,
    confidence: LEGACY_DEFAULT_CONFIDENCE,
    lastUpdated: new Date().toISOString(),
  }));
}

// ============================================================================
// legacy arc-registry.json → V2 promise entries（伏笔/弧线）
// ============================================================================

interface LegacyArc {
  arcId: string;
  name: string;
  coreQuestion?: string;
  priority?: string;
  status?: string;
}

interface LegacyForeshadowing {
  id: string;
  description: string;
  level?: string;
  status?: string;
}

function convertArcRegistry(
  arcs: LegacyArc[] | null,
  foreshadowings: LegacyForeshadowing[] | null,
  sourceChapter: string
): PromiseEntry[] {
  const promises: PromiseEntry[] = [];
  for (const arc of arcs ?? []) {
    promises.push({
      id: `promise:arc:${arc.arcId}`,
      kind: "promise",
      promiseId: arc.arcId,
      description: arc.name + (arc.coreQuestion ? `（核心问题：${arc.coreQuestion}）` : ""),
      currentHeat: arc.priority === "high" ? 0.8 : 0.6,
      status: (arc.status === "resolved" ? "fulfilled" : arc.status === "advancing" ? "advancing" : "open") as "open" | "advancing" | "fulfilled" | "broken",
      sourceChapter,
      sourceRef: `arc-registry.json#${arc.arcId}`,
      confidence: LEGACY_DEFAULT_CONFIDENCE,
      lastUpdated: new Date().toISOString(),
    });
  }
  for (const f of foreshadowings ?? []) {
    promises.push({
      id: `promise:foreshadow:${f.id}`,
      kind: "promise",
      promiseId: f.id,
      description: f.description,
      currentHeat: f.level === "high" ? 0.8 : 0.5,
      status: (f.status === "resolved" ? "fulfilled" : "open") as "open" | "advancing" | "fulfilled" | "broken",
      sourceChapter,
      sourceRef: `arc-registry.json#${f.id}`,
      confidence: LEGACY_DEFAULT_CONFIDENCE,
      lastUpdated: new Date().toISOString(),
    });
  }
  return promises;
}

// ============================================================================
// legacy narrative-state.json → V2 character entries（pendingCosts 等）
// ============================================================================

interface LegacyNarrativeState {
  pendingCosts?: Array<{ action: string; cost: string; chapterIncurred?: number }>;
  characterUpdates?: Array<{ name: string; field: string; value: string }>;
}

function convertNarrativeState(
  state: LegacyNarrativeState | null,
  sourceChapter: string
): CharacterStateEntry[] {
  if (!state) return [];
  const entries: CharacterStateEntry[] = [];
  for (const cost of state.pendingCosts ?? []) {
    entries.push({
      id: `character:cost:${cost.action}:${cost.chapterIncurred ?? "?"}`,
      kind: "character",
      characterId: "protagonist",
      field: "pendingCost",
      value: `${cost.action} → ${cost.cost}`,
      sourceChapter: cost.chapterIncurred ? `ch${cost.chapterIncurred}` : sourceChapter,
      sourceRef: "narrative-state.json#pendingCosts",
      confidence: LEGACY_DEFAULT_CONFIDENCE,
      lastUpdated: new Date().toISOString(),
    });
  }
  for (const upd of state.characterUpdates ?? []) {
    entries.push({
      id: `character:${upd.name}:${upd.field}`,
      kind: "character",
      characterId: upd.name,
      field: upd.field,
      value: upd.value,
      sourceChapter,
      sourceRef: "narrative-state.json#characterUpdates",
      confidence: LEGACY_DEFAULT_CONFIDENCE,
      lastUpdated: new Date().toISOString(),
    });
  }
  return entries;
}

// ============================================================================
// LegacyStateAdapter — 聚合转换
// ============================================================================

export interface LegacyStateImportResult {
  store: NarrativeStateStore;
  /** 导入来源文件列表 */
  sources: string[];
  /** 每类导入数量 */
  counts: { canon: number; character: number; promise: number; pattern: number };
}

export class LegacyStateAdapter {
  /**
   * 从 legacy 状态文件导入，构建 V2 NarrativeStateStore 快照。
   *
   * 用于 V2 在无独立 narrative-state-store.json 时回退读取 legacy 状态。
   * 返回的 store 不直接落盘（落盘由 FinalStateCommit 在最终正文选定后执行）。
   *
   * @param workspaceId workspace id
   * @param projectRoot 项目根
   * @param sourceChapter 来源章节标记（如 "ch17"）
   */
  importFromLegacy(
    workspaceId: string,
    projectRoot: string,
    sourceChapter: string
  ): LegacyStateImportResult {
    const paths = legacyStatePaths(workspaceId, projectRoot);
    const sources: string[] = [];

    const skeleton = readJsonSafe<LegacySkeleton>(paths.skeletonPath);
    if (skeleton) sources.push("skeleton.json");

    const unsettled = readJsonSafe<LegacyUnsettledDetail[]>(paths.unsettledDetailsPath);
    if (unsettled) sources.push("unsettled-details.json");

    const narrativeState = readJsonSafe<LegacyNarrativeState>(paths.narrativeStatePath);
    if (narrativeState) sources.push("narrative-state.json");

    const arcRegistry = readJsonSafe<{ arcs?: LegacyArc[]; foreshadowings?: LegacyForeshadowing[] }>(paths.arcRegistryPath);
    if (arcRegistry) sources.push("arc-registry.json");

    // 转换
    const { canon, character: skeletonChars } = convertSkeleton(skeleton, sourceChapter);
    const unsettledPromises = convertUnsettledDetails(unsettled, sourceChapter);
    const arcPromises = convertArcRegistry(arcRegistry?.arcs ?? null, arcRegistry?.foreshadowings ?? null, sourceChapter);
    const narrativeChars = convertNarrativeState(narrativeState, sourceChapter);

    const store: NarrativeStateStore = {
      schemaVersion: STATE_STORE_SCHEMA_VERSION,
      workspaceId,
      canon,
      character: [...skeletonChars, ...narrativeChars],
      promise: [...unsettledPromises, ...arcPromises],
      pattern: [], // legacy 无直接对应的 pattern memory，Phase 6 在线学习填充
      lastCommittedChapter: sourceChapter,
      updatedAt: new Date().toISOString(),
    };

    return {
      store,
      sources,
      counts: {
        canon: store.canon.length,
        character: store.character.length,
        promise: store.promise.length,
        pattern: store.pattern.length,
      },
    };
  }
}

export function createLegacyStateAdapter(): LegacyStateAdapter {
  return new LegacyStateAdapter();
}
