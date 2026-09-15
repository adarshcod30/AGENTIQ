/**
 * The Express application: assembled here, never started here.
 *
 * Splitting this from index.js is what lets tests do
 *   `import { app } from '../src/app.js'; await request(app).get('/api/health')`
 * without binding a port or requiring a live database.
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import passport from 'passport';

import { env } from './config/env.js';
import { configurePassport } from './config/passport.js';
import { httpLoggerOptions } from './lib/logger.js';
import { notFound, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import healthRoutes from './routes/health.routes.js';
import mcpRoutes from './routes/mcp.routes.js';

import requestRoutes from './routes/request.routes.js';
import securityRoutes from './routes/security.routes.js';
import runsRoutes from './routes/runs.routes.js';
import specsRoutes from './routes/specs.routes.js';
import deploymentsRoutes from './routes/deployments.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import assessmentsRoutes from './routes/assessments.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import connectionsRoutes from './routes/connections.routes.js';
import providersRoutes from './routes/providers.routes.js';

export function createApp({ logging = env.NODE_ENV !== 'test' } = {}) {
  const app = express();

  // Behind Render's proxy; required for correct client IPs, which the rate
  // limiter keys on. Trust exactly one hop rather than `true`: trusting every
  // hop lets a client spoof X-Forwarded-For and evade the limiter entirely.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      // Comma-separated list so a deployed origin and localhost can coexist.
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    }),
  );

  if (logging) app.use(pinoHttp(httpLoggerOptions));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Registers the Google strategy only if credentials are present.
  configurePassport();
  app.use(passport.initialize());

  // docs/02_TRD.md §8. Deliberately not applied to /api/auth/me, which the
  // frontend polls on every route change.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // GET /me is polled on every route change, so it is not limited. The limiter
    // is also disabled under test: a suite legitimately registers dozens of
    // users, and a shared 20-per-15-minutes budget would make results depend on
    // how many tests ran before this one. rateLimit.test.js covers the limiter
    // itself in isolation.
    skip: (req) => req.method === 'GET' || env.NODE_ENV === 'test',
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' },
    },
  });

  app.use('/api', healthRoutes);
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/mcp', mcpRoutes);

  app.use('/api/request', requestRoutes);
  app.use('/api/security', securityRoutes);
  app.use('/api/runs', runsRoutes);
  app.use('/api/specs', specsRoutes);
  app.use('/api/deployments', deploymentsRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/assessments', assessmentsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/connections', connectionsRoutes);
  app.use('/api/providers', providersRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
