/* ============================================================
   SaveHatke AI — Google service-account access tokens.

   Implements the OAuth2 JWT-bearer flow directly on WebCrypto + fetch
   instead of a Node-only library, so the same code runs in the Edge
   middleware and in the Node.js API routes. This is the only way the
   page gate and the API gate can share one authorization decision.

   The private key never leaves the server: it is used to sign a
   short-lived JWT assertion that is exchanged for a Sheets read token.
   ============================================================ */

import { encoder } from './config.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/* ---------------- base64url ---------------- */
function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('Service account private key is empty or malformed');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Imports a PKCS#8 RSA private key for RS256 signing.
 * Cached because importing costs more than signing.
 */
let cachedKey = null;
let cachedKeyPem = '';

async function importPrivateKey(pem) {
  if (cachedKey && cachedKeyPem === pem) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  cachedKeyPem = pem;
  return cachedKey;
}

/* ---------------- JWT assertion ---------------- */
async function createAssertion(clientEmail, privateKey, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        iss: clientEmail,
        scope,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600,
      })
    )
  );

  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importPrivateKey(privateKey),
    encoder.encode(signingInput)
  );

  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

/* ---------------- token cache ---------------- */
// Keyed BY SCOPE. The whitelist reads with `spreadsheets.readonly` while the
// persistence layer (lib/googleSheets.js) needs read+write `spreadsheets`. A
// single shared slot meant whichever ran first pinned its scope for ~an hour,
// so the other got a token with the wrong scope (writes 403, or the read path
// silently over-privileged). One entry per scope keeps them independent.
const tokenCache = new Map();      // scope -> { value, expiresAt }
const inFlightByScope = new Map(); // scope -> Promise<string>

/**
 * Returns a cached access token for the given scope, minting a new one
 * when it is missing or close to expiry. Tokens are cached per scope.
 * @returns {Promise<string>}
 */
export async function getServiceAccountToken({ clientEmail, privateKey, scope }) {
  const now = Date.now();
  const key = String(scope || '');

  const cached = tokenCache.get(key);
  if (cached && now < cached.expiresAt) return cached.value;

  const pending = inFlightByScope.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const assertion = await createAssertion(clientEmail, privateKey, scope);
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      cache: 'no-store',
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new Error(
        `Service account token exchange failed (${response.status}): ` +
          `${String(body.error_description || body.error || '').slice(0, 200)}`
      );
    }

    tokenCache.set(key, {
      value: body.access_token,
      // Refresh a minute before the real expiry.
      expiresAt: now + (Number(body.expires_in) || 3600) * 1000 - 60_000,
    });
    return body.access_token;
  })().finally(() => { inFlightByScope.delete(key); });

  inFlightByScope.set(key, promise);
  return promise;
}

export function resetServiceAccountTokenCache() {
  tokenCache.clear();
  inFlightByScope.clear();
  cachedKey = null;
  cachedKeyPem = '';
}