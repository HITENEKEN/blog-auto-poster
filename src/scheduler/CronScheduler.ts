import cron from 'node-cron';
import { getLogger } from '@core/logger';
import { JobQueue, JobType } from '@core/interfaces';
import { SchedulerConfig, ScheduledJobConfig } from '@core/interfaces';

const logger = getLogger('cron-scheduler');

export interface CronSchedulerOptions {
  jobQueue: JobQueue;
  config: SchedulerConfig;
}

export class CronScheduler {
  private jobQueue: JobQueue;
  private config: SchedulerConfig;
  private scheduledJobs = new Map<string, cron.ScheduledTask>();
  private jobConfigs = new Map<string, ScheduledJobConfig>();
  private running = false;

  constructor(options: CronSchedulerOptions) {
    this.jobQueue = options.jobQueue;
    this.config = options.config;

    // Load scheduled jobs from config
    for (const jobConfig of this.config.jobs) {
      this.jobConfigs.set(jobConfig.name, jobConfig);
    }
  }

  start(): void {
    if (this.running) {
      logger.warn('Scheduler already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('Scheduler disabled in config');
      return;
    }

    logger.info('Starting cron scheduler');

    for (const [name, jobConfig] of this.jobConfigs) {
      if (jobConfig.enabled) {
        this.scheduleJob(name, jobConfig);
      }
    }

    this.running = true;
    logger.info({ scheduledCount: this.scheduledJobs.size }, 'Cron scheduler started');
  }

  stop(): void {
    if (!this.running) return;

    logger.info('Stopping cron scheduler');

    for (const [name, task] of this.scheduledJobs) {
      task.stop();
      logger.debug({ name }, 'Stopped scheduled job');
    }

    this.scheduledJobs.clear();
    this.running = false;
    logger.info('Cron scheduler stopped');
  }

  scheduleJob(name: string, config: ScheduledJobConfig): void {
    if (this.scheduledJobs.has(name)) {
      this.scheduledJobs.get(name)!.stop();
    }

    const task = cron.schedule(
      config.cron,
      async () => {
        logger.info({ jobName: name, type: config.type }, 'Executing scheduled job');

        try {
          const jobId = await this.jobQueue.enqueue({
            type: config.type as JobType,
            priority: config.priority || 0,
            payload: config.config || {},
            maxAttempts: config.maxAttempts || 3,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          logger.info({ jobName: name, jobId }, 'Scheduled job enqueued');
        } catch (error) {
          logger.error({ jobName: name, error: String(error) }, 'Failed to enqueue scheduled job');
        }
      },
      {
        scheduled: true,
        timezone: this.config.timezone,
      },
    );

    this.scheduledJobs.set(name, task);
    this.jobConfigs.set(name, config);
    logger.info({ name, cron: config.cron, timezone: this.config.timezone }, 'Job scheduled');
  }

  unscheduleJob(name: string): boolean {
    const task = this.scheduledJobs.get(name);
    if (task) {
      task.stop();
      this.scheduledJobs.delete(name);
      this.jobConfigs.delete(name);
      logger.info({ name }, 'Job unscheduled');
      return true;
    }
    return false;
  }

  enableJob(name: string): boolean {
    const config = this.jobConfigs.get(name);
    if (!config) return false;

    config.enabled = true;
    this.scheduleJob(name, config);
    return true;
  }

  disableJob(name: string): boolean {
    const config = this.jobConfigs.get(name);
    if (!config) return false;

    config.enabled = false;
    this.unscheduleJob(name);
    return true;
  }

  updateJob(name: string, updates: Partial<ScheduledJobConfig>): boolean {
    const config = this.jobConfigs.get(name);
    if (!config) return false;

    Object.assign(config, updates);
    if (config.enabled) {
      this.scheduleJob(name, config);
    } else {
      this.unscheduleJob(name);
    }
    return true;
  }

  triggerJob(name: string): Promise<string | null> {
    const config = this.jobConfigs.get(name);
    if (!config) {
      logger.warn({ name }, 'Job config not found for manual trigger');
      return Promise.resolve(null);
    }

    logger.info({ jobName: name }, 'Manually triggering job');

    return this.jobQueue.enqueue({
      type: config.type as JobType,
      priority: config.priority || 0,
      payload: config.config || {},
      maxAttempts: config.maxAttempts || 3,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  getScheduledJobs(): Array<{ name: string; config: ScheduledJobConfig; nextRun?: Date }> {
    const result: Array<{ name: string; config: ScheduledJobConfig; nextRun?: Date }> = [];

    for (const [name, config] of this.jobConfigs) {
      const task = this.scheduledJobs.get(name);
      let nextRun: Date | undefined;

      if (task) {
        // node-cron doesn't expose next run directly, we'd need to calculate it
        // For now, just indicate it's scheduled
      }

      result.push({ name, config, nextRun });
    }

    return result;
  }

  getJobConfig(name: string): ScheduledJobConfig | undefined {
    return this.jobConfigs.get(name);
  }

  getAllJobConfigs(): ScheduledJobConfig[] {
    return Array.from(this.jobConfigs.values());
  }

  isRunning(): boolean {
    return this.running;
  }

  updateConfig(config: Partial<SchedulerConfig>): void {
    this.config = { ...this.config, ...config };

    if (config.enabled === false) {
      this.stop();
    } else if (config.enabled === true && !this.running) {
      this.start();
    }

    if (config.jobs) {
      // Re-schedule all jobs
      this.stop();
      for (const jobConfig of config.jobs) {
        this.jobConfigs.set(jobConfig.name, jobConfig);
      }
      this.start();
    }
  }

  getConfig(): SchedulerConfig {
    return { ...this.config };
  }
}

export function createCronScheduler(options: CronSchedulerOptions): CronScheduler {
  return new CronScheduler(options);
}
