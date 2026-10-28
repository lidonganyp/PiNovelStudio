/** Real Vue component regression checks against the local Vite server; no API generation requests. */
import { test, expect } from '@playwright/test';

test('不可恢复故障在完整消息中不显示重试，已采用方案不再显示缺失或确认提示', async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(async () => {
    const { createApp, h } = await import('/node_modules/.vite/deps/vue.js');
    const { default: MessageItem } = await import('/src/components/workspace/chat/MessageItem.vue');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    createApp({ render: () => h(MessageItem, {
      message: {
        id: 1, role: 'assistant', content: '生成服务暂不可用', status: 'failed',
        request: { content: '生成第21章' },
        failure: { stage: 'jobs.submit', gate: 'billing_configuration', code: 'generation_billing_unavailable', severity: 'preflight', reason: '计费配置未就绪', recoverable: false },
        steward: {
          status: 'ready', chapterNumber: 21, sourceVersion: 'v1', proposalStatus: 'applied', generationJobId: 'job-21',
          proposals: [{ field: 'genre', value: '都市', source: ['作者'], requiresConfirmation: true }], missing: ['章节种子'],
        },
      },
    }) }).mount(root);
  });
  await expect(page.locator('.failure-card')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await expect(page.getByText('已采用并提交生成')).toBeVisible();
  await expect(page.locator('.steward-card .missing')).toHaveCount(0);
  await expect(page.locator('.steward-card .confirm-mark')).toHaveCount(0);
});
