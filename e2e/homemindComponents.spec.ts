import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// T3.1: TaskList, CalendarBoard and the Simulated badge, rendered from the real builders on a test-only
// harness page (the Family tab is T3.2). Phone width, both languages, axe.
const HARNESS = '/e2e/harness/homemind-components.html';

async function open(page: Page, lang: 'en' | 'zh') {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS}?lang=${lang}`);
  await expect(page.locator('.hm-cal')).toBeVisible();
}

async function seriousIssues(page: Page) {
  // Surfaces fade in (`surfaceIn`); axe measured mid-fade reports false contrast failures on a cold server.
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
  const result = await new AxeBuilder({ page }).include('main').analyze();
  return result.violations
    .filter(v => v.impact === 'critical' || v.impact === 'serious')
    .map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }));
}

for (const lang of ['en', 'zh'] as const) {
  test(`Homemind components at 390 px in ${lang}: no overflow, no serious axe issues`, async ({ page }, testInfo) => {
    await open(page, lang);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.locator('.hm-task').first()).toBeVisible();
    await expect(page.locator('.hm-sim-badge').first()).toHaveText(lang === 'zh' ? '模拟' : 'Simulated');
    expect(await seriousIssues(page), 'week').toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`homemind-${lang}-week.png`), fullPage: true });

    await page.getByRole('button', { name: lang === 'zh' ? '月' : 'Month', exact: true }).click();
    await expect(page.locator('.hm-cal-month')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect(await seriousIssues(page), 'month').toEqual([]);
    await page.locator('.hm-cal').screenshot({ path: testInfo.outputPath(`homemind-${lang}-month.png`) });

    await page.getByRole('button', { name: lang === 'zh' ? '日' : 'Day', exact: true }).click();
    expect(await seriousIssues(page), 'day').toEqual([]);
    await page.locator('.hm-cal').screenshot({ path: testInfo.outputPath(`homemind-${lang}-day.png`) });
  });
}

test('TaskList buttons send the row action', async ({ page }) => {
  await open(page, 'en');
  const row = page.locator('[data-screen="homemind-family"] .hm-task', { hasText: 'Bring apples' });
  await expect(row.locator('.hm-sim-badge')).toHaveText('Simulated');
  await expect(row.locator('.hm-task-state')).toHaveText('Proposed');
  const itemId = await row.getAttribute('data-task-id');
  // Proposed items offer Approve and Dismiss; the accessible name carries the row title.
  await row.getByRole('button', { name: 'Approve: Bring apples' }).click();
  const sent = JSON.parse((await page.getByTestId('last-action').textContent()) ?? '{}');
  expect(sent.id).toBe(`homemind.approve:${itemId}`);
  expect(sent.args).toMatchObject({ verb: 'approve', itemId });
});

test('CalendarBoard switches views, moves through time, and filters by person', async ({ page }) => {
  await open(page, 'en');
  const board = page.locator('.hm-cal');
  const title = board.locator('.hm-cal-title');
  await expect(board).toHaveAttribute('data-view', 'week');
  const week = await title.textContent();

  await board.getByRole('button', { name: 'Next' }).click();
  await expect(title).not.toHaveText(week ?? '');
  await expect(board.getByRole('button', { name: 'Today', exact: true })).toBeEnabled();
  await board.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(title).toHaveText(week ?? '');

  // The wedding shows who is unavailable.
  await expect(board.locator('.hm-cal-entry', { hasText: 'Wedding' }).locator('.hm-cal-away')).toContainText('Mom');

  // Filter by person: Dad's entries are fewer than everyone's, and "Everyone" brings them all back.
  const all = await board.locator('.hm-cal-entry').count();
  await board.getByLabel('Person').selectOption('dad');
  const dad = await board.locator('.hm-cal-entry').count();
  expect(dad).toBeLessThan(all);
  await board.getByLabel('Person').selectOption('all');
  await expect(board.locator('.hm-cal-entry')).toHaveCount(all);

  // Month grid: a day cell opens that day.
  await board.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(title).toHaveText('November 2026');
  await board.locator('.hm-cal-cell[data-date="2026-11-05"]').click();
  await expect(board).toHaveAttribute('data-view', 'day');
  await expect(title).toHaveText('Thu, Nov 5');
  await expect(board.locator('.hm-cal-entry', { hasText: 'Wedding' })).toBeVisible();
});
