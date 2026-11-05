import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// T3.2: the Family tab against the Homemind-enabled dev server (playwright.config.ts, port 5176).
// The tests share one state file, so they run one after the other and each starts from a reset.
const BASE = 'http://127.0.0.1:5176';

test.describe.configure({ mode: 'serial' });

async function resetBoard(request: APIRequestContext) {
  const session = await request.post(`${BASE}/api/homemind/session`, { data: { memberId: 'mom' } });
  expect(session.ok()).toBe(true);
  const { token } = (await session.json()) as { token: string };
  const reset = await request.post(`${BASE}/api/homemind/demo/reset`, { headers: { 'x-homemind-session': token }, data: {} });
  expect(reset.ok()).toBe(true);
}

async function openFamily(page: Page, lang: 'en' | 'zh', member?: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(language => {
    if (!window.sessionStorage.getItem('dm-e2e-initialized')) {
      window.localStorage.clear();
      window.localStorage.setItem('digitalmate.web.v2.welcomeSeen.v1', 'true');
      window.localStorage.setItem('digitalmate.web.v2.language.v1', JSON.stringify(language));
      window.sessionStorage.setItem('dm-e2e-initialized', '1');
    }
  }, lang);
  await page.goto(`${BASE}/${member ? `?member=${member}` : ''}`);
  await page.getByRole('navigation', { name: lang === 'zh' ? '主导航' : 'Main navigation' }).getByRole('button', { name: lang === 'zh' ? '家庭' : 'Family' }).click();
}

const family = (page: Page) => page.locator('.hm-family');

async function seriousIssues(page: Page) {
  // Wait for fades (`surfaceIn`) to end; looping animations (the background glow) never finish.
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
  const result = await new AxeBuilder({ page }).include('main').analyze();
  return result.violations.filter(v => v.impact === 'critical' || v.impact === 'serious').map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }));
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ request }) => {
  await resetBoard(request);
});

test('demo sign-in: pick a member, see My day, switch member', async ({ page }) => {
  await openFamily(page, 'en');
  await expect(page.getByText('Demo sign-in').first()).toBeVisible();
  await page.getByRole('button', { name: /Dad/ }).click();
  await expect(family(page)).toHaveAttribute('data-member', 'dad');
  await expect(page.locator('.a2ui-surface h3')).toHaveText('My day');
  await page.getByRole('button', { name: 'Switch member' }).click();
  await page.getByRole('button', { name: /Maya/ }).click();
  await expect(family(page)).toHaveAttribute('data-member', 'maya');
  // Each window keeps its own member (sessionStorage), so a reload keeps Maya.
  await page.reload();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Family' }).click();
  await expect(family(page)).toHaveAttribute('data-member', 'maya');
});

