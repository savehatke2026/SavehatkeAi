/* ============================================================
   SaveHatke AI — end-to-end verification (dev-only).

   Drives real Chrome against dev-server.mjs and asserts the auth model,
   page gating, and Google-only UI. Uses a stubbed Google token endpoint
   so the callback chain can be exercised without a live Google account.

   Usage: node verify.mjs
   ============================================================ */

import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------- .env loader ----------------
   This script runs in its OWN process, separate from dev-server.mjs, but it
   imports lib/config.js directly to mint a session cookie. Without loading
   .env here, getConfig() would see an empty SESSION_SECRET and the signed
   token could not be created.

   Mirrors the loader in dev-server.mjs exactly: `.env.local` overrides `.env`
   (the Vercel convention `.env.example` tells people to use), and a value
   exported in the shell wins over both. Reading only `.env` meant a developer
   who followed `.env.example` — which says to create `.env.local` — got a
   harness that could not mint a session at all. */
(function loadEnv() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const fromShell = new Map(Object.entries(process.env));
  const usesBuiltinParser = typeof process.loadEnvFile === 'function';

  for (const name of ['.env', '.env.local']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;

    // Node's own parser is used when available because a naive line-by-line
    // split truncates the multi-line quoted GOOGLE_PRIVATE_KEY PEM.
    if (usesBuiltinParser) {
      process.loadEnvFile(file);
      continue;
    }

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

  // Restore anything already exported in the shell so the files never shadow it.
  for (const [key, value] of fromShell) process.env[key] = value;
})();

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* Chosen at runtime so a `npm run dev` on the usual 8931 does not collide. */
let BASE = '';

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

async function page(browser, width = 1440, height = 900) {
  const p = await browser.newPage();
  await p.setViewport({ width, height });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.__errors = errors;
  return p;
}

const overflow = (p) => p.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth
);

/* ---------------- dev server lifecycle ----------------
   Authorization is decided in the SERVER process, so this harness has to
   start that server itself and give it a whitelist it can control.
   SAVEHATKE_WHITELIST_STUB makes dev-server.mjs pin its whitelist cache to a
   JSON file; setWhitelist() rewrites that file between sections. Injecting a
   snapshot here in the harness process would have no effect on the server. */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STUB_FILE = path.join(ROOT, 'tests', '.whitelist.stub.json');

function writeStub(entries) {
  fs.writeFileSync(STUB_FILE, JSON.stringify(entries));
}

/** Rewrites the stub and waits for the server's poller to pick it up. */
async function setWhitelist(entries) {
  writeStub(entries);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function serverResponding() {
  try {
    await fetch(`${BASE}/api/auth/config`);
    return true;
  } catch {
    return false;
  }
}

/** Asks the OS for a port nobody is using, then releases it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server = null;

async function startServer() {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;

  writeStub({}); // start from an empty whitelist
  server = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SAVEHATKE_WHITELIST_STUB: STUB_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  server.on('exit', (code) => {
    if (code) console.error(`[server] exited early with code ${code}`);
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await serverResponding()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error('The dev server did not become ready in time.');
  process.exit(2);
}

function stopServer() {
  if (server && !server.killed) {
    if (process.platform === 'win32') {
      // child.kill() alone can leave the node process holding the port on
      // Windows. Kill the whole tree instead.
      try {
        spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch { /* best effort */ }
    } else {
      server.kill();
    }
  }
  try { fs.unlinkSync(STUB_FILE); } catch { /* already gone */ }
}

