import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts', 'src/workflows/__tests__/**/*.test.ts'],
    exclude: [
      'src/__tests__/unit.test.ts',
      // These files use Node.js `test` module (node:test), not vitest
      'src/__tests__/facade.test.ts',
      'src/__tests__/contract-fixtures.test.ts',
      'src/__tests__/integration.test.ts',
      'src/__tests__/models.test.ts',
      'src/__tests__/pty.test.ts',
      'src/__tests__/quickstart.test.ts',
      'src/__tests__/spawn-from-env.test.ts',
      // Communicate tests use node:test, not vitest
      'src/__tests__/communicate/**/*.test.ts',
    ],
  },
});
