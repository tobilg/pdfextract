import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173/pdfextract-demo/', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: process.env.PDFEXTRACT_PACKED ? 'node scripts/serve-packed.mjs' : 'pnpm dev',
    url: 'http://127.0.0.1:4173/pdfextract-demo/',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
