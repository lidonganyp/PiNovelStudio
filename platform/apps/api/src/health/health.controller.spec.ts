/** API 健康检查必须反映数据库可用性，而不是仅反映 Node 进程存活。 */
import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports healthy only after the database readiness query succeeds', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ ok: 1 }]);
    const controller = new HealthController({ $queryRaw: queryRaw } as never);

    await expect(controller.getHealth()).resolves.toMatchObject({ status: 'ok' });
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('fails readiness when the database is unavailable', async () => {
    const controller = new HealthController({
      $queryRaw: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as never);

    await expect(controller.getHealth()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
