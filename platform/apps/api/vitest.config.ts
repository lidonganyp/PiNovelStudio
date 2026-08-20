/**
 * 模块说明：Vitest 配置（单元 + e2e 注入式测试）。
 * e2e 用 Fastify 原生 inject()（Supertest 等价物），依赖 dev postgres。
 * 转译必须走 unplugin-swc（NestJS 官方 Vitest 方案）：vitest 默认的
 * esbuild 不产出 design:paramtypes，Nest 依赖注入会全部变成 undefined。
 * unplugin-swc 自动读取本目录 tsconfig.json（emitDecoratorMetadata 已开）。
 */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    // Several production-configuration tests intentionally exercise process.env
    // and module reloading. Running files in parallel lets one file change the
    // process-wide configuration while another service test is constructing its
    // dependency graph, producing false failures and masking real regressions.
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
