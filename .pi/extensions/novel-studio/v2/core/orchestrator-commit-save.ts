/**
 * orchestrator-commit-save - 统一主链路"状态提交 + 原子保存"相位
 *
 * 从 unified-orchestrator.ts 抽出（行为保持重构 Step 2）。
 * 包含：commitAndSave（事务：先原子保存正文，后提交状态）、atomicSave、
 * extractPatternEntriesFromText（B2 PatternMemory）、chapterFilePath。
 *
 * 事务顺序（计划 §3 FinalStateCommit + AGENTS.md 状态维护事务边界）：
 * 1. 先原子保存正文（失败 = hard block，不污染状态）
 * 2. 后提交状态（失败 = hard block，并回滚刚保存的正文）
 *
 * 本模块为纯函数集合，不持有实例状态，不调用 UnifiedOrchestrator 的其他方法。
 */

import { writeFileSync, mkdirSync, renameSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import type { UnifiedOrchestratorInput } from "./orchestrator-types.js";
import {
  createFinalStateCommit,
  loadStateStore,
  reanchorStagedStateToFinalText,
  computeFinalTextHash,
  type PatternEntry,
  type StagedStateUpdate,
} from "./final-state-commit.js";
import { createLanguageRiskLibrary } from "./language-risk-library.js";
import { bridgeStateToSeriesFiles } from "./narrative-state-bridge.js";
import { integrateClosureTracker } from "./closure-tracker-integration.js";
import { persistChapterProgressionContract } from "./chapter-progression-contract.js";
import { writeChapterContinuitySnapshot } from "../../craft/chapter-continuity-snapshot.js";
import type { StructuralEvidence, ChapterQualityEvidence } from "./chapter-quality-evidence.js";
// G7-Checkpoint：代理审批稿 pending 守护（计划 §6.3 / §12.2）
// 用户最终确认前，FinalStateCommit 和正式章节原子保存均不得执行。
// hasPendingProxyDraft 检查 workspaces/{id}/chapter-approvals/{chapterId}.pending.json
// 是否存在且 status="pending"；存在时 commitAndSave 拒绝执行（不写 chapters/、不提交状态）。
// 闭包自包含（仅依赖 node:fs / node:path），可安全进入生产闭包。
import { hasPendingProxyDraft } from "../governance/chapter-proxy-approval-draft-checkpoint.js";

/**
 * 最终正文选定后：原子保存正文 + 提交状态（P0-4 事务一致性）。
 *
 * 事务顺序（计划 §3 FinalStateCommit + AGENTS.md 状态维护事务边界）：
 * 1. 先原子保存正文（失败 = hard block，不污染状态）
 * 2. 后提交状态（失败 = hard block，并回滚刚保存的正文）
 *
 * 不再吞掉正文保存失败：正文是主产物，保存失败必须阻断。
 * 状态提交失败不假装成功：记录 error，回滚已保存的正文并返回 ok=false。
 */
export function commitAndSave(
  input: UnifiedOrchestratorInput,
  selectedCandidateId: string,
  finalText: string,
  stageResults: Record<string, unknown>
): {
  ok: boolean;
  error?: string;
  stateCommit: { committed: number; rejected: number; error?: string | null } | null;
} {
  const { workspaceId, projectRoot } = input;

  // ── 0. G7-Checkpoint：代理审批稿 pending 守护（计划 §6.3 / §12.2） ──
  // 用户最终确认前，FinalStateCommit 和正式章节原子保存均不得执行。
  // 如果本章有未确认的代理审批稿（chapter-approvals/{chapterId}.pending.json 存在），
  // commitAndSave 拒绝执行：不写 chapters/、不提交状态、不推进 frontier。
  // 调用方（unified-orchestrator stage 7）收到 ok=false 后 hard block。
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  if (hasPendingProxyDraft(workspacePath, input.chapterId)) {
    const pendingError = `pending_proxy_draft：本章存在未确认的代理审批稿，FinalStateCommit 和正式章节保存被阻止（approvalId 见 chapter-approvals/${input.chapterId}.pending.json）`;
    stageResults.atomicSave = {
      blocked: true,
      reason: "pending_proxy_draft",
      chapterId: input.chapterId,
    };
    return { ok: false, error: pendingError, stateCommit: null };
  }

  // ── 1. 原子保存正文（主产物，失败 = hard block） ──────────────────
  const filePath = chapterFilePath(input);
  let previousChapterText: string | null = null;
  const chapterExisted = existsSync(filePath);
  try {
    if (chapterExisted) {
      previousChapterText = readFileSync(filePath, "utf-8");
    }
    atomicSave(filePath, finalText);
    stageResults.atomicSave = { filePath, bytes: finalText.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    stageResults.atomicSave = { error: msg, filePath };
    // 正文保存失败 -> 状态不提交（无污染），调用方 hard block
    return { ok: false, error: msg, stateCommit: null };
  }

  // ── 2. 状态提交（正文已保存，状态失败 = hard block + 正文回滚） ───
  // A2（计划 §4.2）：状态只根据最终正文提交。stagedStateUpdate 是从 ChapterSeed
  // 派生的"seed 意图"（sourceRef=seed:*），此处用 finalText 重锚定：
  //   - promise 描述关键词在 finalText 命中 -> sourceRef 指向真实 span，confidence 提升
  //   - 未命中 -> 降级为 open，不声称 advancing
  //   - 提交器用 finalText 校验 span 越界，越界 entry 被拒绝
  const rollbackChapter = (stateError: string): {
    ok: false;
    error: string;
    stateCommit: { committed: number; rejected: number; error: string };
  } => {
    try {
      if (chapterExisted && previousChapterText !== null) {
        atomicSave(filePath, previousChapterText);
      } else if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      stageResults.atomicSave = {
        ...(stageResults.atomicSave as Record<string, unknown>),
        rolledBack: true,
        rollbackAction: chapterExisted ? "restored_previous" : "removed_new",
      };
    } catch (rollbackError: unknown) {
      const rollbackMessage = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      stageResults.atomicSave = {
        ...(stageResults.atomicSave as Record<string, unknown>),
        rolledBack: false,
        rollbackError: rollbackMessage,
      };
      return {
        ok: false,
        error: `state commit failed: ${stateError}; chapter rollback failed: ${rollbackMessage}`,
        stateCommit: { committed: 0, rejected: 0, error: stateError },
      };
    }
    return {
      ok: false,
      error: `state commit failed: ${stateError}`,
      stateCommit: { committed: 0, rejected: 0, error: stateError },
    };
  };

  let committed = 0;
  let rejected = 0;
  // reanchored 提升到外层作用域，供 STATE-BRIDGE-1 + CLOSURE-TRACKER-1 使用。
  // reanchor 把 seed:* sourceRef 重锚定为 finalText span，ClosureTracker 接入
  // 依据 reanchored sourceRef 判断 promise/expectation 是否在正文中实际兑现。
  let reanchoredForBridge: StagedStateUpdate | null = null;
  if (input.stagedStateUpdate) {
    // ── 2.5 P1 回滚支持：备份章节前叙事状态 ─────────────────────
    // 在状态提交前备份 narrative-state-store.json，供 rollbackCommittedChapter 恢复。
    // 备份到 chapter-approvals/{chapterId}.pre-commit-state-{timestamp}.json
    // （与 draft-checkpoint / finalization 共用 chapter-approvals/ 隔离目录）。
    //
    // P1#2（计划 §12.2 验收 3）：备份失败时阻断状态提交。
    // 若备份失败仍提交状态，rollbackCommittedChapter 会删除正文却无法恢复叙事状态
    // （无 pre-commit 备份），破坏"正文与状态一起回退"保证。
    // 因此：prior state store 存在但备份失败 -> 跳过状态提交（committed=0），
    //       state store 保持章节前状态，并回滚刚保存的正文。
    // 无 prior state store（skipped）不视为备份失败（无内容需备份/恢复）。
    let backupOk = true;
    let backupErrorMsg: string | null = null;
    try {
      const statePath = join(workspacePath, "narrative-state-store.json");
      if (existsSync(statePath)) {
        const backupDir = join(workspacePath, "chapter-approvals");
        if (!existsSync(backupDir)) {
          mkdirSync(backupDir, { recursive: true });
        }
        const timestamp = Date.now();
        const stateBackupPath = join(
          backupDir,
          `${input.chapterId}.pre-commit-state-${timestamp}.json`
        );
        const stateContent = readFileSync(statePath, "utf-8");
        atomicSave(stateBackupPath, stateContent);
        stageResults.stateBackup = {
          backupPath: stateBackupPath,
          chapterId: input.chapterId,
        };
      } else {
        stageResults.stateBackup = { skipped: "no_prior_state_store", chapterId: input.chapterId };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      stageResults.stateBackup = { error: msg, chapterId: input.chapterId };
      // P1#2：备份失败（且 prior state 存在）-> 阻断状态提交
      backupOk = false;
      backupErrorMsg = msg;
    }

    if (!backupOk) {
      // 备份失败：跳过状态提交，state store 保持章节前状态，并回滚正文。
      stageResults.stateCommit = {
        blocked: "backup_failed",
        committed: 0,
        rejected: 0,
        error: backupErrorMsg ?? "pre-commit state backup failed",
        chapterId: input.chapterId,
      };
      return rollbackChapter(backupErrorMsg ?? "pre-commit state backup failed");
    } else {
      try {
        const reanchored = reanchorStagedStateToFinalText(
          input.stagedStateUpdate,
          finalText,
          input.chapterNumber,
          // P0 第六轮结构化绑定：传入本章角色名（含别名），启用境界主体归属的
          // 结构化判断（句中含其他角色但不含目标角色 → fail-closed），取代动词正则补丁。
          input.characterNames,
          // P0 第七轮 P1 修复：传入别名→规范名映射，启用境界主体绑定的 alias 规范化
          // （"小尘" → "叶尘"），与 Story Preservation Gate 共用同一映射来源。
          input.aliasToCanonical
        );
        // B2：PatternMemory - 从最终正文扫描语言风险，追加 pattern entries。
        // pattern 是正文派生状态（非 seed 派生），在 reanchor 后追加到 additions。
        const patternEntries = extractPatternEntriesFromText(
          finalText,
          input.characterNames,
          input.chapterNumber
        );
        if (patternEntries.length > 0) {
          reanchored.additions.push(...patternEntries);
        }
        // 保存 reanchored 给 STATE-BRIDGE-1 + CLOSURE-TRACKER-1 使用
        reanchoredForBridge = reanchored;
        const stateCommit = createFinalStateCommit();
        stateCommit.stage(reanchored);
        const store = loadStateStore(workspaceId, projectRoot);
        // Phase 3D：传入原始 stagedStateUpdate 作为 plannedUpdate，
        // 让 FinalStateCommit 把 seed 派生的计划状态写入 store.planned 字段
        // （非权威，供下一章 Preflight 连续性参考）。
        const result = stateCommit.commit(
          store,
          selectedCandidateId,
          finalText,
          workspaceId,
          projectRoot,
          input.stagedStateUpdate
        );
        committed = result.committed;
        rejected = result.rejected.length;
        stageResults.stateCommit = {
          committed,
          rejected,
          finalTextHash: result.finalTextHash,
          patternEntriesAdded: patternEntries.length,
          plannedPersisted: result.plannedPersisted,
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // 状态提交失败：记录 error，回滚正文并阻断交付。
        stageResults.stateCommit = { error: msg, committed: 0, rejected: 0 };
        return rollbackChapter(msg);
      }
    }
  } else {
    stageResults.stateCommit = { skipped: "无 stagedStateUpdate" };
  }

  // ── 3. STATE-BRIDGE-1 + CLOSURE-TRACKER-1：状态桥接 + ClosureTracker 接入 ──
  // P0-1 事务边界修复（STATE-BRIDGE-TXN-FIX）：
  // 桥接/closure/progression 是**可重建的 advisory cache**，不是权威状态。
  // 权威状态是 narrative-state-store.json（已在第 2 步由 FinalStateCommit 原子落盘）。
  // 桥接/closure/progression 写入 series/*-derived.json，与 FinalStateCommit 事务**独立**。
  //
  // 失败处理（advisory cache 失败不阻断主链路）：
  // - 桥接/closure/progression 失败 → warning + 写入 trace，返回 ok=true
  // - 这是**有意的设计**：state-store 已落盘，advisory cache 可从 state-store 重建
  // - 不会导致正文/state-store 不一致（state-store 已先落盘）
  // - 不会导致 arc-registry-derived.json 损坏（bridge 内部有 backup→write→rollback）
  //
  // 与 STEP-3 测试守护的关系：
  // - arc-registry.json（权威）只能由 final-state-commit.js 写入
  // - 桥接/closure 写入 arc-registry-derived.json（派生缓存），不违反 STEP-3 守护
  if (reanchoredForBridge) {
    try {
      const store = loadStateStore(input.workspaceId, input.projectRoot);
      const bridgeResult = bridgeStateToSeriesFiles(
        workspacePath,
        store,
        reanchoredForBridge,
        input.chapterNumber,
      );
      stageResults.stateBridge = {
        ok: bridgeResult.ok,
        error: bridgeResult.error,
        writtenPaths: bridgeResult.writtenPaths,
        // P0-1: 明确标记为 advisory cache，失败不阻断主链路
        advisoryCache: true,
        rebuildableFrom: "narrative-state-store.json",
      };

      // 桥接成功后接入 ClosureTracker（基于 reanchored stagedStateUpdate）。
      // reanchored 的 promise/expectation sourceRef 已重锚定为 finalText span
      // （非 seed:*），ClosureTracker 据此判断是否实际兑现并触发 arc/foreshadow 状态推进。
      const closureResult = integrateClosureTracker(
        workspacePath,
        reanchoredForBridge,
        input.chapterNumber,
      );
      stageResults.closureIntegration = {
        ok: closureResult.ok,
        error: closureResult.error,
        arcRegistryPath: closureResult.arcRegistryPath,
        arcUpdates: closureResult.arcUpdates,
        recalledForeshadowIds: closureResult.recalledForeshadowIds,
        skippedReason: closureResult.skippedReason,
        // completenessReport 是 advisory，写入 trace 供诊断层读取
        completenessReport: closureResult.completenessReport,
        // P0-1: 明确标记为 advisory cache
        advisoryCache: true,
        rebuildableFrom: "narrative-state-store.json",
      };

      // ── PROGRESSION-CONTRACT-1：持久化 ChapterProgressionContract ──
      // 从 stageResults.chapterQualityEvidence.structuralEvidence 派生实际推进轴，
      // 与 ChapterIntent.expectedAxes 对比生成复核信号，持久化到
      // series/chapter-progression-contracts.json 供下游诊断层读取跨章 delta。
      // P0-1: 失败不阻断主链路（advisory cache，可从 state-store + structuralEvidence 重建）。
      try {
        const qualityEvidence = stageResults.chapterQualityEvidence as
          | ChapterQualityEvidence
          | undefined;
        const structuralEvidence: StructuralEvidence[] =
          qualityEvidence?.structuralEvidence ?? [];
        // input.intent 是 ChapterIntentBuilder 输出（chapter-intent-builder.ChapterIntent），
        // 已含 chapterFunction / readerExperience / causalEndPressure 等字段。
        const intent = input.intent;
        const finalTextHash = computeFinalTextHash(finalText);

        const contractResult = persistChapterProgressionContract(
          workspacePath,
          input.workspaceId,
          input.chapterNumber,
          input.chapterId,
          intent,
          structuralEvidence,
          reanchoredForBridge,
          finalTextHash,
        );
        stageResults.progressionContract = {
          ok: contractResult.ok,
          error: contractResult.error,
          chapterNumber: input.chapterNumber,
          expectedAxes: contractResult.contract?.expectedAxes,
          actualAxes: contractResult.contract?.actualAxes,
          reviewSignals: contractResult.contract?.reviewSignals ?? [],
          // P0-1: 明确标记为 advisory cache
          advisoryCache: true,
          rebuildableFrom: "narrative-state-store.json + structuralEvidence",
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        stageResults.progressionContract = {
          ok: false,
          error: msg,
          advisoryCache: true,
          rebuildableFrom: "narrative-state-store.json + structuralEvidence",
        };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // P0-1: 桥接失败不阻断主链路（state-store 已落盘，advisory cache 可重建）
      // 但必须在 trace 中留下明确证据，不能 silent degrade
      stageResults.stateBridge = {
        ok: false,
        error: msg,
        advisoryCache: true,
        rebuildableFrom: "narrative-state-store.json",
        warning: "bridge failed; advisory cache not written; rebuildable from state-store",
      };
    }
  }

  // ── 4. P1-F：写入章节连续性快照（advisory cache） ────────────────
  // 下一章 ChapterSeedBuilder.loadPreviousChapterTextContinuation 会读取该快照，
  // 把上一章实际产生的新事件/未结钩子/新登场角色结构化传入下一章模型上下文。
  // 失败不阻断主链路（advisory cache，可从 narrative-state-store.json 重建）。
  try {
    writeChapterContinuitySnapshot(
      workspacePath,
      input.chapterNumber,
      finalText,
      reanchoredForBridge,
      computeFinalTextHash(finalText),
    );
    stageResults.continuitySnapshot = {
      ok: true,
      advisoryCache: true,
      rebuildableFrom: "narrative-state-store.json",
      chapterNumber: input.chapterNumber,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    stageResults.continuitySnapshot = {
      ok: false,
      error: msg,
      advisoryCache: true,
      rebuildableFrom: "narrative-state-store.json",
      chapterNumber: input.chapterNumber,
    };
  }

  // 成功路径不会吞掉 stateCommit 异常；异常已在上方回滚并以 ok=false 返回。
  return { ok: true, stateCommit: { committed, rejected, error: null } };
}

/**
 * 原子保存：写临时文件 -> rename。失败不覆盖原文件。
 */
export function atomicSave(filePath: string, text: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, text, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * B2：从最终正文扫描语言风险，生成 PatternMemory entries。
 *
 * 使用 LanguageRiskLibrary（本地扫描，无 LLM 调用）检测正文中的语言风险模式，
 * 按 riskId 分组计数，每个唯一 riskId 生成一条 PatternEntry。
 *
 * patternType 映射：所有语言风险类别（ai_pattern / perception_erosion /
 * agency_dilution / naturalness）统一归为 "sentence_risk"，
 * 因为 PatternMemory 的 sentence_risk 类型正是追踪可重复的语言模式。
 *
 * sourceRef/sourceRefs 保留 scanner 返回的首个/全部正文 span。
 * 扫描失败返回空数组（pattern 是增强，不阻断状态提交）。
 */
export function extractPatternEntriesFromText(
  finalText: string,
  characterNames: string[],
  chapterNumber: number
): PatternEntry[] {
  try {
    const lib = createLanguageRiskLibrary();
    const report = lib.scan(finalText, characterNames);
    const sourceChapter = `ch${chapterNumber}`;
    const hash = computeFinalTextHash(finalText);
    const now = new Date().toISOString();

    // 按 riskId 分组，并保留 scanner 返回的全部有效 span。
    const grouped = new Map<string, { description: string; spans: Array<{ start: number; end: number }> }>();
    for (const entry of report.entries) {
      if (entry.span.start < 0 || entry.span.end <= entry.span.start || entry.span.end > finalText.length) {
        continue;
      }
      const existing = grouped.get(entry.riskId);
      if (existing) {
        existing.spans.push({ start: entry.span.start, end: entry.span.end });
      } else {
        grouped.set(entry.riskId, {
          description: entry.description,
          spans: [{ start: entry.span.start, end: entry.span.end }],
        });
      }
    }

    const entries: PatternEntry[] = [];
    for (const [riskId, { description, spans }] of grouped) {
      const sourceRefs = spans.map(
        (span) => `ch${chapterNumber}#finalText:${hash}:${span.start}-${span.end}`
      );
      entries.push({
        kind: "pattern",
        id: `pattern:${riskId}:ch${chapterNumber}`,
        sourceChapter,
        sourceRef: sourceRefs[0],
        sourceRefs,
        confidence: 0.8, // 正文扫描确认，置信度较高
        lastUpdated: now,
        patternType: "sentence_risk",
        description,
        occurrenceCount: spans.length,
      });
    }
    return entries;
  } catch {
    // 扫描失败不阻断状态提交（pattern 是增强）
    return [];
  }
}

export function chapterFilePath(input: UnifiedOrchestratorInput): string {
  return join(input.projectRoot, "workspaces", input.workspaceId, "chapters", `${input.chapterId}.md`);
}
