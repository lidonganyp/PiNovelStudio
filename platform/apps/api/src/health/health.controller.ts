/**
 * 健康检查控制器：提供 GET /api/health 供容器探活与前端连通性探测。
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** 返回服务存活状态与运行时长。 */
  @Get()
  async getHealth(): Promise<{ status: string; uptime: number; timestamp: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('database is not ready');
    }
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
