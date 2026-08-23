/**
 * 管理后台用户反馈：菜单、列表筛选、回复、门户可见。需要已启动 web+api 与 E2E_BASE_URL。
 */
import { test, expect, type Page } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL);
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@lidong';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'lidong520';
const PASSWORD = 'Password123';

test.skip(!enabled, 'Set E2E_BASE_URL to run against a live server');

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('至少 8 位').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/projects/);
}

async function registerUser(page: Page, email: string, nickname: string): Promise<void> {
  await page.goto('/register');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('至少 8 位').fill(PASSWORD);
  await page.getByPlaceholder('再次输入密码').fill(PASSWORD);
  await page.getByPlaceholder('1-32 字符').fill(nickname);
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL(/\/projects\/?$/);
}

async function authHeader(page: Page): Promise<Record<string, string>> {
  const token = await page.evaluate(() => localStorage.getItem('platform_token'));
  expect(token).toBeTruthy();
  return { Authorization: `Bearer ${token}` };
}

async function createProjectWithFeedback(
  page: Page,
  title: string,
  content: string,
): Promise<{ projectId: number; feedbackId: number }> {
  const headers = await authHeader(page);
  const projectRes = await page.request.post('/api/projects', {
    headers,
    data: { title, genre: '玄幻' },
  });
  expect(projectRes.ok()).toBeTruthy();
  const project = (await projectRes.json()) as { id: number };
  const chapterRes = await page.request.post(`/api/projects/${project.id}/chapters`, {
    headers,
    data: { chapterNumber: 1, title: '开篇' },
  });
  expect(chapterRes.ok()).toBeTruthy();
  const chapter = (await chapterRes.json()) as { id: number };
  const feedbackRes = await page.request.post(`/api/projects/${project.id}/feedback`, {
    headers,
    data: { type: 'quality', content, chapterId: chapter.id },
  });
  expect(feedbackRes.ok()).toBeTruthy();
  const feedback = (await feedbackRes.json()) as { id: number };
  return { projectId: project.id, feedbackId: feedback.id };
}

async function logoutPortal(page: Page): Promise<void> {
  await page.locator('.user-chip').click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test('非管理员无法访问管理反馈页面', async ({ page }) => {
  const email = `fb-ui-user-${Date.now()}@test.local`;
  await registerUser(page, email, '普通用户');
  await page.goto('/admin/feedback');
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByRole('menuitem', { name: '用户反馈' })).toHaveCount(0);
});

test('管理员可进入用户反馈页，列表筛选分页，回复后门户可见', async ({ page }) => {
  const stamp = Date.now();
  const userEmail = `fb-ui-${stamp}@test.local`;
  const marker = `钩子偏弱-${stamp}`;
  const projectTitle = `反馈项目-${stamp}`;

  await registerUser(page, userEmail, '反馈用户');
  const { projectId } = await createProjectWithFeedback(page, projectTitle, marker);
  await page.goto(`/projects/${projectId}/workbench`);
  await page.getByRole('tab', { name: '反馈' }).click();
  await expect(page.getByTestId('feedback-panel')).toBeVisible();
  await expect(page.getByText('待处理').first()).toBeVisible();
  await logoutPortal(page);

  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/admin');
  await expect(page.getByRole('menuitem', { name: '用户反馈' })).toBeVisible();
  await page.getByRole('menuitem', { name: '用户反馈' }).click();
  await expect(page).toHaveURL(/\/admin\/feedback/);
  await expect(page.getByTestId('admin-feedback-page')).toBeVisible();
  await expect(page.getByText('用户反馈').first()).toBeVisible();

  await page.getByPlaceholder('邮箱、昵称、项目或内容关键词').fill(marker);
  await page.getByRole('button', { name: '筛选' }).click();
  const table = page.getByTestId('admin-feedback-table');
  await expect(table.getByText(marker)).toBeVisible();
  await expect(table.getByText(projectTitle)).toBeVisible();
  await expect(table.getByText('待处理').first()).toBeVisible();

  await page.getByTestId('admin-feedback-type').click();
  await page.getByRole('option', { name: '文学质量' }).click();
  await expect(table.getByText(marker)).toBeVisible();

  await page.getByTestId('admin-feedback-status').click();
  await page.getByRole('option', { name: '待处理' }).click();
  await expect(table.getByText(marker)).toBeVisible();
  await expect(page.locator('.el-pagination')).toBeVisible();

  await page.getByRole('button', { name: '回复' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('完整反馈内容')).toBeVisible();
  await expect(dialog.getByText(marker)).toBeVisible();
  await dialog.getByRole('textbox', { name: '填写回复' }).fill('已记录，下章加强钩子');
  await dialog.getByRole('button', { name: '提交回复' }).click();
  await expect(page.getByText('回复已保存')).toBeVisible();
  await expect(dialog.getByText('已回复').first()).toBeVisible();
  await dialog.getByRole('button', { name: '关闭此对话框' }).click();
  await expect(dialog).toBeHidden();
  await page.getByTestId('admin-feedback-status').click();
  await page.getByRole('option', { name: '已回复' }).click();
  await expect(table.getByText(marker)).toBeVisible();
  await expect(table.getByText('已回复').first()).toBeVisible();

  await page.getByRole('button', { name: '退出' }).click();
  await login(page, userEmail, PASSWORD);
  await page.goto(`/projects/${projectId}/workbench`);
  await page.getByRole('tab', { name: '反馈' }).click();
  await expect(page.getByTestId('feedback-reply-block')).toBeVisible();
  await expect(page.getByText('已记录，下章加强钩子')).toBeVisible();
  await expect(page.getByText('已回复').first()).toBeVisible();
});

test('回复提交失败时显示错误提示且不丢失编辑内容', async ({ page }) => {
  const stamp = Date.now();
  const userEmail = `fb-ui-fail-${stamp}@test.local`;
  const marker = `失败保留-${stamp}`;
  await registerUser(page, userEmail, '失败用户');
  await createProjectWithFeedback(page, `失败项目-${stamp}`, marker);
  await logoutPortal(page);

  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/admin/feedback');
  await page.getByPlaceholder('邮箱、昵称、项目或内容关键词').fill(marker);
  await page.getByRole('button', { name: '筛选' }).click();
  await expect(page.getByTestId('admin-feedback-table').getByText(marker)).toBeVisible();
  await page.getByRole('button', { name: '回复' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('完整反馈内容')).toBeVisible();

  await page.route('**/api/admin/feedback/*/reply', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 500, message: '服务暂时不可用' }),
      });
      return;
    }
    await route.continue();
  });

  const draft = '这条回复必须保留在输入框里';
  const replyBox = dialog.getByRole('textbox', { name: '填写回复' });
  await replyBox.fill(draft);
  await dialog.getByRole('button', { name: '提交回复' }).click();
  await expect(page.getByText('服务暂时不可用')).toBeVisible();
  await expect(replyBox).toHaveValue(draft);
});
