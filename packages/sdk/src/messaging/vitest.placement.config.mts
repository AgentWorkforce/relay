import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/sdk/src/messaging/placement.test.mts'],
  },
});
