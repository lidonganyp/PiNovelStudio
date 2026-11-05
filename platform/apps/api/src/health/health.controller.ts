/**
 * 健康检查控制器：提供 GET /api/health 供容器探活与前端连通性探测。
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** 返回服务存活状态与运行时长；runtime 断连时降级为 degraded（仍返回 200，避免健康探针引发重启循环）。 */
  @Get()
  async getHealth(): Promise<{
    status: string;
    runtime: 'up' | 'down';
    uptime: number;
    timestamp: string;
  }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('database is not ready');
    }
    const runtimeUp = await probeRuntime();
    return {
      status: runtimeUp ? 'ok' : 'degraded',
      runtime: runtimeUp ? 'up' : 'down',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

/** 探测章节生成 runtime 可达性（短超时，不阻塞整体健康检查）。 */
async function probeRuntime(): Promise<boolean> {
  const base = process.env.NOVEL_RUNTIME_BASE_URL;
  if (!base) return true;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/v1/tools`, {
      signal: AbortSignal.timeout(2000),
    });
    // runtime 对未授权请求返回 401/403 也视为存活；只有网络层失败才算 down。
    return response.status > 0;
  } catch {
    return false;
  }
}
