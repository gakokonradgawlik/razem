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
  webServer: [...[4324, 4325].map((port) => ({
    command: `node tests/start-sync-server.mjs --push ${port}`,
    url: `http://127.0.0.1:${port}/readyz`, reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 },
  })), ...[4322, 4323].map((port) => ({
    command: `node tests/start-sync-server.mjs --port ${port}`,
    url: `http://127.0.0.1:${port}/readyz`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 },
  })), {
    command: 'node tests/start-server.mjs',
    url: 'http://127.0.0.1:4317/readyz',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  }, ...[4320, 4321].map((port) => ({
    command: `node tests/start-sync-server.mjs --pwa ${port}`,
    url: `http://127.0.0.1:${port}/readyz`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 },
  })), {
    // Signed-in offline/sync scenarios (tests/e2e/offline.spec.ts), synthetic accounts.
    command: 'node tests/start-sync-server.mjs',
    url: 'http://127.0.0.1:4319/readyz',
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
