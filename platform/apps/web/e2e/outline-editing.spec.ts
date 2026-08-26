import { expect, test } from '@playwright/test';

test('full-book outline can be edited and saved', async ({ page }) => {
  let savedContent = '';
  let version = 3;

  await page.addInitScript(() => {
    localStorage.setItem('platform_token', 'outline-e2e-token');
    localStorage.setItem('platform_user', JSON.stringify({
      id: 1,
      email: 'outline@test.local',
      nickname: '大纲编辑测试',
      role: 'user',
      status: 'active',
      balance: '0',
      bonusBalance: '0',
      totalBalance: '0',
      createdAt: '2026-08-25T00:00:00.000Z',
    }));
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }

    if (path === '/api/auth/me') {
      await route.fulfill({
        json: {
          id: 1,
          email: 'outline@test.local',
          nickname: '大纲编辑测试',
          role: 'user',
          status: 'active',
          balance: '0',
          bonusBalance: '0',
          totalBalance: '0',
          createdAt: '2026-08-25T00:00:00.000Z',
        },
      });
      return;
    }
    if (path === '/api/projects/252') {
      await route.fulfill({
        json: {
          id: 252,
          userId: 1,
          title: '测试小说',
          description: '',
          genre: '玄幻',
          subGenres: [],
          worldKeyTerms: [],
          status: 'active',
          workflowState: 'draft',
          version: 1,
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      });
      return;
    }
    if (path === '/api/projects/252/chapters') {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === '/api/projects/252/documents' && request.method() === 'GET') {
      await route.fulfill({
        json: [{
          id: 77,
          documentType: 'story_outline',
          title: '故事大纲',
          content: savedContent || '# 原始大纲\n第一幕。',
          currentVersion: version,
        }],
      });
      return;
    }
    if (path === '/api/projects/252/documents/77' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { content: string };
      savedContent = body.content;
      version += 1;
      await route.fulfill({
        json: {
          id: 77,
          documentType: 'story_outline',
          title: '故事大纲',
          content: savedContent,
          currentVersion: version,
        },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto('/projects/252/workbench');
  await page.getByRole('tab', { name: '大纲（全书）' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();

  const editor = page.getByRole('textbox', { name: '大纲正文' });
  await editor.fill('# 修改后的大纲\n第十七章继续追查。');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(page.getByText('v4')).toBeVisible();
  await expect(page.getByText('# 修改后的大纲')).toBeVisible();
  expect(savedContent).toBe('# 修改后的大纲\n第十七章继续追查。');
});
