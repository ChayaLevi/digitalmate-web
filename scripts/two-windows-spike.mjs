#!/usr/bin/env node
// T0.4 spike: can two windows of one browser profile hold two Homemind identities, and does the app
// fit side by side? See docs/homemind-spikes.md.
//
//   node scripts/two-windows-spike.mjs [--base http://127.0.0.1:5173]
//
// Uses the running dev server, or starts vite (as `npm run dev` does) and stops it afterwards. Screenshots go to
// test-results/two-windows/ (git-ignored). The Family tab does not exist yet, so the layout check
// covers the current app shell only.

import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argBase = process.argv.indexOf('--base');
const BASE = argBase > 0 ? process.argv[argBase + 1] : 'http://127.0.0.1:5173';
const OUT = resolve(ROOT, 'test-results', 'two-windows');
const KEY = 'homemind.session';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

let dev = null;
if (!(await reachable())) {
  // Same as `npm run dev`, without npm.cmd and a shell in between (simpler to stop on Windows).
  const { hostname, port } = new URL(BASE);
  console.log(`starting vite on ${BASE}`);
  dev = spawn(process.execPath, [resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', hostname, '--port', port], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await reachable())) { stopDev(); fail('dev server did not start'); }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  console.log('\nOne browser profile, two windows opened separately (two tabs or two windows typed by hand)');
  const profile = await browser.newContext();
  const mom = await profile.newPage();
  const dad = await profile.newPage();
  await mom.goto(BASE);
  await dad.goto(BASE);
  await mom.evaluate(([k]) => { sessionStorage.setItem(k, 'mom'); localStorage.setItem('homemind.spike.shared', 'written by mom'); }, [KEY]);
  await dad.evaluate(([k]) => sessionStorage.setItem(k, 'dad'), [KEY]);
  await mom.reload();
  await dad.reload();
  const momId = await mom.evaluate(([k]) => sessionStorage.getItem(k), [KEY]);
  const dadId = await dad.evaluate(([k]) => sessionStorage.getItem(k), [KEY]);
  check('each window keeps its own sessionStorage identity after reload', momId === 'mom' && dadId === 'dad', `mom window=${momId}, dad window=${dadId}`);
  const sharedInDad = await dad.evaluate(() => localStorage.getItem('homemind.spike.shared'));
  check('localStorage is shared between the windows (the known limit)', sharedInDad === 'written by mom', `dad window reads "${sharedInDad}"`);

  console.log('\nA window opened from another one (window.open, or the browser\'s Duplicate tab)');
  const [popup] = await Promise.all([profile.waitForEvent('page'), mom.evaluate((u) => window.open(u, '_blank'), BASE)]);
  await popup.waitForLoadState();
  const copied = await popup.evaluate(([k]) => sessionStorage.getItem(k), [KEY]);
  check('the new window starts with a copy of the opener\'s identity', copied === 'mom', `popup=${copied}`);
  await popup.evaluate(([k]) => sessionStorage.setItem(k, 'dad'), [KEY]);
  const momAfter = await mom.evaluate(([k]) => sessionStorage.getItem(k), [KEY]);
  check('changing the copy does not change the opener', momAfter === 'mom', `opener=${momAfter}`);
  await popup.close();

  console.log('\nTwo browser profiles (the recommended stage setup)');
  const other = await browser.newContext();
  const dad2 = await other.newPage();
  await dad2.goto(BASE);
  const leaked = await dad2.evaluate(([k]) => [sessionStorage.getItem(k), localStorage.getItem('homemind.spike.shared')], [KEY]);
  check('a second profile shares neither sessionStorage nor localStorage', leaked[0] === null && leaked[1] === null, `session=${leaked[0]}, local=${leaked[1]}`);
  await other.close();

  console.log('\nSide-by-side layout (current app shell, welcome deck dismissed)');
  // The welcome deck covers the app until dismissed; the app remembers that in localStorage.
  await mom.getByRole('button', { name: /^(Skip|跳过)$/ }).click({ timeout: 5000 }).catch(() => {});
  const shots = {};
  for (const [label, width, height] of [['half of a 1440 px laptop', 720, 900], ['half of a 1280 px laptop', 640, 800], ['phone', 390, 844]]) {
    const page = await profile.newPage(); // context.newPage() takes no viewport option
    await page.setViewportSize({ width, height });
    await page.goto(BASE);
    await page.waitForLoadState('networkidle').catch(() => {});
    const covered = await page.getByRole('button', { name: /^(Skip|跳过)$/ }).isVisible().catch(() => false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const file = resolve(OUT, `app-${width}.png`);
    await page.screenshot({ path: file });
    shots[width] = file;
    check(`${width} px (${label}): app visible, no horizontal scroll`, !covered && overflow <= 0, `${covered ? 'welcome deck still shown, ' : ''}overflow ${overflow} px, ${file}`);
    await page.close();
  }

  const pair = await profile.newPage();
  await pair.setViewportSize({ width: 1442, height: 900 });
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  await pair.setContent(`<body style="margin:0;display:flex;gap:2px;background:#333">
    <img src="${img(shots[720])}" width="720" height="900"><img src="${img(shots[720])}" width="720" height="900"></body>`);
  await pair.screenshot({ path: resolve(OUT, 'side-by-side-1440.png') });
  console.log(`  NOTE  side-by-side picture (two 720 px windows): ${resolve(OUT, 'side-by-side-1440.png')}`);
  await profile.close();
} finally {
  await browser.close();
  stopDev();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed ? `FAIL: ${failed} of ${results.length}` : `PASS: ${results.length} checks`}`);
process.exit(failed ? 1 : 0);

async function reachable() {
  try { await fetch(BASE, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

function stopDev() {
  if (!dev || dev.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(dev.pid)], { stdio: 'ignore' });
  else dev.kill();
}

function fail(msg) {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}
