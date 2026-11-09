import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addDays, localParts, zonedToUtc } from '../server/homemind/clock';

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

async function openFamily(page: Page, lang: 'en' | 'zh', member?: string, persona?: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(([language, companion]) => {
    if (!window.sessionStorage.getItem('dm-e2e-initialized')) {
      window.localStorage.clear();
      window.localStorage.setItem('digitalmate.web.v2.welcomeSeen.v1', 'true');
      window.localStorage.setItem('digitalmate.web.v2.language.v1', JSON.stringify(language));
      if (companion) window.localStorage.setItem('digitalmate.web.v2.persona.v1', JSON.stringify(companion));
      window.sessionStorage.setItem('dm-e2e-initialized', '1');
    }
  }, [lang, persona ?? ''] as const);
  await page.goto(`${BASE}/${member ? `?member=${member}` : ''}`);
  await page.getByRole('navigation', { name: lang === 'zh' ? '主导航' : 'Main navigation' }).getByRole('button', { name: lang === 'zh' ? '家庭' : 'Family' }).click();
}

const family = (page: Page) => page.locator('.hm-family');

async function seriousIssues(page: Page) {
  // Wait for fades (`surfaceIn`) to end; looping animations (the background glow) never finish.
  // allSettled: a live re-render can cancel a fade, which rejects its promise.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
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
    const names = lang === 'zh' ? ['我的一天', '家庭', '日历', '搜索', '规则', '记忆', '服务', '动态', '设置', '+ 添加'] : ['My day', 'Family', 'Calendar', 'Search', 'Rules', 'Memory', 'Services', 'Activity', 'Settings', '+ Add'];
    const nav = family(page).getByRole('navigation', { name: lang === 'zh' ? '家庭页面' : 'Family screens' });
    // Every screen button is in view without sideways scrolling: a hidden scroll hid the last ones.
    const navBox = await nav.boundingBox();
    expect(navBox).not.toBeNull();
    for (const name of names) {
      const box = await nav.getByRole('button', { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(navBox!.x + navBox!.width + 1);
    }
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

// T4.2: Scene 1 as scripted, answered from the board rows, and the Settings screen.
async function momToken(request: APIRequestContext): Promise<string> {
  const session = await request.post(`${BASE}/api/homemind/session`, { data: { memberId: 'mom' } });
  return ((await session.json()) as { token: string }).token;
}

test('Scene 1: Mom assigns the pickup, Dad does not confirm, the clock jumps, Mom is alerted and takes it from the board', async ({ browser, request }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom');
    await openFamily(dad, 'zh', 'dad');
    await expect(mom.locator('[data-stream="live"]')).toBeVisible();
    await expect(dad.locator('[data-stream="live"]')).toBeVisible();

    // 1. Mom assigns the kindergarten pickup to Dad. It is on his screen at once, with an alert.
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Family', exact: true }).click();
    await expect(family(mom)).toHaveAttribute('data-screen', 'family');
    await mom.getByRole('button', { name: 'Assign to Dad: Kindergarten pickup' }).first().click();
    const dadRow = dad.locator('[data-task-id="pickup-today"]').first();
    await expect(dadRow).toHaveAttribute('data-state', 'assigned');
    await expect(dad.locator('.hm-alert[data-item-id="pickup-today"]')).toContainText('妈妈把「幼儿园接孩子」交给了你');

    // 2. The demo clock jumps to 55 minutes before the pickup: Dad is reminded, on the alert and on the row.
    const token = await momToken(request);
    const minutes = Math.ceil(((await pickupStart(request)) - Date.now()) / 60_000) - 55;
    expect((await request.post(`${BASE}/api/homemind/demo/clock`, { headers: { 'x-homemind-session': token }, data: { minutes } })).ok()).toBe(true);
    await expect(dad.locator('.hm-alert[data-item-id="pickup-today"]')).toHaveAttribute('data-kind', 'reminder');
    await expect(dadRow).toContainText('已提醒');
    await expect(dadRow.getByRole('button', { name: '稍后提醒: 幼儿园接孩子' })).toBeVisible();
    await expect(dadRow.getByRole('button', { name: '我来处理: 幼儿园接孩子' })).toBeVisible();
    await expect(mom.locator('.hm-alert')).toHaveCount(0);

    // 3. Dad does not answer. Two jumps of 15 minutes on Mom's chip: Mom gets the escalation, in neutral words.
    await mom.getByRole('button', { name: '+15 min (demo clock)' }).click();
    await mom.getByRole('button', { name: '+15 min (demo clock)' }).click();
    const momAlert = mom.locator('.hm-alert[data-kind="escalation"]');
    await expect(momAlert).toContainText(/Kindergarten pickup at \d\d:\d\d is not confirmed yet\./);
    await expect(momAlert).not.toContainText('Dad');
    const momRow = mom.locator('[data-task-id="pickup-today"]').first();
    await expect(momRow).toContainText('reminder sent');
    await expect(momRow.getByRole('button', { name: 'Got it: Kindergarten pickup' })).toBeVisible();
    await noOverflow(mom);
    await noOverflow(dad);
    expect(await seriousIssues(mom)).toEqual([]);
    expect(await seriousIssues(dad)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('scene1-mom-en.png') });
    await dad.screenshot({ path: test.info().outputPath('scene1-dad-zh.png') });

    // 4. Mom takes it from the row on her board: the pickup is hers, and every alert closes in both windows.
    await momRow.getByRole('button', { name: "I'll take it: Kindergarten pickup" }).click();
    await expect(mom.locator('.hm-alert')).toHaveCount(0);
    await expect(dad.locator('.hm-alert')).toHaveCount(0);
    const st = (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as { items: Array<{ id: string; ownership: { state: string; ownerId?: string } }> };
    expect(st.items.find(i => i.id === 'pickup-today')?.ownership).toMatchObject({ state: 'assigned', ownerId: 'mom' });
    await expect(dad.locator('[data-task-id="pickup-today"]')).toHaveCount(0);
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

test('Settings: a parent saves quiet hours, pause and the backup contact; the other parent sees it live; a teen sets only her quiet hours', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [mom, dad, maya] = await Promise.all(contexts.map(c => c.newPage()));
    await openFamily(mom, 'en', 'mom');
    await openFamily(dad, 'zh', 'dad');
    await openFamily(maya, 'en', 'maya');
    for (const page of [mom, dad, maya]) await expect(page.locator('[data-stream="live"]')).toBeVisible();
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await family(dad).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '设置', exact: true }).click();
    await family(maya).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Settings', exact: true }).click();

    await expect(family(mom)).toContainText('Homemind helps, but an alert can be missed.');
    await expect(family(mom)).toContainText('In this demo nothing is sent to the backup contact.');
    await expect(family(dad)).toContainText('Homemind 会帮忙，但提醒仍可能被错过。');
    await expect(mom.getByLabel('Backup contact name (empty for none)')).toHaveValue('Grandma Lin');
    await expect(dad.getByLabel('备用联系人姓名（留空表示无）')).toHaveValue('林奶奶');
    const dadPause = dad.getByLabel('暂停自动操作（提醒仍会发送）');
    await expect(dadPause).not.toBeChecked();

    // A half-filled quiet-hours pair is a form problem, shown above Save, and nothing is saved.
    await mom.getByLabel('Quiet from').fill('');
    await mom.getByRole('button', { name: 'Save settings' }).click();
    await expect(family(mom).locator('.a2ui-error')).toContainText('Fill in both quiet-hours times, or leave both empty.');

    await mom.getByLabel('Quiet from').fill('21:30');
    await mom.getByLabel('Quiet until').fill('06:30');
    await mom.getByLabel('Pause automatic actions (reminders still fire)').check();
    await mom.getByRole('radio', { name: /2 Organizes/ }).click();
    await mom.getByLabel('Backup contact name (empty for none)').fill('Aunt Wei');
    await mom.getByRole('radio', { name: 'Phone call' }).click();
    await mom.getByRole('button', { name: 'Save settings' }).click();
    await expect(family(mom).locator('.hm-notice')).toContainText('Settings saved.');
    await expect(mom.getByLabel('Quiet from')).toHaveValue('21:30');
    await expect(mom.getByRole('radio', { name: /2 Organizes/ })).toHaveAttribute('aria-checked', 'true');

    // Dad's open Settings screen follows without a reload.
    await expect(dadPause).toBeChecked();
    await expect(dad.getByLabel('备用联系人姓名（留空表示无）')).toHaveValue('Aunt Wei');
    await expect(dad.getByRole('radio', { name: '电话' })).toHaveAttribute('aria-checked', 'true');
    // Dad's own quiet hours are his: still the seeded ones.
    await expect(dad.getByLabel('免打扰开始')).toHaveValue('22:00');

    // Maya: only her quiet hours; the family settings are rows she can't change.
    await expect(maya.getByLabel('Quiet from')).toHaveValue('22:30');
    await expect(maya.getByLabel(/Pause automatic actions/)).toHaveCount(0);
    await expect(family(maya)).toContainText('Only a parent can change these.');
    await expect(family(maya)).toContainText('Paused. Reminders still fire.');
    await maya.getByLabel('Quiet from').fill('23:00');
    await maya.getByRole('button', { name: 'Save settings' }).click();
    await expect(family(maya).locator('.hm-notice')).toContainText('Settings saved.');
    await expect(maya.getByLabel('Quiet from')).toHaveValue('23:00');

    for (const page of [mom, dad, maya]) {
      await noOverflow(page);
      expect(await seriousIssues(page)).toEqual([]);
    }
    await mom.screenshot({ path: test.info().outputPath('settings-mom-en.png'), fullPage: true });
    await dad.screenshot({ path: test.info().outputPath('settings-dad-zh.png'), fullPage: true });
  } finally {
    await Promise.all(contexts.map(c => c.close()));
  }
});

// T5.2: chat with the Family companion, against the simulated model (HOMEMIND_LLM=fake on port 5176).
/** Sends one message and returns its reply bubble. Each test waits for the reply's text before the next send. */
async function chatTo(page: Page, text: string) {
  const before = await page.locator('.message-assistant').count();
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer-send').click();
  return page.locator('.message-assistant').nth(before);
}

async function openChat(page: Page, lang: 'en' | 'zh') {
  await page.getByRole('navigation', { name: lang === 'zh' ? '主导航' : 'Main navigation' }).getByRole('button', { name: lang === 'zh' ? '对话' : 'Chat' }).click();
}

test('chat (T5.2): Mom asks, adds, reassigns and asks why; Dad sees it live; Undo from the chat card works', async ({ browser }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom', 'family');
    await openFamily(dad, 'zh', 'dad', 'family');
    await expect(family(mom)).toHaveAttribute('data-member', 'mom');
    await expect(family(dad)).toHaveAttribute('data-member', 'dad');
    await expect(dad.locator('[data-stream="live"]')).toHaveText('实时');
    const dadRow = dad.locator('[data-task-id="pickup-today"]').first();
    await expect(dadRow).toHaveAttribute('data-state', 'open');

    await openChat(mom, 'en');
    // Answers from the board, labelled as the simulated model.
    const answer = await chatTo(mom, "What's on today?");
    await expect(answer).toContainText('Today on the board');
    await expect(answer).toContainText('Kindergarten pickup');
    await expect(answer).toContainText('Simulated model');

    // Adds.
    const added = await chatTo(mom, 'Remind me to buy milk tomorrow');
    await expect(added).toContainText('Added to the board');
    await expect(added.locator('[data-task-id]')).toHaveCount(1);

    // Reassigns: Dad's window shows it without reloading.
    const assigned = await chatTo(mom, 'Assign the pickup to Dad');
    await expect(assigned).toContainText('Assigned “Kindergarten pickup” to Dad. Dad still needs to confirm.');
    await expect(dadRow).toHaveAttribute('data-state', 'assigned');

    // Explains, from Homemind's own record.
    const why = await chatTo(mom, 'Why is the kindergarten pickup on the board?');
    await expect(why).toContainText('not from PPMA');
    await expect(why).toContainText('Mom assigned to Dad');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('chat-en.png'), fullPage: true });

    // Dad chats in Chinese.
    await openChat(dad, 'zh');
    const dadWhy = await chatTo(dad, '为什么有幼儿园接孩子？');
    await expect(dadWhy).toContainText('不是来自 PPMA');
    await expect(dadWhy).toContainText('模拟模型');
    expect(await seriousIssues(dad)).toEqual([]);

    // Undo on the assignment's card: the Family tab runs it, and the pickup is open again for Dad.
    await dad.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '家庭' }).click();
    await expect(dad.locator('[data-task-id="pickup-today"]').first()).toHaveAttribute('data-state', 'assigned');
    await assigned.getByRole('button', { name: 'Undo' }).click();
    await expect(family(mom)).toBeVisible();
    await expect(dad.locator('[data-task-id="pickup-today"]').first()).toHaveAttribute('data-state', 'open');
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

