/**
 * NarrativeStateBridge — 统一最终状态快照/事务桥接（STATE-BRIDGE-1）
 *
 * 职责：在 FinalStateCommit.commit 成功落盘 narrative-state-store.json 后，
 * 把状态投影到 MethodologyDiagnosticState 读取的三个 series/*.json 文件：
 *   - series/narrative-state.json（currentChapter / readerExpectation / horrorFatigue 等）
 *   - series/fatigue-state.json（fatigueIndicators / cooldownPeriods / recentPatterns）
 *   - series/arc-registry.json（arcs / pending_foreshadows / config.currentChapter）
 *
 * 设计原则（计划 §4.2 + AGENTS.md 状态事务边界）：
 * - 与 narrative-state-store.json 同一事务：backup → write → rename，任一失败回滚全部
 * - 不引入新真相源：series/*.json 是 narrative-state-store.json 的派生 projection
 * - 不机器生成关系状态/情感温度：relationshipTemperature / horrorFatigue 等需要 LLM
 *   才能可靠派生的字段保持原值（不覆盖），不靠 finalText 关键词代理写入
 * - 只写入可从 stagedStateUpdate + finalText + 已有 series/*.json 安全派生的字段
 * - 失败不阻断主链路（narrative-state-store.json 已落盘，桥接失败只 warning + trace）
 *
 * 与 ClosureTracker 的协作：
 * - arc-registry.json 的 arcs/pending_foreshadows 字段由 ClosureTracker 接入模块更新
 *   （closure-tracker-integration.ts），本桥接只更新 config.currentChapter
 * - 桥接先于 ClosureTracker 写入（ClosureTracker 在桥接基础上更新 arc/foreshadow 状态）
 *
 * 与 MethodologyDiagnosticState 的契约：
 * - 下一章生成时，MethodologyDiagnosticStateLoader 读取 series/*.json
 * - 桥接确保 series/*.json 的 currentChapter < 下一章 chapterNumber，
 *   使 buildSerialState / buildEnsemble / parseFatigue 能识别"有前章状态可读"
 * - buildOverdueAlerts 用 expectation.overdueWindow + currentChapter 计算逾期
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type {
  NarrativeStateStore,
  ExpectationEntry,
  PromiseEntry,
  PatternEntry,
  StagedStateUpdate,
} from "./final-state-commit.js";

// ============================================================================
// 桥接产物 schema（与 MethodologyDiagnosticState 读取字段对齐）
// ============================================================================

/**
 * series/narrative-state.json 桥接产物（advisory 输入源）。
 *
 * 字段映射（MethodologyDiagnosticStateLoader.parseFatigue / buildEnsemble 读取）：
 * - currentChapter：parseFatigue 用 finiteNumber 校验"前章状态可读"
 * - readerExpectation：unresolvedCount / chaptersSinceLastPeak / lastPayoffChapter
 * - horrorFatigue：保留原值（不机器生成，需要 LLM 派生）
 * - relationshipTemperature：保留原值（不机器生成）
 * - ensembleFocusHistory：从 stagedStateUpdate character entries 派生（角色名 = 本章焦点）
 */
export interface BridgedNarrativeState {
  currentChapter: number;
  readerExpectation?: {
    unresolvedCount?: number;
    chaptersSinceLastPeak?: number | null;
    lastPayoffChapter?: number | null;
  };
  horrorFatigue?: {
    recentTechniques?: string[];
    consecutiveSameTechnique?: number | null;
  };
  relationshipTemperature?: Record<
    string,
    {
      state?: string | null;
      lastInteractionChapter?: number | null;
      pendingTension?: string | null;
    }
  >;
  ensembleFocusHistory?: Array<{ chapter: number; character: string; sourceRef?: string }>;
}

/**
 * series/fatigue-state.json 桥接产物。
 *
 * 字段映射（parseFatigue 读取）：
 * - fatigueIndicators.consecutiveSameType：保留原值（不机器生成）
 * - cooldownPeriods：保留原值
 * - recentPatterns：从本章 PatternEntry 派生（patternType/description）
 * - recentHookTypes / recentSceneTypes / recentEmotionPeaks：保留原值
 */
