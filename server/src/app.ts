import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { corsOrigins, env, isProd } from './config/env.js';
import { query } from './db/pool.js';
import { logger } from './lib/logger.js';
import { authenticate } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './modules/auth/routes.js';
import batchRoutes from './modules/batches/routes.js';
import bulkRoutes from './modules/bulk/routes.js';
import catalogRoutes from './modules/catalog/routes.js';
import classroomRoutes from './modules/classroom/routes.js';
import { assignmentsRouter, submissionsRouter } from './modules/classroom/assignments.js';
import { assessmentRouter, scoresRouter } from './modules/assessment/routes.js';
import { quizzesRouter } from './modules/assessment/quizzes.js';
import gamificationRoutes from './modules/gamification/routes.js';
import { attendanceRouter, sessionsRouter } from './modules/attendance/routes.js';
import notificationRoutes from './modules/notifications/routes.js';
import portalRoutes from './modules/portal/routes.js';
import analyticsRoutes from './modules/analytics/routes.js';
import crmRoutes from './modules/crm/routes.js';
import { tagsRouter } from './modules/crm/tags.js';
import fileRoutes from './modules/files/routes.js';
import dashboardRoutes from './modules/dashboard/routes.js';
import learnerRoutes from './modules/learners/routes.js';
import orgRoutes from './modules/organizations/routes.js';
import parentRoutes from './modules/parents/routes.js';
import selectionRoutes from './modules/selection/routes.js';
import userRoutes from './modules/users/routes.js';
import auditRoutes from './modules/audit/routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: { 'img-src': ["'self'", 'data:', 'https:'], 'connect-src': ["'self'"] },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProd ? undefined : false,
  }));
  app.use(cors({
    origin(origin, cb) {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Org-Id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  app.use(rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test' && process.env.TEST_LIMITS !== '1',
    message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(csrfProtection);

  app.get('/api/health', async (_req, res) => {
    try { await query('SELECT 1'); res.json({ ok: true, data: { status: 'up' } }); }
    catch (e) { logger.error({ err: e }, 'health check failed'); res.status(503).json({ ok: false, error: { code: 'DB_DOWN', message: 'Database unavailable.' } }); }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', authenticate);                       // everything below requires a valid session
  app.use('/api/organizations', orgRoutes);
  app.use('/api/learners', learnerRoutes);
  app.use('/api/parents', parentRoutes);
  app.use('/api/batches', batchRoutes);
  app.use('/api/selection', selectionRoutes);
  app.use('/api/bulk', bulkRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/classrooms', assessmentRouter);       // before classroomRoutes: its catch-all '/' mount must not shadow these
  app.use('/api/classrooms', sessionsRouter);
  app.use('/api/classrooms', classroomRoutes);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/portal', portalRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/crm', crmRoutes);
  app.use('/api/tags', tagsRouter);
  app.use('/api/scores', scoresRouter);
  app.use('/api/quizzes', quizzesRouter);
  app.use('/api/gamification', gamificationRoutes);
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api/submissions', submissionsRouter);
  app.use('/api/files', fileRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api', catalogRoutes);                      // /branches /programs /courses
  app.use('/api', userRoutes);                         // /teachers /users
  app.use('/api', notFoundHandler);

  // Production: serve the built web app from the same Node process.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h', setHeaders: (r, p) => { if (p.includes('/assets/')) r.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
