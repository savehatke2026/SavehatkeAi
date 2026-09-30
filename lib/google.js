/* ============================================================
   SaveHatke AI — identity-token verification for Google Sign-In.

   The browser hands us a JWT credential. We verify it server-side before
   trusting one character of it:
     * RS256 signature against Google's published JWKS
     * `aud` must equal OUR client id, so a token minted for a different
       application cannot be replayed against this site
     * `iss` must be a Google issuer
     * `exp` / `iat` validity
     * `email_verified` must be true
     * `nonce` must match the value we issued for this login attempt

   Implemented on WebCrypto + fetch rather than `google-auth-library` so it
   works in both the Node.js and Edge runtimes, and so there is no hidden
   HTTP client behaviour in the auth path. Google's JWKS is cached in
   module scope, which is what keeps this fast.
   ============================================================ */

import { fromBase64Url } from './cookies.js';
import { getConfig } from './config.js';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const ALLOWED_ALGORITHMS = ['RS256'];

/* ---------------- JWKS cache ---------------- */
let jwks = null;
let jwksFetchedAt = 0;
let jwksInFlight = null;
let cachedTtlMs = 60 * 60 * 1000;

// Google rotates keys on a rolling basis; the Cache-Control header tells us
// when to re-check. Refreshing sooner than needed is harmless.
const JWKS_MIN_TTL_MS = 5 * 60 * 1000;

function parseMaxAge(cacheControl) {
  const match = /max-age=(\d+)/.exec(cacheControl || '');
  return match ? Number(match[1]) * 1000 : 60 * 60 * 1000;
}

async function refreshJwks() {
  if (!jwksInFlight) {
    jwksInFlight = fetch(JWKS_URL, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`);
        const body = await response.json();
        if (!Array.isArray(body.keys)) throw new Error('JWKS response had no keys');
        jwks = body.keys;
        jwksFetchedAt = Date.now();
        cachedTtlMs = Math.max(parseMaxAge(response.headers.get('cache-control')), JWKS_MIN_TTL_MS);
        return jwks;
      })
      .finally(() => { jwksInFlight = null; });
  }
  return jwksInFlight;
}

async function getSigningKey(kid, { forceRefresh = false } = {}) {
  const stale = Date.now() - jwksFetchedAt > cachedTtlMs;
  if (!jwks || stale || forceRefresh) await refreshJwks();
  return jwks.find((key) => key.kid === kid) || null;
}

async function importSigningKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg || 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

/* ---------------- JWT verification ---------------- */
function decodeSegment(segment) {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));
}

/**
 * @param {string} credential - raw Google ID token (JWT)
 * @param {string} [expectedNonce] - nonce issued for this login attempt
 * @returns {Promise<{sub:string,email:string,name:string,picture:string}>}
 * @throws {Error} with a machine-readable `code`
 */
export async function verifyGoogleIdToken(credential, expectedNonce) {
  const config = getConfig();

  if (!config.googleClientId) {
    throw Object.assign(new Error('Google client id is not configured'), {
      code: 'server_misconfigured',
    });
  }
  if (!credential || typeof credential !== 'string') {
    throw Object.assign(new Error('Missing Google credential'), { code: 'invalid_token' });
  }

  const parts = credential.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Malformed Google credential'), { code: 'invalid_token' });
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header;
  let payload;
  try {
    header = decodeSegment(headerSegment);
    payload = decodeSegment(payloadSegment);
  } catch {
    throw Object.assign(new Error('Malformed Google credential'), { code: 'invalid_token' });
  }

  if (!ALLOWED_ALGORITHMS.includes(header?.alg)) {
    // Rejects `alg: none` and any algorithm-substitution attempt.
    throw Object.assign(new Error('Unsupported token algorithm'), { code: 'invalid_token' });
  }
  if (!header?.kid) {
    throw Object.assign(new Error('Token has no key id'), { code: 'invalid_token' });
  }

  // Signature check — fetch the key, refreshing once in case Google rotated.
  let key = await getSigningKey(header.kid);
  if (!key) key = await getSigningKey(header.kid, { forceRefresh: true });
  if (!key) {
    throw Object.assign(new Error('Signing key not found'), { code: 'invalid_token' });
  }

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      await importSigningKey(key),
      fromBase64Url(signatureSegment),
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw Object.assign(new Error('Invalid token signature'), { code: 'invalid_token' });
  }

  /* -------- claims -------- */
  if (!ALLOWED_ISSUERS.includes(payload?.iss)) {
    throw Object.assign(new Error('Unexpected token issuer'), { code: 'invalid_token' });
  }

  // The audience check is what stops a token minted for another Google app
  // from being replayed here.
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(config.googleClientId)) {
    throw Object.assign(new Error('Token audience mismatch'), { code: 'invalid_token' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw Object.assign(new Error('Token expired'), { code: 'invalid_token' });
  }
  // Google tokens are short-lived; reject anything dated in the future
  // beyond a small clock-skew allowance.
  if (typeof payload.iat === 'number' && payload.iat > now + 300) {
    throw Object.assign(new Error('Token issued in the future'), { code: 'invalid_token' });
  }

  // Only a verified email may ever be matched against the whitelist.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw Object.assign(new Error('Google email is not verified'), {
      code: 'email_unverified',
    });
  }

  // Replay protection: must be the nonce we issued for this login attempt.
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw Object.assign(new Error('Login nonce mismatch'), { code: 'invalid_nonce' });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  const sub = String(payload.sub || '');
  if (!email.includes('@') || !sub) {
    throw Object.assign(new Error('Token is missing an identity'), { code: 'invalid_token' });
  }

  return {
    sub,
    email,
    name: String(payload.name || '').slice(0, 120),
    picture: String(payload.picture || ''),
  };
}