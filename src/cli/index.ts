import { Command } from 'commander';
import { getConfigManager, getLogger } from '../core';
import { getAffiliateRegistry } from '../affiliates';
import { createTemplateEngine } from '../content/TemplateEngine';
import { createImageGenerator } from '../content/ImageGenerator';
import { createPostAssembler } from '../content/PostAssembler';
import { createJobQueue } from '../scheduler/JobQueue';
import { createCronScheduler } from '../scheduler/CronScheduler';
import { PlatformPostContent } from '../core/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const logger = getLogger('cli');

const program = new Command();

program
  .name('blog-poster')
  .description('Automated blog posting system for affiliate marketing')
  .version('1.0.0');

// Global options
program
  .option('-c, --config <path>', 'Config directory path', './config')
  .option('-e, --env <env>', 'Environment (development|test|production)', 'development')
  .option('-v, --verbose', 'Verbose output');

// Initialize core services
async function initializeServices(configDir: string, env: string) {
  const configManager = getConfigManager(configDir, env);
  await configManager.load();

  const affiliateRegistry = getAffiliateRegistry();

  // Initialize affiliates
  const affiliateConfigs = configManager.getAll().affiliates || {};
  for (const [name, config] of Object.entries(affiliateConfigs)) {
    if ((config as any).enabled) {
      try {
        await affiliateRegistry.initialize(name, config as any);
      } catch (error) {
        logger.warn({ name, error: String(error) }, 'Failed to initialize affiliate adapter');
      }
    }
  }

  return { affiliateRegistry };
}

// Config wizard command
program
  .command('config')
  .description('Interactive configuration wizard')
  .action(async () => {
    const inquirer = await import('inquirer');
    const { default: chalk } = await import('chalk');

    console.log(chalk.cyan('\n=== Blog Auto Poster Configuration Wizard ===\n'));

    const answers = await inquirer.default.prompt([
      {
        type: 'input',
        name: 'coupangApiKey',
        message: 'Coupang Partners API Key:',
        mask: '*',
      },
      {
        type: 'input',
        name: 'coupangApiSecret',
        message: 'Coupang Partners API Secret:',
        mask: '*',
      },
      {
        type: 'input',
        name: 'coupangTrackingId',
        message: 'Coupang Tracking ID (subId):',
      },
      {
        type: 'confirm',
        name: 'tistoryEnabled',
        message: 'Enable Tistory publishing?',
        default: false,
      },
      {
        type: 'input',
        name: 'tistoryBlogName',
        message: 'Tistory Blog Name:',
        when: (answers: any) => answers.tistoryEnabled,
      },
      {
        type: 'input',
        name: 'tistoryUsername',
        message: 'Tistory Username:',
        when: (answers: any) => answers.tistoryEnabled,
      },
      {
        type: 'password',
        name: 'tistoryPassword',
        message: 'Tistory Password:',
        when: (answers: any) => answers.tistoryEnabled,
        mask: '*',
      },
      {
        type: 'input',
        name: 'tistoryApiKey',
        message: 'Tistory API Key:',
        when: (answers: any) => answers.tistoryEnabled,
      },
      {
        type: 'confirm',
        name: 'wordpressEnabled',
        message: 'Enable WordPress publishing?',
        default: false,
      },
      {
        type: 'input',
        name: 'wordpressUrl',
        message: 'WordPress URL:',
        when: (answers: any) => answers.wordpressEnabled,
      },
      {
        type: 'input',
        name: 'wordpressUsername',
        message: 'WordPress Username:',
        when: (answers: any) => answers.wordpressEnabled,
      },
      {
        type: 'password',
        name: 'wordpressAppPassword',
        message: 'WordPress Application Password:',
        when: (answers: any) => answers.wordpressEnabled,
        mask: '*',
      },
      {
        type: 'confirm',
        name: 'youtubeEnabled',
        message: 'Enable YouTube Shorts publishing?',
        default: false,
      },
      {
        type: 'input',
        name: 'youtubeClientId',
        message: 'YouTube Client ID:',
        when: (answers: any) => answers.youtubeEnabled,
      },
      {
        type: 'password',
        name: 'youtubeClientSecret',
        message: 'YouTube Client Secret:',
        when: (answers: any) => answers.youtubeEnabled,
        mask: '*',
      },
      {
        type: 'password',
        name: 'youtubeRefreshToken',
        message: 'YouTube Refresh Token:',
        when: (answers: any) => answers.youtubeEnabled,
        mask: '*',
      },
    ]);

    // Write secrets.yaml
    const secretsPath = path.join('./config', 'secrets.yaml');
    const secretsContent = `
affiliates:
  coupang:
    apiKey: "${answers.coupangApiKey}"
    apiSecret: "${answers.coupangApiSecret}"
    trackingId: "${answers.coupangTrackingId}"
${answers.tistoryEnabled ? `
platforms:
  tistory:
    blogName: "${answers.tistoryBlogName}"
    username: "${answers.tistoryUsername}"
    password: "${answers.tistoryPassword}"
    apiKey: "${answers.tistoryApiKey}"
` : ''}
${answers.wordpressEnabled ? `
platforms:
  wordpress:
    url: "${answers.wordpressUrl}"
    username: "${answers.wordpressUsername}"
    appPassword: "${answers.wordpressAppPassword}"
` : ''}
${answers.youtubeEnabled ? `
platforms:
  youtube-shorts:
    clientId: "${answers.youtubeClientId}"
    clientSecret: "${answers.youtubeClientSecret}"
    refreshToken: "${answers.youtubeRefreshToken}"
` : ''}
`;

    fs.writeFileSync(secretsPath, secretsContent.trim());
    console.log(chalk.green(`\nConfiguration saved to ${secretsPath}`));
    console.log(chalk.yellow('Note: secrets.yaml is gitignored. Do not commit it.'));
  });

