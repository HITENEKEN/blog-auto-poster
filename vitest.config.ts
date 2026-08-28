import { defineConfig } from 'vitest/config';
import path from 'path';

// tsconfig paths 미러(@core/* 등) — 유닛 테스트가 에일리어스 import를 로드할 수 있게 한다.
const aliases: Record<string, string> = {
  '@core': path.resolve(__dirname, 'src/core'),
  '@affiliates': path.resolve(__dirname, 'src/affiliates'),
  '@content': path.resolve(__dirname, 'src/content'),
  '@scheduler': path.resolve(__dirname, 'src/scheduler'),
  '@cli': path.resolve(__dirname, 'src/cli'),
  '@platforms': path.resolve(__dirname, 'src/platforms'),
  '@shared': path.resolve(__dirname, 'src/web/shared'),
};

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      Object.entries(aliases).map(([key, dir]) => [
        key,
        // @platforms는 index.ts 파일로 직결, 나머지는 디렉터리 매핑
        key === '@platforms' ? path.join(dir, 'index.ts') : dir,
      ]),
    ),
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/web/client/**', 'e2e/**'],
    passWithNoTests: true,
  },
});
