import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fileURLToPath } from 'node:url';

const clip = fileURLToPath(new URL('./fixtures/clip.mp4', import.meta.url));
const shots = process.env.EPIC_SHOTS ?? '';
const FAKE = 'http://127.0.0.1:18010';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('dm-e2e-initialized')) {
      window.localStorage.clear();
      window.localStorage.setItem('digitalmate.web.v2.welcomeSeen.v1', 'true');
      window.sessionStorage.setItem('dm-e2e-initialized', '1');
    }
  });
  await page.goto('/');
});

async function shot(page: Page, name: string) {
  await page.waitForTimeout(700);
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function openEpic(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: /Labs/ }).click();
  await page.getByRole('button', { name: /Epic Replay/ }).click();
}

test('Epic Replay flow is driven by A2UI surfaces end to end', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1300 });
  await openEpic(page);
  await expect(page.getByRole('button', { name: 'Start replay' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /News reporter/ })).toBeVisible();
  await shot(page, '1-start');

  // validation before upload
  await page.getByRole('button', { name: 'Start replay' }).click();
  await expect(page.getByText('Choose a clip first.')).toBeVisible();

  await page.getByTestId('epic-file').setInputFiles(clip);
  await page.getByRole('radio', { name: /News reporter/ }).click();
  await page.getByLabel(/Name to use for the person/).fill('Noa');
  await expect(page.getByLabel("Remove the clip's own sound")).not.toBeChecked();
  await page.getByLabel("Remove the clip's own sound").check();
  await page.getByLabel(/Everyone in the clip is fine with it being narrated/).check();
  await shot(page, '2-start-filled');
  await page.getByRole('button', { name: 'Start replay' }).click();

  await expect(page.getByRole('heading', { name: 'Is this what happened?' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Frame 313/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Frame 289/ })).toBeVisible();
  await expect(page.getByLabel('What is going on')).toHaveValue('football free kick');
  await expect(page.getByLabel(/Name to use for the person/)).toHaveValue('Noa');
  await shot(page, '3-check');

  const a11y = await new AxeBuilder({ page }).include('.sheet-layer').analyze();
  expect(a11y.violations.filter(v => v.impact === 'critical' || v.impact === 'serious').map(v => v.id)).toEqual([]);

  await page.getByRole('radio', { name: /Frame 289/ }).click();
  await page.getByLabel('What is going on').fill('football penalty');
  await page.getByLabel(/Keep: goalkeeper does not dive/).uncheck();
  await shot(page, '4-check-edited');
  await page.getByRole('button', { name: 'Yes, write the call' }).click();

  await expect(page.getByRole('heading', { name: 'Your replay is ready' })).toBeVisible();
  const video = page.getByTestId('epic-video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0);
  expect(await video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(320);
  await shot(page, '5-result');

  // the sound switch reached the Epic Replay server's upload form
  const formId = await page.evaluate(() => window.localStorage.getItem('dm.epic.run'));
  expect(await (await page.request.get(`${FAKE}/runs/${formId}/form`)).json()).toMatchObject({ keep_original_audio: 'false', style: 'news_reporter' });

  // what the Epic Replay server actually received at the play card
  const runId = await page.evaluate(() => window.localStorage.getItem('dm.epic.run'));
  const answer = await (await page.request.get(`${FAKE}/runs/${runId}/last-answer`)).json();
  expect(answer).toMatchObject({
    action: 'confirm',
    edits: { climax_frame: 289, activity: 'football penalty', events: [{ id: 'e7', keep: false }] },
    context: { player_name: 'Noa' }
  });

  // restyle starts a new run in another style and finishes
  await page.getByRole('radio', { name: /Nature documentary/ }).click();
  await page.getByRole('button', { name: 'Tell it in another style' }).last().click();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('dm.epic.run'))).not.toBe(runId);
  await expect(page.getByRole('heading', { name: 'Your replay is ready' })).toBeVisible();

  await page.getByRole('button', { name: 'Make another' }).click();
  await expect(page.getByRole('button', { name: 'Start replay' })).toBeVisible();
});

test('Epic Replay stop at the check ends the run', async ({ page }) => {
  await openEpic(page);
  await page.getByTestId('epic-file').setInputFiles(clip);
  await page.getByLabel(/Everyone in the clip is fine with it being narrated/).check();
  await page.getByRole('button', { name: 'Start replay' }).click();
  await expect(page.getByRole('heading', { name: 'Is this what happened?' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('This run stopped')).toBeVisible();
  await shot(page, '6-stopped');
});

test('Epic Replay works on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await openEpic(page);
  await page.getByTestId('epic-file').setInputFiles(clip);
  await page.getByLabel(/Everyone in the clip is fine with it being narrated/).check();
  await page.getByRole('button', { name: 'Start replay' }).click();
  await expect(page.getByRole('heading', { name: 'Is this what happened?' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await shot(page, '7-mobile-check');
});

test('Epic Replay start page keeps the sound by default and lists past replays', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1300 });
  await openEpic(page);
  await expect(page.getByRole('button', { name: /Past replays \(\d+\)/ })).toBeVisible();
  await shot(page, '8-start-with-past');
  await page.getByTestId('epic-file').setInputFiles(clip);
  await page.getByLabel(/Everyone in the clip is fine with it being narrated/).check();
  await page.getByRole('button', { name: 'Start replay' }).click();
  await expect(page.getByRole('heading', { name: 'Is this what happened?' })).toBeVisible();
  const id = await page.evaluate(() => window.localStorage.getItem('dm.epic.run'));
  expect(await (await page.request.get(`${FAKE}/runs/${id}/form`)).json()).toMatchObject({ keep_original_audio: 'true' });

  // past replays: back to start, open the list, open a finished replay
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Make another' }).click();
  await page.getByRole('button', { name: /Past replays/ }).click();
  await expect(page.getByRole('heading', { name: 'Past replays' }).first()).toBeVisible();
  await expect(page.locator('.epic-replay').first()).toBeVisible();
  await shot(page, '9-past');
  await page.locator('.epic-replay').first().click();
  await expect(page.getByRole('heading', { name: 'Your replay is ready' })).toBeVisible();
  await expect(page.getByTestId('epic-video')).toBeVisible();
  await page.getByRole('button', { name: 'Past replays' }).click();
  await expect(page.locator('.epic-replay').first()).toBeVisible();
});
