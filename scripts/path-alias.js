// Runtime path alias resolver for compiled dist/ output
const tsconfigPaths = require('tsconfig-paths');
const path = require('path');
const baseUrl = path.resolve(__dirname, '..', 'dist');
tsconfigPaths.register({
  baseUrl,
  paths: {
    '@core/*': ['core/*'],
    '@affiliates/*': ['affiliates/*'],
    '@content/*': ['content/*'],
    '@scheduler/*': ['scheduler/*'],
    '@cli/*': ['cli/*'],
  },
});