test('chat (T5.2): a teen asking about a Parents-only item gets no trace of it', async ({ page }) => {
  await openFamily(page, 'en', 'maya', 'family');
  await expect(family(page)).toHaveAttribute('data-member', 'maya');
  await openChat(page, 'en');
  const reply = await chatTo(page, 'When is the counselor meeting?');
  await expect(reply).toContainText('Simulated model');
  await expect(reply).not.toContainText(/counselor|辅导/i);
});

test('screenshot (T5.3): Mom sends the 接龙 screenshot in chat; proposed items with quotes; Dad sees them live and one tap approves the party with its preparation', async ({ browser }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom', 'family');
    await openFamily(dad, 'zh', 'dad', 'family');
    await expect(family(dad)).toHaveAttribute('data-member', 'dad');
    await expect(dad.locator('[data-stream="live"]')).toHaveText('实时');
    // The Family screen lists what waits for approval.
    await family(dad).getByRole('button', { name: '家庭', exact: true }).click();

    await openChat(mom, 'en');
    const before = await mom.locator('.message-assistant').count();
    await mom.locator('.composer-wrap input[type="file"]:not([capture])').setInputFiles('e2e/fixtures/homemind/jielong-sample.png');
    await mom.locator('.composer-send').click();
    const card = mom.locator('.message-assistant').nth(before);
    await expect(card).toContainText('waiting for approval');
    await expect(card).toContainText('秋季水果派对');
    await expect(card).toContainText('切好装盒，够8个小朋友吃');
    await expect(card).toContainText('苹果 (乐乐妈妈)');
    await expect(card).toContainText('Check the quotes before approving');
    await expect(card).toContainText('Simulated model');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('screenshot-card-en.png'), fullPage: true });

    // Dad's board shows the proposed party without a reload, with Approve.
    const partyRow = dad.locator('[data-task-id]', { hasText: '秋季水果派对' }).first();
    await expect(partyRow).toBeVisible();
    await expect(partyRow).toContainText('待确认');
    await partyRow.getByRole('button', { name: /^确认添加/ }).first().dispatchEvent('click'); // see the note on dispatchEvent above
    // Approved, the party is an event with participants only: it leaves the board's lists; its
    // preparation is what waits for someone ("谁来负责？").
    await expect(dad.locator('[data-task-id]', { hasText: '秋季水果派对' })).toHaveCount(0);
    const fruitRow = dad.locator('[data-task-id]', { hasText: '切好装盒的水果' }).first();
    await expect(fruitRow).toHaveAttribute('data-state', 'open');
    await expect(fruitRow).not.toContainText('待确认');
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('screenshot-approved-zh.png'), fullPage: true });

    // The preparation was approved with it: asking the bridge as Dad.
    const state = await (await dad.request.get(`${BASE}/api/homemind/debug/state`)).json();
    const party = state.items.find((i: { title: string }) => i.title === '秋季水果派对');
    expect(party.status).toBe('open');
    expect(state.items.find((i: { parentEventId?: string }) => i.parentEventId === party.id).status).toBe('open');
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

