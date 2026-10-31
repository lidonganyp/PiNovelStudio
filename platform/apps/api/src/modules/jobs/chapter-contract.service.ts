/**
 * 作者章纲契约 handoff（EXPERT-HOST-HANDOFF-1 / 作者侧审批闭环）
 *
 * 目的：把 web 端作者编辑/粘贴的契约提案，变成「已批准并持久化」的章纲契约。
 *
 * 全链路（全部在服务端完成，客户端拿不到内部签名，也不能自报 approvedBy）：
 *   1. preview：platform-api 用 HMAC 调 runtime `/internal/chapter-contract/handoff`
 *      （mode=preview），拿到规范化 outlineMarkdown 与 proposalHash；不落任何持久状态。
 *   2. approve：用同一 proposalHash 调本模块已存在的
 *      `ChapterContractApprovalService.approve`，由 runtime 宿主审批层签发一次性 receipt。
 *   3. commit：把 receipt 交回同一 handoff 路由（mode=commit、confirm=true），
 *      由 runtime 在临时 workspace 原子写章纲 + provenance，并回读校验 hash。
 *   4. persist：把 commit 回读的 outlineMarkdown / provenance 以事务写入
 *      `chapter_contract:ch{N}` 与 `chapter_contract_provenance:ch{N}` 文档，
 *      生成链路（jobs.service.buildRuntimeWorkspaceInput）按章节物化这两份文档。
 *
 * 边界：
 * - `knownFactIds` / `knownPromiseIds` 只从作者已确认材料派生，不接受客户端自报。
 * - runtime 的 receipt 是进程内存、单次消费；commit 失败时 runtime 会把它放回，
 *   DB 写入失败则需重新审批（不会留下半提交的持久状态）。
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { request } from 'undici';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';
import { signInternalRequest, stableStringify } from '../internal/hmac';
import type { AuthUserPayload } from '../auth/auth.types';
import { ChapterContractApprovalService } from './chapter-contract-approval.service';
import {
  chapterContractDocumentType,
  chapterContractProvenanceDocumentType,
  deriveKnownContractIds,
} from './chapter-contract-materials';
import { resolveProjectGenre } from './runtime-workspace-defaults';

export interface ChapterContractPreviewInput {
  chapterNumber: number;
  proposalText: string;
  expertRole?: string;
}

export interface ChapterContractCommitInput extends ChapterContractPreviewInput {
  overwrite?: boolean;
}

export interface ChapterContractPreviewResult {
  status: 'ok';
  workspaceId: string;
  chapterNumber: number;
  proposalHash: string;
  outlineMarkdown: string;
  validation: unknown;
}

export interface ChapterContractCommitResult extends ChapterContractPreviewResult {
  contractDocumentId: number;
  provenanceDocumentId: number;
  provenance: unknown;
}

/** runtime handoff 路由路径：签名必须覆盖完整路径（含 /internal 前缀）。 */
const HANDOFF_PATH = '/internal/chapter-contract/handoff';

interface RuntimeHandoffResponse {
  code?: string;
  message?: string;
  workspaceId?: string;
  chapterNumber?: number;
  proposalHash?: string;
  outlineMarkdown?: string;
  targetPath?: string;
  provenancePath?: string;
  validation?: unknown;
  provenance?: unknown;
  requestId?: string;
}

interface ProjectMaterials {
  project: { id: number; genre: string | null; subGenres: unknown; worldKeyTerms: unknown };
  documents: Array<{ documentType: string; content: string }>;
  knownFactIds: string[];
  knownPromiseIds: string[];
}

@Injectable()
export class ChapterContractService {
  private readonly logger = new Logger(ChapterContractService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ChapterContractApprovalService,
  ) {}

  /** 预览：只校验并返回规范化章纲与 proposalHash，不写盘、不签发凭证。 */
  async preview(
    user: AuthUserPayload,
    projectId: number,
    input: ChapterContractPreviewInput,
  ): Promise<ChapterContractPreviewResult> {
    await requireOwnedProject(this.prisma, user.sub, projectId);
    const materials = await this.loadMaterials(user.sub, projectId);
    const response = await this.invokeHandoff(this.buildBody({
      mode: 'preview',
      user,
      projectId,
      input,
      materials,
    }));
    return this.toPreviewResult(response, input.chapterNumber);
  }

