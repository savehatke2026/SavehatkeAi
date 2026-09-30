/* ============================================================
   SaveHatke AI — local development server.

   Emulates the Vercel routing this project deploys to:
     * static files from public/
     * /api/** dispatched to the Edge-style handlers in api/
     * middleware.js applied to the protected pages

   This exists so the real auth flow (nonce cookie → Google credential →
   session cookie → whitelist check) can be exercised locally with the
   exact same code that runs in production, instead of mocking it.

   Usage:  node dev-server.mjs
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8931);

/* ---------------- .env loader ----------------
   Read before anything imports lib/config.js, since config reads
   process.env lazily (per call), not at import time.

   `.env.local` overrides `.env` (the Vercel/Next convention), and a value
   exported in the shell always wins over both.

   Multi-line quoted values matter here: GOOGLE_PRIVATE_KEY is a PEM that
   spans several lines, and a naive line-by-line split would truncate it to
   the "-----BEGIN PRIVATE KEY-----" header, leaving the service account
   unable to sign anything. Node's own parser handles that correctly, so use
   it when present and fall back to a single-line reader only on older
   runtimes. */
function loadEnvFileSimple(file) {
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadEnv() {
  const fromShell = new Map(Object.entries(process.env));
  const usesBuiltinParser = typeof process.loadEnvFile === 'function';

  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;

    if (usesBuiltinParser) process.loadEnvFile(file);
    else loadEnvFileSimple(file);
  }

  // Restore anything that was already exported in the shell so the files
  // never shadow it.
  for (const [key, value] of fromShell) process.env[key] = value;

  if (!usesBuiltinParser) {
    console.warn(
      '[dev-server] Node < 20.12: multi-line quoted values in .env may not ' +
      'parse. Upgrade Node, or put GOOGLE_PRIVATE_KEY on one line with \\n escapes.'
    );
  }
}
loadEnv();

/* ---------------- module cache ---------------- */
const modules = new Map();
async function load(relative) {
  const url = pathToFileURL(path.join(ROOT, relative)).href;
  if (!modules.has(url)) modules.set(url, import(url));
  return modules.get(url);
}

/* ---------------- test seam: stubbed whitelist ----------------
   verify.mjs drives a real browser against this server, so it cannot inject
   a whitelist snapshot in-process the way tests/backend.test.mjs does — the
   authorization decision happens HERE, in the server process.

   When SAVEHATKE_WHITELIST_STUB points at a JSON file of
   `{ "email": "status" }`, re-read it continuously and keep the whitelist
   cache pinned to its contents. Re-stamping `fetchedAt` each tick means the
   TTL never expires, so a change written by the test is picked up
   immediately rather than after the cache window.

   Dev/test only: nothing sets this in production, and the whitelist module
   still refuses to authorize when the stub file is absent or unreadable. */
async function installWhitelistStub() {
  const file = process.env.SAVEHATKE_WHITELIST_STUB;
  if (!file) return;

  const { __setWhitelistSnapshot } = await load('lib/whitelist.js');

  const apply = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      __setWhitelistSnapshot(new Map(Object.entries(parsed)), Date.now());
    } catch {
      // Mid-rewrite or not yet written; the next tick will pick it up.
    }
  };

  apply();
  const timer = setInterval(apply, 200);
  timer.unref?.();
  console.log(`[dev-server] whitelist stub active → ${file}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- request/response bridging ---------------- */
async function toWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  // The Web Request constructor rejects a body for GET/HEAD.
  const method = req.method || 'GET';
  const hasBody = body && method !== 'GET' && method !== 'HEAD';

  return new Request(url, {
    method,
    headers: req.headers,
    body: hasBody ? body : undefined,
  });
}

async function sendWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') headers[key] = value;
  });

  // Set-Cookie needs append semantics, which headers.forEach collapses.
  // writeHead accepts an array here; setHeader-after-writeHead throws.
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  if (cookies.length) headers['Set-Cookie'] = cookies;

  const buffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(buffer);
}

/* ---------------- static ---------------- */
function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Contain the resolved path inside PUBLIC_DIR.
  const target = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
    // No caching locally, so edits show up on reload.
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    // 1. API routes — same handlers that deploy to Vercel Edge.
    if (pathname.startsWith('/api/')) {
      const modulePath = pathname.replace(/^\//, '').replace(/\/$/, '') + '.js';
      const file = path.join(ROOT, modulePath);

      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No such API route', code: 'not_found' }));
        return;
      }

      const handler = (await load(modulePath)).default;
      const response = await handler(await toWebRequest(req));
      await sendWebResponse(res, response);
      return;
    }

    // 2. Middleware — gate the protected pages exactly as production does.
    if (pathname.endsWith('.html')) {
      const middleware = (await load('middleware.js')).default;
      const result = await middleware(await toWebRequest(req));
      if (result instanceof Response) {
        await sendWebResponse(res, result);
        return;
      }
    }

    // 3. Static.
    if (serveStatic(req, res)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (error) {
    console.error('[dev-server]', error);
    // The failure may have happened after a response was already sent.
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error: ' + error.message);
    } else {
      res.end();
    }
  }
});

await installWhitelistStub();

server.listen(PORT, '127.0.0.1', () => {
  const configured = ['GOOGLE_CLIENT_ID', 'SESSION_SECRET', 'GOOGLE_SHEET_ID']
    .filter((name) => !process.env[name]);
  console.log(`SaveHatke AI dev server → http://127.0.0.1:${PORT}`);
  if (configured.length) {
    console.log(`\n  Not configured yet: ${configured.join(', ')}`);
    console.log('  Copy .env.example to .env and fill it in to test Google sign-in.\n');
  }
});