/* ============================================================
   SaveHatke AI — Google OAuth 2.0 Authorization Code flow (with PKCE).

   Why this flow rather than the Google Identity Services JS popup:
     * `state` and `nonce` are both supported and validated server-side,
       which is what actually binds a login attempt to this browser.
     * the client secret never leaves the server, and the authorization
       code is useless without it
     * PKCE adds a second, per-attempt secret that is never exposed to
       the redirect URL or the browser's history
     * no third-party script is loaded on the login page at all

   Everything security-relevant happens in /api/auth/callback: the
   browser's only job is to be redirected.
   ============================================================ */

import { createSignedToken, randomToken, verifySignedToken } from './cookies.js';
import { getConfig } from './config.js';
import { STATE_COOKIE } from './session.js';
import { checkWhitelist } from './whitelist.js';
import { verifyGoogleIdToken } from './google.js';

export { STATE_COOKIE };

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SCOPE = 'openid email profile';

/* ---------------- redirect URIs ---------------- */

/**
 * The redirect URI must match one registered in the Google Cloud console
 * byte for byte, so it is derived from the incoming request rather than
 * configured separately (which is the usual source of
 * redirect_uri_mismatch).
 */
export function callbackUrl(req) {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return `${proto}://${host}/api/auth/callback`;
}

/**
 * Only same-site relative page targets are allowed, so `?next=` cannot be
 * turned into an open redirect.
 */
export function safeNext(value, fallback = 'chat.html') {
  const next = String(value || '').trim();
  if (!next) return fallback;
  if (/^[a-z0-9._-]+\.html([#?].*)?$/i.test(next)) return next;
  return fallback;
}

/* ---------------- PKCE ---------------- */
function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/* ---------------- attempt state ----------------
   state, nonce and the PKCE verifier are kept together in one signed,
   HttpOnly cookie. Signing means a tampered cookie is rejected outright;
   HttpOnly means no script (and no XSS payload) can read the verifier. */

export async function beginLogin(req, nextPath) {
  const config = getConfig();
  const state = randomToken(16);
  const nonce = randomToken(16);
  const codeVerifier = randomToken(32);

  const cookieValue = await createSignedToken(
    {
      state,
      nonce,
      codeVerifier,
      next: safeNext(nextPath),
      exp: Math.floor(Date.now() / 1000) + config.nonceMaxAgeSeconds,
    },
    config.sessionSecret
  );

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce,
    code_challenge: await codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    // Let the user pick which Google account to use.
    prompt: 'select_account',
  });

  return { redirectTo: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`, cookieValue };
}

/**
 * Validates the OAuth `state` returned by Google against the signed cookie.
 * @returns {Promise<null|{state:string,nonce:string,codeVerifier:string,next:string}>}
 */
export async function readLoginAttempt(req, returnedState) {
  const config = getConfig();
  const raw = readCookieFrom(req, STATE_COOKIE);
  if (!raw || !returnedState) return null;

  const payload = await verifySignedToken(raw, config.sessionSecret);
  if (!payload) return null;
  // Timing-safe comparison of the CSRF state.
  if (!constantTimeEqual(String(payload.state || ''), String(returnedState))) return null;

  return {
    state: payload.state,
    nonce: payload.nonce,
    codeVerifier: payload.codeVerifier,
    next: safeNext(payload.next),
  };
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookieFrom(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

/* ---------------- code exchange ---------------- */

/**
 * Exchanges the authorization code for tokens and verifies the resulting
 * ID token. Returns the verified identity.
 *
 * @throws {Error} with a `code` on any failure
 */
export async function completeLogin(req, code, attempt) {
  const config = getConfig();

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      // Both the secret and the PKCE verifier are required: the secret
      // proves the caller is this app, the verifier proves the code was
      // issued to this specific login attempt.
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      code_verifier: attempt.codeVerifier,
      redirect_uri: callbackUrl(req),
    }).toString(),
    cache: 'no-store',
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.id_token) {
    throw Object.assign(new Error('Google code exchange failed'), {
      code: 'exchange_failed',
      detail: String(body.error_description || body.error || response.status).slice(0, 200),
    });
  }

  // Full ID-token verification, including the nonce issued for this attempt.
  return verifyGoogleIdToken(body.id_token, attempt.nonce);
}

/** Re-checks the whitelist for a freshly authenticated identity. */
export async function authorizeIdentity(email) {
  return checkWhitelist(email);
}