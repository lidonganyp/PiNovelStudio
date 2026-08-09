/**
 * Phase 6.1 eval-only：从 BaselineScenario 派生 LongTermStateSnapshot。
 *
 * 当前 eval runner 的临时 workspace 只写入 legacy 状态文件（narrative-state.json），
 * 不写入 narrative-state-store.json（四类长期状态权威文件）。因此 ContextCompiler
 * 返回的 longTermState 为 null。
 *
 * 本模块从 BaselineScenario 的 workspace 数据（skeleton/narrativeState/arcRegistry/
 * unsettledDetails）派生模拟的 LongTermStateSnapshot，使 A/B/C 三组能测量长期状态
 * 注入对模型工具选择和证据覆盖的影响。
 *
 * 设计原则：
 * - 派生的状态数据必须与场景的 mustVerify 项相关（否则注入也无意义）
 * - 状态来源章节为历史章节（sourceChapter < currentChapter），遵循 FUTURE-STATE-ISOLATION
 * - 每类状态至少 2-3 条，确保有足够的信号测量边际价值
 */

import type { LongTermStateSnapshot } from "../../v2/core/types.js";
import type { BaselineScenario } from "./tool-interface-baseline.js";

/**
 * 从 BaselineScenario 派生模拟的 LongTermStateSnapshot。
 * 若场景无历史章节或无可用状态数据，返回 null（C 组行为）。
 */
export function deriveSnapshotFromScenario(scenario: BaselineScenario): LongTermStateSnapshot | null {
  const ws = scenario.workspace;
  const historicalCount = ws.historicalChapters.length;
  if (historicalCount === 0) return null;

  // 用最后一个历史章节作为"当前章"前一章
  const lastChapterNum = ws.historicalChapters[historicalCount - 1].number;
  const sourceChapter = `ch${lastChapterNum}`;

  // ── CanonState：从 skeleton.events 派生确立事实 ──
  const canon = ws.skeleton.events.slice(0, 6).map((evt, i) => ({
    id: `canon-${scenario.id}-${i}`,
    fact: `${evt.summary}（${evt.location}）`,
    category: evt.type.includes("time") ? "timeline" : evt.type.includes("location") ? "location" : "entity",
    sourceChapter,
  }));

  // ── CharacterState：从 narrativeState.characterUpdates 派生 ──
  const character = ws.narrativeState.characterUpdates.map((cu, i) => ({
    id: `char-${scenario.id}-${i}`,
    characterId: cu.name,
    field: cu.field,
    value: cu.value,
    sourceChapter,
  }));

  // ── PromiseLedger：从 arcRegistry.foreshadowings + arcs 派生 ──
  const promise = [
    ...ws.arcRegistry.foreshadowings.map((fs, i) => ({
      id: `promise-${scenario.id}-${i}`,
      promiseId: fs.id,
      description: fs.description,
      status: (fs.status ?? "open") as "open" | "advancing" | "fulfilled" | "broken",
      currentHeat: fs.level === "high" ? 8 : fs.level === "medium" ? 5 : 3,
      sourceChapter,
    })),
    ...ws.arcRegistry.arcs.map((arc, i) => ({
      id: `arc-${scenario.id}-${i}`,
      promiseId: arc.arcId,
      description: `${arc.name}${arc.coreQuestion ? `：${arc.coreQuestion}` : ""}`,
      status: (arc.status === "closed" ? "fulfilled" : "open") as "open" | "advancing" | "fulfilled" | "broken",
      currentHeat: arc.priority === "high" ? 7 : 4,
      sourceChapter,
    })),
  ];

  // ── PatternMemory：从历史章节文本派生简化模式 ──
  // 从历史章节标题和内容中提取简单模式标记
  const pattern = ws.historicalChapters.slice(0, 4).map((ch, i) => ({
    id: `pattern-${scenario.id}-${i}`,
    patternType: i % 2 === 0 ? "hook_type" : "trope",
    description: `${ch.title}中的叙事节奏模式`,
    occurrenceCount: i + 1,
    sourceChapter: `ch${ch.number}`,
  }));

  // ── Expectation：从 unsettledDetails 派生读者期待 ──
  const expectation = ws.unsettledDetails.slice(0, 4).map((ud, i) => ({
    id: `exp-${scenario.id}-${i}`,
    expectationId: ud.id,
    description: ud.description,
    expectationType: ud.type,
    targetReaderExperience: undefined,
    delayReason: undefined,
    status: (ud.status ?? "open") as "open" | "advanced" | "delayed" | "escalated" | "fulfilled",
    sourceChapter: ud.chapterId ?? sourceChapter,
    sourceRef: undefined,
  }));

  // 空状态检查
  if (canon.length === 0 && character.length === 0 && promise.length === 0 && pattern.length === 0) {
    return null;
  }

  return {
    canon,
    character,
    promise,
    pattern,
    expectation: expectation.length > 0 ? expectation : undefined,
    lastCommittedChapter: sourceChapter,
    sourceIds: ["narrative-state-store.json"],
    retrievalReport: null,
    promptItems: [], // 由 compressed-context-builder.buildContextBlock 直接从快照构建
    overdueAlerts: [],
    planned: undefined,
  };
}
