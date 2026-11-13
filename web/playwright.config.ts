import { defineConfig, devices } from '@playwright/test';

// The suite runs against a REAL htcondor-api in demo mode, never against
// mocked API responses.
//
// A lab app's most likely bug is a wrong assumption about the API -- a
// field that is a string and not a number, a job that is "held" because
// the input upload has not finished yet. A fixture freezes that
// assumption instead of testing it, and then agrees with you forever.
//
// scripts/e2e.sh starts the server and sets PLAYWRIGHT_BASE_URL.
export default defineConfig({
  // ../e2e: the specs stay at the repository root, where they are easy
  // to find, but this config lives beside web/node_modules. Playwright
  // resolves @playwright/test from the CONFIG's directory, so a config
  // at the root could not find its own dependency.
  testDir: '../e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // localhost, and the container is run with -h localhost to match.
    // Logging in is a real OAuth round trip and the server builds the
    // IdP's address from its own hostname, so the name the browser
    // starts on has to be the name the redirect comes back to.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:8443',
    // Demo mode generates its own CA at startup, so nothing trusts the
    // certificate. Serving plain HTTP instead would be worse: the
    // session cookie is set Secure, and without it every authenticated
    // test fails for a reason unrelated to what it tests.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
