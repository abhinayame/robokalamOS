import mysql from 'mysql2/promise';

/** Fresh database for every test run; migrations are applied by the helper on first import. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'mysql://rk:rk_dev_pw@127.0.0.1:3306/rk_test');
  const db = url.pathname.slice(1);
  if (!/_test$/.test(db)) throw new Error('Refusing to reset a database whose name does not end in _test');
  const c = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
  await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await c.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await c.end();
}
