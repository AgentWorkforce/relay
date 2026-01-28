import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@agent-relay/protocol': path.resolve(__dirname, './packages/protocol/dist/index.js'),
      '@agent-relay/config': path.resolve(__dirname, './packages/config/dist/index.js'),
      '@agent-relay/storage': path.resolve(__dirname, './packages/storage/dist/index.js'),
      '@agent-relay/bridge': path.resolve(__dirname, './packages/bridge/dist/index.js'),
      '@agent-relay/continuity': path.resolve(__dirname, './packages/continuity/dist/index.js'),
      '@agent-relay/trajectory': path.resolve(__dirname, './packages/trajectory/dist/index.js'),
      '@agent-relay/hooks': path.resolve(__dirname, './packages/hooks/dist/index.js'),
      '@agent-relay/state': path.resolve(__dirname, './packages/state/dist/index.js'),
      '@agent-relay/policy': path.resolve(__dirname, './packages/policy/dist/index.js'),
      '@agent-relay/memory': path.resolve(__dirname, './packages/memory/dist/index.js'),
      '@agent-relay/utils': path.resolve(__dirname, './packages/utils/dist/index.js'),
      '@agent-relay/resiliency': path.resolve(__dirname, './packages/resiliency/dist/index.js'),
      '@agent-relay/user-directory': path.resolve(__dirname, './packages/user-directory/dist/index.js'),
      '@agent-relay/daemon': path.resolve(__dirname, './packages/daemon/dist/index.js'),
      '@agent-relay/wrapper': path.resolve(__dirname, './packages/wrapper/dist/index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/vitest.setup.ts'],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/**'],
    },
  },
});