// Research command
program
  .command('research <keyword>')
  .description('Research keywords and analyze competitors via Naver API Hub')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-p, --providers <providers>', 'Comma-separated providers (naver-api-hub,coupang)', 'naver-api-hub,coupang')
  .action(async (keyword: string, options: any) => {
    const configDir = program.opts().config;
    const env = program.opts().env;

    const configManager = getConfigManager(configDir, env);
    await configManager.load();

    const { NaverApiHubKeywordProvider } = await import('../intelligence/NaverApiHubProvider.js');

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      console.error(chalk.red('Naver API Hub credentials not configured. Set keywordProviders.naver-api-hub in secrets.yaml'));
      process.exit(1);
    }

    const provider = new NaverApiHubKeywordProvider(hubConfig);

    console.log(chalk.cyan(`\nResearching: "${keyword}"\n`));

    // Keyword research
    const results = await provider.research([keyword], { limit: parseInt(options.limit) });
    console.log(chalk.green('=== Keyword Research Results ==='));
    for (const r of results) {
      console.log(`  Keyword:    ${r.keyword}`);
      console.log(`  Volume:     ~${r.volume.toLocaleString()}`);
      console.log(`  Competition:${'█'.repeat(Math.round(r.competition * 10))}${'░'.repeat(10 - Math.round(r.competition * 10))} ${(r.competition * 100).toFixed(0)}%`);
      console.log(`  Trend:      ${r.trend}`);
      if (r.related.length > 0) {
        console.log(`  Related:    ${r.related.slice(0, 8).join(', ')}`);
      }
      console.log('');
    }

    // Blog search results
    try {
      const blogResults = await provider.searchBlog(keyword, parseInt(options.limit));
      console.log(chalk.green('=== Blog Search Results (Top Competitors) ==='));
      const items = blogResults.items || [];
      for (let i = 0; i < Math.min(items.length, 10); i++) {
        const item = items[i];
        const title = item.title.replace(/<[^>]*>/g, '');
        console.log(`  ${i + 1}. ${title}`);
        console.log(`     Blog: ${item.bloggername || 'N/A'} | Date: ${item.postdate || 'N/A'}`);
        console.log(`     URL:  ${item.link}`);
        console.log('');
      }
      console.log(chalk.gray(`Total results: ${blogResults.total?.toLocaleString()}`));
    } catch (error) {
      console.error(chalk.red(`Blog search failed: ${String(error)}`));
    }
  });
