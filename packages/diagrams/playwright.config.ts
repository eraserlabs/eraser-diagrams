import { defineConfig } from '@playwright/test';
import { CHROMIUM_ARGS } from './test/support/browser.js';

// Workers inherit this; keeps fastify request logs out of the test output.
process.env.LOG_LEVEL = 'silent';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  // `pnpm snap` sets PLAYWRIGHT_HTML_OPEN=on-failure so a golden mismatch opens the report
  // (expected / actual / diff per fixture); behavioural e2e runs stay silent.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    launchOptions: { args: CHROMIUM_ARGS },
  },
  // Goldens (goldens.spec.ts) live with the fixtures they mirror, one file per fixture and
  // platform: fixtures/__goldens__/<group>/<name>-<platform>.png|json.
  snapshotDir: '../../fixtures/__goldens__',
  snapshotPathTemplate: '{snapshotDir}/{arg}{-snapshotSuffix}{ext}',
});
