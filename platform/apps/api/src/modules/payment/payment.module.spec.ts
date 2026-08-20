import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { PaymentReconcileHost } from './payment.module';
import type { PaymentService } from './payment.service';

describe('PaymentReconcileHost', () => {
  const originalNodeEnv = env.NODE_ENV;

  afterEach(() => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('reconciles pending orders immediately on a non-test process start', async () => {
    (env as { NODE_ENV: typeof env.NODE_ENV }).NODE_ENV = 'development';
    const reconcilePendingOrders = vi.fn().mockResolvedValue({ credited: 0, expired: 0 });
    const host = new PaymentReconcileHost({ reconcilePendingOrders } as unknown as PaymentService);

    host.onModuleInit();
    await vi.waitFor(() => expect(reconcilePendingOrders).toHaveBeenCalledTimes(1));
    host.onModuleDestroy();
  });
});
