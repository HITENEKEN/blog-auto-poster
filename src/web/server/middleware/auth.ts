// @ts-nocheck
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '@core/logger';

const logger = getLogger('auth-middleware');

export interface JWTPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  iat?: number;
  exp?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

export async function authMiddleware(app: FastifyInstance): Promise<void> {
  // Decorate request with user (skip if already decorated)
  if (!app.hasRequestDecorator('user')) {
    app.decorateRequest('user', undefined);
  }

  // Add hook to verify JWT on protected routes
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public routes
    if (isPublicRoute(request.url)) {
      return;
    }

    try {
      await request.jwtVerify();
      // User is attached to request.user by fastify-jwt
    } catch (error) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing authentication token',
      });
    }
  });

  // Login endpoint
  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = request.body as { username: string; password: string };

    // In production, verify against hashed password in database
    // For now, use config-based admin credentials
    const configManager = app.configManager;
    const adminUser = configManager.get<string>('web.adminUsername', 'admin');
    const adminPass = configManager.get<string>('web.adminPassword', 'changeme');

    if (username === adminUser && password === adminPass) {
      const token = app.jwt.sign({
        userId: '1',
        username,
        role: 'admin',
      });

      return reply.send({
        token,
        user: { username, role: 'admin' },
      });
    }

    return reply.code(401).send({
      error: 'Invalid credentials',
      message: 'Username or password is incorrect',
    });
  });

  // Refresh token endpoint
  app.post('/api/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const token = app.jwt.sign({
        userId: request.user!.userId,
        username: request.user!.username,
        role: request.user!.role,
      });
      return reply.send({ token });
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }
  });

  // Get current user
  app.get('/api/auth/me', async (request: FastifyRequest) => {
    return request.user;
  });
}

function isPublicRoute(url: string): boolean {
  const publicRoutes = [
    '/health',
    '/api/auth/login',
    '/api/auth/refresh',
    '/ws', // WebSocket handled separately
  ];

  return publicRoutes.some(route => url.startsWith(route)) || url.startsWith('/static/') || url === '/';
}

// Role-based access control
export function requireRole(...roles: JWTPayload['role'][]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }
  };
}