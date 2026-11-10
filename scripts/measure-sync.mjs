#!/usr/bin/env node
// T9.1: how long a change takes to show in the other window. Two browser contexts (Mom and Dad, as on
// stage); Mom taps "Assign to Dad" on the pickup, and the time until Dad's row shows "assigned" is
// measured, without a reload. Needs a Homemind dev server with HOMEMIND_DEMO=1 (the model does not matter):
//
//   HOMEMIND_ENABLED=1 HOMEMIND_DEMO=1 HOMEMIND_SECRET=... HOMEMIND_LLM=fake npx vite --port 5177
//   node scripts/measure-sync.mjs [--base http://127.0.0.1:5177] [--runs 10]
//
// Resets the board on that server before each run.

import { chromium } from '@playwright/test';

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const BASE = arg('base') ?? 'http://127.0.0.1:5177';
const RUNS = Number(arg('runs') ?? 10);

const browser = await chromium.launch();
const open = async (member, lang) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(language => {
    window.localStorage.setItem('digitalmate.web.v2.welcomeSeen.v1', 'true');
    window.localStorage.setItem('digitalmate.web.v2.language.v1', JSON.stringify(language));
  }, lang);
  await page.goto(`${BASE}/?member=${member}`);
  await page.getByRole('navigation', { name: lang === 'zh' ? '主导航' : 'Main navigation' }).getByRole('button', { name: lang === 'zh' ? '家庭' : 'Family' }).click();
  await page.locator('[data-stream="live"]').waitFor();
  return page;
};

const session = await (await fetch(`${BASE}/api/homemind/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId: 'mom' }) })).json();
const reset = () => fetch(`${BASE}/api/homemind/demo/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-homemind-session': session.token }, body: JSON.stringify({ preset: 'scene-1' }) });

const mom = await open('mom', 'en');
const dad = await open('dad', 'zh');
const times = [];
try {
  for (let run = 1; run <= RUNS; run++) {
    await reset();
    const assign = mom.getByRole('button', { name: 'Assign to Dad: Kindergarten pickup' }).first();
    await assign.waitFor();
    const dadRow = dad.locator('[data-task-id="pickup-today"]').first();
    await dadRow.waitFor();
    await dad.waitForFunction(() => document.querySelector('[data-task-id="pickup-today"]')?.getAttribute('data-state') !== 'assigned');
    const started = Date.now();
    await assign.click();
    await dad.waitForFunction(() => document.querySelector('[data-task-id="pickup-today"]')?.getAttribute('data-state') === 'assigned', null, { polling: 'raf', timeout: 10_000 });
    times.push(Date.now() - started);
    console.log(`run ${run}: ${times[times.length - 1]} ms`);
  }
} finally {
  await browser.close();
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`\n${times.length} runs, click in Mom's window to "assigned" in Dad's window: min ${sorted[0]} / median ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted[sorted.length - 1]} ms`);
