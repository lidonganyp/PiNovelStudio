/**
 * PiVideoStudio 视频工场聚合服务（B6 融合）。
 * 章节页点击『生成视频』：聚合章节正文 + 大纲 + 人物卡 + 章节种子，
 * 推送给 PiVideoStudio API 创建视频项目，返回跳转 URL。
 *
 * 环境变量：
 *   PIVIDEO_API_URL — PiVideoStudio API 地址（容器内默认经 docker0 网关访问宿主机）
 *   PIVIDEO_WEB_URL — PiVideoStudio Web 前端地址（用于生成跳转链接）
 */
import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireOwnedProject } from '../../common/ownership';

@Injectable()
export class PivideoService {
  constructor(private readonly prisma: PrismaService) {}

  /** 章节发起视频生成：聚合上下文 → 调 PiVideoStudio 创建项目。 */
  async generateVideo(
    userId: number,
    projectId: number,
    chapterId: number,
    authHeader: string,
  ): Promise<{
    ok: boolean;
    videoProjectId: string;
    videoProjectUrl: string;
  }> {
    // 1. 权限校验 + 项目信息
    const project = await requireOwnedProject(this.prisma, userId, projectId);

    // 2. 章节正文（含种子）
    const chapter = await this.prisma.novelChapter.findFirst({
      where: { id: chapterId, projectId, userId, deletedAt: null },
      include: { seed: true },
    });
    if (!chapter) {
      throw new NotFoundException('章节不存在');
    }
    if (!chapter.content || chapter.content.trim().length === 0) {
      throw new NotFoundException('章节正文为空，请先生成或编辑正文');
    }

    // 3. 大纲节点（全项目，按序取前 50 条）
    const outlineNodes = await this.prisma.novelOutlineNode.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: 50,
    });

    // 4. 人物卡（全项目，按序取前 20 个）
    const characters = await this.prisma.novelCharacter.findMany({
      where: { projectId, userId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      take: 20,
    });

    // 5. 组装结构化上下文（PiVideoStudio N1/N4 会注入 LLM prompt，人物设定优先采用）
    const novelContext = {
      source: 'pinovelstudio' as const,
      novelProjectId: projectId,
      novelProjectTitle: project.title,
      outline: outlineNodes.map((n) => ({
        title: n.title,
        summary: n.summary,
        nodeType: n.nodeType,
      })),
      characters: characters.map((c) => ({
        name: c.name,
        roleType: c.roleType,
        identity: c.identity,
        personality: c.personality,
        relationships: c.relationships,
        notes: c.notes,
      })),
      seed: chapter.seed
        ? {
            intent: chapter.seed.intent,
            mustInclude: chapter.seed.mustInclude,
            endingGoal: chapter.seed.endingGoal,
          }
        : undefined,
    };

    // 6. 调 PiVideoStudio API 创建视频项目
    const baseUrl = process.env.PIVIDEO_API_URL ?? 'http://172.17.0.1:3100';
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          title: `${project.title} · ${chapter.title}`,
          rawText: chapter.content,
          chapterIds: [String(chapter.id)],
          novelContext,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadGatewayException(`无法连接 PiVideoStudio（${baseUrl}）: ${message}`);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new BadGatewayException(
        `PiVideoStudio 创建项目失败: HTTP ${resp.status} ${errText.slice(0, 200)}`,
      );
    }
    const created = (await resp.json()) as { id: string };

    // 7. 返回项目 ID 与 Web 跳转 URL
    const webUrl = process.env.PIVIDEO_WEB_URL ?? 'http://localhost:5173';
    return {
      ok: true,
      videoProjectId: created.id,
      videoProjectUrl: `${webUrl}/projects/${created.id}`,
    };
  }
}
