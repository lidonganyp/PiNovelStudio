/**
 * NovelOS Candidate Workspace（OPT-9.4）
 *
 * 隔离的候选工作区，agent 在此产出生成产物。
 * 路径：workspaces/{id}/novelos-sessions/{sessionId}/
 *
 * 产出文件：
 * 1. evidence-plan.json   — 本轮 EvidencePlan
 * 2. tool-events.jsonl    — 工具调用事件流（每行一个 JSON）
 * 3. draft.md             — （历史遗留）旧 workspace 的正文镜像；不再生产写入，仅 readDraft 只读回退
 * 4. verifier-report.json — NarrativeVerifier 验证报告
 * 5. patch-proposals.json — 局部修复 patch 提案
 * 6. lineage.json         — 完整 lineage（sourceRefs / stopReason / budget）
 * 7. candidates/          — append-only 不可变候选存储（REASONING-REPAIR-BOUNDARY-1 RRB-2.1）
 * 8. current-candidate.json — 当前候选指针（原子替换，只保存 candidateId + textHash）
 *
 * 候选不可变（RRB-2.2）：每次正文变化产生一个不可变候选并推进 current pointer，
 * 旧候选正文与 manifest 永不覆盖（`flag:"wx"` 独占写）。覆盖式 draft.md 写路径已删除（RRB-6.6）。
 *
 * 权限边界：candidate_write 仅允许写入此目录（由 PermissionPolicy 校验）。
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  readFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import type { EvidencePlan } from "./evidence-plan.js";
import {
  hashText,
  buildCandidateId,
  createCandidateRevisionManifest,
} from "../../v2/core/candidate-revision-store.js";
import type {
  CandidateRevisionManifest,
  CandidateDerivationType,
} from "../../v2/core/repair-authorization-contracts.js";
import {
  computeLineDiff,
  hashDiff,
  serializeDiff,
} from "../../v2/core/diff-utils.js";

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
   * writeDraft 的内容仍保留在内存（memoryCandidates），供 readDraft 读取。
   */
  dryRun?: boolean;
}

/** createCandidate 的入参（RRB-2.1）。 */
export interface CreateCandidateInput {
  text: string;
  chapterId?: string;
  derivationType?: CandidateDerivationType;
  parentCandidateId?: string | null;
  sourceCandidateId?: string | null;
  authorizationId?: string | null;
  verifierReportId?: string | null;
  /** 父候选正文 hash（派生候选时设置） */
  parentTextHash?: string | null;
  /** diff artifact 引用路径（派生候选时设置） */
  diffArtifactRef?: string | null;
  /** diff hash（派生候选时设置） */
  diffHash?: string | null;
  createdAt?: string;
}

export class CandidateWorkspace {
  private readonly dir: string;
  private readonly sessionId: string;
  private readonly dryRun: boolean;
  /** dryRun 模式下不可变候选的内存存储（candidateId → { text, manifest }） */
  private readonly memoryCandidates = new Map<
    string,
    { text: string; manifest: CandidateRevisionManifest }
  >();
  /** dryRun 模式下当前候选指针 */
  private memoryCurrentCandidateId: string | null = null;
  /** 同 session 内单调递增候选序号（消歧相同正文） */
  private candidateCount = 0;

