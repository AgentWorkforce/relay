import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts', 'src/workflows/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/unit.test.ts'],
    // setupFiles removed — no longer needed since globals:true provides describe/it
  },
});
