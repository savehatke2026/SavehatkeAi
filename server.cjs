/* ============================================================
   SaveHatke AI — deprecated alias for the dev server.

   This file used to hold a second, independent copy of the local dev
   server. It had drifted from dev-server.mjs (it read only .env.local,
   and had no way to stub the whitelist for the end-to-end tests), so
   keeping both was a source of confusion: `node server.cjs` and
   `node dev-server.mjs` did not behave the same.

   dev-server.mjs is now the single implementation. This alias exists so
   the old command still works; it simply hands over to the real server.

   Prefer:  npm run dev      (or: node dev-server.mjs)
   ============================================================ */

const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, 'dev-server.mjs')], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
