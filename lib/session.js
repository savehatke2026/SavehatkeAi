/* ============================================================
   SaveHatke AI — server session tokens.

   A stateless, HMAC-SHA256 signed cookie. The token proves IDENTITY
   (this browser authenticated as this Google account).

   It deliberately does NOT prove authorization: whether the account is
   still on the whitelist is re-checked against the Google Sheet on every
   protected request (see requireAuthorizedUser). That is what makes
   "set Status = disabled" take effect within the cache TTL instead of
   waiting for the cookie to expire.
   ============================================================ */

import {
  buildCookie,
  createSignedToken,
  nowSeconds,
  readCookie,
  verifySignedToken,
} from './cookies.js';

export const COOKIE_NAME = 'sh_session';

/* Cookie holding an in-progress login attempt (OAuth state + nonce + PKCE
   verifier). Owned here because this module is the single place that knows
   the names of the cookies SaveHatke AI sets. */
export const STATE_COOKIE = 'sh_oauth';

/** Expires the in-progress login attempt cookie. */
export function clearedStateCookie(req) {
  return buildCookie(req, { name: STATE_COOKIE, value: '', maxAge: 0 });
}

/* ---------------- session ---------------- */

/**
 * @param {{sub:string,email:string,name:string}} identity - from a verified Google token
 * @returns {Promise<string>} signed session token
 */
export async function createSessionToken(identity, { secret, maxAgeSeconds }) {
  const issuedAt = nowSeconds();
  return createSignedToken(
    {
      sub: String(identity.sub || ''),
      email: String(identity.email || '').trim().toLowerCase(),
      name: String(identity.name || '').slice(0, 120),
      iat: issuedAt,
      exp: issuedAt + maxAgeSeconds,
    },
    secret
  );
}

/**
 * Verifies signature and expiry only. Authorization is a separate step.
 * @returns {Promise<null|{sub:string,email:string,name:string,iat:number,exp:number}>}
 */
export async function verifySessionToken(token, secret) {
  const payload = await verifySignedToken(token, secret);
  if (!payload) return null;
  if (typeof payload.email !== 'string' || !payload.email) return null;

  return {
    sub: typeof payload.sub === 'string' ? payload.sub : '',
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : '',
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: payload.exp,
  };
}

export function sessionCookie(token, req, maxAgeSeconds) {
  return buildCookie(req, { name: COOKIE_NAME, value: token, maxAge: maxAgeSeconds });
}

export function clearedSessionCookie(req) {
  return buildCookie(req, { name: COOKIE_NAME, value: '', maxAge: 0 });
}

export function readSessionCookie(req) {
  return readCookie(req, COOKIE_NAME);
}