import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '@core/logger';
import {
  JobQueue,
  Job,
  JobType,
  JobStatus,
  JobFilters,
  JobQueueStats,
} from '@core/interfaces';
import { ConfigurationError } from '@core/errors';

const logger = getLogger('job-queue');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS published_posts (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  template TEXT,
  product_id TEXT,
  affiliate_url TEXT,
  status TEXT NOT NULL,
  published_at TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at ON jobs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_priority_created ON jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_published_posts_platform ON published_posts(platform);
CREATE INDEX IF NOT EXISTS idx_published_posts_published_at ON published_posts(published_at);
`;

export class JobQueueImpl implements JobQueue {
  private db: Database.Database;
  private dbPath: string;
  private processors = new Map<JobType, (job: Job) => Promise<any>>();
  private running = false;
  private maxConcurrent: number;
  private defaultRetryAttempts: number;
  private defaultRetryDelayMs: number;
  private deadLetterAfterAttempts: number;
  private concurrencySlots = 0;

  constructor(
    dbPath: string = './data/jobs.sqlite',
    options: {
      maxConcurrent?: number;
      defaultRetryAttempts?: number;
      defaultRetryDelayMs?: number;
      deadLetterAfterAttempts?: number;
    } = {}
  ) {
    this.dbPath = dbPath;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.defaultRetryAttempts = options.defaultRetryAttempts || 3;
    this.defaultRetryDelayMs = options.defaultRetryDelayMs || 5000;
    this.deadLetterAfterAttempts = options.deadLetterAfterAttempts || 5;

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    logger.info({ dbPath, maxConcurrent: this.maxConcurrent }, 'Job queue initialized');
  }

  registerProcessor(type: JobType, processor: (job: Job) => Promise<any>): void {
    this.processors.set(type, processor);
    logger.debug({ type }, 'Processor registered');
  }

  async enqueue(job: Omit<Job, 'id' | 'retryCount' | 'status'>): Promise<string> {
    const id = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, type, status, priority, payload, max_attempts, scheduled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      job.type,
      job.scheduledAt ? 'PENDING' : 'QUEUED',
      job.priority || 0,
      JSON.stringify(job.payload),
      job.maxAttempts || this.defaultRetryAttempts,
      job.scheduledAt || null,
      now,
      now
    );

    logger.info({ jobId: id, type: job.type, status: job.scheduledAt ? 'PENDING' : 'QUEUED' }, 'Job enqueued');
    return id;
  }

  async enqueueBatch(jobs: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'attempts'>[]): Promise<string[]> {
    const ids: string[] = [];
    const now = new Date().toISOString();

    const insert = this.db.prepare(`
      INSERT INTO jobs (id, type, status, priority, payload, max_attempts, scheduled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((jobsToInsert: typeof jobs) => {
      for (const job of jobsToInsert) {
        const id = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        insert.run(
          id,
          job.type,
          job.scheduledAt ? 'PENDING' : 'QUEUED',
          job.priority || 0,
          JSON.stringify(job.payload),
          job.maxAttempts || this.defaultRetryAttempts,
          job.scheduledAt || null,
          now,
          now
        );
        ids.push(id);
      }
    });

    transaction(jobs);
    logger.info({ count: ids.length }, 'Jobs enqueued in batch');
    return ids;
  }

  async dequeue(types?: JobType[]): Promise<Job | null> {
    if (this.concurrencySlots >= this.maxConcurrent) {
      return null;
    }

    let query = `
      SELECT * FROM jobs
      WHERE status = 'QUEUED'
      AND (scheduled_at IS NULL OR scheduled_at <= ?)
    `;
    const params: any[] = [new Date().toISOString()];

    if (types && types.length > 0) {
      query += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    query += ` ORDER BY priority DESC, created_at ASC LIMIT 1`;

    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as any;

    if (!row) return null;

    // Update status to RUNNING
    const updateStmt = this.db.prepare(`
      UPDATE jobs SET status = 'RUNNING', started_at = ?, updated_at = ?, attempts = attempts + 1
      WHERE id = ?
    `);
    const now = new Date().toISOString();
    updateStmt.run(now, now, row.id);

    this.concurrencySlots++;

    return this.rowToJob(row);
  }

  async process(job: Job): Promise<void> {
    const processor = this.processors.get(job.type);
    if (!processor) {
      throw new ConfigurationError(`No processor registered for job type: ${job.type}`, 'job_queue');
    }

    try {
      logger.info({ jobId: job.id, type: job.type, attempt: job.attempts }, 'Processing job');

      const result = await processor(job);

      // Mark completed
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE jobs SET status = 'COMPLETED', result = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(result), now, now, job.id);

      this.log(job.id, 'info', 'Job completed successfully', { result });
      logger.info({ jobId: job.id }, 'Job completed');
    } catch (error) {
      await this.handleFailure(job, error);
    } finally {
      this.concurrencySlots = Math.max(0, this.concurrencySlots - 1);
    }
  }

  private async handleFailure(job: Job, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isRetryable = job.attempts < job.maxAttempts;

    const now = new Date().toISOString();

    if (isRetryable) {
      // Schedule retry with exponential backoff
      const delay = this.defaultRetryDelayMs * Math.pow(2, job.attempts - 1);
      const retryAt = new Date(Date.now() + delay).toISOString();

      this.db.prepare(`
        UPDATE jobs SET status = 'RETRYING', error = ?, scheduled_at = ?, updated_at = ?
        WHERE id = ?
      `).run(errorMessage, retryAt, now, job.id);

      this.log(job.id, 'warn', `Job failed, scheduling retry in ${delay}ms`, { error: errorMessage, attempt: job.attempts, nextRetry: retryAt });
      logger.warn({ jobId: job.id, attempt: job.attempts, delay }, 'Job failed, retry scheduled');
    } else {
      // Check if should go to dead letter
      if (job.attempts >= this.deadLetterAfterAttempts) {
        this.db.prepare(`
          UPDATE jobs SET status = 'DEAD_LETTER', error = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(errorMessage, now, now, job.id);

        this.log(job.id, 'error', 'Job moved to dead letter queue', { error: errorMessage, attempts: job.attempts });
        logger.error({ jobId: job.id, attempts: job.attempts }, 'Job moved to dead letter');
      } else {
        this.db.prepare(`
          UPDATE jobs SET status = 'FAILED', error = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(errorMessage, now, now, job.id);

        this.log(job.id, 'error', 'Job failed permanently', { error: errorMessage });
        logger.error({ jobId: job.id, error: errorMessage }, 'Job failed permanently');
      }
    }
  }

  async retry(jobId: string): Promise<boolean> {
    const job = this.get(jobId);
    if (!job || (job.status !== 'FAILED' && job.status !== 'DEAD_LETTER')) {
      return false;
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE jobs SET status = 'QUEUED', attempts = 0, error = NULL, scheduled_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, jobId);

    this.log(jobId, 'info', 'Job manually retried');
    logger.info({ jobId }, 'Job manually retried');
    return true;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.get(jobId);
    if (!job || (job.status !== 'QUEUED' && job.status !== 'PENDING' && job.status !== 'RETRYING')) {
      return false;
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE jobs SET status = 'FAILED', error = 'Cancelled by user', completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, jobId);

    this.log(jobId, 'info', 'Job cancelled by user');
    logger.info({ jobId }, 'Job cancelled');
    return true;
  }
  get(jobId: string): Job | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(jobId) as any;
    return row ? this.rowToJob(row) : null;
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.get(jobId);
  }

  async getJobs(filters: JobFilters = {}): Promise<Job[]> {
    return this.getMany(filters);
  }

  async complete(jobId: string, result?: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE jobs SET status = 'COMPLETED', result = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(result ? JSON.stringify(result) : null, now, now, jobId);
    this.log(jobId, 'info', 'Job completed', { result });
  }

  async fail(jobId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE jobs SET status = 'FAILED', error = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(error, now, now, jobId);
    this.log(jobId, 'error', 'Job failed', { error });
  }

  async cleanup(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM jobs WHERE created_at < ? AND status IN ('COMPLETED', 'FAILED', 'DEAD_LETTER')
    `).run(cutoffDate);
    return result.changes;
  }

  getMany(filters: JobFilters = {}): Job[] {
    let query = 'SELECT * FROM jobs WHERE 1=1';
    const params: any[] = [];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters.fromDate) {
      query += ' AND created_at >= ?';
      params.push(filters.fromDate);
    }
    if (filters.toDate) {
      query += ' AND created_at <= ?';
      params.push(filters.toDate);
    }
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.rowToJob(row));
  }

  getStats(): JobQueueStats {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END) as retrying,
        SUM(CASE WHEN status = 'DEAD_LETTER' THEN 1 ELSE 0 END) as dead_letter
      FROM jobs
    `).get() as any;

    const typeStats = this.db.prepare(`
      SELECT type, status, COUNT(*) as count
      FROM jobs
      GROUP BY type, status
    `).all() as any[];

    const byType: Record<string, Record<string, number>> = {};
    for (const row of typeStats) {
      if (!byType[row.type]) byType[row.type] = {};
      byType[row.type][row.status] = row.count;
    }

    return {
      total: stats.total || 0,
      pending: stats.pending || 0,
      queued: stats.queued || 0,
      running: stats.running || 0,
      completed: stats.completed || 0,
      failed: stats.failed || 0,
      retrying: stats.retrying || 0,
      deadLetter: stats.dead_letter || 0,
      byType,
    };
  }

  async log(jobId: string, level: 'info' | 'warn' | 'error' | 'debug', message: string, metadata?: Record<string, unknown>): Promise<void> {
    this.db.prepare(`
      INSERT INTO job_logs (job_id, level, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, level, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
  }

  getLogs(jobId: string, limit: number = 100): Array<{ level: string; message: string; metadata?: Record<string, unknown>; createdAt: string }> {
    const stmt = this.db.prepare(`
      SELECT level, message, metadata, created_at FROM job_logs
      WHERE job_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(jobId, limit) as any[];
    return rows.map(row => ({
      level: row.level,
      message: row.message,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    }));
  }

  recordPublishedPost(post: {
    jobId?: string;
    platform: string;
    postId: string;
    url: string;
    title?: string;
    template?: string;
    productId?: string;
    affiliateUrl?: string;
    status: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO published_posts (id, job_id, platform, post_id, url, title, template, product_id, affiliate_url, status, published_at, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `pub-${post.platform}-${post.postId}`,
      post.jobId || null,
      post.platform,
      post.postId,
      post.url,
      post.title || null,
      post.template || null,
      post.productId || null,
      post.affiliateUrl || null,
      post.status,
      now,
      post.metadata ? JSON.stringify(post.metadata) : null,
      now
    );
  }

  getPublishedPosts(filters: { platform?: string; status?: string; fromDate?: string; toDate?: string; limit?: number } = {}): any[] {
    let query = 'SELECT * FROM published_posts WHERE 1=1';
    const params: any[] = [];

    if (filters.platform) {
      query += ' AND platform = ?';
      params.push(filters.platform);
    }
    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.fromDate) {
      query += ' AND published_at >= ?';
      params.push(filters.fromDate);
    }
    if (filters.toDate) {
      query += ' AND published_at <= ?';
      params.push(filters.toDate);
    }
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    query += ' ORDER BY published_at DESC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as any[];
  }

  close(): void {
    this.db.close();
    logger.info('Job queue closed');
  }

  private rowToJob(row: any): Job {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      priority: row.priority,
      payload: JSON.parse(row.payload),
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function createJobQueue(dbPath?: string, options?: any): JobQueueImpl {
  return new JobQueueImpl(dbPath, options);
}