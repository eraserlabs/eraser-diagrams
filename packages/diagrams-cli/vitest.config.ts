import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The suite shells out to the real CLI, which launches Chromium per render. On small CI
    // runners, parallel workers starve the vitest RPC channel ("Timeout calling onTaskUpdate")
    // even though every test passes — and the suite is effectively serial anyway.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
