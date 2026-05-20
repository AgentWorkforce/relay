import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@agent-relay/cloud',
        replacement: path.resolve(__dirname, './packages/cloud/src/index.ts'),
      },
      {
        find: '@agent-relay/telemetry',
        replacement: path.resolve(__dirname, './packages/telemetry/src/index.ts'),
      },
    ],
  },
  test: {
    include: ['tests/cli-tokens.test.ts'],
    environment: 'node',
  },
});
