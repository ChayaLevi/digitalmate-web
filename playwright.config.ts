import { defineConfig, devices } from '@playwright/test';

const port = 5175;
const baseURL = `http://127.0.0.1:${port}`;
/** The Homemind-enabled dev server (e2e/homemind.spec.ts). */
const homemindPort = 5176;

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
    },
    {
      // Homemind on, with its own state file and the simulated model. The server above keeps Homemind
      // off, so the base app's tests run exactly as before.
      command: `npm run dev -- --port ${homemindPort}`,
      env: {
        HOMEMIND_ENABLED: '1',
        HOMEMIND_SECRET: 'e2e-only-homemind-secret-0123',
        HOMEMIND_DEMO: '1',
        HOMEMIND_DATA_FILE: '.homemind/e2e-state.json',
        HOMEMIND_LLM: 'fake'
      },
      url: `http://127.0.0.1:${homemindPort}/api/homemind/health`,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
