import { defineConfig } from 'vitest/config';
import path from 'node:path';

// E2E config for the live two-node fleet matrix. Kept separate from the unit
// `vitest.config.ts` so the default `npm test` never boots a real engine +
// brokers. Booting processes is slow, so timeouts are generous and the suite
// runs single-threaded (the scenarios share one live stack).
//
// Workspace packages still resolve from `src/` (no build required for the
// harness itself); the node definition files are loaded out-of-process by
// `fleet serve` via jiti, not by vitest.
const workspacePackages = [
  'agent', 'cloud', 'config', 'events', 'fleet', 'gateway', 'github-primitive',
  'harness-driver', 'harnesses', 'hooks', 'memory', 'policy', 'runtime', 'sdk',
  'slack-primitive', 'telemetry', 'trajectory', 'utils',
] as const;

const workspaceAliases = workspacePackages.flatMap((packageName) => {
  const sourceRoot = path.resolve(__dirname, `./packages/${packageName}/src`);
  return [
    { find: new RegExp(`^@agent-relay/${packageName}/(.+)$`), replacement: `${sourceRoot}/$1` },
    { find: `@agent-relay/${packageName}`, replacement: path.resolve(sourceRoot, 'index.ts') },
  ];
});

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    teardownTimeout: 30_000,
    // One live stack shared across scenarios — never run files in parallel.
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
  },
});