test('preferences (T5.4): saved from chat with reason and scope; a hard one blocks a choice in chat and on the board; the cake applies only to Noa’s kindergarten party', async ({ browser }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom', 'family');
    await openFamily(dad, 'zh', 'dad', 'family');
    await expect(family(mom)).toHaveAttribute('data-member', 'mom');
    await expect(family(dad)).toHaveAttribute('data-member', 'dad');

    // A new hard preference, saved and shown for checking.
    await openChat(mom, 'en');
    const kiwi = await chatTo(mom, 'Noa is allergic to kiwi');
    await expect(kiwi).toContainText('Saved as a family preference');
    await expect(kiwi).toContainText('Never overridden');
    await expect(kiwi.getByRole('button', { name: 'Undo' })).toBeVisible();

    // The cake preference, corrected with Mom's own reason, and its scope.
    const cake = await chatTo(mom, 'For kindergarten parties, bake a cake because Noa enjoys it most');
    await expect(cake).toContainText('Updated the saved preference');
    await expect(cake).toContainText('Noa enjoys it most');
    await expect(cake).toContainText('kindergarten-party');
    await expect(cake).toContainText('Can be overridden');

    // The hard block in chat: nothing is added.
    const blocked = await chatTo(mom, "Bring kiwi salad for Family dinner at Grandma's");
    await expect(blocked).toContainText('Not added');
    await expect(blocked).toContainText('Noa is allergic to kiwi');
    await expect(blocked).toContainText('Simulated model');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('preferences-chat-en.png'), fullPage: true });

    // And in Chinese, for the seeded peanut allergy.
    await openChat(dad, 'zh');
    const dadBlocked = await chatTo(dad, '要带花生饼干去奶奶家吃饭');
    await expect(dadBlocked).toContainText('没有添加');
    await expect(dadBlocked).toContainText('不吃花生');
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('preferences-chat-zh.png'), fullPage: true });

    // On the board: the same block on the Add form.
    await mom.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Family' }).click();
    await mom.locator('[data-task-id="family-dinner"]').first().getByRole('button', { name: /Edit|Family dinner/ }).first().click();
    await mom.getByRole('button', { name: 'Add preparation' }).last().click();
    await expect(mom.locator('.a2ui-surface h3')).toHaveText('Add preparation');
    await mom.getByLabel('Title').fill('Peanut cookies');
    await mom.getByRole('button', { name: 'Save' }).dispatchEvent('click');
    await expect(mom.locator('.hm-notice')).toContainText('Not saved: a family preference that is never overridden rules this out');

    // Scope: the cake shows on Noa's kindergarten party, not on her swimming gala.
    for (const [title, hasCake] of [['Kindergarten autumn party', true], ['Swimming gala', false]] as const) {
      await mom.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Family' }).click();
      await mom.getByRole('button', { name: '+ Add' }).first().click();
      await expect(mom.locator('.a2ui-surface h3')).toHaveText('Add to the board');
      await mom.getByLabel('Title').fill(title);
      await mom.getByLabel('Start time (empty for all day)').fill('15:00');
      await mom.getByLabel('End time').fill('16:00');
      await mom.getByLabel('For Noa').check();
      await mom.getByRole('button', { name: 'Save' }).dispatchEvent('click');
      await expect(mom.locator('.a2ui-surface h3')).toHaveText(title);
      const applies = mom.locator('.a2ui-surface', { hasText: 'Family preferences that apply' });
      await expect(applies).toContainText('No peanuts');
      if (hasCake) await expect(applies).toContainText('For kindergarten parties, bake a cake');
      else await expect(applies).not.toContainText('bake a cake');
    }
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('preferences-item-en.png'), fullPage: true });
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

