# Playwright 浏览器旅程（可选）

P8-1 的 CI 验收走 `apps/api/test/p8-journey.e2e.spec.ts`（Fastify inject，与 Phase 1 起的 e2e 口径一致）。

若要在真实浏览器里复跑同一旅程：

1. `pnpm --filter @platform/api start:dev`
2. `pnpm --filter @platform/web dev`
3. 安装 Playwright：`pnpm --filter @platform/web exec playwright install chromium`
4. `E2E_BASE_URL=http://localhost:5173 pnpm --filter @platform/web exec playwright test`

未设置 `E2E_BASE_URL` 时规格文件直接 skip，避免 CI 缺浏览器失败。
