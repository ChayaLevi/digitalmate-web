import { defineConfig, devices } from '@playwright/test';

const port = 5175;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: [
    {
      command: 'node scripts/fake-epic-replay.mjs',
      env: { FAKE_EPIC_PORT: '18010' },
      url: 'http://127.0.0.1:18010/styles',
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: 'node scripts/fake-fridge2table.mjs',
      env: { FAKE_F2T_PORT: '18020', FAKE_F2T_DELAY_MS: '200' },
      url: 'http://127.0.0.1:18020/health',
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `npm run dev -- --port ${port}`,
      env: { EPIC_REPLAY_URL: 'http://127.0.0.1:18010', FRIDGE2TABLE_URL: 'http://127.0.0.1:18020' },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
