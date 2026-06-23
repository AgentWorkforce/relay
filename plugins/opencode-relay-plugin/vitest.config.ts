import { defineConfig } from 'vitest/config';

// Standalone config so the plugin's tests resolve against this package's own
// dependencies rather than climbing to the monorepo root config (the plugin is
// not part of the npm workspaces and is installed/tested in isolation).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    root: __dirname,
  },
});
