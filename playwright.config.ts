import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1, // 단일 서버 인스턴스 상태 공유(템플릿 CRUD, 캐시) — 결정적 실행
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/mock/naver-hub-mock.mjs',
      port: 4600,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: 'bash e2e/serve.sh',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
