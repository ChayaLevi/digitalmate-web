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

/** How far the app is scrolled sideways inside its stage (`overflow: hidden` can still be scrolled by script). */
const stageShift = (page: Page) => page.evaluate(() => document.querySelector('.stage')?.scrollLeft ?? 0);

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
  // dispatchEvent, not click(): click() first scrolls the button into view on both axes, which moves the
  // stage sideways by itself (a real tap does not). The check below is about what the app does.
  await page.getByRole('button', { name: 'Save' }).dispatchEvent('click');
  await expect(page.locator('.hm-notice')).toContainText('Saved. You can add preparations below.');
  // After a save: the short view of the item (details, Edit, Remove), not the whole form.
  await expect(page.locator('.a2ui-surface h3')).toHaveText('School concert');
  await expect(page.getByLabel('Title')).toHaveCount(0);
  await expect(page.locator('.a2ui-actions').first().getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.locator('.a2ui-actions').first().getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect(page.locator('.info-row', { hasText: 'When' })).toContainText('18:00–19:30');
  expect(await stageShift(page)).toBe(0);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
  await page.screenshot({ path: test.info().outputPath('family-saved-event.png') });

  // Two preparations, each saved back to the event's short view.
  for (const title of ['Iron the shirt', 'Charge the camera']) {
    await page.getByRole('button', { name: 'Add preparation' }).last().click();
    await expect(page.locator('.a2ui-surface h3')).toHaveText('Add preparation');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.hm-notice')).toContainText('Saved.');
    await expect(page.locator('.a2ui-surface h3')).toHaveText('School concert');
  }
  const preps = page.locator('.hm-task-list').last().locator('.hm-task');
  await expect(preps).toHaveCount(2);

  // Edit the event: Edit opens the form; Save comes back to the short view.
  await page.locator('.a2ui-actions').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.a2ui-surface h3')).toHaveText('Edit item');
  await page.getByLabel('Notes').fill('Row 3');
  await page.getByLabel('Title').fill('School concert (Maya)');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.hm-notice')).toContainText('Saved.');
  await expect(page.locator('.a2ui-surface h3')).toHaveText('School concert (Maya)');
  await expect(page.locator('.info-row', { hasText: 'Notes' })).toContainText('Row 3');
  await page.getByRole('button', { name: 'Back' }).first().click();

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

test('a form problem shows right above Save, in view, and nothing is saved', async ({ page }) => {
  await openFamily(page, 'en', 'mom');
  await page.getByRole('button', { name: '+ Add' }).click();
  await page.getByLabel('Start time (empty for all day)').fill('18:00');
  await page.getByRole('button', { name: 'Save' }).dispatchEvent('click'); // see the note on dispatchEvent above
  const error = page.locator('.hm-family .a2ui-error');
  await expect(error).toContainText('Add a title.');
  await expect(error).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Save' })).toBeInViewport();
  expect(await stageShift(page)).toBe(0);
  // The very next element is the bar with Save in it.
  await expect(error.locator('xpath=following-sibling::*[1]').getByRole('button', { name: 'Save' })).toBeVisible();
  await expect(page.locator('.hm-notice')).toHaveCount(0);
  await expect(page.locator('.a2ui-surface h3')).toHaveText('Add to the board');
  await page.screenshot({ path: test.info().outputPath('family-form-error.png') });
  // Fixed and saved: the error goes away.
  await page.getByLabel('Title').fill('Dentist');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.a2ui-surface h3')).toHaveText('Dentist');
  await expect(error).toHaveCount(0);
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

// T3.3: live sync and alerts. Two browser contexts are two separate windows with their own sign-in.
test('live sync: Mom assigns the pickup, Dad sees it and an alert without reloading, and his "I\'m on it" reaches Mom', async ({ browser }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom');
    await openFamily(dad, 'zh', 'dad');
    await expect(family(mom)).toHaveAttribute('data-member', 'mom');
    await expect(family(dad)).toHaveAttribute('data-member', 'dad');
    // Both streams are open before anything changes.
    await expect(mom.locator('[data-stream="live"]')).toHaveText('Live');
    await expect(dad.locator('[data-stream="live"]')).toHaveText('实时');
    await expect(dad.locator('.hm-alert')).toHaveCount(0);
    let dadLoads = 0;
    dad.on('framenavigated', frame => {
      if (frame === dad.mainFrame()) dadLoads++;
    });

    // Mom watches from the Family screen: once the pickup is Dad's, it leaves her own My day.
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Family', exact: true }).click();
    await expect(family(mom)).toHaveAttribute('data-screen', 'family');
    const momRow = mom.locator('[data-task-id="pickup-today"]').first();
    await expect(momRow).toHaveAttribute('data-state', 'open');
    await mom.getByRole('button', { name: 'Assign to Dad: Kindergarten pickup' }).first().click();
    await expect(momRow).toHaveAttribute('data-state', 'assigned');

    // Dad's window: the row changes and the alert appears, with no reload.
    const dadRow = dad.locator('[data-task-id="pickup-today"]').first();
    await expect(dadRow).toHaveAttribute('data-state', 'assigned');
    const alert = dad.locator('.hm-alert[data-item-id="pickup-today"]');
    await expect(alert).toContainText('妈妈把「幼儿园接孩子」交给了你');
    expect(dadLoads).toBe(0);
    // Mom made the change, so she gets no alert about it.
    await expect(mom.locator('.hm-alert')).toHaveCount(0);
    await noOverflow(dad);
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('live-alert-zh.png') });

    // Dad answers from the alert; Mom's window shows it confirmed, and the alert is gone.
    await alert.getByRole('button', { name: '我来处理: 幼儿园接孩子' }).click();
    await expect(alert).toHaveCount(0);
    await expect(dadRow).toHaveAttribute('data-state', 'confirmed');
    // Mom's Family screen lists it as waiting for an answer, then drops it once Dad confirmed.
    await expect(momRow).toHaveCount(0);
    expect(await seriousIssues(mom)).toEqual([]);
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

test('live sync: an alert closes by itself when the item is answered in another window', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [mom, dadPhone, dadLaptop] = await Promise.all(contexts.map(c => c.newPage()));
    await openFamily(mom, 'en', 'mom');
    await openFamily(dadPhone, 'en', 'dad');
    await openFamily(dadLaptop, 'en', 'dad');
    for (const page of [mom, dadPhone, dadLaptop]) await expect(page.locator('[data-stream="live"]')).toBeVisible();
    await mom.getByRole('button', { name: 'Assign to Dad: Kindergarten pickup' }).first().click();
    const phoneAlert = dadPhone.locator('.hm-alert[data-item-id="pickup-today"]');
    const laptopAlert = dadLaptop.locator('.hm-alert[data-item-id="pickup-today"]');
    await expect(phoneAlert).toContainText('Mom assigned you: Kindergarten pickup');
    await expect(laptopAlert).toBeVisible();
    // Dad answers on the board in one window (not on the alert): the other window's alert goes away.
    await dadLaptop.locator('[data-task-id="pickup-today"]').first().getByRole('button', { name: "I'm on it: Kindergarten pickup" }).click();
    await expect(phoneAlert).toHaveCount(0);
    await expect(laptopAlert).toHaveCount(0);
    await expect(dadPhone.locator('[data-task-id="pickup-today"]').first()).toHaveAttribute('data-state', 'confirmed');
  } finally {
    await Promise.all(contexts.map(c => c.close()));
  }
});

// T4.1: reminders and escalation, driven by the demo clock.
async function pickupStart(request: APIRequestContext): Promise<number> {
  const state = (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as { items: Array<{ id: string; start?: string }> };
  return Date.parse(state.items.find(i => i.id === 'pickup-today')?.start as string);
}

test('reminders: the demo clock jumps, Dad is reminded, Mom gets the escalation, and her "I\'ll take it" closes both', async ({ browser, request }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom');
    await openFamily(dad, 'zh', 'dad');
    await expect(mom.locator('[data-stream="live"]')).toBeVisible();
    await expect(dad.locator('[data-stream="live"]')).toBeVisible();
    // The demo clock chip shows in both windows, with no offset after a reset.
    await expect(mom.locator('.hm-demo-clock')).toContainText('Demo clock');
    await expect(dad.locator('.hm-demo-clock')).toContainText('演示时钟');
    await expect(mom.locator('.hm-demo-clock')).toHaveAttribute('data-offset', '0');

    await mom.getByRole('button', { name: 'Assign to Dad: Kindergarten pickup' }).first().click();
    const dadAlert = dad.locator('.hm-alert[data-item-id="pickup-today"]');
    await expect(dadAlert).toContainText('妈妈把「幼儿园接孩子」交给了你');

    // Jump to 25 minutes before the pickup (the panel with exact jumps is T9.1; the API does it here).
    const session = await request.post(`${BASE}/api/homemind/session`, { data: { memberId: 'mom' } });
    const { token } = (await session.json()) as { token: string };
    const minutes = Math.ceil(((await pickupStart(request)) - Date.now()) / 60_000) - 25;
    const jump = await request.post(`${BASE}/api/homemind/demo/clock`, { headers: { 'x-homemind-session': token }, data: { minutes } });
    expect(jump.ok()).toBe(true);
    await expect(dad.locator('.hm-demo-clock')).toHaveAttribute('data-offset', String(minutes * 60_000));
    await expect(mom.locator('.hm-demo-clock')).toContainText(`+${minutes} min`);

    await expect(dadAlert).toHaveAttribute('data-kind', 'reminder');
    await expect(dadAlert).toContainText('请确认：');
    await expect(dadAlert).toContainText('幼儿园接孩子');
    const momAlert = mom.locator('.hm-alert[data-kind="escalation"]');
    await expect(momAlert).toContainText(/Kindergarten pickup at \d\d:\d\d is not confirmed yet\./);
    await expect(momAlert).not.toContainText('Dad');

    // Ten more minutes on the chip: the (simulated) backup contact is messaged, and both parents are told.
    await mom.getByRole('button', { name: '+15 min (demo clock)' }).click();
    await expect(mom.locator('.hm-alert[data-kind="backup"]')).toContainText('Grandma Lin was sent a short message to get in touch. (Simulated)');
    await expect(dad.locator('.hm-alert[data-kind="backup"]')).toContainText('林奶奶');
    await expect(momAlert).toBeVisible();
    await noOverflow(mom);
    await noOverflow(dad);
    expect(await seriousIssues(mom)).toEqual([]);
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('reminder-zh.png') });
    await mom.screenshot({ path: test.info().outputPath('escalation-en.png') });

    // Mom takes it from the escalation: every alert of that reminder closes, in both windows.
    await momAlert.getByRole('button', { name: "I'll take it: Kindergarten pickup" }).click();
    await expect(mom.locator('.hm-alert')).toHaveCount(0);
    await expect(dad.locator('.hm-alert')).toHaveCount(0);
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});