// T6.1: the e2e server points PPMA at a port where nothing listens (playwright.config.ts).
test('PPMA offline (T6.1): the chip says so, and the board keeps working', async ({ page, request }) => {
  const health = (await (await request.get(`${BASE}/api/homemind/health`)).json()) as { ppma: string };
  expect(['offline', 'connecting']).toContain(health.ppma);
  await openFamily(page, 'en', 'mom');
  await expect(family(page)).toHaveAttribute('data-member', 'mom');
  const chip = family(page).locator('[data-ppma="offline"]');
  await expect(chip).toHaveText('PPMA offline');
  // A board action does not wait for PPMA.
  const row = page.locator('[data-task-id="library-books"]').first();
  const started = Date.now();
  await row.getByRole('button', { name: "I'll take it: Return the library books" }).click();
  await expect(row).toHaveAttribute('data-state', 'confirmed');
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await seriousIssues(page)).toEqual([]);
});

test('PPMA offline (T6.1): the chip in Chinese', async ({ page }) => {
  await openFamily(page, 'zh', 'dad');
  await expect(family(page)).toHaveAttribute('data-member', 'dad');
  await expect(family(page).locator('[data-ppma="offline"]')).toHaveText('PPMA 离线');
  await noOverflow(page);
  expect(await seriousIssues(page)).toEqual([]);
});

// T6.2: PPMA is unreachable on the e2e server, so the memory screen must not invent anything.
test('Memory (T6.2): with PPMA offline it says so, shows only what Homemind saved, and a preference can be removed', async ({ page }) => {
  await openFamily(page, 'en', 'mom');
  await expect(family(page)).toHaveAttribute('data-member', 'mom');
  const nav = family(page).getByRole('navigation', { name: 'Family screens' });
  await nav.getByRole('button', { name: 'Memory', exact: true }).click();
  const surface = page.locator('.a2ui-surface');
  await expect(surface).toContainText('PPMA offline');
  await expect(surface).toContainText('Only what Homemind itself saved is shown');
  await expect(surface).not.toContainText('What PPMA remembers');
  await expect(surface).toContainText('For kindergarten parties, bake a cake');
  await expect(surface).toContainText('No peanuts');
  await noOverflow(page);
  expect(await seriousIssues(page)).toEqual([]);
  // A parent removes the soft preference; it is gone from the screen, and the other stays.
  await surface.getByRole('button', { name: /^Remove: For kindergarten parties, bake a cake/ }).click();
  await expect(surface).not.toContainText('For kindergarten parties, bake a cake');
  await expect(surface).toContainText('No peanuts');
  await expect(family(page)).toContainText('Preference removed');
});

test('Memory (T6.2): a teen cannot remove a hard preference, and the screen reads in Chinese', async ({ page }) => {
  await openFamily(page, 'zh', 'maya');
  await expect(family(page)).toHaveAttribute('data-member', 'maya');
  await family(page).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '记忆', exact: true }).click();
  const surface = page.locator('.a2ui-surface');
  await expect(surface).toContainText('PPMA 离线');
  await expect(surface.getByRole('button', { name: /^删除: / })).toHaveCount(1);
  await noOverflow(page);
  expect(await seriousIssues(page)).toEqual([]);
});

