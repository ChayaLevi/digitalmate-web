#!/usr/bin/env node
// Renders e2e/fixtures/homemind/jielong-sample.html to jielong-sample.png (a simulated 接龙 group
// screenshot at phone size), using the Playwright Chromium the e2e tests already use.
//
//   node scripts/render-jielong-sample.mjs

import { chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures', 'homemind');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(resolve(dir, 'jielong-sample.html')).href);
  await page.screenshot({ path: resolve(dir, 'jielong-sample.png'), fullPage: true });
  console.log(`wrote ${resolve(dir, 'jielong-sample.png')}`);
} finally {
  await browser.close();
}
