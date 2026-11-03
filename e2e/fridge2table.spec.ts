import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fileURLToPath } from 'node:url';

const photo = fileURLToPath(new URL('./fixtures/frame.jpg', import.meta.url));
const shots = process.env.F2T_SHOTS ?? '';

async function start(page: Page, persona?: string) {
  await page.addInitScript(chosen => {
    if (!window.sessionStorage.getItem('dm-e2e-initialized')) {
      window.localStorage.clear();
      window.localStorage.setItem('digitalmate.web.v2.welcomeSeen.v1', 'true');
      if (chosen) window.localStorage.setItem('digitalmate.web.v2.persona.v1', JSON.stringify(chosen));
      window.sessionStorage.setItem('dm-e2e-initialized', '1');
    }
  }, persona ?? '');
  await page.goto('/');
}

async function ask(page: Page, text: string) {
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer-send').click();
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

test('a kitchen question goes to Fridge2Table and comes back as A2UI meal cards', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1400 });
  await start(page);
  await ask(page, 'What can I cook tonight?');
  const cards = page.locator('.recipe-card');
  await expect(cards).toHaveCount(3);
  await expect(page.getByText('Three ideas from your kitchen.')).toBeVisible();
  await expect(cards.first().getByText('Spinach and cheddar frittata')).toBeVisible();
  await expect(page.getByText('Check your pantry first').first()).toBeVisible();
  await shot(page, '1-meals');

  // Show steps -> a recipe surface from GET /recipe/{id}/steps
  await cards.first().getByRole('button', { name: 'Show steps' }).click();
  await expect(page.getByText('Heat the oven grill.')).toBeVisible();
  await shot(page, '2-steps');

  // I made it -> the kitchen is updated, with undo
  await page.getByRole('button', { name: 'I made it' }).last().click();
  await expect(page.getByText(/Taken out of your kitchen: .*Eggs plenty → some/)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(page.getByText('Undone.')).toBeVisible();
  await shot(page, '3-made-undo');

  const axe = await new AxeBuilder({ page }).include('.recipe-list').analyze();
  expect(axe.violations).toEqual([]);
});

test('the Kitchen companion sends everything to Fridge2Table, photos included', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1300 });
  await start(page, 'kitchen');
  await page.locator('input[type="file"]').first().setInputFiles(photo);
  await ask(page, 'This is my fridge');
  await expect(page.getByText(/I looked at your 1 photo\(s\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: /bell pepper/ })).toBeVisible(); // follow-up question

  await ask(page, 'What do I need for lasagna?');
  await expect(page.getByText('You asked', { exact: true })).toBeVisible();
  await expect(page.getByText('use cottage cheese')).toBeVisible();
  await page.getByRole('button', { name: 'I bought these' }).click();
  await expect(page.getByText('Added to your kitchen: lasagna sheet')).toBeVisible();
  await shot(page, '4-kitchen-companion');

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('restaurant searches still use the existing local scenario', async ({ page }) => {
  await start(page);
  await ask(page, 'Find coffee nearby');
  await expect(page.locator('.food-card').first()).toBeVisible();
  await expect(page.locator('.recipe-card')).toHaveCount(0);
});