// T7.2: the simulated services, each card labelled on the card itself.
test('Services (T7.2): every simulated card is labelled; posting the next group message reaches the other window live', async ({ browser }) => {
  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  const mom = await momContext.newPage();
  const dad = await dadContext.newPage();
  await openFamily(mom, 'en', 'mom');
  await openFamily(dad, 'zh', 'dad');
  await expect(family(mom)).toHaveAttribute('data-member', 'mom');
  await expect(family(dad)).toHaveAttribute('data-member', 'dad');
  await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Services', exact: true }).click();
  await family(dad).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '服务', exact: true }).click();

  const momSurface = mom.locator('.a2ui-surface');
  const dadSurface = dad.locator('.a2ui-surface');
  await expect(momSurface).toContainText('Kindergarten group');
  await expect(momSurface).toContainText('No messages yet.');
  // Pizza shop, babysitters, inbox and weather: one List each, and each row carries the badge.
  const momLists = momSurface.locator('.a2ui-list');
  await expect(momLists).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    const list = momLists.nth(i);
    await expect(list.locator('.hm-sim-badge').first()).toHaveText('Simulated');
    expect(await list.locator('.a2ui-list-row').count()).toBe(await list.locator('.hm-sim-badge').count());
  }
  await expect(momSurface).toContainText('Your books are due tomorrow');
  await expect(dadSurface).not.toContainText('您借的书明天到期');
  await expect(dadSurface).toContainText('下周六泳池关闭');

  await momSurface.getByRole('button', { name: /^Post next group message \(demo\) \(3\)/ }).click();
  await expect(family(mom)).toContainText('A new message arrived in the simulated group.');
  await expect(momSurface).toContainText('各位家长好');
  await expect(momLists).toHaveCount(5);
  // Dad's window re-reads on the stream message, without a reload.
  await expect(dadSurface).toContainText('各位家长好');
  await expect(dadSurface.locator('.a2ui-list').first().locator('.hm-sim-badge').first()).toHaveText('模拟');
  await noOverflow(dad);
  expect(await seriousIssues(dad)).toEqual([]);
  await dad.screenshot({ path: test.info().outputPath('services-zh.png'), fullPage: true });
  await mom.screenshot({ path: test.info().outputPath('services-en.png'), fullPage: true });
  await momContext.close();
  await dadContext.close();
});

