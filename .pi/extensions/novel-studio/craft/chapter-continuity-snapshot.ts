/**
 * ChapterContinuitySnapshot — 章节连续性快照（P1-F）
 *
 * 问题：loadPreviousChapterTextContinuation 读取前章正文时 openHooks 恒为空，
 * 上一章实际产生的新事件、未结钩子不能保证被下一章结构化消费。
 *
 * 解决：最终正文提交时（commitAndSave）同步生成带正文证据 span 的连续性快照，
 * 下一章从该快照加载 openHooks / introducedCharacters / unresolvedTensions。
 *
 * 路径：workspaces/{id}/chapter-continuity/{N}.json
 *
 * 快照是 advisory cache：写入失败不阻断主链路；加载失败回退到仅正文尾部。
 *
 * 设计说明：本模块放在 craft/ 下，避免 craft/chapter-seed-builder.ts 反向依赖
 * v2/core/。entry 类型用本地最小接口（结构化兼容 v2/core StagedStateUpdate.additions），
 * 只声明快照实际消费的字段，避免对 v2/core 类型的硬依赖。
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from "fs";
import { join } from "node:path";

// ============================================================================
// 类型
// ============================================================================

/**
 * 快照消费的最小 entry 字段（结构化兼容 v2/core StagedStateUpdate.additions[]）。
 * 只声明快照实际读取的字段，避免对 v2/core 类型的硬依赖。
 */
export interface SnapshotStateEntry {
  kind: string;
  sourceRef: string;
  description?: string;
  status?: string;
  characterId?: string;
}

/**
 * 快照消费的最小 staged update 结构（兼容 v2/core StagedStateUpdate）。
 */
export interface SnapshotStagedUpdate {
  additions: SnapshotStateEntry[];
}

export interface ChapterContinuitySnapshot {
  /** 章节号 */
  chapterNumber: number;
  /** 未结钩子（promise/expectation 描述，有 finalText span 证据） */
  openHooks: string[];
  /** 本章引入/登场的角色名 */
  introducedCharacters: string[];
  /** 未解张力（delayed/escalated expectation / open promise 描述） */
  unresolvedTensions: string[];
  /** 正文最后 1200 字（供下一章 lastEventSummary 使用） */
  lastEventSummary: string;
  /** finalText SHA-256 前 12 位 */
  finalTextHash: string;
  /** 快照来源的 sourceRef 列表（可追溯） */
  sourceRefs: string[];
  /** 创建时间 */
  createdAt: string;
}

// ============================================================================
// 辅助：判断 sourceRef 是否有真实 span 证据
// ============================================================================

/**
 * 判断 sourceRef 是否包含实际 finalText span（而非 not-found / semantic-conflict）。
 *
 * 有 span 格式：ch{N}#finalText:{hash}:{start}-{end}
 * 无 span 格式：ch{N}#finalText:{hash}:not-found
 *               ch{N}#finalText:{hash}:semantic-conflict
 *               ch{N}#finalText:{hash}（pattern kind，无 span）
 */
function hasSpanEvidence(sourceRef: string): boolean {
  if (!sourceRef) return false;
  if (sourceRef.endsWith(":not-found")) return false;
  if (sourceRef.endsWith(":semantic-conflict")) return false;
  // 匹配 :{start}-{end} 结尾
  return /:\d+-\d+$/.test(sourceRef);
}

// ============================================================================
// 写入快照
// ============================================================================

/**
 * 从 reanchored 状态更新提取连续性信息并写入快照。
 *
 * 提取规则（只包含有 finalText span 证据的 entry）：
 * - openHooks:
 *   - promise (status open/advancing) → description
 *   - expectation (status open/advanced/delayed) → description
 * - introducedCharacters:
 *   - character entries → characterId
 * - unresolvedTensions:
 *   - expectation (status delayed/escalated) → description
 *   - promise (status open) → description
 *
 * @param workspacePath workspace 根路径
 * @param chapterNumber 章节号
 * @param finalText 最终正文
 * @param reanchored 重锚定后的状态更新（可能为 null——无 stagedStateUpdate）
 * @param finalTextHash finalText SHA-256 前 12 位
 */
