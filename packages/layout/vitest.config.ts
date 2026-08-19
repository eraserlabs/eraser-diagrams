import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
  },
});
