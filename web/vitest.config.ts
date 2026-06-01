import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/test/**/*.test.ts', 'lib/test/**/*.test.tsx'],
  },
});
