import Fastify, { FastifyInstance } from 'fastify';
import { getConfigManager, getLogger } from '@core/index';
import { getAffiliateRegistry } from '@affiliates/index';
import { getPlatformRegistry } from '@platforms';
import { createJobQueue } from '@scheduler/JobQueue';
import { createCronScheduler } from '@scheduler/CronScheduler';
import type {
  AppConfig,
  AffiliateConfig,
  PlatformCredentials,
  SchedulerConfig,
} from '@core/interfaces';
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
  const { configDir, env } = options;

  // Initialize config
  const configManager = getConfigManager(configDir, env);
  await configManager.load();

  const appConfig = configManager.getAll();
  const webConfig = (appConfig.web || {}) as AppConfig['web'];

  // Initialize services
  const affiliateRegistry = getAffiliateRegistry();
  const affiliateConfigs = (appConfig.affiliates || {}) as Record<
    string,
    AffiliateConfig & { enabled?: boolean }
  >;
  for (const [name, config] of Object.entries(affiliateConfigs)) {
    if (config.enabled) {
      try {
        await affiliateRegistry.initialize(name, config);
      } catch (error) {
        logger.warn({ name, error: String(error) }, 'Failed to initialize affiliate adapter');
      }
    }
  }

  const platformRegistry = getPlatformRegistry();
  const platformConfigs = (appConfig.platforms || {}) as Record<string, PlatformCredentials>;
  for (const [name, config] of Object.entries(platformConfigs)) {
    if (config.enabled) {
      try {
        await platformRegistry.initialize(name, config);
      } catch (error) {
        logger.warn({ name, error: String(error) }, 'Failed to initialize platform adapter');
      }
    }
  }

  const jobQueue = createJobQueue('./data/jobs.sqlite');

  const schedulerConfig = (appConfig.scheduler || { enabled: false, jobs: [] }) as SchedulerConfig;
  const scheduler = createCronScheduler({ jobQueue, config: schedulerConfig });

  if (schedulerConfig.enabled) {
    scheduler.start();
  }

  // Create Fastify app
  const app = Fastify({
    logger: false, // We use our own logger
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: 'array' as const,
      },
    },
  });

  await app.register(import('@fastify/cors'), {
    origin: (origin, cb) => {
      const allowedOrigins =
        webConfig.cors?.origin === '*'
          ? [
              'http://localhost:5173',
              'http://localhost:3002',
              'http://127.0.0.1:3002',
              'http://127.0.0.1:5173',
            ]
          : (Array.isArray(webConfig.cors?.origin)
              ? webConfig.cors.origin
              : [webConfig.cors?.origin]
            ).filter(Boolean);
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error('CORS not allowed'), false);
      }
    },
    credentials: true,
  });

  await app.register(import('@fastify/rate-limit'), {
    // Global limiting disabled: dashboard/Coupang polling + static assets must not
    // count against the limit. Only routes opting in (login) are rate limited.
    global: false,
    max: webConfig.rateLimit?.maxRequests || 100,
    timeWindow: webConfig.rateLimit?.windowMs || 900000,
  });

  await app.register(import('@fastify/websocket'));
  await app.register(import('@fastify/jwt'), {
    secret: webConfig.jwtSecret || 'change-me-in-production',
    sign: { expiresIn: webConfig.jwtExpiresIn || '7d' },
  });

  await app.register(import('@fastify/static'), {
    root: path.resolve(process.cwd(), 'src/web/client/dist'),
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
  await app.register(authMiddleware, { configManager });

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
