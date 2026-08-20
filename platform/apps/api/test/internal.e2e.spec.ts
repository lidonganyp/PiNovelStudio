/**
 * 内部 API e2e：HMAC 守卫 + 5 个 /internal 路由（Fastify inject）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { env } from '../src/config/env';
import { encryptSecret } from '../src/common/crypto/aes-gcm';
import {
  signInternalRequest,
  stableStringify,
} from '../src/modules/internal/hmac';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MODEL_KEY = `p2-int-model-${runId}`;
const PROVIDER_KEY = `p2-int-provider-${runId}`;

function signedHeaders(
  method: string,
  path: string,
  payload: unknown,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-${Math.random().toString(36).slice(2).padEnd(16, '0')}`;
  const body = payload == null ? '' : stableStringify(payload);
  const signature = signInternalRequest({
    secret: env.INTERNAL_API_SECRET,
    timestamp,
    method,
    path,
    body,
    nonce,
  });
  return {
    'x-internal-timestamp': timestamp,
    'x-internal-nonce': nonce,
    'x-internal-signature': signature,
  };
}

describe('内部 API e2e', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let userId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(
      new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }),
    );
    const { configureHttpApp } = await import('../src/configure-http');
    configureHttpApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const user = await prisma.user.create({
      data: {
        email: `internal-${runId}@test.local`,
        passwordHash: 'x',
        nickname: '内部用户',
        balance: 2000n,
      },
    });
    userId = user.id;

    const provider = await prisma.modelProvider.create({
      data: {
        providerKey: PROVIDER_KEY,
        name: '内部测试 Provider',
        apiBaseUrl: 'https://llm.example.test/v1',
        apiKeyEncrypted: encryptSecret(
          'sk-internal-test',
          env.AES_MASTER_KEY,
        ),
        enabled: true,
      },
    });
    await prisma.modelRate.create({
      data: {
        modelKey: MODEL_KEY,
        displayName: '内部测试模型',
        providerId: provider.id,
        inputPricePerMillion: 100n,
        outputPricePerMillion: 200n,
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        enabled: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.novelGenerationCall.deleteMany({
      where: { jobId: { contains: runId } },
    });
    await prisma.novelBalanceHold.deleteMany({
      where: { jobId: { contains: runId } },
    });
    await prisma.modelRate.deleteMany({
      where: { modelKey: { contains: runId } },
    });
    await prisma.modelProvider.deleteMany({
      where: { providerKey: { contains: runId } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: runId } },
    });
    await app.close();
  });

  it('缺少 HMAC 访问内部接口返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/billing/holds',
      payload: { userId, jobId: `no-hmac-${runId}`, amount: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('过期时间戳返回 401', async () => {
    const payload = { userId, jobId: `stale-${runId}`, amount: 100 };
    const timestamp = String(Math.floor(Date.now() / 1000) - 400);
    const nonce = 'nonce-stale-000001';
    const signature = signInternalRequest({
      secret: env.INTERNAL_API_SECRET,
      timestamp,
      method: 'POST',
      path: '/internal/billing/holds',
      body: stableStringify(payload),
      nonce,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/billing/holds',
      headers: {
        'x-internal-timestamp': timestamp,
        'x-internal-nonce': nonce,
        'x-internal-signature': signature,
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /internal/billing/holds 创建预占', async () => {
    const payload = { userId, jobId: `e2e-hold-${runId}`, amount: 300 };
    const res = await app.inject({
      method: 'POST',
      url: '/internal/billing/holds',
      headers: signedHeaders('POST', '/internal/billing/holds', payload),
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.jobId).toBe(`e2e-hold-${runId}`);
    expect(body.amount).toBe('300');
    expect(body.status).toBe('active');
  });

  it('rejects a replayed signed internal request', async () => {
    const payload = { userId, jobId: `replay-${runId}`, amount: 100 };
    const headers = signedHeaders('POST', '/internal/billing/holds', payload);
    const first = await app.inject({
      method: 'POST',
      url: '/internal/billing/holds',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: 'POST',
      url: '/internal/billing/holds',
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('POST /internal/billing/settlements 按费率结算', async () => {
    const payload = {
      jobId: `e2e-hold-${runId}`,
      callId: `e2e-call-${runId}`,
      internalStage: 'agentic_raw',
      model: MODEL_KEY,
      tokensIn: 100_000,
      tokensOut: 50_000,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/internal/billing/settlements',
      headers: signedHeaders('POST', '/internal/billing/settlements', payload),
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.actualCharge).toBe('20');
    expect(body.alreadySettled).toBe(false);
  });

  it('POST /internal/billing/holds/:jobId/finalize 收尾', async () => {
    const payload = { outcome: 'success' };
    const path = `/internal/billing/holds/e2e-hold-${runId}/finalize`;
    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: signedHeaders('POST', path, payload),
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('settled');
  });

  it('GET /internal/models/credentials 返回解密后的启用凭证', async () => {
    const path = '/internal/models/credentials';
    const res = await app.inject({
      method: 'GET',
      url: path,
      headers: signedHeaders('GET', path, null),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      providers: Array<{ providerKey: string; apiKey: string }>;
    };
    const found = body.providers.find((item) => item.providerKey === PROVIDER_KEY);
    expect(found?.apiKey).toBe('sk-internal-test');
  });

  it('POST /internal/jobs/:jobId/status 写入进度', async () => {
    const jobId = `e2e-hold-${runId}`;
    const path = `/internal/jobs/${jobId}/status`;
    const payload = {
      status: 'running',
      stage: 'generating_text',
      detail: { note: 'phase2' },
    };
    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: signedHeaders('POST', path, payload),
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      jobId,
      status: 'running',
      stage: 'generating_text',
    });
    const hold = await prisma.novelBalanceHold.findUniqueOrThrow({
      where: { jobId },
    });
    expect(hold.progressStage).toBe('generating_text');
  });

  it('POST /internal/jobs/:jobId/status rejects terminal job states', async () => {
    const jobId = `e2e-hold-${runId}`;
    const path = `/internal/jobs/${jobId}/status`;
    const payload = {
      status: 'succeeded',
      stage: 'saving_chapter',
    };
    const res = await app.inject({
      method: 'POST',
      url: path,
      headers: signedHeaders('POST', path, payload),
      payload,
    });

    expect(res.statusCode).toBe(400);
  });
});
