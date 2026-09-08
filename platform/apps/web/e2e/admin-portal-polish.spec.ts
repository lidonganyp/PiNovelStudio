/**
 * 管理后台用量/收入/查价 + 门户项目卡闭环（需已启动 web+api）。
 */
import { test, expect } from '@playwright/test';

const enabled = Boolean(process.env.E2E_BASE_URL);

test.skip(!enabled, 'Set E2E_BASE_URL to run against a live server');

test('admin overview usage revenue and rate lookup, portal project cards', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill('admin@lidong');
  await page.getByPlaceholder('至少 8 位').fill('lidong520');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByText(/章/)).toBeVisible({ timeout: 15_000 });

  await page.goto('/admin');
  await expect(page.getByText('待消耗额度')).toBeVisible();
  await expect(page.getByText('近 7 日消耗用户排行')).toBeVisible();

  await page.goto('/admin/usage');
  await expect(page.getByText('请求次数')).toBeVisible();
  await expect(page.getByText('用量趋势')).toBeVisible();

  await page.goto('/admin/revenue');
  await expect(page.getByText('支付宝真实充值')).toBeVisible();
  await expect(page.getByText('后台调账（虚拟充值）')).toBeVisible();
  await expect(page.getByText('平台待消耗额度')).toBeVisible();

  await page.goto('/admin/models');
  await page.getByRole('button', { name: '新增费率' }).click();
  await page.getByPlaceholder('gemini-3.8-flash 或 Qwen/Qwen2.5-7B-Instruct').fill(
    'gemini-3.8-flash',
  );
  await page.getByRole('button', { name: '查询公开价' }).click();
  await expect(page.getByText(/已匹配 google\/gemini-3.8-flash/)).toBeVisible({
    timeout: 20_000,
  });
});
