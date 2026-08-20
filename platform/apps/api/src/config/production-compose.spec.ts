/**
 * 生产拓扑回归：runtime 依赖 api=service_healthy，因此 api 必须定义
 * 使用数据库 readiness 端点的 Compose 健康检查。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production compose readiness wiring', () => {
  it('declares the Fastify static adapter required by the production API entrypoint', () => {
    const packageJson = JSON.parse(readFileSync(
      resolve(process.cwd(), '../../apps/api/package.json'),
      'utf8',
    )) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies?.['@fastify/static']).toBeTruthy();
  });

  it('defines an API healthcheck before runtime waits for service_healthy', () => {
    const compose = readFileSync(
      resolve(process.cwd(), '../../docker-compose.yml'),
      'utf8',
    );
    const apiSection = compose.match(
      /^\x20{2}api:\r?\n([\s\S]*?)(?=^\x20{2}[a-z][\w-]*:\r?\n|^volumes:)/m,
    )?.[1] ?? '';
    const runtimeSection = compose.match(
      /^\x20{2}runtime:\r?\n([\s\S]*?)(?=^\x20{2}[a-z][\w-]*:\r?\n|^volumes:)/m,
    )?.[1] ?? '';

    expect(apiSection).toMatch(/healthcheck:/);
    expect(apiSection).toMatch(/\/api\/health/);
    expect(apiSection).toMatch(/NOVEL_BILLING_REQUIRED_MODELS:\s+.*v2_rawstage2_gemini31/);
    expect(apiSection).toMatch(/v2_amplified_gemini31/);
    expect(apiSection).toMatch(/CORS_ORIGINS:\s+\$\{CORS_ORIGINS:\?CORS_ORIGINS is required in production\}/);
    expect(runtimeSection).toMatch(/NOVEL_REQUIRED_PROVIDER_KEYS:\s+GEMINI_API_KEY/);
    expect(runtimeSection).toMatch(/NODE_ENV:\s+production/);
    expect(runtimeSection).toMatch(/PINOVEL_DEV_MODE:\s+'0'/);
    expect(runtimeSection).toMatch(/PINOVEL_RELEASE_COMMIT:\s+\$\{PINOVEL_RELEASE_COMMIT:\?PINOVEL_RELEASE_COMMIT is required/);
    expect(runtimeSection).toMatch(/\.\.\/config\/production-identity:\/app\/pnovel\/config\/production-identity:ro/);
    expect(runtimeSection).toMatch(/api:\r?\n\s+condition: service_healthy/);
  });

  it('runs the explicit first-deploy bootstrap before the API and runtime', () => {
    const compose = readFileSync(
      resolve(process.cwd(), '../../docker-compose.yml'),
      'utf8',
    );
    expect(compose).toMatch(/^\x20{2}api-bootstrap:\r?\n/m);
    expect(compose).toMatch(/BOOTSTRAP_ADMIN_EMAIL/);
    expect(compose).toMatch(/BOOTSTRAP_GEMINI_API_KEY/);
    expect(compose).toMatch(/service_completed_successfully/);
  });

  it('uses a pnpm 10-compatible production dependency deployment command', () => {
    const dockerfile = readFileSync(
      resolve(process.cwd(), '../../apps/api/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toMatch(/pnpm\s+--filter\s+@platform\/api\s+deploy\s+--prod\s+\/out\s+--legacy/);
  });

  it('uses the lockfile-resolved Prisma CLI instead of downloading a floating global version', () => {
    const dockerfile = readFileSync(
      resolve(process.cwd(), '../../apps/api/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).not.toMatch(/npm\s+install\s+-g\s+prisma@/);
    expect(dockerfile).toMatch(/CMD \["node", "dist\/main\.js"\]/);
    expect(dockerfile).toMatch(/pnpm --filter @platform\/web build/);
    expect(dockerfile).toMatch(/COPY --from=builder \/build\/apps\/web\/dist \.\/web/);
    const compose = readFileSync(
      resolve(process.cwd(), '../../docker-compose.yml'),
      'utf8',
    );
    expect(compose).toMatch(/command:\s*\['npx', '--no-install', 'prisma', 'migrate', 'deploy'/);
    expect(compose).not.toMatch(/command:\s*\['npx', 'prisma', 'migrate', 'deploy'/);
  });

  it('keeps every runtime Docker COPY subtree reachable through the root ignore rules', () => {
    const rootIgnore = readFileSync(
      resolve(process.cwd(), '../../../.dockerignore'),
      'utf8',
    );
    expect(rootIgnore).toContain('.pi/extensions/novel-studio/node_modules');
    expect(rootIgnore).toContain('.pi/extensions/novel-studio/dist');
    expect(rootIgnore).toContain('platform/services/novel-runtime/node_modules');
    expect(rootIgnore).toContain('platform/services/novel-runtime/dist');
  });

  it('keeps the sealed production identity pack out of the runtime image build context', () => {
    const rootIgnore = readFileSync(
      resolve(process.cwd(), '../../../.dockerignore'),
      'utf8',
    );
    const compose = readFileSync(
      resolve(process.cwd(), '../../docker-compose.yml'),
      'utf8',
    );

    expect(rootIgnore).toMatch(/^config\/production-identity\/active\.pack\.json$/m);
    expect(compose).toMatch(
      /\.\.\/config\/production-identity:\/app\/pnovel\/config\/production-identity:ro/,
    );
  });

  it('installs the embedded NovelStudio runtime dependencies from a lockfile', () => {
    const dockerfile = readFileSync(
      resolve(process.cwd(), '../../services/novel-runtime/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toMatch(/COPY\s+\.pi\/extensions\/novel-studio\/package\.json\s+\.\//);
    expect(dockerfile).toMatch(/COPY\s+\.pi\/extensions\/novel-studio\/package-lock\.json\s+\.\//);
    expect(dockerfile).toMatch(/npm ci --no-audit --no-fund/);
  });

  it('builds runtime and the embedded extension inside the image from source', () => {
    const dockerfile = readFileSync(
      resolve(process.cwd(), '../../services/novel-runtime/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toMatch(/npm run build:prod/);
    expect(dockerfile).toMatch(/npm run build/);
    expect(dockerfile).not.toMatch(/COPY platform\/services\/novel-runtime\/dist \.\/dist/);
    const rootIgnore = readFileSync(
      resolve(process.cwd(), '../../../.dockerignore'),
      'utf8',
    );
    expect(rootIgnore).not.toMatch(/^\.pi\/extensions\/novel-studio\/\*$/m);
  });

  it('keeps the web source in the API Docker build context', () => {
    const dockerIgnore = readFileSync(
      resolve(process.cwd(), '../../.dockerignore'),
      'utf8',
    );
    expect(dockerIgnore).not.toMatch(/^apps\/web\/\*$/m);
    expect(dockerIgnore).not.toMatch(/^apps\/web\/$/m);
    expect(dockerIgnore).not.toMatch(/^apps$/m);
  });
});