// Generate command
program
  .command('generate')
  .description('Generate a blog post from template and product data')
  .requiredOption('-t, --template <name>', 'Template name')
  .requiredOption('-p, --product <id>', 'Product ID')
  .option('--platform <name>', 'Target platform (tistory|wordpress|youtube-shorts)')
  .option('--dry-run', 'Output to file without publishing', false)
  .action(async (options: any) => {
    const configDir = program.opts().config;
    const env = program.opts().env;

    const configManager = getConfigManager(configDir, env);
    await configManager.load();

  const affiliateRegistry = getAffiliateRegistry();
  const allConfig = configManager.getAll() as any;
  await affiliateRegistry.initialize('coupang', allConfig.affiliates?.coupang || {});
  const coupangAdapter = affiliateRegistry.getAdapter('coupang');
  const product = await coupangAdapter.getProductDetails(options.product);

  const templateEngine = createTemplateEngine('./templates');
  await templateEngine.loadTemplates();
  await templateEngine.validateTemplate(options.template);

  const imageGenerator = createImageGenerator('placeholder', './output/images');
  const postAssembler = createPostAssembler(templateEngine, imageGenerator);

    const post = await postAssembler.assemble({
      template: options.template,
      affiliateData: product,
      platform: options.platform,
    });

    if (options.dryRun) {
      const outputDir = `./output/posts/${post.id}`;
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'post.html'), post.content);
      fs.writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify(post.meta, null, 2));
      fs.writeFileSync(path.join(outputDir, 'platform-content.json'), JSON.stringify(post.platformContent, null, 2));
      console.log(`Post generated at ${outputDir}`);
    } else {
      console.log(JSON.stringify(post, null, 2));
    }
  });

// Publish command (stubbed - requires platforms module)
program
  .command('publish')
  .description('Publish a post to a platform (requires platforms module)')
  .requiredOption('--post-id <id>', 'Post ID')
  .requiredOption('--platform <name>', 'Platform name (tistory|wordpress|youtube-shorts)')
  .action(async (options: any) => {
    console.log(chalk.yellow('Publish command requires the platforms module which is not included in this build.'));
    console.log(chalk.yellow('Please build with the full module set or use the web dashboard.'));
  });

// Schedule commands
program
  .command('schedule')
  .description('Manage scheduled jobs')
  .argument('<action>', 'Action (list|enable|disable)')
  .argument('[name]', 'Job name')
  .action(async (action: string, name?: string) => {
    const configDir = program.opts().config;
    const env = program.opts().env;

    await initializeServices(configDir, env);

    const jobQueue = createJobQueue('./data/jobs.sqlite');
    const configManager = getConfigManager(configDir, env);
    const schedulerConfig = configManager.getAll().scheduler || { enabled: false, jobs: [] };

    const scheduler = createCronScheduler({
      jobQueue,
      config: schedulerConfig as any,
    });

    switch (action) {
      case 'list':
        const jobs = scheduler.getScheduledJobs();
        console.table(jobs.map(j => ({
          name: j.name,
          type: j.config.type,
          cron: j.config.cron,
          enabled: j.config.enabled,
        })));
        break;

      case 'enable':
        if (!name) {
          console.error('Job name required for enable');
          process.exit(1);
        }
        scheduler.enableJob(name);
        console.log(`Job ${name} enabled`);
        break;

      case 'disable':
        if (!name) {
          console.error('Job name required for disable');
          process.exit(1);
        }
        scheduler.disableJob(name);
        console.log(`Job ${name} disabled`);
        break;

      default:
        console.error(`Unknown action: ${action}`);
        process.exit(1);
    }
  });

// Analytics command
program
  .command('analytics')
  .description('Show analytics')
  .option('-d, --days <number>', 'Number of days', '30')
  .action(async (options: any) => {
    const configDir = program.opts().config;
    const env = program.opts().env;

    await initializeServices(configDir, env);

    const jobQueue = createJobQueue('./data/jobs.sqlite');
    const days = parseInt(options.days);
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const posts = jobQueue.getPublishedPosts({ fromDate, limit: 1000 });

    const stats = {
      totalPosts: posts.length,
      byPlatform: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      byTemplate: {} as Record<string, number>,
      totalViews: 0,
      totalClicks: 0,
    };

    for (const post of posts) {
      stats.byPlatform[post.platform] = (stats.byPlatform[post.platform] || 0) + 1;
      stats.byStatus[post.status] = (stats.byStatus[post.status] || 0) + 1;
      if (post.template) {
        stats.byTemplate[post.template] = (stats.byTemplate[post.template] || 0) + 1;
      }
    }

    console.log(JSON.stringify(stats, null, 2));
  });

// Parse and run
program.parseAsync(process.argv).catch((error) => {
  logger.error({ error: String(error) }, 'CLI error');
  process.exit(1);
});