import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';

migrate()
  .then((a) => console.log(a.length ? `Applied ${a.length} migration(s).` : 'Database is up to date.'))
  .catch((e) => { console.error('Migration failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
