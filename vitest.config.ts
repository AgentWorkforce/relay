import { defineConfig } from 'vitest/config';
import path from 'node:path';

const workspacePackages = [
  'acp-bridge',
  'cloud',
  'config',
  'gateway',
  'hooks',
  'memory',
  'openclaw',
  'policy',
  'sdk',
  'telemetry',
  'trajectory',
  'user-directory',
  'utils',
] as const;

const workspaceAliases = workspacePackages.flatMap((packageName) => {
  const sourceRoot = path.resolve(__dirname, `./packages/${packageName}/src`);

  return [
    {
      find: new RegExp(`^@agent-relay/${packageName}/(.+)$`),
      replacement: `${sourceRoot}/$1`,
    },
    {
      find: `@agent-relay/${packageName}`,
      replacement: path.resolve(sourceRoot, 'index.ts'),
    },
  ];
});

export default defineConfig({
  resolve: {
    alias: [
      ...workspaceAliases,
      {
        find: '@agent-relay/brand/brand.css',
        replacement: path.resolve(__dirname, './packages/brand/brand.css'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    threads: true,
    setupFiles: ['./test/vitest.setup.ts'],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/sdk/**', // Uses Node.js test runner, not vitest
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      all: false,
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/dist/**',
        'packages/sdk/**', // SDK uses Node.js test runner in tests/integration/broker
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
