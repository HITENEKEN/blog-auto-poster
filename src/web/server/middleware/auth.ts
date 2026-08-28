import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConfigManager } from '@core/interfaces';

export interface JWTPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  iat?: number;
  exp?: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JWTPayload;
    user: JWTPayload;
  }
}

export async function authMiddleware(
  app: FastifyInstance,
  opts: { configManager?: ConfigManager } = {},
): Promise<void> {
  // Dev-only auth bypass: opt-in via env BLOG_POSTER_WEB_AUTH_DISABLED=true OR config web.auth.disabled=true.
  const authDisabled =
    process.env.BLOG_POSTER_WEB_AUTH_DISABLED === 'true' ||
    opts?.configManager?.get('web.auth.disabled') === true;

  // Decorate request with user (skip if already decorated)
  if (!app.hasRequestDecorator('user')) {
    app.decorateRequest('user', undefined);
  }

  // Add hook to verify JWT on protected routes
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Guard only /api/* endpoints. Non-API routes must stay public: the
    // not-found handler serves index.html for client-side SPA routes, and this
    // hook runs for that handler too — an unconditional check would 401 every
    // deep link (/login, /keywords, ...) instead of serving the app shell.
    if (!request.url.startsWith('/api/') || isPublicRoute(request.url)) {
      return;
    }

    if (authDisabled) {
      request.user = { userId: '1', username: 'local-admin', role: 'admin' };
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing authentication token',
      });
      return;
    }
  });
  // Login endpoint - credentials hardcoded for single-admin setup
  // Brute-force protection: the only rate-limited route (global limiter is off).
  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { username, password } = request.body as { username: string; password: string };

      // Dev-only bypass: accept any (or empty) credentials and still issue an admin JWT.
      if (authDisabled) {
        const token = app.jwt.sign({
          userId: '1',
          username: username || 'local-admin',
          role: 'admin',
        });
        return reply.send({
          token,
          user: { username: username || 'local-admin', role: 'admin' },
        });
      }

      const adminUser = process.env.BLOG_POSTER_WEB_ADMIN_USERNAME || 'admin';
      const adminPass = process.env.BLOG_POSTER_WEB_ADMIN_PASSWORD || 'changeme';

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
    },
  );

  // Refresh token endpoint
  app.post('/api/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const token = app.jwt.sign({
        userId: request.user.userId,
        username: request.user.username,
        role: request.user.role,
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
  const publicRoutes = ['/health', '/api/auth/login', '/api/auth/refresh', '/ws'];

  return (
    publicRoutes.some((route) => url.startsWith(route)) || url.startsWith('/static/') || url === '/'
  );
}

// Role-based access control
export function requireRole(...roles: JWTPayload['role'][]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(request.user.role)) {
      reply.code(403).send({ error: 'Insufficient permissions' });
    }
  };
}
