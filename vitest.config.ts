import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Workspace packages that vitest should resolve via their `src/index.ts`
// instead of falling through to Node's resolver (which requires `dist/`
// to be built first). Every workspace package under `packages/` that
// ships TypeScript and is imported as `@agent-relay/<name>` from any
// test or source file MUST be listed here — otherwise tests will pass
// in CI (because CI runs `npm run build` first) but fail in fresh
// local checkouts that haven't been built yet.
//
// When you add a new workspace package, add it here too.
const workspacePackages = [
  'agent',
  'chief-execution-bridge',
  'cloud',
  'config',
  'core-bridge',
  'events',
  'gateway',
  'github-primitive',
  'hooks',
  'integration-prompts',
  'memory',
  'runtime',
  'sdk',
  'session',
  'slack-primitive',
  'telemetry',
  'trajectory',
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

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
// The root engines range starts below the version that ships node:sqlite without a flag.
const hasNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, './vitest.setup.ts')],
    include: [
      '.agentworkforce/agents/**/*.test.ts',
      'tests/fixtures/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.tsx',
      'packages/**/tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/sdk-swift/.build/**',
      'packages/sdk/**', // Uses Node.js test runner, not vitest
      ...(hasNodeSqlite ? [] : ['packages/chief-execution-bridge/**']),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      all: false,
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/dist/**',
        'packages/sdk-swift/.build/**',
        'packages/sdk/**', // SDK uses the Node.js test runner
        // Transitively loaded via barrel re-exports but not exercised by the
        // root test suite. Previously these resolved to dist/*.js and were
        // excluded via **/dist/**; the src alias migration started reporting
        // them. Keep them out so the global threshold reflects files we
        // actually unit-test here.
        'packages/cloud/src/workflows.ts',
        'packages/cloud/src/api-client.ts',
      ],
      // Thresholds recalibrated for Vitest 4's AST-aware V8 coverage
      // remapping, which reports a few points lower than v3 on the same
      // code (more precise statement/branch attribution). These track the
      // current measured coverage with a small margin.
      thresholds: {
        lines: 55,
        functions: 53,
        branches: 45,
        statements: 55,
      },
    },
  },
});
