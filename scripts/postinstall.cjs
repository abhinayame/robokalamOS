// Some hosts (e.g. Hostinger's Node.js preset) run only `npm install` and then start server.js.
// Make `npm install` produce the build when it is missing, so no separate build step is needed.
const { existsSync } = require('node:fs');
const { execSync } = require('node:child_process');

const built = existsSync('server/dist/server.js') && existsSync('web/dist/index.html');
const isSourceCheckout = existsSync('server/src') && existsSync('web/src');
if (built || !isSourceCheckout || process.env.SKIP_POSTINSTALL_BUILD === '1') process.exit(0);

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
console.log('[postinstall] building Robokalam Learner OS…');
// build tools are devDependencies; install them even when NODE_ENV=production
run('npm install --include=dev --ignore-scripts --no-audit --no-fund');
run('npm run build -w server');
run('npm run build -w web');
console.log('[postinstall] build complete');