test('create an event with preparations, edit it, delete a preparation, assign it and search for it', async ({ page }) => {
  await openFamily(page, 'en', 'mom');
  await expect(family(page)).toHaveAttribute('data-member', 'mom');

  // Create the event.
  await page.getByRole('button', { name: '+ Add' }).click();
  await expect(page.locator('.a2ui-surface h3')).toHaveText('Add to the board');
  await page.getByLabel('Title').fill('School concert');
  await page.getByLabel('Start time (empty for all day)').fill('18:00');
  await page.getByLabel('End time').fill('19:30');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.hm-notice')).toContainText('Saved. You can add preparations below.');
  await expect(page.locator('.a2ui-surface h3')).toHaveText('Edit item');
  await expect(page.getByLabel('Title')).toHaveValue('School concert');

  // Two preparations.
  for (const title of ['Iron the shirt', 'Charge the camera']) {
    await page.getByRole('button', { name: 'Add preparation' }).last().click();
    await expect(page.locator('.a2ui-surface h3')).toHaveText('Add preparation');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.hm-notice')).toContainText('Saved.');
    await expect(page.locator('.a2ui-surface h3')).toHaveText('Edit item');
  }
  const preps = page.locator('.hm-task-list').last().locator('.hm-task');
  await expect(preps).toHaveCount(2);
  await preps.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('family-edit-event.png') });

  // Edit the event.
  await page.getByLabel('Notes').fill('Row 3');
  await page.getByLabel('Title').fill('School concert (Maya)');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.hm-notice')).toContainText('Saved.');

  // Back on My day: open it again from its row.
  await page.getByRole('button', { name: 'Edit: School concert (Maya)' }).first().click();
  await expect(page.getByLabel('Notes')).toHaveValue('Row 3');

  // Delete a preparation, then undo and delete it again.
  await page.getByRole('button', { name: 'Remove: Charge the camera' }).click();
  await expect(page.locator('.hm-notice')).toContainText('Removed.');
  await expect(preps).toHaveCount(1);
  await page.locator('.hm-notice').getByRole('button', { name: 'Undo' }).click();
  await expect(preps).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove: Charge the camera' }).click();
  await expect(preps).toHaveCount(1);
  await expect(preps.first()).toContainText('Iron the shirt');

  // Assign it to Dad from the item's own row.
  await page.getByRole('button', { name: 'Assign to Dad: School concert (Maya)' }).click();
  await expect(page.locator('.hm-notice')).toContainText('Done.');
  await expect(page.locator('.hm-task-list').first().locator('.hm-task').first()).toHaveAttribute('data-state', 'assigned');

  // Search for it.
  await family(page).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Search the board').fill('concert');
  await page.locator('.a2ui-actions').getByRole('button', { name: 'Search' }).click();
  const hit = page.locator('.hm-task', { hasText: 'School concert (Maya)' });
  await expect(hit).toBeVisible();
  await expect(hit.locator('.hm-task-owner')).toHaveText('Dad');
  await expect(page.locator('.hm-task', { hasText: 'Charge the camera' })).toHaveCount(0);
  await noOverflow(page);
});

test('the calendar opens an item for editing', async ({ page }) => {
  await openFamily(page, 'en', 'mom');
  await family(page).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Calendar' }).click();
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  const entry = page.locator('.hm-cal-entry .hm-open').first();
  const title = (await entry.textContent()) ?? '';
  await entry.click();
  await expect(page.locator('.a2ui-surface h3')).toHaveText('Edit item');
  await expect(page.getByLabel('Title')).toHaveValue(title);
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page.locator('.hm-cal')).toBeVisible();
});

test('a teen sees no Parents-only item and gets no Parents-only toggle', async ({ page }) => {
  await openFamily(page, 'en', 'maya');
  await expect(family(page)).toHaveAttribute('data-member', 'maya');
  await expect(page.locator('.a2ui-surface')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/counselor/i);
  await page.getByRole('button', { name: '+ Add' }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  await expect(page.getByText('Parents only', { exact: true })).toHaveCount(0);
});

for (const lang of ['en', 'zh'] as const) {
  test(`every Family screen at 390 px in ${lang}: no overflow, no serious axe issues`, async ({ page }) => {
    await openFamily(page, lang, 'mom');
    await expect(family(page)).toHaveAttribute('data-member', 'mom');
    const names = lang === 'zh' ? ['我的一天', '家庭', '日历', '搜索', '规则', '动态', '设置', '+ 添加'] : ['My day', 'Family', 'Calendar', 'Search', 'Rules', 'Activity', 'Settings', '+ Add'];
    const nav = family(page).getByRole('navigation', { name: lang === 'zh' ? '家庭页面' : 'Family screens' });
    for (const name of names) {
      await nav.getByRole('button', { name, exact: true }).click();
      await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.a2ui-surface')).toBeVisible();
      await noOverflow(page);
      expect(await seriousIssues(page), name).toEqual([]);
    }
    await page.screenshot({ path: test.info().outputPath(`family-add-${lang}.png`), fullPage: true });
  });
}
