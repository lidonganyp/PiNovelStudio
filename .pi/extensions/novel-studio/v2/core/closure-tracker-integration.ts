/**
 * closure-tracker-integration — ClosureTracker 接入最终状态生命周期（CLOSURE-TRACKER-1）
 *
 * 职责：在 FinalStateCommit.commit 成功 + NarrativeStateBridge 桥接完成后，
 * 把本章的 promise/expectation 状态推进反馈到 ClosureTracker 的 arc/foreshadow 状态，
 * 并执行 scanCompleteness() 把 D1-D6 完备性扫描结果写入 trace。
 *
 * P0-1 事务边界修复（STATE-BRIDGE-TXN-FIX）：
 * - 本模块产物是**可重建的 advisory cache**，不是权威状态。
 * - 写入 series/arc-registry-derived.json（与 NarrativeStateBridge 一致），
 *   不写入受 STEP-3 测试守护的 arc-registry.json。
 * - 失败不阻断主链路（state-store 已落盘，arc-registry-derived.json 可从 state-store 重建）。
 *
 * 设计原则（计划 §4.2 + AGENTS.md 状态事务边界）：
 * - 只在最终正文选定 + 状态提交 + 桥接完成后执行（状态已落盘）
 * - 基于 stagedStateUpdate（已 reanchored 到 finalText）派生 arc/foreshadow 推进
 *   - promise.status==="advancing" 且在 finalText 有 span → 不变更 arc 状态（仍在推进）
 *   - promise.status==="fulfilled"（如有） → 标记对应 foreshadow recalled
 *   - expectation.status==="fulfilled" → 标记 relatedArcIds 状态为 climaxed（如适用）
 * - 不机器生成新 arc/foreshadow：只更新已有条目状态
 * - scanCompleteness() 结果只写入 trace（advisory evidence，不阻断、不替代 judge）
 * - 失败不阻断主链路（narrative-state-store.json + 桥接已落盘），只 warning + trace
 *
 * 与 NarrativeStateBridge 的协作：
 * - 桥接先写入 arc-registry-derived.json 的 config.currentChapter + lastUpdated（保留 arcs/foreshadows）
 * - 本模块加载 arc-registry-derived.json（已含新 currentChapter），更新 arc/foreshadow 状态，再写回
 * - 因此 arc-registry-derived.json 的最终态 = 桥接 config + 本模块的 arc/foreshadow 更新
 *
 * 与 MethodologyDiagnosticState 的契约：
 * - 下一章生成时，MethodologyDiagnosticStateLoader 读取 arc-registry-derived.json（带 fallback）
 * - 本模块确保 arc.status / foreshadow.recalled 反映最新正文推进
 * - buildClosure 用 arcs/pending_foreshadows 派生收尾诊断
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { StagedStateUpdate, PromiseEntry, ExpectationEntry } from "./final-state-commit.js";
import { ClosureTracker } from "../../craft/closure-tracker.js";
import type { CompletenessReport } from "../../craft/closure-tracker.js";

// ============================================================================
// 接入结果（写入 trace）
// ============================================================================

export interface ClosureIntegrationResult {
  /** 桥接 + ClosureTracker 接入是否成功 */
  ok: boolean;
  error?: string;
  /** arc-registry-derived.json 路径（用于 trace 审计） */
  arcRegistryPath: string;
  /** 本次推进的 arc 状态变更（arcId → newStatus） */
  arcUpdates: Array<{ arcId: string; newStatus: string; reason: string }>;
  /** 本次标记 recalled 的 foreshadow id 列表 */
  recalledForeshadowIds: string[];
  /** scanCompleteness() 结果（advisory，写入 trace） */
  completenessReport: CompletenessReport | null;
  /** ClosureTracker 接入跳过原因（如 arc-registry-derived.json 不存在） */
  skippedReason?: string;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 在 FinalStateCommit.commit + NarrativeStateBridge 桥接完成后，
 * 把本章状态推进反馈到 ClosureTracker，并执行 scanCompleteness()。
 *
 * @param workspacePath workspaces/{id} 绝对路径
 * @param staged 本章 stagedStateUpdate（已 reanchored 到 finalText）
 * @param chapterNumber 当前章节号
 * @returns ClosureIntegrationResult 含 arcUpdates / recalledForeshadowIds / completenessReport
 */