  constructor(options: CandidateWorkspaceOptions) {
    this.dir = join(options.workspaceRoot, "novelos-sessions", options.sessionId);
    this.sessionId = options.sessionId;
    this.dryRun = options.dryRun === true;
    if (!this.dryRun && !existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** 获取工作区目录路径 */
  getDir(): string {
    return this.dir;
  }

  /** 获取候选存储子目录路径（candidates/） */
  getCandidatesDir(): string {
    return join(this.dir, "candidates");
  }

  // ── 候选不可变存储（RRB-2.1 / RRB-2.2） ──────────────────────────────

  /**
   * 创建新的不可变候选：计算 hash、构造 candidateId + manifest，append-only 写入
   * `candidates/{candidateId}.md` 与 `candidates/{candidateId}.manifest.json`。
   * 已存在 candidateId 时 `flag:"wx"` 抛错，拒绝覆盖。
   */
  createCandidate(input: CreateCandidateInput): CandidateRevisionManifest {
    const textHash = hashText(input.text);
    const derivationType = input.derivationType ?? "agentic_generation";
    const sequence = this.candidateCount;
    this.candidateCount += 1;
    const candidateId = buildCandidateId({
      runId: this.sessionId,
      derivationType,
      textHash,
      sequence,
    });
    const textArtifactRef = `candidates/${candidateId}.md`;
    const manifest = createCandidateRevisionManifest({
      candidateId,
      chapterId: input.chapterId ?? "",
      parentCandidateId: input.parentCandidateId ?? this.getCurrentCandidateId(),
      sourceCandidateId: input.sourceCandidateId ?? null,
      derivationType,
      textArtifactRef,
      textHash,
      parentTextHash: input.parentTextHash ?? null,
      diffArtifactRef: input.diffArtifactRef ?? null,
      diffHash: input.diffHash ?? null,
      authorizationId: input.authorizationId ?? null,
      verifierReportId: input.verifierReportId ?? null,
      createdAt: input.createdAt,
    });

    if (this.dryRun) {
      this.memoryCandidates.set(candidateId, { text: input.text, manifest });
      return manifest;
    }

    mkdirSync(this.getCandidatesDir(), { recursive: true });
    writeFileSync(
      join(this.getCandidatesDir(), `${candidateId}.md`),
      input.text,
      { encoding: "utf-8", flag: "wx" },
    );
    writeFileSync(
      join(this.getCandidatesDir(), `${candidateId}.manifest.json`),
      JSON.stringify(manifest, null, 2),
      { encoding: "utf-8", flag: "wx" },
    );
    return manifest;
  }

  /**
   * 推进当前候选指针（原子替换 `current-candidate.json`，temp → rename）。
   * 只有已接受且已复验候选才应调用（计划 §4.2 不变量）。
   */
  advanceCurrentCandidate(manifest: CandidateRevisionManifest): void {
    if (this.dryRun) {
      this.memoryCurrentCandidateId = manifest.candidateId;
      return;
    }
    const target = join(this.dir, "current-candidate.json");
    const tmp = `${target}.tmp-${manifest.candidateId}`;
    const payload = {
      candidateId: manifest.candidateId,
      textHash: manifest.textHash,
      updatedAt: manifest.createdAt,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, target);
  }

  /** 读取当前候选 id（无则 null）。 */
  getCurrentCandidateId(): string | null {
    if (this.dryRun) return this.memoryCurrentCandidateId;
    const path = join(this.dir, "current-candidate.json");
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(
        readFileSyncSafe(path) ?? "null",
      ) as { candidateId?: string };
      return typeof raw.candidateId === "string" ? raw.candidateId : null;
    } catch {
      return null;
    }
  }

  /** 读取指定候选正文。 */
  readCandidateText(candidateId: string): string | null {
    if (this.dryRun) {
      return this.memoryCandidates.get(candidateId)?.text ?? null;
    }
    return readFileSyncSafe(join(this.getCandidatesDir(), `${candidateId}.md`));
  }

  /** 读取指定候选 manifest。 */
  readCandidateManifest(candidateId: string): CandidateRevisionManifest | null {
    if (this.dryRun) {
      return this.memoryCandidates.get(candidateId)?.manifest ?? null;
    }
    const raw = readFileSyncSafe(
      join(this.getCandidatesDir(), `${candidateId}.manifest.json`),
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CandidateRevisionManifest;
    } catch {
      return null;
    }
  }

  /**
   * 从父候选派生子候选（RRB-2.3 / RRB-2.4）。
   *
   * 计算 parent→child 文本差异，生成 diff artifact，创建不可变子候选
   * 并关联 parentCandidateId。原父候选正文与 manifest 永不变化。
   *
   * @param parentManifest 父候选 manifest（或 null 表示无父候选的新生成）
   * @param childText 子候选完整正文
   * @param derivationType 派生类型（span_patch / paragraph_patch / bridge_patch / new_candidate / author_style_transform）
   * @param authorizationId 授权 ID（如有）
   * @param verifierReportId 验证报告 ID（如有）
   */
  deriveChildCandidate(input: {
    parentManifest: CandidateRevisionManifest | null;
    childText: string;
    derivationType: CandidateDerivationType;
    chapterId?: string;
    authorizationId?: string | null;
    verifierReportId?: string | null;
  }): CandidateRevisionManifest {
    const {
      parentManifest,
      childText,
      derivationType,
      chapterId,
      authorizationId,
      verifierReportId,
    } = input;

    // 计算 diff（有父候选时）
    let diffArtifactRef: string | null = null;
    let diffHash: string | null = null;
    let parentTextHash: string | null = null;

    if (parentManifest !== null) {
      parentTextHash = parentManifest.textHash;
      const parentText = this.readCandidateText(parentManifest.candidateId);
      if (parentText !== null) {
        const diff = computeLineDiff(parentText, childText);
        diffHash = hashDiff(diff);
        const childCandidateId = buildCandidateId({
          runId: this.sessionId,
          derivationType,
          textHash: hashText(childText),
          sequence: this.candidateCount,
        });
        diffArtifactRef = `candidates/${childCandidateId}.diff.json`;

        // 保存 diff artifact
        if (!this.dryRun) {
          mkdirSync(this.getCandidatesDir(), { recursive: true });
          writeFileSync(
            join(this.getCandidatesDir(), `${childCandidateId}.diff.json`),
            serializeDiff(diff),
            { encoding: "utf-8", flag: "wx" },
          );
        }
      }
    }

    return this.createCandidate({
      text: childText,
      chapterId,
      derivationType,
      parentCandidateId: parentManifest?.candidateId ?? null,
      sourceCandidateId: parentManifest?.sourceCandidateId ?? parentManifest?.candidateId ?? null,
      authorizationId: authorizationId ?? null,
      verifierReportId: verifierReportId ?? null,
      parentTextHash,
      diffArtifactRef,
      diffHash,
    });
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

  /**
   * 3. 不可变候选（RRB-2.2）的测试/兼容入口。
   *
   * 生产 loop 不得在首次验证前调用本方法：它会推进 current。
   * 生产路径使用 createCandidate，仅在验证通过后 advanceCurrentCandidate。
   */
  writeDraft(text: string): void {
    const manifest = this.createCandidate({ text });
    this.advanceCurrentCandidate(manifest);
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

  /** 读取当前正文（优先 current candidate，只读回退旧 draft.md 镜像）。 */
  readDraft(): string | null {
    const currentId = this.getCurrentCandidateId();
    if (currentId !== null) {
      const text = this.readCandidateText(currentId);
      if (text !== null) return text;
    }
    // 只读兼容：旧 workspace 可能仍残留 draft.md 镜像（RRB-6.6 后不再生产写入）。
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