  /**
   * 提交：preview → 宿主审批签发 receipt → handoff commit → 事务落库。
   *
   * 客户端不提交 proposalHash：hash 必须由 runtime 从规范化章纲计算，
   * 审批凭证才会与本轮真实落盘内容绑定。
   */
  async commit(
    user: AuthUserPayload,
    projectId: number,
    input: ChapterContractCommitInput,
  ): Promise<ChapterContractCommitResult> {
    await requireOwnedProject(this.prisma, user.sub, projectId);
    const materials = await this.loadMaterials(user.sub, projectId);

    const previewResponse = await this.invokeHandoff(this.buildBody({
      mode: 'preview',
      user,
      projectId,
      input,
      materials,
    }));
    const preview = this.toPreviewResult(previewResponse, input.chapterNumber);

    const approval = await this.approvals.approve(user, projectId, {
      chapterNumber: input.chapterNumber,
      proposalHash: preview.proposalHash,
    });

    const commitResponse = await this.invokeHandoff(this.buildBody({
      mode: 'commit',
      user,
      projectId,
      input,
      materials,
      confirmedBy: user.email,
      approvalReceipt: approval.receiptId,
      confirm: true,
      overwrite: input.overwrite,
    }));
    const committed = this.toPreviewResult(commitResponse, input.chapterNumber);

    // 回读值与审批绑定的 hash 必须一致：防止 runtime 落盘内容与签发凭证漂移。
    const persistedHash = createHash('sha256').update(committed.outlineMarkdown, 'utf8').digest('hex');
    if (persistedHash !== approval.proposalHash) {
      throw new ServiceUnavailableException(
        '章纲契约落盘内容与审批凭证绑定的 proposalHash 不一致，已阻止落库',
      );
    }
    const rawProvenance = commitResponse.provenance;
    if (!rawProvenance || typeof rawProvenance !== 'object' || Array.isArray(rawProvenance)) {
      throw new ServiceUnavailableException('运行时未返回章纲 provenance，已阻止落库');
    }
    // receipt 只在本次 commit 的内存中流转：既不能出现在 HTTP 响应，也不能随
    // provenance 落库，否则作者可凭文档里的 receipt 复用一次性凭证。
    const provenance = stripApprovalReceipt(rawProvenance as Record<string, unknown>);

    let documents: { contractDocumentId: number; provenanceDocumentId: number };
    try {
      documents = await this.persistApprovedContract({
        userId: user.sub,
        projectId,
        chapterNumber: input.chapterNumber,
        proposalHash: approval.proposalHash,
        outlineMarkdown: committed.outlineMarkdown,
        provenance,
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          statusCode: 409,
          message: '同一章章纲契约正在被并发提交，请重新预览后再提交',
          reason: 'concurrent_contract_commit',
        });
      }
      throw error;
    }

    this.logger.log(
      `作者批准第${input.chapterNumber}章章纲契约（approvedBy=${approval.approvedBy}, hash=${approval.proposalHash.slice(0, 12)}）`,
    );