export interface BridgedFatigueState {
  fatigueIndicators?: {
    consecutiveSameType?: number | null;
    recentHookTypes?: string[];
    recentSceneTypes?: string[];
    recentEmotionPeaks?: string[];
  };
  cooldownPeriods?: Record<string, number>;
  recentPatterns?: string[];
}

/**
 * series/arc-registry.json 桥接产物（仅 config + 元数据；arcs/pending_foreshadows
 * 由 ClosureTracker 接入模块更新，本桥接不覆盖）。
 */
export interface BridgedArcRegistry {
  config: {
    currentChapter: number;
    totalChapters?: number;
    closureTarget?: string;
  };
  lastUpdated?: string;
}

// ============================================================================
// 桥接结果
// ============================================================================

export interface BridgeResult {
  ok: boolean;
  error?: string;
  /** 实际写入的文件路径列表（用于 trace 审计） */
  writtenPaths: string[];
  /** 各文件写入前的备份路径（用于回滚） */
  backupPaths: Array<{ target: string; backup: string | null }>;
}

// ============================================================================
// 派生函数（从 narrative-state-store.json + stagedStateUpdate 派生 series/* 字段）
// ============================================================================

/**
 * 从 narrative-state-store.json + 本章 stagedStateUpdate 派生 series/narrative-state.json。
 *
 * 派生规则（保守：不机器生成关系/情感温度）：
 * - currentChapter = chapterNumber
 * - readerExpectation.unresolvedCount = store.expectation 中非 fulfilled 的数量
 * - readerExpectation.lastPayoffChapter = 最近一个 fulfilled expectation 的 sourceChapter
 * - readerExpectation.chaptersSinceLastPeak = chapterNumber - lastPayoffChapter（无则 null）
 * - horrorFatigue / relationshipTemperature：保留 existing 原值，不覆盖
 * - ensembleFocusHistory：从 stagedStateUpdate.character entries 派生（本章焦点角色）
 *
 * @param store 已落盘的 narrative-state-store.json
 * @param staged 本章 stagedStateUpdate（含 character entries，已 reanchored）
 * @param chapterNumber 当前章节号
 * @param existing 已有的 series/narrative-state.json（用于保留原值）
 */
export function deriveBridgedNarrativeState(
  store: NarrativeStateStore,
  staged: StagedStateUpdate,
  chapterNumber: number,
  existing: BridgedNarrativeState | null,
): BridgedNarrativeState {
  const expectations = store.expectation ?? [];
  const nonFulfilled = expectations.filter((e) => e.status !== "fulfilled");
  const fulfilled = expectations.filter((e) => e.status === "fulfilled");

  // lastPayoffChapter：从 fulfilled expectation 的 sourceChapter 提取最大章节号
  let lastPayoffChapter: number | null = null;
  for (const exp of fulfilled) {
    const match = exp.sourceChapter.match(/^ch(\d+)$/u);
    if (match) {
      const ch = Number(match[1]);
      if (lastPayoffChapter === null || ch > lastPayoffChapter) {
        lastPayoffChapter = ch;
      }
    }
  }

  const chaptersSinceLastPeak =
    lastPayoffChapter !== null ? chapterNumber - lastPayoffChapter : null;

  // ensembleFocusHistory：本章焦点角色（从 staged character entries 派生）
  const characterEntries = staged.additions.filter(
    (e): e is Extract<typeof e, { kind: "character" }> => e.kind === "character",
  );
  const focusHistory: Array<{ chapter: number; character: string; sourceRef?: string }> = [];
  for (const entry of characterEntries) {
    if (entry.field === "participation" && entry.value === "present") {
      focusHistory.push({
        chapter: chapterNumber,
        character: entry.characterId,
        sourceRef: entry.sourceRef,
      });
    }
  }

  // 保留 existing 的 horrorFatigue / relationshipTemperature（不机器生成）
  return {
    currentChapter: chapterNumber,
    readerExpectation: {
      unresolvedCount: nonFulfilled.length,
      chaptersSinceLastPeak,
      lastPayoffChapter,
    },
    horrorFatigue: existing?.horrorFatigue,
    relationshipTemperature: existing?.relationshipTemperature,
    ensembleFocusHistory: [
      ...(existing?.ensembleFocusHistory ?? []).slice(-20), // 保留最近 20 条
      ...focusHistory,
    ],
  };
}

