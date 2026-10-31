/**
 * 作者章纲契约 API（EXPERT-HOST-HANDOFF-1）。
 *
 * 对齐 platform-api `ChapterContractController`：
 *   POST /projects/:id/chapter-contract/preview —— 只校验并返回规范化章纲与 hash
 *   POST /projects/:id/chapter-contract/commit  —— 服务端签发审批凭证、handoff commit 并落库
 *
 * 客户端不提交 proposalHash，也不能自报 approvedBy：两者都由服务端派生。
 * 一次性审批凭证只在服务端内部流转，响应里不会出现 receiptId / expiresAt。
 */
import { http } from './http';

export interface ChapterContractValidationIssue {
  code?: string;
  message?: string;
  field?: string;
}

export interface ChapterContractValidation {
  ok?: boolean;
  errors?: ChapterContractValidationIssue[];
  warnings?: ChapterContractValidationIssue[];
  scoreAdvisory?: number | null;
}

export interface ChapterContractPreviewResult {
  status: 'ok';
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
  outlineMarkdown: string;
  validation?: ChapterContractValidation;
}

export interface ChapterContractCommitResult extends ChapterContractPreviewResult {
  contractDocumentId: number;
  provenanceDocumentId: number;
  provenance: unknown;
}

export interface ChapterContractProposalInput {
  chapterNumber: number;
  proposalText: string;
  expertRole?: string;
}

export function previewChapterContract(
  projectId: number,
  input: ChapterContractProposalInput,
): Promise<ChapterContractPreviewResult> {
  return http
    .post(`/projects/${projectId}/chapter-contract/preview`, input)
    .then((r) => r.data);
}

export function commitChapterContract(
  projectId: number,
  input: ChapterContractProposalInput & { overwrite?: boolean },
): Promise<ChapterContractCommitResult> {
  return http
    .post(`/projects/${projectId}/chapter-contract/commit`, input)
    .then((r) => r.data);
}
