import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e', fullyParallel: false, workers: 1, timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://127.0.0.1:3001', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run build && npm run seed:emulator && npm start', url: 'http://127.0.0.1:3001', reuseExistingServer: !process.env.CI,
    timeout: 900_000,
    env: { GOOGLE_CLOUD_PROJECT: 'demo-healthcheck', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', HOST: '127.0.0.1', PORT: '3001' },
  },
});
