import Fastify, { FastifyInstance } from 'fastify';
import { getConfigManager, getLogger } from '@core';
import { getAffiliateRegistry } from '@affiliates';
import { getPlatformRegistry } from '@platforms';
import { createJobQueue } from '@scheduler/JobQueue';
import { createCronScheduler } from '@scheduler/CronScheduler';
import { createKeywordResearcher } from '@intelligence/KeywordResearcher';
import { createCompetitorAnalyzerRegistry } from '@intelligence/CompetitorAnalyzer';
import { createTopicSelector } from '@intelligence/TopicSelector';
import { registerRoutes } from './routes';
import { authMiddleware } from './middleware/auth';
import * as path from 'path';

const logger = getLogger('web-server');

export interface WebServerOptions {
  configDir: string;
  env: string;
  port: number;
  host: string;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const { configDir, env, port, host } = options;

  // Initialize config
  const configManager = getConfigManager(configDir, env);
  await configManager.load();

  const appConfig = configManager.getAll();
  const webConfig = appConfig.web || {};

  // Initialize services
  const affiliateRegistry = getAffiliateRegistry();
  const affiliateConfigs = appConfig.affiliates || {};
  for (const [name, config] of Object.entries(affiliateConfigs)) {
    if ((config as any).enabled) {
      try {
        await affiliateRegistry.initialize(name, config as any);
      } catch (error) {
        logger.warn({ name, error: String(error) }, 'Failed to initialize affiliate adapter');
      }
    }
  }

  const platformRegistry = getPlatformRegistry();
  const platformConfigs = appConfig.platforms || {};
  for (const [name, config] of Object.entries(platformConfigs)) {
    if ((config as any).enabled) {
      try {
        await platformRegistry.initialize(name, config as any);
      } catch (error) {
        logger.warn({ name, error: String(error) }, 'Failed to initialize platform adapter');
      }
    }
  }

  const jobQueue = createJobQueue('./data/jobs.sqlite', {
    maxConcurrentJobs: appConfig.jobQueue?.maxConcurrentJobs || 3,
  });

  const schedulerConfig = appConfig.scheduler || { enabled: false, jobs: [] };
  const scheduler = createCronScheduler({ jobQueue, config: schedulerConfig as any });

  if (schedulerConfig.enabled) {
    scheduler.start();
  }

  // Create Fastify app
  const app = Fastify({
    logger: false, // We use our own logger
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: 'array',
      },
    },
  });

  // Register plugins
  await app.register(import('@fastify/cors'), {
    origin: webConfig.cors?.origin || '*',
    credentials: webConfig.cors?.credentials || true,
  });

  await app.register(import('@fastify/rate-limit'), {
    max: webConfig.rateLimit?.maxRequests || 100,
    timeWindow: webConfig.rateLimit?.windowMs || 900000,
  });

  await app.register(import('@fastify/websocket'));
  await app.register(import('@fastify/jwt'), {
    secret: webConfig.jwtSecret || 'change-me-in-production',
    sign: { expiresIn: webConfig.jwtExpiresIn || '7d' },
  });

  await app.register(import('@fastify/static'), {
    root: path.join(__dirname, '../../client/dist'),
    prefix: '/',
  });

  // Health check
  app.get('/health', async () => {
    const affiliateStatus = await affiliateRegistry.validateAll();
    const platformStatus = await platformRegistry.validateAll();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        affiliates: affiliateStatus,
        platforms: platformStatus,
        jobQueue: jobQueue.getStats(),
        scheduler: scheduler.isRunning() ? 'running' : 'stopped',
      },
    };
  });

  // Auth middleware
  await app.register(authMiddleware);

  // Register API routes
  await registerRoutes(app, {
    configManager,
    affiliateRegistry,
    platformRegistry,
    jobQueue,
    scheduler,
  });

  // Serve SPA for non-API routes
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down web server...');
    scheduler.stop();
    jobQueue.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return app;
}

export async function startWebServer(options: WebServerOptions): Promise<void> {
  const app = await createWebServer(options);
  const { port, host } = options;

  try {
    await app.listen({ port, host });
    logger.info({ port, host }, 'Web server started');
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to start web server');
    process.exit(1);
  }
}