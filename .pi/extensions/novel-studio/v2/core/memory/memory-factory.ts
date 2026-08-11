/**
 * MEMORY-RECORD 工厂层（MEMORY-FACTORY-1）
 *
 * 把现有 NarrativeStateEntry（final-state-commit.ts 的四类长期状态）转换为
 * MemoryRecord 信封，供权威检索、回源、TTL 与 receipt 消费。
 *
 * 与生产链路集成点：
 * - FinalStateCommit.commit() 对每条 accepted entry 附加 memory 信封
 * - 生成 MemoryCommitReceipt 供 trace 留存
 *
 * 本模块纯函数，无副作用。
 */

import type { MemoryRecord, MemoryType } from "./memory-record.js";
import { computeSha12 } from "./memory-hash.js";
import type { NarrativeStateEntry } from "../final-state-commit.js";

export interface EntryToMemoryOptions {
  sourceChapter: number;
  sourceRunId: string;
  finalText: string;
}

/**
 * 从现有状态条目构建 MemoryRecord 信封。
 *
 * 权威等级判定（§5.3）：
 * - promise/character/canon 来源为最终正文 finalText span → final_text_explicit + confirmed
 * - 来源为 seed:*（未重锚定）→ 不构造正式记忆（调用方应已过滤）
 * - pattern → system_derived（正文派生，抽象统计）
 */
export function stateEntryToMemoryRecord(
  entry: NarrativeStateEntry,
  opts: EntryToMemoryOptions
): MemoryRecord | null {
  const sourceRef = entry.sourceRef;
  // 仅接受已重锚定到最终正文的条目（sourceRef 含 #finalText:）
  if (!sourceRef.includes("#finalText:")) return null;

  const now = new Date().toISOString();
  const textHashes = extractTextHashes(sourceRef, opts.finalText);
  const base: Omit<MemoryRecord, "memoryType" | "payload"> = {
    memoryId: entry.id,
    sourceChapter: opts.sourceChapter,
    sourceRef: [...(entry.sourceRefs ?? [entry.sourceRef])],
    textHash: textHashes.length > 0 ? textHashes : [computeSha12(opts.finalText)],
    sourceRunId: opts.sourceRunId,
    sourceFinalTextHash: computeSha12(opts.finalText),
    createdAt: now,
    updatedAt: entry.lastUpdated ?? now,
    expiresAt: null,
    confidence: entry.confidence,
    derivedFromMemoryIds: [],
    supersedesMemoryIds: entry.supersedes ? [entry.supersedes] : [],
    authorityClass: "final_text_explicit",
    epistemicStatus: "confirmed",
    lifecycleStatus: entry.effectiveTo ? "superseded" : "active",
  };

  switch (entry.kind) {
    case "canon":
      return {
        ...base,
        memoryType: "canon",
        payload: {
          memoryType: "canon",
          data: {
            value: entry.fact,
            category: entry.category,
            key: entry.id,
          },
        },
      };
    case "character":
      return {
        ...base,
        memoryType: "character",
        payload: {
          memoryType: "character",
          data: {
            value: entry.value,
            category: entry.field,
            key: `character:${entry.characterId}:${entry.field}`,
          },
        },
      };
    case "promise":
      return {
        ...base,
        memoryType: "promise",
        payload: {
          memoryType: "promise",
          data: {
            promiseId: entry.promiseId,
            description: entry.description,
            status: entry.status,
            currentHeat: entry.currentHeat,
            payoffWindow: entry.expectedPayoffWindow,
          },
        },
      };
    case "expectation":
      return {
        ...base,
        memoryType: "promise",
        payload: {
          memoryType: "promise",
          data: {
            promiseId: entry.expectationId,
            description: entry.description,
            status: mapExpectationStatus(entry.status),
            currentHeat: 0,
          },
        },
      };
    case "pattern":
      return {
        ...base,
        memoryType: "pattern",
        authorityClass: "system_derived",
        epistemicStatus: "derived",
        payload: {
          memoryType: "pattern",
          data: {
            patternType: entry.patternType,
            description: entry.description,
            occurrenceCount: entry.occurrenceCount,
          },
        },
      };
    default:
      return null;
  }
}

function mapExpectationStatus(
  status: string
): "open" | "advancing" | "fulfilled" | "broken" {
  switch (status) {
    case "advanced":
    case "delayed":
    case "escalated":
      return "advancing";
    case "fulfilled":
      return "fulfilled";
    default:
      return "open";
  }
}

/** 从 sourceRef 提取最终正文 hash（格式 ch{N}#finalText:{hash}[:span]） */
function extractTextHashes(sourceRef: string, finalText: string): string[] {
  const hash = computeSha12(finalText);
  return sourceRef.includes(`#finalText:${hash}`) ? [hash] : [hash];
}

export type { MemoryRecord, MemoryType };
