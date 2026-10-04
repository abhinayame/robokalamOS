import { createApp } from './app.js';
import { db as dbConfig, env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { ensureSuperAdmin } from './lib/bootstrap.js';
import { logger } from './lib/logger.js';

async function main() {
  // Hosts such as Hostinger start the app with a single command, so the server prepares its own database.
  // Both steps are idempotent and migrations are guarded by a database lock.
  if (env.AUTO_MIGRATE === 'true') {
    const applied = await migrate((m) => logger.info(m));
    if (applied.length) logger.info(`Applied ${applied.length} migration(s)`);
    await ensureSuperAdmin((m) => logger.info(m));
  }
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info(`Robokalam Learner OS API listening on :${env.PORT} (${env.NODE_ENV})`));

  const shutdown = (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandledRejection'));
main().catch((e) => {
  logger.error({ err: e }, 'Startup failed');
  // Never prints the password — only its length, so stray spaces / empty values are obvious.
  const target = `[tried: host="${dbConfig.host}" port=${dbConfig.port} user="${dbConfig.user}" database="${dbConfig.database}" password_length=${dbConfig.password.length}]`;
  const hint = e?.errno === 1045 ? ' → The database rejected the login. Check DB_USER / DB_PASSWORD, that the user is attached to the database, and — if DB_HOST is not localhost — that Remote MySQL allows this server (hPanel → Databases → Remote MySQL).'
    : e?.errno === 1049 ? ' → Unknown database: check DB_NAME.'
    : e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' ? ' → Cannot reach the database server: check DB_HOST (try 127.0.0.1 or the host shown in hPanel).' : '';
  console.error(`Startup failed: ${e?.message ?? e}${hint} ${target}`);
  process.exit(1);
});
