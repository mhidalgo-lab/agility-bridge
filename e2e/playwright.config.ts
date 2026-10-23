// SPDX-License-Identifier: Apache-2.0
// P4-08: the admin panel in a real browser. Run with `pnpm test:e2e`; it is not part of `pnpm test` (see
// docs/dev/testing.md). Chromium always; `AB_E2E_BROWSERS=all` adds Firefox and WebKit for the smoke spec.
import { defineConfig, devices } from '@playwright/test';

const all = process.env['AB_E2E_BROWSERS'] === 'all';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { actionTimeout: 10_000, navigationTimeout: 20_000, trace: 'retain-on-failure' },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './global-setup.ts',
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // 320 px is the narrowest phone the layout promises to hold (WCAG reflow).
    {
      name: 'mobile-320',
      // The header, cookie and sign-in specs do not depend on the viewport: run them once, on desktop.
      testIgnore: ['security.spec.ts', 'secure.spec.ts'],
      use: { ...devices['Pixel 5'], viewport: { width: 320, height: 640 }, deviceScaleFactor: 1 },
    },
    ...(all
      ? [
          { name: 'firefox', testMatch: 'smoke.spec.ts', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', testMatch: 'smoke.spec.ts', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
