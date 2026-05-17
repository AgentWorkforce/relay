import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/cli-tokens.test.ts'],
    environment: 'node',
  },
});