(async () => {
  await startServer();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  });

  /* ============ 1. Public pages load clean ============ */
  for (const path of ['index.html', 'login.html', 'privacy.html', 'terms.html', 'contact.html']) {
    const p = await page(browser);
    await p.goto(`${BASE}/${path}`, { waitUntil: 'networkidle0' });
    check(`${path}: loads with no JS errors`, p.__errors.length === 0, p.__errors.join('; ').slice(0, 140));
    const ov = await overflow(p);
    check(`${path}: no horizontal overflow`, ov <= 0, `overflow=${ov}px`);
    await p.close();
  }

  /* ============ 2. Protected pages gate signed-out visitors ============ */
  for (const [path, next] of [['chat.html', 'chat.html'], ['dashboard.html', 'dashboard.html'], ['profile.html', 'profile.html']]) {
    const p = await page(browser);
    await p.goto(`${BASE}/${path}`, { waitUntil: 'networkidle0' });
    const url = new URL(p.url());
    check(`${path}: signed-out visit redirects to login with ?next=${next}`,
      url.pathname === '/login.html' && url.searchParams.get('next') === next,
      p.url());
    await p.close();
  }

  /* ============ 3. Google-only login UI ============ */
  {
    const p = await page(browser);
    await p.goto(`${BASE}/login.html`, { waitUntil: 'networkidle0' });

    const ui = await p.evaluate(() => ({
      heading: document.querySelector('.auth-title').textContent.trim(),
      button: document.querySelector('#google-signin').textContent.trim(),
      hasGoogleMark: !!document.querySelector('#google-signin .google-mark'),
      // No password/signup surface may exist anywhere on the page.
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      emailInputs: document.querySelectorAll('input[type="email"]').length,
      tabs: document.querySelectorAll('.auth-tab').length,
      signupLink: /sign ?up|create account|register/i.test(document.body.innerText),
      forgot: /forgot password/i.test(document.body.innerText),
      googleScript: !!document.querySelector('script[src*="accounts.google.com"]'),
    }));

    check('login: heading is "Welcome to SaveHatke AI"',
      ui.heading === 'Welcome to SaveHatke AI', ui.heading);
    check('login: single "Continue with Google" button with Google mark',
      ui.button === 'Continue with Google' && ui.hasGoogleMark, ui.button);
    check('login: no password field', ui.passwordInputs === 0, 'password inputs=' + ui.passwordInputs);
    check('login: no email field', ui.emailInputs === 0, 'email inputs=' + ui.emailInputs);
    check('login: no Login/Sign Up tabs', ui.tabs === 0, 'tabs=' + ui.tabs);
    check('login: no sign-up affordance', ui.signupLink === false);
    check('login: no forgot-password affordance', ui.forgot === false);
    check('login: loads no third-party script', ui.googleScript === false);

    // The button hands off to the server flow.
    await p.click('#google-signin');
    await p.waitForFunction(() => location.pathname.startsWith('/api/auth/') ||
      location.hostname.includes('google'), { timeout: 8000 }).catch(() => {});
    const after = new URL(p.url());
    check('login: button starts the server OAuth flow',
      after.pathname === '/api/auth/login' || after.hostname.includes('google'), p.url());
    await p.close();
  }

  /* ============ 4. OAuth start params are correct ============ */
  {
    const res = await fetch(`${BASE}/api/auth/login?next=chat.html`, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    const params = new URL(location).searchParams;
    const cookie = res.headers.getSetCookie ? res.headers.getSetCookie().join(';') : '';

    check('oauth: /api/auth/login redirects to Google',
      location.startsWith('https://accounts.google.com/'), location.slice(0, 48));
    check('oauth: PKCE challenge present with S256',
      params.get('code_challenge_method') === 'S256' && (params.get('code_challenge') || '').length > 20);
    check('oauth: state + nonce issued', Boolean(params.get('state')) && Boolean(params.get('nonce')));
    check('oauth: response_type=code, scope=openid email profile',
      params.get('response_type') === 'code' && params.get('scope') === 'openid email profile',
      params.get('scope'));
    check('oauth: attempt cookie is HttpOnly + SameSite=Lax + short-lived',
      /sh_oauth=/.test(cookie) && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) &&
      /Max-Age=600/i.test(cookie));
    check('oauth: no secret leaked into the redirect URL',
      !/client_secret|secret/i.test(location));
  }

  /* ============ 5. Callback rejects forged / cancelled attempts ============ */
  {
    const bad = await fetch(`${BASE}/api/auth/callback?code=fake&state=fake`, { redirect: 'manual' });
    check('callback: forged state is refused (no session cookie)',
      bad.status === 302 &&
      (bad.headers.get('location') || '').includes('error=expired') &&
      !(bad.headers.getSetCookie() || []).some((c) => c.startsWith('sh_session=')),
      bad.headers.get('location'));

    const denied = await fetch(`${BASE}/api/auth/callback?error=access_denied`, { redirect: 'manual' });
    check('callback: user cancellation returns to login with error=cancelled',
      (denied.headers.get('location') || '').includes('error=cancelled'),
      denied.headers.get('location'));
  }

  /* ============ 6. API authorization ============ */
  {
    const chat = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ message: 'hello' }),
    });
    check('api: /api/chat refuses an unauthenticated caller (401)',
      chat.status === 401, `status=${chat.status}`);

    const session = await fetch(`${BASE}/api/auth/session`).then((r) => r.json());
    check('api: /api/auth/session reports signed-out cleanly',
      session.authenticated === false && session.authorized === false, JSON.stringify(session));

    const cfg = await fetch(`${BASE}/api/auth/config`).then((r) => r.json());
    check('api: /api/auth/config exposes no secrets',
      cfg.configured === true && cfg.signInUrl === '/api/auth/login' &&
      !JSON.stringify(cfg).includes('test-secret'), JSON.stringify(cfg));

    const crossSite = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });
    check('api: cross-origin logout POST is rejected (403)', crossSite.status === 403, `status=${crossSite.status}`);
  }

  /* ============ 7. Session cookie accepted by middleware ============ */
  {
    // Mint a valid session cookie directly through the app's own signer, so
    // the gating logic is tested without needing live Google credentials.
    const { createSessionToken, COOKIE_NAME } = await import('./lib/session.js');
    const { getConfig } = await import('./lib/config.js');

    await setWhitelist({ 'allowed@example.com': 'active' });
    const token = await createSessionToken(
      { sub: '12345', email: 'allowed@example.com', name: 'Allowed User' },
      { secret: getConfig().sessionSecret, maxAgeSeconds: 3600 }
    );

    const p = await page(browser);
    await p.setCookie({ name: COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/' });
    await p.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle0' });

    const authed = await p.evaluate(() => {
      const user = document.querySelector('[data-nav-auth="user"]');
      const guest = document.querySelector('[data-nav-auth="guest"]');
      return {
        path: location.pathname,
        navDashboard: Boolean(user) && !user.hidden,
        // A signed-in visitor must not be offered a Login link. The auth-only
        // pages omit the guest item entirely instead of rendering it hidden,
        // so "absent" satisfies the requirement just as well as "hidden".
        navLogin: !guest || guest.hidden,
        avatar: document.querySelector('[data-avatar]').textContent,
        email: document.querySelector('[data-user-email]').textContent,
      };
    });

    check('session: whitelisted user reaches the dashboard', authed.path === '/dashboard.html', authed.path);
    check('session: navbar shows Dashboard + avatar, hides Login',
      authed.navDashboard && authed.navLogin, JSON.stringify(authed));
    check('session: avatar shows initials and email is rendered',
      authed.avatar === 'AU' && authed.email === 'allowed@example.com',
      authed.avatar + ' / ' + authed.email);

    // Chat works for the authorized user.
    const chatRes = await p.evaluate(async () => {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'How can you help me?' }),
      });
      return { status: r.status, body: await r.json() };
    });
    check('chat: authorized user gets a reply from /api/chat',
      chatRes.status === 200 && typeof chatRes.body.reply === 'string' && chatRes.body.reply.length > 10,
      `status=${chatRes.status} source=${chatRes.body.source}`);
    await p.close();

    /* ---- revoked user is refused even with a valid cookie ---- */
    await setWhitelist({ 'allowed@example.com': 'disabled' });
    const p2 = await page(browser);
    await p2.setCookie({ name: COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/' });
    await p2.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle0' });
    const revoked = new URL(p2.url());
    check('revocation: whitelist "disabled" blocks the page despite a valid cookie',
      revoked.pathname === '/access-restricted.html' && revoked.searchParams.get('reason') === 'disabled',
      p2.url());

    const revokedChat = await p2.evaluate(async () => {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });
      return { status: r.status, body: await r.json() };
    });
    check('revocation: /api/chat also refuses the revoked user (403)',
      revokedChat.status === 403 && revokedChat.body.code === 'disabled',
      `status=${revokedChat.status} code=${revokedChat.body.code}`);

    const deniedSession = await p2.evaluate(() => fetch('/api/auth/session').then((r) => r.json()));
    check('revocation: session endpoint reports authorized:false with reason',
      deniedSession.authenticated === true && deniedSession.authorized === false &&
      deniedSession.reason === 'disabled' && deniedSession.user === null,
      JSON.stringify(deniedSession));
    await p2.close();

    /* ---- an email absent from the sheet is refused ---- */
    await setWhitelist({ 'someone@else.com': 'active' });
    const p3 = await page(browser);
    await p3.setCookie({ name: COOKIE_NAME, value: token, domain: '127.0.0.1', path: '/' });
    await p3.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle0' });
    check('whitelist: unlisted email is refused (not_listed)',
      new URL(p3.url()).searchParams.get('reason') === 'not_listed', p3.url());
    await p3.close();
  }

  /* ============ 8. Access-restricted page renders the reason ============ */
  {
    // The page re-confirms the reason against /api/auth/session, and the
    // browser still holds the session cookie from section 7, so the server's
    // answer has to agree with the URL. Pin the whitelist to "disabled".
    await setWhitelist({ 'allowed@example.com': 'disabled' });

    const p = await page(browser);
    await p.goto(`${BASE}/access-restricted.html?reason=disabled`, { waitUntil: 'networkidle0' });
    const copy = await p.evaluate(() => ({
      title: document.querySelector('#denial-title').textContent.trim(),
      message: document.querySelector('#denial-message').textContent.trim(),
      hasSwitch: !!document.querySelector('#switch-account'),
      signedInAs: document.querySelector('#denial-email').textContent.trim(),
    }));
    check('restricted: disabled reason is explained',
      copy.title === 'Access disabled' && /disabled/i.test(copy.message), JSON.stringify(copy));
    check('restricted: offers a way to switch Google account', copy.hasSwitch === true);
    check('restricted: names the refused account', copy.signedInAs === 'allowed@example.com', copy.signedInAs);
    await p.close();
  }

  /* ============ 9. Homepage reflects the product model ============ */
  {
    const p = await page(browser, 1440, 1000);
    await p.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
    const home = await p.evaluate(() => ({
      primary: document.querySelector('.hero-actions .btn-primary').textContent.trim(),
      navLogin: !document.querySelector('[data-nav-auth="guest"]').hidden,
      // The guest-facing sign-in route in the hero. The homepage deliberately
      // has no guest "hero note"; the sign-in affordance is the Login button.
      heroLogin: document.querySelector('.hero-actions [data-guest-only]').textContent.trim(),
      previewUser: document.querySelector('.bubble-user').textContent.trim(),
    }));
    check('index: primary action is "Try SaveHatke AI"',
      home.primary.startsWith('Try SaveHatke AI'), home.primary);
    check('index: navbar offers Login when signed out', home.navLogin === true);
    check('index: hero offers a Login route for guests', home.heroLogin === 'Login', home.heroLogin);
    await p.close();
  }

  /* ============ 10. Mobile ============ */
  {
    for (const path of ['index.html', 'login.html', 'access-restricted.html']) {
      const p = await page(browser, 390, 844);
      await p.goto(`${BASE}/${path}`, { waitUntil: 'networkidle0' });
      const ov = await overflow(p);
      check(`${path} (mobile): no horizontal overflow`, ov <= 0, `overflow=${ov}px`);
      await p.close();
    }
  }

  await browser.close();
  stopServer();
  console.log('\n' + (fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} OF ${pass + fail} CHECKS FAILED`));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  stopServer();
  process.exit(2);
});