import { defineConfig } from 'vitest/config';

// *.spec.ts files are Playwright e2e suites (run via `test:e2e`), not vitest tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
