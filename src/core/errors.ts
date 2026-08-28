export class BlogPosterError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isRetryable: boolean;
  public readonly details?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    isRetryable: boolean = false,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
    this.details = details;
    this.cause = cause;

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      isRetryable: this.isRetryable,
      details: this.details,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }
}

export class PlatformError extends BlogPosterError {
  public readonly platform: string;
  public readonly endpoint?: string;
  public readonly requestId?: string;

  constructor(
    message: string,
    platform: string,
    code: string = 'PLATFORM_ERROR',
    statusCode: number = 502,
    isRetryable: boolean = true,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, statusCode, isRetryable, details, cause);
    this.platform = platform;
    this.name = 'PlatformError';
  }
}

export class AffiliateError extends BlogPosterError {
  public readonly affiliate: string;
  public readonly productId?: string;

  constructor(
    message: string,
    affiliate: string,
    code: string = 'AFFILIATE_ERROR',
    statusCode: number = 502,
    isRetryable: boolean = true,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, statusCode, isRetryable, details, cause);
    this.affiliate = affiliate;
    this.name = 'AffiliateError';
  }
}

export class TemplateError extends BlogPosterError {
  public readonly templateName: string;
  public readonly missingFields?: string[];

  constructor(
    message: string,
    templateName: string,
    code: string = 'TEMPLATE_ERROR',
    statusCode: number = 400,
    isRetryable: boolean = false,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, statusCode, isRetryable, details, cause);
    this.templateName = templateName;
    this.name = 'TemplateError';
  }
}

export class RateLimitError extends BlogPosterError {
  public readonly retryAfter: number;
  public readonly limit: number;
  public readonly remaining: number;
  public readonly resetAt: Date;

  constructor(
    message: string,
    retryAfter: number,
    limit: number,
    remaining: number,
    resetAt: Date,
    code: string = 'RATE_LIMIT_EXCEEDED',
    statusCode: number = 429,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, statusCode, true, details, cause);
    this.retryAfter = retryAfter;
    this.limit = limit;
    this.remaining = remaining;
    this.resetAt = resetAt;
    this.name = 'RateLimitError';
  }
}

export class AuthenticationError extends BlogPosterError {
  public readonly provider: string;
  public readonly tokenType: 'access' | 'refresh' | 'api_key';

  constructor(
    message: string,
    provider: string,
    tokenType: 'access' | 'refresh' | 'api_key' = 'access',
    code: string = 'AUTHENTICATION_FAILED',
    statusCode: number = 401,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, statusCode, false, details, cause);
    this.provider = provider;
    this.tokenType = tokenType;
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends BlogPosterError {
  public readonly field: string;
  public readonly value: unknown;
  public readonly constraints: string[];

  constructor(
    message: string,
    field: string,
    value: unknown,
    constraints: string[],
    code: string = 'VALIDATION_ERROR',
    statusCode: number = 400,
    details?: Record<string, unknown>,
  ) {
    super(message, code, statusCode, false, details);
    this.field = field;
    this.value = value;
    this.constraints = constraints;
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends BlogPosterError {
  public readonly configKey: string;

  constructor(
    message: string,
    configKey: string,
    code: string = 'CONFIGURATION_ERROR',
    statusCode: number = 500,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, statusCode, false, details, cause);
    this.configKey = configKey;
    this.name = 'ConfigurationError';
  }
}

export class NotFoundError extends BlogPosterError {
  public readonly resource: string;
  public readonly identifier: string;

  constructor(
    resource: string,
    identifier: string,
    code: string = 'NOT_FOUND',
    details?: Record<string, unknown>,
  ) {
    super(`${resource} not found: ${identifier}`, code, 404, false, details);
    this.resource = resource;
    this.identifier = identifier;
    this.name = 'NotFoundError';
  }
}

export class TimeoutError extends BlogPosterError {
  public readonly operation: string;
  public readonly timeoutMs: number;

  constructor(
    operation: string,
    timeoutMs: number,
    code: string = 'TIMEOUT',
    statusCode: number = 504,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(
      `Operation timed out: ${operation} (${timeoutMs}ms)`,
      code,
      statusCode,
      true,
      details,
      cause,
    );
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.name = 'TimeoutError';
  }
}

export class QuotaExceededError extends BlogPosterError {
  public readonly provider: string;
  public readonly quotaType: 'daily' | 'monthly' | 'concurrent';
  public readonly resetAt?: Date;

  constructor(
    provider: string,
    quotaType: 'daily' | 'monthly' | 'concurrent',
    resetAt?: Date,
    code: string = 'QUOTA_EXCEEDED',
    statusCode: number = 429,
    details?: Record<string, unknown>,
  ) {
    super(
      `Quota exceeded for ${provider}: ${quotaType}${resetAt ? `, resets at ${resetAt.toISOString()}` : ''}`,
      code,
      statusCode,
      true,
      details,
    );
    this.provider = provider;
    this.quotaType = quotaType;
    this.resetAt = resetAt;
    this.name = 'QuotaExceededError';
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof BlogPosterError) {
    return error.isRetryable;
  }
  if (error instanceof Error) {
    const networkErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN'];
    return networkErrors.some((code) => (error as NodeJS.ErrnoException).code === code);
  }
  return false;
}

export function getRetryDelay(error: unknown, attempt: number, baseDelay: number = 1000): number {
  if (error instanceof RateLimitError) {
    return error.retryAfter * 1000;
  }
  return Math.min(baseDelay * Math.pow(2, attempt), 30000) + Math.random() * 1000;
}

export function formatErrorForLogging(error: unknown): Record<string, unknown> {
  if (error instanceof BlogPosterError) {
    return error.toJSON();
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