export function integrateClosureTracker(
  workspacePath: string,
  staged: StagedStateUpdate,
  chapterNumber: number,
): ClosureIntegrationResult {
  // P0-1: 写入 arc-registry-derived.json（派生缓存），不写入受 STEP-3 守护的 arc-registry.json
  const arcRegistryPath = join(workspacePath, "series", "arc-registry-derived.json");

  if (!existsSync(arcRegistryPath)) {
    // 无 arc-registry-derived.json：跳过（桥接已写入新文件，但 arcs/pending_foreshadows 为空）
    return {
      ok: true,
      arcRegistryPath,
      arcUpdates: [],
      recalledForeshadowIds: [],
      completenessReport: null,
      skippedReason: "arc-registry-derived.json not found or empty (bridged file has no arcs)",
    };
  }

  try {
    // 加载 ClosureTracker（已含桥接写入的 config.currentChapter）
    const tracker = ClosureTracker.loadFromFile(arcRegistryPath);
    if (!tracker) {
      return {
        ok: true,
        arcRegistryPath,
        arcUpdates: [],
        recalledForeshadowIds: [],
        completenessReport: null,
        skippedReason: "arc-registry-derived.json parse failed (treated as empty)",
      };
    }

    const arcUpdates: Array<{ arcId: string; newStatus: string; reason: string }> = [];
    const recalledForeshadowIds: string[] = [];

    // 1. 派生 foreshadow recalled：从 stagedStateUpdate.promise entries 推导
    //    promise.status==="fulfilled" 且在 finalText 有 span → 对应 foreshadow recalled
    //    promise.status==="advancing" → 不变更（仍在推进，未兑现）
    const promiseEntries = staged.additions.filter(
      (e): e is PromiseEntry => e.kind === "promise",
    );
    for (const promise of promiseEntries) {
      // 只对 fulfilled promise 触发 recall（advancing 不触发）
      if (promise.status !== "fulfilled") continue;
      // sourceRef 必须指向 finalText span（reanchored 成功），不能是 seed:*
      if (!promise.sourceRef || promise.sourceRef.startsWith("seed:")) continue;
      const foreshadowId = promise.promiseId;
      if (!foreshadowId) continue;
      const recalled = tracker.recallForeshadow(foreshadowId);
      if (recalled) {
        recalledForeshadowIds.push(foreshadowId);
      }
    }

    // 2. 派生 arc 状态推进：从 stagedStateUpdate.expectation entries 推导
    //    P1-6 修复：expectation.status==="fulfilled" → 标记 arc 为 climaxed（合法状态机）
    //    （之前错误使用 "closing" as never，isLegalTransition 总是拒绝）
    //    只对当前状态为 in_progress 的 arc 推进到 climaxed；
    //    opened/in_progress 状态下 fulfilled 期待意味着弧线已达到高潮，可推进到 climaxed。
    //    climaxed → resolved/abandoned 的最终关闭需要更严格的人工/LLM 确认，不在此自动执行。
    const expectationEntries = staged.additions.filter(
      (e): e is ExpectationEntry => e.kind === "expectation",
    );
    for (const exp of expectationEntries) {
      if (exp.status !== "fulfilled") continue;
      // sourceRef 必须指向 finalText span
      if (!exp.sourceRef || exp.sourceRef.startsWith("seed:")) continue;
      const arcIds = exp.relatedArcIds ?? [];
      for (const arcId of arcIds) {
        // 推进到 climaxed（合法状态机：opened/in_progress → climaxed）
        // isLegalTransition 会在不合法时返回 success=false，我们只记录成功的更新
        const result = tracker.updateArcStatus(arcId, "climaxed");
        if (result.success) {
          arcUpdates.push({
            arcId,
            newStatus: "climaxed",
            reason: `expectation ${exp.expectationId} fulfilled in ch${chapterNumber}`,
          });
        }
      }
    }

    // 3. 执行 scanCompleteness()（advisory，不阻断）
    let completenessReport: CompletenessReport | null = null;
    try {
      completenessReport = tracker.scanCompleteness();
    } catch {
      // scan 失败不阻断（advisory）
      completenessReport = null;
    }

    // 4. 保存 ClosureTracker（写回 arc-registry-derived.json）
    //    P1-6 修复：saveToFile 内部使用原子写入（tmp→rename），失败抛出异常被外层捕获
    tracker.saveToFile(arcRegistryPath);

    return {
      ok: true,
      arcRegistryPath,
      arcUpdates,
      recalledForeshadowIds,
      completenessReport,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `closure tracker integration failed: ${msg}`,
      arcRegistryPath,
      arcUpdates: [],
      recalledForeshadowIds: [],
      completenessReport: null,
    };
  }
}
