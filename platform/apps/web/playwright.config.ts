/**
 * 浏览器旅程：需要已启动的 web+api，以及 E2E_BASE_URL。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    locale: 'zh-CN',
  },
});
