import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// 프록시 대상 API 포트: 미설정 시 기존대로 3002(PM2 운영 서버). dev-server.sh 는
// BLOG_POSTER_WEB_PORT=3005 로 실행하므로 dev:web 사용 시 자동으로 dev 서버를 바라본다.
const apiPort = process.env.BLOG_POSTER_WEB_PORT || '3002';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
