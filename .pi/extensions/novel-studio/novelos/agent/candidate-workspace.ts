/**
 * NovelOS Candidate Workspace（OPT-9.4）
 *
 * 隔离的候选工作区，agent 在此产出生成产物。
 * 路径：workspaces/{id}/novelos-sessions/{sessionId}/
 *
 * 产出 6 个文件：
 * 1. evidence-plan.json   — 本轮 EvidencePlan
 * 2. tool-events.jsonl    — 工具调用事件流（每行一个 JSON）
 * 3. draft.md             — agent 产出的正文草稿
 * 4. verifier-report.json — NarrativeVerifier 验证报告
 * 5. patch-proposals.json — 局部修复 patch 提案
 * 6. lineage.json         — 完整 lineage（sourceRefs / stopReason / budget）
 *
 * 权限边界：candidate_write 仅允许写入此目录（由 PermissionPolicy 校验）。
 */

import { mkdirSync, writeFileSync, existsSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import type { EvidencePlan } from "./evidence-plan.js";

// ============================================================================
// CandidateWorkspace
// ============================================================================

export interface CandidateWorkspaceOptions {
  /** workspace 根目录（workspaces/{id}/） */
  workspaceRoot: string;
  /** session ID */
  sessionId: string;
  /**
   * P0-1 修复：dryRun=true 时不创建目录、不写盘（预览模式用）。
   * writeDraft 的内容仍保留在内存（memoryStore），供 readDraft 读取。
   */
  dryRun?: boolean;
}

export class CandidateWorkspace {
  private readonly dir: string;
  private readonly dryRun: boolean;
  /** dryRun 模式下 draft 的内存镜像（供 readDraft 读取） */
  private readonly memoryStore = new Map<string, string>();

  constructor(options: CandidateWorkspaceOptions) {
    this.dir = join(options.workspaceRoot, "novelos-sessions", options.sessionId);
    this.dryRun = options.dryRun === true;
    if (!this.dryRun && !existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** 获取工作区目录路径 */
  getDir(): string {
    return this.dir;
  }

  // ── 6 文件写入 ────────────────────────────────────────────────────────

  /** 1. evidence-plan.json */
  writeEvidencePlan(plan: EvidencePlan): void {
    if (this.dryRun) return;
    writeFileSync(
      join(this.dir, "evidence-plan.json"),
      JSON.stringify(plan, null, 2),
      "utf-8",
    );
  }

  /** 2. tool-events.jsonl（追加写入，每行一个 JSON） */
  recordToolEvent(event: unknown): void {
    if (this.dryRun) return;
    appendFileSync(
      join(this.dir, "tool-events.jsonl"),
      JSON.stringify(event) + "\n",
      "utf-8",
    );
  }

  /** 3. draft.md */
  writeDraft(text: string): void {
    if (this.dryRun) {
      this.memoryStore.set("draft.md", text);
      return;
    }
    writeFileSync(join(this.dir, "draft.md"), text, "utf-8");
  }

  /** 4. verifier-report.json */
  saveVerifierReport(report: unknown): void {
    if (this.dryRun) return;
    writeFileSync(
      join(this.dir, "verifier-report.json"),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
  }

  /** 5. patch-proposals.json */
  savePatchProposals(proposals: unknown[]): void {
    if (this.dryRun) return;
    writeFileSync(
      join(this.dir, "patch-proposals.json"),
      JSON.stringify(proposals, null, 2),
      "utf-8",
    );
  }

  /** 追加单个 patch proposal（不覆盖已有） */
  appendPatchProposal(proposal: unknown): void {
    if (this.dryRun) return;
    const path = join(this.dir, "patch-proposals.json");
    let existing: unknown[] = [];
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSyncSafe(path) || "[]");
      } catch {
        existing = [];
      }
    }
    existing.push(proposal);
    writeFileSync(path, JSON.stringify(existing, null, 2), "utf-8");
  }

  /** 6. lineage.json */
  saveLineage(lineage: unknown): void {
    if (this.dryRun) return;
    writeFileSync(
      join(this.dir, "lineage.json"),
      JSON.stringify(lineage, null, 2),
      "utf-8",
    );
  }

  /** 读取 draft.md（供 verifier 读取） */
  readDraft(): string | null {
    if (this.dryRun) {
      return this.memoryStore.get("draft.md") ?? null;
    }
    const path = join(this.dir, "draft.md");
    if (!existsSync(path)) return null;
    return readFileSyncSafe(path);
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createCandidateWorkspace(
  options: CandidateWorkspaceOptions,
): CandidateWorkspace {
  return new CandidateWorkspace(options);
}

// ============================================================================
// 内部工具
// ============================================================================

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