/**
 * 从本章 PatternEntry 派生 series/fatigue-state.json 的 recentPatterns。
 *
 * 保守派生：只追加本章 pattern description，不删除历史；
 * 其他字段（consecutiveSameType / cooldownPeriods 等）保留 existing 原值。
 */
export function deriveBridgedFatigueState(
  staged: StagedStateUpdate,
  existing: BridgedFatigueState | null,
): BridgedFatigueState {
  const patternEntries = staged.additions.filter(
    (e): e is PatternEntry => e.kind === "pattern",
  );
  const newPatterns = patternEntries.map((p) => p.description);

  // 保留 existing 的 fatigueIndicators / cooldownPeriods（不机器生成）
  const existingIndicators = existing?.fatigueIndicators;
  return {
    fatigueIndicators: existingIndicators
      ? {
          consecutiveSameType: existingIndicators.consecutiveSameType ?? null,
          recentHookTypes: existingIndicators.recentHookTypes ?? [],
          recentSceneTypes: existingIndicators.recentSceneTypes ?? [],
          recentEmotionPeaks: existingIndicators.recentEmotionPeaks ?? [],
        }
      : undefined,
    cooldownPeriods: existing?.cooldownPeriods ?? {},
    recentPatterns: [
      ...(existing?.recentPatterns ?? []).slice(-15), // 保留最近 15 条
      ...newPatterns,
    ],
  };
}

/**
 * 派生 series/arc-registry.json 的 config.currentChapter。
 *
 * arcs / pending_foreshadows 字段由 ClosureTracker 接入模块更新，
 * 本桥接只更新 config.currentChapter + lastUpdated。
 */