    return {
      ...committed,
      contractDocumentId: documents.contractDocumentId,
      provenanceDocumentId: documents.provenanceDocumentId,
      provenance,
    };
  }

  /** 读取作者已确认材料；只用于派生可引用 ID，不读取提案文本。 */
  private async loadMaterials(userId: number, projectId: number): Promise<ProjectMaterials> {
    const [project, characters, documents] = await Promise.all([
      this.prisma.novelProject.findFirst({
        where: { id: projectId, userId, deletedAt: null },
        select: { id: true, genre: true, subGenres: true, worldKeyTerms: true },
      }),
      this.prisma.novelCharacter.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.novelDocument.findMany({
        where: { projectId, userId, deletedAt: null },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        select: { documentType: true, content: true },
      }),
    ]);
    if (!project) throw new NotFoundException('项目不存在');

    const characterText = characters
      .map((character) => Object.entries(character)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('\n'))
      .filter((text) => text.length > 0)
      .join('\n\n');
    const materials = [
      ...documents,
      ...(characterText ? [{ documentType: 'character_profile', content: characterText }] : []),
    ];
    const { knownFactIds, knownPromiseIds } = deriveKnownContractIds(materials);
    return { project, documents, knownFactIds, knownPromiseIds };
  }

  private buildBody(params: {
    mode: 'preview' | 'commit';
    user: AuthUserPayload;
    projectId: number;
    input: ChapterContractCommitInput;
    materials: ProjectMaterials;
    confirmedBy?: string;
    approvalReceipt?: string;
    confirm?: boolean;
    overwrite?: boolean;
  }): Record<string, unknown> {
    return {
      userId: params.user.sub,
      projectId: params.projectId,
      chapterNumber: params.input.chapterNumber,
      mode: params.mode,
      proposalText: params.input.proposalText,
      expertRole: params.input.expertRole,
      knownFactIds: params.materials.knownFactIds,
      knownPromiseIds: params.materials.knownPromiseIds,
      projectConfig: {
        genre: resolveProjectGenre(params.materials.project.genre),
        subGenres: readStringArray(params.materials.project.subGenres),
        worldKeyTerms: readStringArray(params.materials.project.worldKeyTerms),
      },
      // handoff 只校验提案并写章纲/provenance，不需要物化其他材料进临时 workspace。
      documents: [],
      confirmedBy: params.confirmedBy,
      approvalReceipt: params.approvalReceipt,
      confirm: params.confirm,
      overwrite: params.overwrite,
    };
  }

  /** HMAC 调用 runtime 内部 handoff 路由，并把运行时错误映射成 HTTP 语义。 */
  private async invokeHandoff(body: Record<string, unknown>): Promise<RuntimeHandoffResponse> {
    if (env.NOVEL_RUNTIME_MODE !== 'http') {
      throw new ServiceUnavailableException('当前运行时为 stub 模式，无法处理作者章纲契约');
    }

    const bodyText = stableStringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const signature = signInternalRequest({
      secret: env.INTERNAL_API_SECRET,
      timestamp,
      nonce,
      method: 'POST',
      path: HANDOFF_PATH,
      body: bodyText,
    });
    const headers = {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-nonce': nonce,
      'x-internal-signature': signature,
    };
    const url = `${env.NOVEL_RUNTIME_BASE_URL.replace(/\/$/, '')}${HANDOFF_PATH}`;

    let response;
    try {
      response = await request(url, {
        method: 'POST',
        headers,
        body: bodyText,
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`handoff 请求失败：${reason}`);
      throw new ServiceUnavailableException(
        `无法连接章节生成运行时处理章纲契约：${reason}`.slice(0, 500),
      );
    }

    const payload = (await response.body.json()) as RuntimeHandoffResponse;
    if (response.statusCode === 401) {
      throw new ServiceUnavailableException(
        '章节生成运行时拒绝了内部签名，请检查两侧 INTERNAL_API_SECRET 是否一致',
      );
    }
    if (response.statusCode === 400) {
      throw new BadRequestException({
        code: payload.code ?? 'HANDOFF_BLOCKED',
        message: payload.message ?? '运行时拒绝了章纲契约',
        validation: payload.validation,
      });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ServiceUnavailableException(
        `处理章纲契约失败（HTTP ${response.statusCode}）：${payload.message ?? '未知错误'}`,
      );
    }
    return payload;
  }

  private toPreviewResult(
    payload: RuntimeHandoffResponse,
    chapterNumber: number,
  ): ChapterContractPreviewResult {
    if (!payload.proposalHash || !payload.outlineMarkdown) {
      throw new ServiceUnavailableException('运行时未返回章纲文本或 proposalHash');
    }
    return {
      status: 'ok',
      workspaceId: payload.workspaceId ?? '',
      chapterNumber: payload.chapterNumber ?? chapterNumber,
      proposalHash: payload.proposalHash,
      outlineMarkdown: payload.outlineMarkdown,
      validation: payload.validation,
    };
  }

  /**
   * 事务写入契约与 provenance 两个文档；任一失败即整体回滚。
   *
   * 并发语义：同一章的两次 commit 由项目 + 文档类型粒度的 Postgres 事务级
   * advisory lock 串行化，`novel_documents` 上的部分唯一索引作为兜底；
   * 重复提交同一 proposalHash 复用同一文档并追加版本（幂等），并发冲突返回 409。
   */
  private async persistApprovedContract(params: {
    userId: number;
    projectId: number;
    chapterNumber: number;
    proposalHash: string;
    outlineMarkdown: string;
    provenance: unknown;
  }): Promise<{ contractDocumentId: number; provenanceDocumentId: number }> {
    const hashLabel = params.proposalHash.slice(0, 12);
    return this.prisma.$transaction(async (tx) => {
      const transaction = tx as unknown as Prisma.TransactionClient;
      const contract = await upsertDocumentWithVersion(transaction, {
        projectId: params.projectId,
        userId: params.userId,
        documentType: chapterContractDocumentType(params.chapterNumber),
        title: `第${params.chapterNumber}章章纲契约（作者已批准）`,
        content: params.outlineMarkdown,
        changeSummary: `作者批准章纲契约（proposalHash ${hashLabel}）`,
      });
      const provenance = await upsertDocumentWithVersion(transaction, {
        projectId: params.projectId,
        userId: params.userId,
        documentType: chapterContractProvenanceDocumentType(params.chapterNumber),
        title: `第${params.chapterNumber}章章纲契约审批记录`,
        content: JSON.stringify(params.provenance, null, 2),
        changeSummary: `章纲契约 provenance（proposalHash ${hashLabel}）`,
      });
      return { contractDocumentId: contract.id, provenanceDocumentId: provenance.id };
    });
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 一次性审批凭证只在服务端内存流转，禁止随 provenance 持久化或返回给客户端。 */
function stripApprovalReceipt(provenance: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...provenance };
  delete sanitized.approvalReceiptId;
  return sanitized;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'P2002';
}

/** 章纲契约落库的唯一写入点；导出供并发/幂等回归测试直接验证锁与版本语义。 */
export async function upsertDocumentWithVersion(
  tx: Prisma.TransactionClient,
  input: {
    projectId: number;
    userId: number;
    documentType: string;
    title: string;
    content: string;
    changeSummary: string;
  },
): Promise<{ id: number }> {
  // 两个并发事务会同时 findFirst 得到“不存在”并各自 create（同一章节多份契约、
  // 相同版本号）。事务级 advisory lock 按「项目 + 文档类型」串行化，锁在事务结束时释放。
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`author-contract:${input.projectId}:${input.documentType}`}, 0::bigint))`;
  const existing = await tx.novelDocument.findFirst({
    where: {
      projectId: input.projectId,
      userId: input.userId,
      documentType: input.documentType,
      deletedAt: null,
    },
    select: { id: true, currentVersion: true },
  });
  if (!existing) {
    const created = await tx.novelDocument.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        documentType: input.documentType,
        title: input.title,
        content: input.content,
        currentVersion: 1,
      },
      select: { id: true },
    });
    await tx.novelDocumentVersion.create({
      data: {
        documentId: created.id,
        createdBy: input.userId,
        versionNumber: 1,
        content: input.content,
        changeSummary: input.changeSummary,
      },
    });
    return created;
  }

  const nextVersion = existing.currentVersion + 1;
  await tx.novelDocument.update({
    where: { id: existing.id },
    data: { title: input.title, content: input.content, currentVersion: nextVersion },
  });
  await tx.novelDocumentVersion.create({
    data: {
      documentId: existing.id,
      createdBy: input.userId,
      versionNumber: nextVersion,
      content: input.content,
      changeSummary: input.changeSummary,
    },
  });
  return { id: existing.id };
}