// T7.3: Scene 4 as scripted: the wedding marks Mom away, her pickup is flagged, the Friday pizza card is
// prepared smaller and waits for one tap, a babysitter message is drafted, and "Why?" says where it came from.
type DebugState = { items: Array<{ id: string; start?: string; ownership: { state: string } }>; actionCards: Array<{ id: string; adapter: string; status: string; payload: Record<string, unknown> }>; services?: { pizzaOrders: Array<{ total: number }> }; clockOffsetMs: number };
const debugState = async (request: APIRequestContext) => (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as DebugState;

async function jumpTo(request: APIRequestContext, token: string, target: number) {
  const state = await debugState(request);
  const minutes = Math.ceil((target - (Date.now() + state.clockOffsetMs)) / 60_000);
  if (minutes < 1) return;
  expect((await request.post(`${BASE}/api/homemind/demo/clock`, { headers: { 'x-homemind-session': token }, data: { minutes } })).ok()).toBe(true);
}

test('Scene 4: the wedding marks Mom away, her pickup is flagged, the Friday pizza card is smaller and waits for a tap, a babysitter is drafted, and Why? explains', async ({ browser, request }) => {
  const HOUR = 3_600_000;
  const token = await momToken(request);
  // The seeded Tuesday pickup is at 16:30. Start the scene on the Monday before it, 10:00, so "Tuesday to
  // Saturday" and "Friday" are the coming days whatever weekday the test runs on.
  const tuesdayPickup = Date.parse((await debugState(request)).items.find(i => i.id === 'pickup-tuesday')?.start as string);
  await jumpTo(request, token, tuesdayPickup - 30.5 * HOUR);
  const fridayAt1805 = tuesdayPickup + 3 * 24 * HOUR + 2 * HOUR - 25 * 60_000;

  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom', 'family');
    await openFamily(dad, 'zh', 'dad');
    await expect(family(mom)).toHaveAttribute('data-member', 'mom');
    await expect(dad.locator('[data-stream="live"]')).toBeVisible();

    // 1. Mom tells the Family companion about the wedding. She is away from Tuesday to Saturday.
    await openChat(mom, 'en');
    await chatTo(mom, "I'm at my cousin's wedding from Tuesday to Saturday");
    await expect.poll(async () => (await debugState(request)).items.find(i => i.id === 'pickup-tuesday')?.ownership.state, { timeout: 15_000 }).toBe('open');

    // 2. Her Tuesday pickup is flagged on Dad's board: "Who's taking this?".
    await family(dad).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '家庭', exact: true }).click();
    await expect(dad.locator('[data-task-id="pickup-tuesday"]').first()).toHaveAttribute('data-state', 'open');

    // 3. The Friday rule looks at the calendar (the demo control instead of waiting for Friday 18:00).
    await mom.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Family' }).click();
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Rules', exact: true }).click();
    await expect(family(mom)).toHaveAttribute('data-screen', 'rules');
    await mom.getByRole('button', { name: /^Prepare the next card now \(demo\)/ }).click();
    await expect(mom.locator('.a2ui-surface')).toContainText('card prepared');
    await expect(mom.locator('.a2ui-surface')).toContainText('3 at home (Mom away)');

    // 4. On My day the card waits for one tap: smaller order, labelled simulated, in both languages.
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'My day', exact: true }).click();
    const momPizza = mom.locator('.approval-card', { hasText: 'Friday pizza night: order' });
    await expect(momPizza).toContainText('1 × Large margherita, 1 × Medium margherita · 154 CNY');
    await expect(momPizza).toContainText('for 3 at home (Mom away)');
    await expect(momPizza.locator('.hm-sim-badge')).toHaveText('Simulated');
    await family(dad).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '我的一天', exact: true }).click();
    const dadPizza = dad.locator('.approval-card', { hasText: '周五披萨之夜：下单' });
    await expect(dadPizza).toContainText('在家 3 人');
    await expect(dadPizza.locator('.hm-sim-badge')).toHaveText('模拟');

    // 5. Dad taps "Why?": the rule, who is away and why, and the source is the rule (never PPMA).
    await dadPizza.getByRole('button', { name: '为什么？' }).click();
    await expect(family(dad)).toContainText('来自 Homemind 规则');
    await expect(family(dad)).toContainText('来源: Homemind 规则');
    await noOverflow(dad);
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('scene4-card-zh.png'), fullPage: true });

    // 6. Dad has a work dinner on Friday evening too: both parents are out. The card is replaced at once,
    //    smaller again, and a message to a babysitter is drafted as its own card.
    const dadToken = ((await (await request.post(`${BASE}/api/homemind/session`, { data: { memberId: 'dad' } })).json()) as { token: string }).token;
    const dinner = await request.post(`${BASE}/api/homemind/items`, {
      headers: { 'x-homemind-session': dadToken },
      data: { type: 'event', title: 'Work dinner', start: new Date(fridayAt1805 - 5 * 60_000).toISOString(), end: new Date(fridayAt1805 + 4 * HOUR - 5 * 60_000).toISOString(), unavailableMemberIds: ['dad'] }
    });
    expect(dinner.ok()).toBe(true);
    await expect(momPizza).toContainText('1 × Large margherita · 89 CNY');
    await expect(momPizza).toContainText('for 2 at home (Mom, Dad away)');
    const momSitter = mom.locator('.approval-card', { hasText: 'Babysitter for' });
    await expect(momSitter).toContainText('Xiao Chen');
    await expect(momSitter.locator('.hm-sim-badge')).toHaveText('Simulated');
    await expect(family(mom)).toContainText('replaced: the calendar changed');
    await momSitter.getByRole('button', { name: 'Why?' }).click();
    await expect(family(mom)).toContainText('Both parents are out');
    await expect(family(mom)).toContainText('(Source: a Homemind rule)');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('scene4-cards-en.png'), fullPage: true });

    // 7. Friday, 18:05: Dad taps Confirm on the pizza card. The simulated shop gets the order once.
    await jumpTo(request, token, fridayAt1805);
    await dad.locator('.approval-card', { hasText: '周五披萨之夜：下单' }).getByRole('button', { name: '确认' }).click();
    await expect(family(dad)).toContainText('已完成，只发送到模拟服务。');
    await expect.poll(async () => (await debugState(request)).services?.pizzaOrders.map(o => o.total)).toEqual([89]);
    await expect(mom.locator('.approval-card', { hasText: 'Friday pizza night: order' })).toHaveCount(0);
    await expect(family(mom)).toContainText('Friday pizza night: order: done (simulated)');
    // Nobody tapped the babysitter card, so nothing was sent.
    expect((await debugState(request)).actionCards.find(c => c.adapter === 'babysitter' && c.status === 'pending')).toBeTruthy();
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

