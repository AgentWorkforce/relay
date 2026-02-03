import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      // Use array format with find/replace for better subpath matching
      {
        find: /^@agent-relay\/protocol\/(.+)$/,
        replacement: path.resolve(__dirname, './packages/protocol/dist/$1.js'),
      },
      {
        find: /^@agent-relay\/config\/(.+)$/,
        replacement: path.resolve(__dirname, './packages/config/dist/$1.js'),
      },
      {
        find: /^@agent-relay\/utils\/(.+)$/,
        replacement: path.resolve(__dirname, './packages/utils/dist/$1.js'),
      },
      {
        find: /^@agent-relay\/storage\/(.+)$/,
        replacement: path.resolve(__dirname, './packages/storage/dist/$1.js'),
      },
      // Main package entries (must come after subpath patterns)
      {
        find: '@agent-relay/protocol',
        replacement: path.resolve(__dirname, './packages/protocol/dist/index.js'),
      },
      {
        find: '@agent-relay/config',
        replacement: path.resolve(__dirname, './packages/config/dist/index.js'),
      },
      {
        find: '@agent-relay/storage',
        replacement: path.resolve(__dirname, './packages/storage/dist/index.js'),
      },
      {
        find: '@agent-relay/bridge',
        replacement: path.resolve(__dirname, './packages/bridge/dist/index.js'),
      },
      {
        find: '@agent-relay/continuity',
        replacement: path.resolve(__dirname, './packages/continuity/dist/index.js'),
      },
      {
        find: '@agent-relay/trajectory',
        replacement: path.resolve(__dirname, './packages/trajectory/dist/index.js'),
      },
      {
        find: '@agent-relay/hooks',
        replacement: path.resolve(__dirname, './packages/hooks/dist/index.js'),
      },
      {
        find: '@agent-relay/state',
        replacement: path.resolve(__dirname, './packages/state/dist/index.js'),
      },
      {
        find: '@agent-relay/policy',
        replacement: path.resolve(__dirname, './packages/policy/dist/index.js'),
      },
      {
        find: '@agent-relay/memory',
        replacement: path.resolve(__dirname, './packages/memory/dist/index.js'),
      },
      {
        find: '@agent-relay/utils',
        replacement: path.resolve(__dirname, './packages/utils/dist/index.js'),
      },
      {
        find: '@agent-relay/resiliency',
        replacement: path.resolve(__dirname, './packages/resiliency/dist/index.js'),
      },
      {
        find: '@agent-relay/user-directory',
        replacement: path.resolve(__dirname, './packages/user-directory/dist/index.js'),
      },
      {
        find: '@agent-relay/daemon',
        replacement: path.resolve(__dirname, './packages/daemon/dist/index.js'),
      },
      {
        find: '@agent-relay/wrapper',
        replacement: path.resolve(__dirname, './packages/wrapper/dist/index.js'),
      },
    ],
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
