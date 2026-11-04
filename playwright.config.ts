import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4317', trace: 'retain-on-failure', locale: 'pl-PL', timezoneId: 'Europe/Warsaw' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } },
  ],
  webServer: [{
    command: 'node tests/start-server.mjs',
    url: 'http://127.0.0.1:4317/readyz',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  }, {
    // Test-only fixture app (synthetic records) for detail/edit screens with content.
    command: 'node node_modules/vite/bin/vite.js --config apps/web/vite.fixtures.config.ts',
    url: 'http://127.0.0.1:4318/',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  }],
});
