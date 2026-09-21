// PM2 앱 정의 — web(대시보드)과 robot(자동 포스터)을 함께 관리한다.
// 비밀값은 커밋하지 않는 .env에서 읽어 두 앱에 전달한다.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const pick = (...keys) =>
  Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const adminEnv = pick('BLOG_POSTER_WEB_ADMIN_USERNAME', 'BLOG_POSTER_WEB_ADMIN_PASSWORD');

module.exports = {
  apps: [
    {
      name: 'blog-auto-poster-web',
      script: 'scripts/start-web.js',
      cwd: __dirname,
      env: { BLOG_POSTER_WEB_PORT: '3002', BLOG_POSTER_WEB_HOST: '127.0.0.1', ...adminEnv },
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'blog-auto-poster-robot',
      script: 'dist/robot/index.js',
      node_args: '-r ./scripts/path-alias.js',
      cwd: __dirname,
      env: { BLOG_POSTER_ROBOT_API_BASE: 'http://127.0.0.1:3002', ...adminEnv },
      autorestart: true,
      min_uptime: '60s',
      max_restarts: 10,
      restart_delay: 30000,
      kill_timeout: 10000,
    },
  ],
};
