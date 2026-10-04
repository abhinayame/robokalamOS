import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';

const app = createApp();
const server = app.listen(env.PORT, () => logger.info(`Robokalam Learner OS API listening on :${env.PORT} (${env.NODE_ENV})`));

const shutdown = (sig: string) => {
  logger.info(`${sig} received, shutting down`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandledRejection'));
