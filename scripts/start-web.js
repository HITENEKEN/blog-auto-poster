// Web server entry point
const path = require('path');
const { startWebServer } = require(path.resolve(__dirname, '..', 'dist', 'web', 'server'));

const configDir = process.env.BLOG_POSTER_CONFIG_DIR || './config';
const env = process.env.NODE_ENV || 'development';
const port = parseInt(process.env.BLOG_POSTER_WEB_PORT || process.env.PORT || '3000', 10);
const host = process.env.BLOG_POSTER_WEB_HOST || '0.0.0.0';

startWebServer({ configDir, env, port, host }).catch((error) => {
  console.error('Failed to start web server:', error);
  process.exit(1);
});