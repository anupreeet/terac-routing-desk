// Browser end-to-end suite: the brief's use cases, driven through the real UI against the real server
// (production build, fresh database, real time). Run with `npm run test:e2e`.
// Uses the locally installed Google Chrome by default; set PW_CHANNEL= (empty) to use Playwright's Chromium.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3201);
const channel = process.env.PW_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(channel ? { channel } : {}) }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...(channel ? { channel } : {}) }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    command: `rm -rf .e2e && npm run build && NODE_ENV=production DESK_DB=.e2e/desk.sqlite PORT=${PORT} LOG_LEVEL=warn npx tsx src/server/main.ts`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
