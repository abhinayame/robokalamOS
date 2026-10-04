// Entry point for hosts that look for a root server.js (e.g. Hostinger Node.js apps).
// The real application is compiled to server/dist by `npm run build`.
import('./server/dist/server.js').catch((e) => {
  console.error('Could not start the app. Did the build finish? (npm run build)\n', e);
  process.exit(1);
});