// T7.4: Scene 2 as scripted: a 接龙 sign-up arrives in the simulated group, Homemind claims apples and tells
// the family, "Change" switches to cake from the saved preference (with its reason), and the preparations follow.
test('Scene 2: a 接龙 sign-up arrives, Homemind claims apples and alerts the family, Change switches to cake from the saved preference, preparations follow', async ({ browser, request }) => {
  const token = await momToken(request);
  // Start on the coming Monday 10:00 in the family's zone, so Thursday's party and Wednesday's deadline are ahead.
  const state = (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as { family: { timezone: string }; clockOffsetMs: number };
  const zone = state.family.timezone;
  const today = localParts(Date.now() + state.clockOffsetMs, zone).date;
  let monday = 0;
  for (let d = 1; d <= 8 && !monday; d++) {
    const date = addDays(today, d);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) monday = zonedToUtc(date, '10:00', zone);
  }
  await jumpTo(request, token, monday);

  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom');
    await openFamily(dad, 'zh', 'dad');
    await expect(family(mom)).toHaveAttribute('data-member', 'mom');
    await expect(dad.locator('[data-stream="live"]')).toBeVisible();
    const momSurface = mom.locator('.a2ui-surface');

    // 1. Off by default. Mom turns it on for the group: food only, posted on its own (level 4, simulated group).
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Services', exact: true }).click();
    await expect(momSurface).toContainText('Off. Homemind does not sign the family up for anything here.');
    await momSurface.getByRole('button', { name: 'Turn on: post on its own (level 4)' }).click();
    await expect(momSurface).toContainText('On, approved by Mom');
    await expect(momSurface).toContainText('Posts a claim on its own (level 4, simulated group only).');

    // 2. The teacher's message, then the 接龙 sign-up, arrive in the simulated group. Homemind claims apples there.
    await momSurface.getByRole('button', { name: /^Post next group message \(demo\) \(3\)/ }).click();
    await expect(momSurface).toContainText('各位家长好');
    await momSurface.getByRole('button', { name: /^Post next group message \(demo\) \(2\)/ }).click();
    await expect(momSurface).toContainText('3. 诺娅妈妈 苹果');
    await expect(momSurface).toContainText('posted by Homemind · claim');

    // 3. The family is told: Dad's window gets the notice without a reload, labelled simulated.
    const dadNotice = dad.locator('.hm-alert[data-kind="group"]');
    await expect(dadNotice).toContainText('Homemind 已替家里认领苹果：幼儿园秋季美食派对。（模拟群）');

    // 4. My day: what was signed up for, read by fixed rules, and the choices to change to. Cake first, with the reason.
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'My day', exact: true }).click();
    const claimRow = mom.locator('[data-task-id="claim-claim-grp-msg-2"]');
    await expect(claimRow).toContainText('Signed up: 苹果 (apples) · Kindergarten autumn food party');
    await expect(claimRow).toContainText('read by fixed rules, not the model');
    await expect(claimRow.locator('.hm-sim-badge')).toHaveText('Simulated');
    const cakeRow = mom.locator('[data-task-id="alt-claim-grp-msg-2-cake"]');
    await expect(cakeRow).toContainText('Saved preference: “For kindergarten parties, bake a cake” because Noa enjoys baking it with us the most');
    await expect(cakeRow).toContainText('someone has to make it');
    await expect(mom.locator('.hm-task', { hasText: 'Buy apples for the kindergarten party (8 children)' })).toHaveAttribute('data-state', 'open');
    await claimRow.getByRole('button', { name: /^Why\?/ }).click();
    await expect(family(mom)).toContainText('fixed rules, not the model');
    await expect(family(mom)).toContainText('(Source: a Homemind rule)');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('scene2-claim-en.png'), fullPage: true });

    // 5. Mom taps Change on cake: a correction is posted, apples leave the board, the cake preparations arrive.
    await cakeRow.getByRole('button', { name: /^Change/ }).click();
    await expect(family(mom)).toContainText('Change sent to the simulated group.');
    await expect(claimRow).toContainText('Signed up: 蛋糕 (cake)');
    await expect(claimRow).toContainText('changed');
    await expect(mom.locator('.hm-task', { hasText: 'Make the cake for the party (8 children)' })).toHaveAttribute('data-state', 'open');
    await expect(mom.locator('.hm-task', { hasText: 'Buy apples for the kindergarten party' })).toHaveCount(0);
    await expect(dad.locator('.hm-alert[data-kind="group"]').first()).toContainText('接龙已从苹果改为蛋糕');

    // 6. Dad's board in Chinese: the new preparations ask "Who's taking this?".
    await family(dad).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '我的一天', exact: true }).click();
    await expect(dad.locator('[data-task-id="claim-claim-grp-msg-2"]')).toContainText('已认领：蛋糕 · 幼儿园秋季美食派对');
    const dadBake = dad.locator('.hm-task', { hasText: '为派对做蛋糕（8个小朋友）' });
    await expect(dadBake).toHaveAttribute('data-state', 'open');
    await expect(dadBake).toContainText('谁来负责？');
    await noOverflow(dad);
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('scene2-change-zh.png'), fullPage: true });

    // The correction is in the simulated group, and the apples preparations were removed (kept for Undo).
    const after = (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as { services: { group: { messages: Array<{ text: string; replyKind?: string }> } }; items: Array<{ title: string; status: string }> };
    expect(after.services.group.messages.at(-1)).toMatchObject({ replyKind: 'correction', text: '更正：诺娅妈妈认领改为蛋糕（原来是苹果）' });
    expect(after.items.filter(i => i.title.startsWith('Buy apples')).map(i => i.status)).toEqual(['cancelled']);

    // 7. T7.5, the last beat: the kindergarten moves the party to Friday and edits the list. What depends on it is
    // marked, Dad (asked "Who's taking this?") is told, and Mom applies the change; the cake stays, so nothing is posted.
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Services', exact: true }).click();
    await momSurface.getByRole('button', { name: 'Update message (demo)' }).click();
    await expect(momSurface).toContainText('本周五下午3点');
    await expect(momSurface).toContainText('edited');
    await expect(dad.locator('.hm-alert[data-kind="stale"]')).toContainText('幼儿园修改了一条消息');
    await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'My day', exact: true }).click();
    const sourceRow = mom.locator('[data-task-id^="source-src-claim-grp-msg-2"]');
    await expect(sourceRow).toContainText('The kindergarten changed the party to Friday. 4 items depend on it.');
    await expect(sourceRow).toContainText('Compared in code, not by the model');
    await expect(mom.locator('.hm-task', { hasText: 'Make the cake for the party (8 children)' }).first()).toContainText('Message changed');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('scene2-update-en.png'), fullPage: true });
    await family(dad).getByRole('navigation', { name: '家庭页面' }).getByRole('button', { name: '我的一天', exact: true }).click();
    await expect(dad.locator('[data-task-id^="source-src-claim-grp-msg-2"]')).toContainText('幼儿园把派对改到了周五。有 4 项与它有关。');
    await dad.screenshot({ path: test.info().outputPath('scene2-update-zh.png'), fullPage: true });

    await sourceRow.getByRole('button', { name: 'Apply changes' }).click();
    await expect(family(mom)).toContainText('Changes applied.');
    await expect(sourceRow).toContainText('Applied by Mom');
    await expect(mom.locator('.hm-task', { hasText: 'Make the cake for the party (8 children)' }).first()).not.toContainText('Message changed');
    const applied = (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as { items: Array<{ titleZh?: string; start?: string; status: string; stale?: unknown }>; services: { group: { messages: Array<{ text: string }> } } };
    const party = applied.items.find(i => i.titleZh === '幼儿园秋季美食派对' && i.status === 'open')!;
    expect(localParts(Date.parse(party.start!), zone).weekday).toBe(5);
    expect(applied.items.some(i => i.stale)).toBe(false);
    expect(applied.services.group.messages.at(-1)?.text).toBe('更正：诺娅妈妈认领改为蛋糕（原来是苹果）');

    // Undo puts it back to Thursday and the card asks again.
    await sourceRow.getByRole('button', { name: 'Undo' }).click();
    await expect(sourceRow).toContainText('Apply changes');
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});

