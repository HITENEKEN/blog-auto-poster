import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/web/client/**', 'e2e/**'],
    passWithNoTests: true,
  },
});
