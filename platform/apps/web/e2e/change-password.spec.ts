/**
 * 用户端右上角下拉：修改密码对话框。需要已启动 web+api 与 E2E_BASE_URL。
 */
import { test, expect } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL);

test.skip(!enabled, 'Set E2E_BASE_URL to run the browser journey against a live server');

test('user menu exposes change-password dialog', async ({ page }) => {
  const email = `pw-ui-${Date.now()}@test.local`;
  await page.goto('/register');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('至少 8 位').fill('Password123');
  await page.getByPlaceholder('再次输入密码').fill('Password123');
  await page.getByPlaceholder('1-32 字符').fill('改密用户');
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL(/\/projects\/?$/);

  await page.locator('.user-chip').click();
  await page.getByRole('menuitem', { name: '修改密码' }).click();
  await expect(page.getByRole('dialog', { name: '修改密码' })).toBeVisible();
  await expect(page.getByText('当前密码')).toBeVisible();
  await expect(page.getByText('新密码')).toBeVisible();
  await expect(page.getByText('确认新密码')).toBeVisible();
});
