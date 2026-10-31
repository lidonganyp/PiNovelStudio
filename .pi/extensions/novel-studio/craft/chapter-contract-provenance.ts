/**
 * 章节契约 provenance 对账（CRASH-RECOVERY-1）
 *
 * 专家 handoff commit 的事务顺序是：
 *   pending provenance → series/ch{N}-outline-explicit.md → committed provenance
 *
 * 进程若在“章纲已写入、committed 尚未落盘”处崩溃，异常回滚不会执行。本模块让
 * **消费方**在读取显式章纲时做一次对账：
 *   - 无 provenance：作者手写章纲（历史合法路径），保持可消费；
 *   - pending + 章纲 hash == proposalHash：崩溃点恰在提交前，原子修复为 committed；
 *   - pending/committed + hash 不一致：文件与已批准提案不一致，记 failed 并拒绝消费；
 *   - failed / 非法 provenance：拒绝消费。
 *
 * 对账只在状态可判定时写盘（pending→committed 或 →failed），使用临时文件 + rename，
 * 不做任何内容改写。生产者（handlers/expert-handoff-handler.ts）与消费者
 * （craft/chapter-seed-builder.ts、craft/workspace-preflight-checker.ts）共用本模块。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** provenance schema 版本（与专家 handoff 写入侧一致）。 */
export const CHAPTER_CONTRACT_PROVENANCE_SCHEMA_VERSION = 1;

/** 事务提交状态。 */
export type ChapterContractCommitStatus = "pending" | "committed" | "failed";

/** provenance 记录（允许扩展字段，读取时只校验关键字段）。 */
export interface ChapterContractProvenanceRecord {
  schemaVersion?: number;
  workspaceId?: string;
  chapterNumber?: number;
  targetPath?: string;
  proposalHash?: string;
  commitStatus?: ChapterContractCommitStatus | string;
  failure?: { message?: string; outlineRolledBack?: boolean; at?: string };
  [key: string]: unknown;
}

/** 消费判定状态。 */
export type ChapterContractProvenanceState =
  | "unmanaged"
  | "committed"
  | "recovered"
  | "pending"
  | "failed"
  | "mismatch"
  | "invalid";

/** 消费判定结果。 */
export interface ChapterContractConsumption {
  /** 是否允许作为写前输入被消费。 */
  consumable: boolean;
  state: ChapterContractProvenanceState;
  reason?: string;
  provenancePath: string;
}

/** 显式章纲对应的 provenance 路径。 */
export function chapterContractProvenancePath(outlinePath: string): string {
  return `${outlinePath}.provenance.json`;
}

/** 与 handoff 写入侧一致的章纲文本 hash。 */
export function sha256ChapterContractText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isCommitStatus(value: unknown): value is ChapterContractCommitStatus {
  return value === "pending" || value === "committed" || value === "failed";
}

/** 临时文件 + rename，避免对账写盘产生半截 JSON。 */
function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tempPath, filePath);
}

function emptyConsumption(
  state: ChapterContractProvenanceState,
  provenancePath: string,
  reason?: string,
): ChapterContractConsumption {
  return { consumable: false, state, provenancePath, ...(reason ? { reason } : {}) };
}

/**
 * 读取并（在可判定时）对账显式章纲的 provenance。
 *
 * @param outlinePath 显式章纲绝对路径
 * @param outlineText 已读取的章纲全文（调用方负责读取，避免重复 I/O）
 */
export function resolveChapterContractConsumption(
  outlinePath: string,
  outlineText: string,
): ChapterContractConsumption {
  const provenancePath = chapterContractProvenancePath(outlinePath);
  if (!existsSync(provenancePath)) {
    // 作者手写的显式章纲没有 provenance，属于既有合法流程，不得误杀。
    return { consumable: true, state: "unmanaged", provenancePath };
  }

  let record: ChapterContractProvenanceRecord;
  try {
    record = JSON.parse(readFileSync(provenancePath, "utf8")) as ChapterContractProvenanceRecord;
  } catch (error: unknown) {
    return emptyConsumption(
      "invalid",
      provenancePath,
      `provenance 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== CHAPTER_CONTRACT_PROVENANCE_SCHEMA_VERSION ||
    !isCommitStatus(record.commitStatus) ||
    !isSha256Hex(record.proposalHash)
  ) {
    return emptyConsumption(
      "invalid",
      provenancePath,
      "provenance 缺少 schemaVersion/commitStatus/proposalHash 或字段非法",
    );
  }

  const actualHash = sha256ChapterContractText(outlineText);

  if (record.proposalHash !== actualHash) {
    if (record.commitStatus === "failed") {
      return emptyConsumption("failed", provenancePath, "提案提交失败且章纲内容与批准提案不一致");
    }
    // 章纲与已批准提案不一致：拒绝消费，并把状态降级为 failed，避免下次再被误判为可恢复。
    const failedRecord: ChapterContractProvenanceRecord = {
      ...record,
      commitStatus: "failed",
      failure: {
        message: record.commitStatus === "pending"
          ? "outline_provenance_hash_mismatch"
          : "outline_changed_after_commit",
        outlineRolledBack: false,
        at: new Date().toISOString(),
      },
    };
    try {
      atomicWriteJson(provenancePath, failedRecord);
    } catch {
      // 对账写盘失败时保持原状态；仍拒绝消费（fail-closed）。
    }
    return emptyConsumption(
      "mismatch",
      provenancePath,
      "章纲内容与已批准提案 hash 不一致（可能被事务外修改）",
    );
  }

  switch (record.commitStatus) {
    case "committed":
      return { consumable: true, state: "committed", provenancePath };
    case "pending": {
      // 崩溃点：章纲写入完成，committed 尚未落盘。内容与批准提案一致 → 对账修复。
      const reconciled: ChapterContractProvenanceRecord = {
        ...record,
        commitStatus: "committed",
        reconciledAt: new Date().toISOString(),
        reconciledBy: "chapter-contract-provenance",
      };
      try {
        atomicWriteJson(provenancePath, reconciled);
      } catch (error: unknown) {
        return emptyConsumption(
          "pending",
          provenancePath,
          `pending 对账写盘失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { consumable: true, state: "recovered", provenancePath };
    }
    case "failed":
      return emptyConsumption("failed", provenancePath, "提案提交失败，需人工核对或重新 handoff");
  }
}