export function deriveBridgedArcRegistry(
  chapterNumber: number,
  existing: unknown,
): BridgedArcRegistry {
  const existingConfig =
    isRecord(existing) && isRecord(existing.config)
      ? (existing.config as { totalChapters?: unknown; closureTarget?: unknown })
      : null;
  return {
    config: {
      currentChapter: chapterNumber,
      totalChapters:
        typeof existingConfig?.totalChapters === "number"
          ? existingConfig.totalChapters
          : undefined,
      closureTarget:
        typeof existingConfig?.closureTarget === "string"
          ? existingConfig.closureTarget
          : undefined,
    },
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// 桥接主入口：原子写入三个 series/*.json
// ============================================================================

/**
 * 在 FinalStateCommit.commit 成功后，把状态桥接写入 series/*.json。
 *
 * 事务策略：
 * - 三个文件分别 backup（如有）→ write tmp → rename
 * - 任一文件写入失败：尝试回滚已写入的文件（用 backup 恢复），返回 ok=false
 * - 桥接失败不阻断主链路（narrative-state-store.json 已落盘）；
 *   调用方应记录 warning + 写入 trace
 *
 * @param workspacePath workspaces/{id} 绝对路径
 * @param store 已落盘的 narrative-state-store.json
 * @param staged 本章 stagedStateUpdate（已 reanchored）
 * @param chapterNumber 当前章节号
 * @returns BridgeResult 含 writtenPaths 与 backupPaths
 */
export function bridgeStateToSeriesFiles(
  workspacePath: string,
  store: NarrativeStateStore,
  staged: StagedStateUpdate,
  chapterNumber: number,
): BridgeResult {
  const seriesDir = join(workspacePath, "series");
  const narrativeStatePath = join(seriesDir, "narrative-state.json");
  const fatigueStatePath = join(seriesDir, "fatigue-state.json");
  const arcRegistryPath = join(seriesDir, "arc-registry.json");

  if (!existsSync(seriesDir)) {
    mkdirSync(seriesDir, { recursive: true });
  }

  // 读取 existing（用于保留原值）
  const existingNarrative = readBridgedJson<BridgedNarrativeState>(narrativeStatePath);
  const existingFatigue = readBridgedJson<BridgedFatigueState>(fatigueStatePath);
  const existingArcRegistry = readBridgedJson<unknown>(arcRegistryPath);

  // 派生新内容
  const newNarrative = deriveBridgedNarrativeState(
    store,
    staged,
    chapterNumber,
    existingNarrative,
  );
  const newFatigue = deriveBridgedFatigueState(staged, existingFatigue);
  const newArcRegistry = deriveBridgedArcRegistry(chapterNumber, existingArcRegistry);

  // 写入计划：保留 ClosureTracker 接入模块写入的 arcs/pending_foreshadows 字段
  // arc-registry.json 只更新 config + lastUpdated，其他字段从 existing 保留
  const mergedArcRegistry = mergeArcRegistry(existingArcRegistry, newArcRegistry);

  const writePlan: Array<{
    path: string;
    content: string;
    backup: string | null;
  }> = [
    {
      path: narrativeStatePath,
      content: JSON.stringify(newNarrative, null, 2),
      backup: backupContent(narrativeStatePath, existingNarrative),
    },
    {
      path: fatigueStatePath,
      content: JSON.stringify(newFatigue, null, 2),
      backup: backupContent(fatigueStatePath, existingFatigue),
    },
    {
      path: arcRegistryPath,
      content: JSON.stringify(mergedArcRegistry, null, 2),
      backup: backupContent(arcRegistryPath, existingArcRegistry),
    },
  ];

  const writtenPaths: string[] = [];
  const backupPaths: Array<{ target: string; backup: string | null }> = [];
  const writtenIndex: number[] = [];

  for (let i = 0; i < writePlan.length; i++) {
    const plan = writePlan[i];
    try {
      atomicWriteJson(plan.path, plan.content);
      writtenPaths.push(plan.path);
      backupPaths.push({ target: plan.path, backup: plan.backup });
      writtenIndex.push(i);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // 回滚已写入的文件
      for (const j of writtenIndex) {
        const done = writePlan[j];
        try {
          restoreBackup(done.path, done.backup);
        } catch {
          // 回滚失败：保留已写入状态，调用方需 warning
        }
      }
      return {
        ok: false,
        error: `bridge write failed at ${plan.path}: ${msg}`,
        writtenPaths: [],
        backupPaths,
      };
    }
  }

  return { ok: true, writtenPaths, backupPaths };
}

// ============================================================================
// 内部工具
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBridgedJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function backupContent<T>(path: string, existing: T | null): string | null {
  if (existing === null) return null;
  // backup 只在内存保留原内容（避免在 series/ 下堆积 backup 文件）
  // 真正的事务安全由 narrative-state-store.json 的 backup 提供（commitAndSave 已备份）
  return JSON.stringify(existing, null, 2);
}

function atomicWriteJson(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, path);
}

function restoreBackup(path: string, backup: string | null): void {
  if (backup === null) {
    // 原文件不存在：删除新写入的文件
    if (existsSync(path)) {
      unlinkSync(path);
    }
    return;
  }
  // 用 backup 内容覆盖
  const tmpPath = `${path}.${process.pid}.${Date.now()}.restore.tmp`;
  writeFileSync(tmpPath, backup, "utf-8");
  renameSync(tmpPath, path);
}

/**
 * 合并 arc-registry：保留 existing 的 arcs/pending_foreshadows/metadata，
 * 只更新 config.currentChapter + lastUpdated。
 *
 * ClosureTracker 接入模块负责更新 arcs/pending_foreshadows 状态，
 * 它会在本桥接之后执行（同样原子写入 arc-registry.json）。
 */
function mergeArcRegistry(
  existing: unknown,
  bridged: BridgedArcRegistry,
): Record<string, unknown> {
  if (!isRecord(existing)) {
    return {
      config: bridged.config,
      arcs: [],
      pending_foreshadows: [],
      lastUpdated: bridged.lastUpdated,
    };
  }
  return {
    ...existing,
    config: {
      ...(isRecord(existing.config) ? existing.config : {}),
      currentChapter: bridged.config.currentChapter,
      ...(bridged.config.totalChapters !== undefined
        ? { totalChapters: bridged.config.totalChapters }
        : {}),
      ...(bridged.config.closureTarget !== undefined
        ? { closureTarget: bridged.config.closureTarget }
        : {}),
    },
    lastUpdated: bridged.lastUpdated,
  };
}