export function writeChapterContinuitySnapshot(
  workspacePath: string,
  chapterNumber: number,
  finalText: string,
  reanchored: SnapshotStagedUpdate | null,
  finalTextHash: string,
): void {
  const openHooks: string[] = [];
  const introducedCharacters: string[] = [];
  const unresolvedTensions: string[] = [];
  const sourceRefs: string[] = [];

  if (reanchored) {
    for (const entry of reanchored.additions) {
      if (!hasSpanEvidence(entry.sourceRef)) continue;
      sourceRefs.push(entry.sourceRef);

      if (entry.kind === "promise") {
        const desc = entry.description?.trim();
        if (!desc) continue;
        if (entry.status === "open" || entry.status === "advancing") {
          if (!openHooks.includes(desc)) openHooks.push(desc);
        }
        if (entry.status === "open") {
          if (!unresolvedTensions.includes(desc)) unresolvedTensions.push(desc);
        }
      } else if (entry.kind === "expectation") {
        const desc = entry.description?.trim();
        if (!desc) continue;
        if (
          entry.status === "open" ||
          entry.status === "advanced" ||
          entry.status === "delayed"
        ) {
          if (!openHooks.includes(desc)) openHooks.push(desc);
        }
        if (entry.status === "delayed" || entry.status === "escalated") {
          if (!unresolvedTensions.includes(desc)) unresolvedTensions.push(desc);
        }
      } else if (entry.kind === "character") {
        const name = entry.characterId?.trim();
        if (name && !introducedCharacters.includes(name)) {
          introducedCharacters.push(name);
        }
      }
    }
  }

  // 正文最后 1200 字作为 lastEventSummary
  const maxChars = 1200;
  let lastEventSummary = finalText.length > maxChars
    ? finalText.slice(-maxChars)
    : finalText;
  if (finalText.length > maxChars) {
    const paragraphBreak = lastEventSummary.indexOf("\n\n");
    if (paragraphBreak >= 0 && paragraphBreak < 320) {
      lastEventSummary = lastEventSummary.slice(paragraphBreak + 2);
    }
  }

  const snapshot: ChapterContinuitySnapshot = {
    chapterNumber,
    openHooks,
    introducedCharacters,
    unresolvedTensions,
    lastEventSummary,
    finalTextHash,
    sourceRefs,
    createdAt: new Date().toISOString(),
  };

  const snapshotDir = join(workspacePath, "chapter-continuity");
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }
  const snapshotPath = join(snapshotDir, `${chapterNumber}.json`);
  const tmpPath = `${snapshotPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
  // 原子写入：tmp → rename
  renameSync(tmpPath, snapshotPath);
}

// ============================================================================
// 加载快照
// ============================================================================

/**
 * 加载前章连续性快照。
 *
 * @param workspacePath workspace 根路径
 * @param chapterNumber 前章章节号
 * @returns 快照对象；文件不存在或损坏时返回 null
 */
export function loadChapterContinuitySnapshot(
  workspacePath: string,
  chapterNumber: number,
): ChapterContinuitySnapshot | null {
  const snapshotPath = join(workspacePath, "chapter-continuity", `${chapterNumber}.json`);
  if (!existsSync(snapshotPath)) return null;
  try {
    const raw = readFileSync(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.chapterNumber !== "number" ||
      !Array.isArray(parsed?.openHooks) ||
      !Array.isArray(parsed?.introducedCharacters) ||
      !Array.isArray(parsed?.unresolvedTensions)
    ) {
      return null;
    }
    return parsed as ChapterContinuitySnapshot;
  } catch {
    return null;
  }
}
