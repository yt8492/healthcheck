import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e', fullyParallel: false, workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run seed:emulator && npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI,
    env: { GOOGLE_CLOUD_PROJECT: 'demo-healthcheck', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
  },
});
