import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Use jsdom environment for frontend tests
    environmentMatchGlobs: [
      ['src/dashboard/frontend/**/*.test.ts', 'jsdom'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/**'],
    },
  },
});
