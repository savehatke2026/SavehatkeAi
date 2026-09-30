/* ============================================================
   GET /api/auth/callback?code=...&state=...

   Google redirects here after the user consents. This is the ONLY place
   a SaveHatke AI session is ever created.

   Steps, in order — any failure stops the chain:
     1. Validate `state` against the signed HttpOnly cookie (CSRF).
        A mismatch means this redirect did not originate from a login
        this browser started, so it is refused.
     2. Exchange `code` for tokens using the client secret AND the PKCE
        verifier held in that cookie.
     3. Verify the returned Google ID token (signature, audience,
        issuer, expiry, verified email, nonce).
     4. Check the verified email against the Google Sheet whitelist.
        Authenticating correctly is NOT the same as being allowed in.
     5. Only then issue the session cookie.

   On any refusal the user is sent to a page that explains the situation
   rather than being shown a raw error.
   ============================================================ */

import { getConfig } from '../../lib/config.js';
import { buildCookie } from '../../lib/cookies.js';
import {
  STATE_COOKIE,
  completeLogin,
  authorizeIdentity,
  readLoginAttempt,
} from '../../lib/oauth.js';
import { createSessionToken, sessionCookie } from '../../lib/session.js';

export const config = { runtime: 'nodejs' };

function redirect(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store, max-age=0',
  });
  for (const cookie of cookies) {
    if (cookie) headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

/** Sends the user back to the login page with a readable message. */
function backToLogin(req, code) {
  const url = new URL('/login.html', new URL(req.url).origin);
  url.searchParams.set('error', code);
  return redirect(url.toString(), [expireState(req)]);
}

function expireState(req) {
  return buildCookie(req, { name: STATE_COOKIE, value: '', maxAge: 0 });
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return redirect(new URL('/login.html', new URL(req.url).origin).toString());
  }

  const settings = getConfig();
  const url = new URL(req.url);

  // The user declined the consent screen, or Google refused.
  const googleError = url.searchParams.get('error');
  if (googleError) {
    console.warn('[savehatke] Google returned an error:', googleError);
    const code = googleError === 'access_denied' ? 'cancelled' : 'google_error';
    return backToLogin(req, code);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return backToLogin(req, 'invalid_request');

  // 1. CSRF / session-fixation check.
  const attempt = await readLoginAttempt(req, state);
  if (!attempt) {
    console.warn('[savehatke] login attempt rejected: state mismatch or expired cookie');
    return backToLogin(req, 'expired');
  }

  // 2. Exchange + 3. verify the Google identity.
  let identity;
  try {
    identity = await completeLogin(req, code, attempt);
  } catch (error) {
    console.error('[savehatke] code exchange failed:', error.code, error.detail || error.message);
    return backToLogin(req, 'signin_failed');
  }

  // 4. Authorization — a separate decision from authentication.
  const access = await authorizeIdentity(identity.email);
  if (!access.authorized) {
    console.warn('[savehatke] access denied for', identity.email, '-', access.reason);
    const denied = new URL('/access-restricted.html', url.origin);
    denied.searchParams.set('reason', access.reason);
    // Deliberately no session cookie: an unauthorized user gets no session
    // at all, so there is nothing to later "upgrade" by reloading a page.
    return redirect(denied.toString(), [expireState(req)]);
  }

  // 5. Issue the session.
  const token = await createSessionToken(identity, {
    secret: settings.sessionSecret,
    maxAgeSeconds: settings.sessionMaxAgeSeconds,
  });

  const destination = new URL(`/${attempt.next}`, url.origin);
  return redirect(destination.toString(), [
    sessionCookie(token, req, settings.sessionMaxAgeSeconds),
    // The attempt cookie has served its purpose; single-use.
    expireState(req),
  ]);
}