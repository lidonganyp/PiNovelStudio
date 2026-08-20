/**
 * P8-1 浏览器旅程占位：需要已启动的 web+api，以及 E2E_BASE_URL。
 * CI 默认 skip；权威旅程测试是 apps/api/test/p8-journey.e2e.spec.ts。
 */
import { test, expect } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL);

test.skip(!enabled, 'Set E2E_BASE_URL to run the browser journey against a live server');

test('register then land on /projects', async ({ page }) => {
  const email = `p8-ui-${Date.now()}@test.local`;
  await page.goto('/register');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('至少 8 位').fill('Password123');
  await page.getByPlaceholder('再次输入密码').fill('Password123');
  await page.getByPlaceholder('1-32 字符').fill('旅程用户');
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL(/\/projects\/?$/);
});
