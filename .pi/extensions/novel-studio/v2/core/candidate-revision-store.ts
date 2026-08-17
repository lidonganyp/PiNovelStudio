/**
 * Candidate Revision Store（REASONING-REPAIR-BOUNDARY-1 Wave 1B / RRB-2.1）
 *
 * 候选修订的纯函数工具：正文 hash、candidateId 构造、manifest 创建与 schema 校验。
 * 本模块只做确定性计算，**不含 I/O**（append-only 落盘在 candidate-workspace.ts 完成）。
 *
 * 不变量（计划 §4.2）：
 * - candidateId 必须包含运行身份与内容 hash，不得用每章固定 ID 表示多轮不同正文；
 * - 每次初稿 / patch / 新候选 / 作者风格转换都必须生成独立 manifest；
 * - 已存在 candidateId 不得覆盖（落盘侧用 `flag:"wx"` 独占写强制保证）。
 *
 * candidateId 格式：`${runId}-${derivationType}-${textHash.slice(0,16)}-${sequence}`
 * - 使用 `-` 分隔（`:` 是 Windows 文件名保留字符，候选正文以 candidateId 作文件名）；
 * - sequence 为同 run 内单调递增序号，用于消歧同 run 内相同正文的多次产出。
 */

import { createHash } from "node:crypto";
import type {
  CandidateRevisionManifest,
  CandidateDerivationType,
} from "./repair-authorization-contracts.js";

// ============================================================================
// 正文 hash（与 evidence-governance-contracts 的 hash 约定一致：sha256 完整 hex）
// ============================================================================

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ============================================================================
// candidateId
// ============================================================================

export interface BuildCandidateIdInput {
  /** 运行身份（sessionId / orchestratorRunId）。 */
  runId: string;
  derivationType: CandidateDerivationType;
  textHash: string;
  /** 同 run 内单调递增序号，消歧相同正文。 */
  sequence: number;
}

export function buildCandidateId(input: BuildCandidateIdInput): string {
  return `${input.runId}-${input.derivationType}-${input.textHash.slice(0, 16)}-${input.sequence}`;
}

// ============================================================================
// manifest 创建
// ============================================================================

export interface CreateCandidateRevisionManifestInput {
  candidateId: string;
  chapterId: string;
  parentCandidateId: string | null;
  sourceCandidateId: string | null;
  derivationType: CandidateDerivationType;
  /** 正文 artifact 引用（相对 session dir，如 `candidates/{candidateId}.md`）。 */
  textArtifactRef: string;
  textHash: string;
  parentTextHash?: string | null;
  diffArtifactRef?: string | null;
  diffHash?: string | null;
  authorizationId?: string | null;
  verifierReportId?: string | null;
  /** 缺省取当前时间（测试可注入确定值）。 */
  createdAt?: string;
}

export function createCandidateRevisionManifest(
  input: CreateCandidateRevisionManifestInput,
): CandidateRevisionManifest {
  return {
    candidateId: input.candidateId,
    chapterId: input.chapterId,
    parentCandidateId: input.parentCandidateId,
    sourceCandidateId: input.sourceCandidateId,
    derivationType: input.derivationType,
    textArtifactRef: input.textArtifactRef,
    textHash: input.textHash,
    parentTextHash: input.parentTextHash ?? null,
    diffArtifactRef: input.diffArtifactRef ?? null,
    diffHash: input.diffHash ?? null,
    authorizationId: input.authorizationId ?? null,
    verifierReportId: input.verifierReportId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

// ============================================================================
// schema 校验（fail-closed：任一不变量不满足即拒绝）
// ============================================================================

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

const CANDIDATE_ID_TEXT_HASH_PREFIX_LEN = 16;

export function validateCandidateRevisionManifest(
  manifest: CandidateRevisionManifest,
): ManifestValidationResult {
  const errors: string[] = [];

  if (typeof manifest.candidateId !== "string" || manifest.candidateId.length === 0) {
    errors.push("candidateId 必须为非空字符串");
  }
  if (typeof manifest.chapterId !== "string") {
    errors.push("chapterId 必须为字符串");
  }
  if (manifest.parentCandidateId !== null && typeof manifest.parentCandidateId !== "string") {
    errors.push("parentCandidateId 必须为 string | null");
  }
  if (manifest.sourceCandidateId !== null && typeof manifest.sourceCandidateId !== "string") {
    errors.push("sourceCandidateId 必须为 string | null");
  }
  if (typeof manifest.derivationType !== "string" || manifest.derivationType.length === 0) {
    errors.push("derivationType 必须为非空字符串");
  }
  if (typeof manifest.textArtifactRef !== "string" || manifest.textArtifactRef.length === 0) {
    errors.push("textArtifactRef 必须为非空字符串");
  }
  if (typeof manifest.textHash !== "string" || manifest.textHash.length === 0) {
    errors.push("textHash 必须为非空字符串");
  }
  if (typeof manifest.createdAt !== "string" || manifest.createdAt.length === 0) {
    errors.push("createdAt 必须为非空字符串");
  }

  // candidateId 必须绑定内容 hash（运行身份 + 内容 hash 的核心不变量）。
  if (
    typeof manifest.candidateId === "string" &&
    typeof manifest.textHash === "string" &&
    manifest.textHash.length > 0 &&
    !manifest.candidateId.includes(manifest.textHash.slice(0, CANDIDATE_ID_TEXT_HASH_PREFIX_LEN))
  ) {
    errors.push("candidateId 必须包含内容 hash 片段（textHash 前缀）");
  }

  return { ok: errors.length === 0, errors };
}

// ============================================================================
// candidate text hash 绑定校验（REASONING-REPAIR-BOUNDARY-1 Wave 4B / RRB-5.1）
// ============================================================================

export interface CandidateTextHashCheckResult {
  ok: boolean;
  /** 校验失败原因（ok=false 时填充，供编排器单一可解释阻断）。 */
  reason?: string;
}

/**
 * 校验候选正文与 candidateId 的内容 hash 绑定（fail-closed）。
 *
 * RRB-5.1：`runUnifiedPipeline` 只接受"已清零且 lineage/hash 完整"的 Agentic
 * current candidate。本函数是"hash 完整"的最小确定性校验：candidateId 必须
 * 内嵌 hashText(text) 的前缀（与 buildCandidateId 口径一致），且正文非空。
 *
 * 与 validateCandidateRevisionManifest 的分工：后者校验落盘 manifest 的完整
 * schema；本函数只校验内存候选的 id↔text 绑定，供编排器在推进候选前快速拒绝。
 */
export function checkCandidateTextHashBinding(candidate: {
  id: string;
  text: string;
}): CandidateTextHashCheckResult {
  if (typeof candidate?.id !== "string" || candidate.id.length === 0) {
    return { ok: false, reason: "candidate_id_missing" };
  }
  if (typeof candidate?.text !== "string" || candidate.text.length === 0) {
    return { ok: false, reason: "candidate_text_empty" };
  }
  const textHashPrefix = hashText(candidate.text).slice(0, CANDIDATE_ID_TEXT_HASH_PREFIX_LEN);
  if (!candidate.id.includes(textHashPrefix)) {
    return { ok: false, reason: "candidate_text_hash_mismatch" };
  }
  return { ok: true };
}
