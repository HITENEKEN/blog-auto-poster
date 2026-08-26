// Runtime path alias resolver for compiled dist/ output
const tsconfigPaths = require('tsconfig-paths');
const path = require('path');
const baseUrl = path.resolve(__dirname, '..', 'dist');
tsconfigPaths.register({
  baseUrl,
  paths: {
    '@core': ['core/index.js'],
    '@core/*': ['core/*'],
    '@affiliates': ['affiliates/index.js'],
    '@affiliates/*': ['affiliates/*'],
    '@platforms': ['platforms/index.js'],
    '@platforms/*': ['platforms/*'],
    '@intelligence': ['intelligence/index.js'],
    '@intelligence/*': ['intelligence/*'],
    '@content': ['content/index.js'],
    '@content/*': ['content/*'],
    '@scheduler': ['scheduler/index.js'],
    '@scheduler/*': ['scheduler/*'],
    '@cli': ['cli/index.js'],
    '@cli/*': ['cli/*'],
  },
});