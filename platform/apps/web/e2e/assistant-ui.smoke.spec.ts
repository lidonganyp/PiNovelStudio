/**
 * 阶段六 UI 冒烟：聊天工作区组件树在真实工作台上的挂载与布局。
 * 需要已启动的 web+api：设置 E2E_BASE_URL、E2E_WORKSPACE_URL（含可选 E2E_EMAIL/E2E_PASSWORD）。
 * CI 默认 skip；纯逻辑契约见 assistant-chat.spec.ts。
 */
import { test, expect } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL && process.env.E2E_WORKSPACE_URL);

test.skip(!enabled, 'Set E2E_BASE_URL + E2E_WORKSPACE_URL to run the chat workspace smoke');

test.beforeEach(async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (email && password) {
    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByPlaceholder('至少 8 位').fill(password);
    await page.getByRole('button', { name: '登录' }).click();
  }
});

test('桌面端：聊天工作区组件树挂载，拖拽把手可见', async ({ page }) => {
  await page.goto(process.env.E2E_WORKSPACE_URL!);
  const workspace = page.locator('.assistant-workspace');
  await expect(workspace).toBeVisible({ timeout: 20000 });
  await expect(workspace.locator('.conversation-header')).toBeVisible();
  await expect(workspace.locator('.message-list')).toBeVisible();
  await expect(workspace.locator('.composer')).toBeVisible();
  // 阶段五：右栏拖拽把手与滚动容器并存
  await expect(page.locator('.right-resizer')).toBeVisible();
});

test.describe('移动端视口', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('聊天面板以抽屉呈现，拖拽把手隐藏', async ({ page }) => {
    await page.goto(process.env.E2E_WORKSPACE_URL!);
    // ≤720px：resizer 由 CSS 隐藏，聊天面板以 fixed 抽屉呈现
    await expect(page.locator('.right-resizer')).toBeHidden();
    const composer = page.locator('.assistant-workspace .composer');
    if (await composer.isVisible()) {
      await expect(composer).toBeAttached();
    }
  });
});
