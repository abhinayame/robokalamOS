import pg from 'pg';

/** Fresh schema for every test run; migrations are applied by the helper on first import. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://rk:rk_dev_pw@localhost:5432/rk_test';
  if (!/_test(\?|$)/.test(url)) throw new Error('Refusing to reset a database whose name does not end in _test');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}
