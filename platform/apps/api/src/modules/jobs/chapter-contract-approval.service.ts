/**
 * 作者章纲契约审批：签发一次性 commit 凭证（EXPERT-HOST-APPROVAL-1）
 *
 * 为什么在 platform-api 而不是扩展工具面：
 * - 扩展的 6 个公开工具对 agent 可见；agent 若能签发审批凭证，就等于自己批准自己。
 * - 因此签发只发生在「作者已登录」的 platform-api commit 流程内部，再由 platform-api
 *   用内部 HMAC 调用 novel-runtime 的宿主审批路由（只有 platform-api 持有 INTERNAL_API_SECRET）。
 * - `approvedBy` 由服务端从 JWT 用户取（user.email），客户端无法自填。
 *
 * 流程（全部在服务端内部完成，没有公开审批 HTTP 端点）：
 * `ChapterContractService.commit` 先 preview 得到 proposalHash，再调用本服务签发
 * receipt，随后立即把 receipt 交给 runtime handoff commit。receipt 只在同一次
 * commit 调用的内存中传递，既不出现在 HTTP 响应，也不落库。
 */
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { signInternalRequest, stableStringify } from '../internal/hmac';
import type { AuthUserPayload } from '../auth/auth.types';

export interface ChapterContractApprovalInput {
  chapterNumber: number;
  proposalHash: string;
}

export interface ChapterContractApprovalResult {
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
  receiptId: string;
  approvedBy: string;
  expiresAt: string;
}

interface RuntimeApprovalResponse {
  code?: string;
  message?: string;
  workspaceId?: string;
  chapterNumber?: number;
  proposalHash?: string;
  receiptId?: string;
  approvedBy?: string;
  expiresAt?: string;
}

/** 运行时审批路由路径（签名必须覆盖完整路径，含 /internal 前缀）。 */
const APPROVAL_PATH = '/internal/chapter-contract/approvals';

@Injectable()
export class ChapterContractApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  async approve(
    user: AuthUserPayload,
    projectId: number,
    input: ChapterContractApprovalInput,
  ): Promise<ChapterContractApprovalResult> {
    // 越权一律 404，不泄露项目是否存在。
    await requireOwnedProject(this.prisma, user.sub, projectId);

    if (env.NOVEL_RUNTIME_MODE !== 'http') {
      throw new ServiceUnavailableException('当前运行时为 stub 模式，无法签发宿主审批凭证');
    }

    const body = stableStringify({
      userId: user.sub,
      projectId,
      chapterNumber: input.chapterNumber,
      proposalHash: input.proposalHash,
      approvedBy: user.email,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = signInternalRequest({
      secret: env.INTERNAL_API_SECRET,
      timestamp,
      nonce,
      method: 'POST',
      path: APPROVAL_PATH,
      body,
    });
    const headers = {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-nonce': nonce,
      'x-internal-signature': signature,
    };
    const url = `${env.NOVEL_RUNTIME_BASE_URL.replace(/\/$/, '')}${APPROVAL_PATH}`;

    let response;
    try {
      response = await request(url, {
        method: 'POST',
        headers,
        body,
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(
        `无法连接章节生成运行时签发审批凭证：${reason}`.slice(0, 500),
      );
    }

    const payload = (await response.body.json()) as RuntimeApprovalResponse;
    if (response.statusCode === 401) {
      throw new ServiceUnavailableException(
        '章节生成运行时拒绝了内部签名，请检查两侧 INTERNAL_API_SECRET 是否一致',
      );
    }
    if (response.statusCode === 400) {
      throw new BadRequestException(payload.message ?? '运行时拒绝了审批请求');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ServiceUnavailableException(
        `签发审批凭证失败（HTTP ${response.statusCode}）`,
      );
    }
    if (!payload.receiptId) {
      throw new ServiceUnavailableException('运行时未返回审批凭证');
    }

    return {
      workspaceId: payload.workspaceId ?? '',
      chapterNumber: payload.chapterNumber ?? input.chapterNumber,
      proposalHash: payload.proposalHash ?? input.proposalHash,
      receiptId: payload.receiptId,
      approvedBy: payload.approvedBy ?? user.email,
      expiresAt: payload.expiresAt ?? '',
    };
  }
}