// T8.1: Scene 3 as scripted: "Noa is sick." Homemind shows what falls through that day, asks the free parents
// who stays home (it never picks), suggests what to cancel or postpone, and drafts a teacher message behind a tap.
type SceneState = {
  family: { timezone: string };
  clockOffsetMs: number;
  items: Array<{ id: string; start?: string; status: string; ownership: { state: string; ownerId?: string } }>;
  actionCards: Array<{ id: string; adapter: string; status: string }>;
  situations?: Array<{ id: string; stayHomeItemId?: string; cardIds: string[] }>;
};

test('Scene 3: Mom says Noa is sick; Dad sees who could stay home and takes it; Mom applies the suggestions; the teacher message waits for a tap', async ({ browser, request }) => {
  // The seeded pickup is about two hours ahead of the reset: today, or tomorrow late in the evening.
  const first = (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as SceneState;
  const zone = first.family.timezone;
  const today = localParts(Date.now() + first.clockOffsetMs, zone).date;
  const pickupDay = localParts(Date.parse(first.items.find(i => i.id === 'pickup-today')?.start as string), zone).date;
  const word = pickupDay === today ? 'today' : 'tomorrow';
  const weekday = new Date(`${pickupDay}T12:00:00Z`).getUTCDay();
  const sceneState = async () => (await (await request.get(`${BASE}/api/homemind/debug/state`)).json()) as SceneState;

  const momContext = await browser.newContext();
  const dadContext = await browser.newContext();
  try {
    const mom = await momContext.newPage();
    const dad = await dadContext.newPage();
    await openFamily(mom, 'en', 'mom', 'family');
    await openFamily(dad, 'zh', 'dad');
    await expect(family(mom)).toHaveAttribute('data-member', 'mom');
    await expect(dad.locator('[data-stream="live"]')).toBeVisible();

    // 1. Mom tells the Family companion. The card shows what falls through; nothing is cancelled yet.
    await openChat(mom, 'en');
    const reply = await chatTo(mom, `Noa is sick ${word}`);
    await expect(reply).toContainText('Nothing is cancelled or moved until someone taps');
    await expect(reply).toContainText('Not needed: Noa stays home');
    await expect(reply).toContainText('Postpone a week');
    await expect(reply).toContainText('Stay home with Noa');
    await expect(reply).toContainText('Simulated model');
    const situation = (await sceneState()).situations?.[0];
    expect(situation?.stayHomeItemId).toBeTruthy();
    expect((await sceneState()).items.find(i => i.id === 'pickup-today')?.status).toBe('open');

    // 2. Dad's window, without reloading: the alert and My day ask who stays home; only availability is compared.
    await expect(dad.locator('.hm-alert', { hasText: '在家照顾诺娅' })).toBeVisible();
    await expect(family(dad)).toContainText('谁可以留在家');
    await expect(family(dad)).toContainText('当天没有标记外出');
    await expect(family(dad)).toContainText('不需要了：诺娅在家');
    await noOverflow(dad);
    expect(await seriousIssues(dad)).toEqual([]);
    await dad.screenshot({ path: test.info().outputPath('scene3-dad-zh.png'), fullPage: true });

    // 3. Dad takes it from his board.
    const task = dad.locator(`[data-task-id="${situation?.stayHomeItemId}"]`).first();
    await task.getByRole('button', { name: '我来' }).click();
    await expect.poll(async () => (await sceneState()).items.find(i => i.id === situation?.stayHomeItemId)?.ownership).toMatchObject({ state: 'assigned', ownerId: 'dad' });

    // 4. Mom, on My day: Apply all. The pickup is not needed, swimming moves a week; each has its own Undo.
    await mom.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Family' }).click();
    await expect(family(mom)).toContainText('Who could stay home');
    await mom.getByRole('button', { name: 'Apply all (2)' }).click();
    await expect(family(mom)).toContainText('All suggestions applied');
    await expect.poll(async () => (await sceneState()).items.find(i => i.id === 'pickup-today')?.status).toBe('cancelled');
    await expect(family(mom)).toContainText('Done by Mom');
    await expect(family(dad)).toContainText('妈妈已采纳');

    // 5. "Why?" says it was Homemind's rules, not the model and not PPMA.
    await family(mom).getByRole('button', { name: 'Why?' }).first().click();
    await expect(family(mom)).toContainText('fixed rules (the model only read the message)');
    await expect(family(mom)).toContainText('(Source: a Homemind rule)');
    await noOverflow(mom);
    expect(await seriousIssues(mom)).toEqual([]);
    await mom.screenshot({ path: test.info().outputPath('scene3-mom-en.png'), fullPage: true });

    // 6. On a weekday, the teacher message waits for a parent's own tap, then goes to the simulated teacher only.
    if (weekday >= 1 && weekday <= 5) {
      const card = mom.locator('.approval-card', { hasText: 'Tell Teacher Wang that Noa stays home' });
      await expect(card).toContainText('不来幼儿园了');
      await expect(card.locator('.hm-sim-badge')).toHaveText('Simulated');
      await card.getByRole('button', { name: 'Confirm' }).click();
      await expect(family(mom)).toContainText('It went to the simulated service only');
      await family(mom).getByRole('navigation', { name: 'Family screens' }).getByRole('button', { name: 'Services', exact: true }).click();
      await expect(family(mom)).toContainText('Messages to the class teacher');
      await expect(family(mom)).toContainText('Wishing a quick recovery');
    } else {
      expect(situation?.cardIds).toEqual([]);
    }
  } finally {
    await momContext.close();
    await dadContext.close();
  }
});
