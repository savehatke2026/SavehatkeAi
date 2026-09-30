/* ============================================================
   SaveHatke AI — signed cookie primitives.

   WebCrypto-only (no Node `crypto`) so this runs unchanged in Node.js
   API routes and in Edge middleware. Provides base64url, HMAC-SHA256
   signing/verification, and cookie header helpers.
   ============================================================ */

/* ---------------- base64url ---------------- */
export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeJson(value) {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
}

/** Cryptographically strong random id, base64url encoded. */
export function randomToken(bytes = 16) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

/* ---------------- HMAC ---------------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signSegment(segment, secret) {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(segment));
  return toBase64Url(new Uint8Array(signature));
}

/** Constant-time comparison for equal-length secrets. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- signed tokens ---------------- */
const VERSION = 'v1';

/**
 * Creates a `v1.<base64url payload>.<hmac>` token.
 * @param {object} payload - claims object; must include `exp` (unix seconds).
 */
export async function createSignedToken(payload, secret) {
  if (!secret) throw new Error('Signing secret is not configured');
  const segment = encodeJson(payload);
  return `${VERSION}.${segment}.${await signSegment(segment, secret)}`;
}

/**
 * Verifies signature + expiry. Never throws — returns null for anything
 * absent, malformed, tampered with, or expired.
 */
export async function verifySignedToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, segment, providedSignature] = parts;

  let expectedSignature;
  try {
    expectedSignature = await signSegment(segment, secret);
  } catch {
    return null;
  }
  if (!timingSafeEqual(providedSignature, expectedSignature)) return null;

  let payload;
  try {
    payload = decodeJson(segment);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return payload;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/* ---------------- cookie helpers ---------------- */

/** True when the request arrived over https (Vercel preview and production). */
export function isSecureRequest(req) {
  const proto = req?.headers?.get?.('x-forwarded-proto') ?? req?.headers?.['x-forwarded-proto'];
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Builds a Set-Cookie value. `Secure` follows the request scheme so the
 * cookie still works on http://127.0.0.1 locally, and is always set in
 * production where Vercel terminates TLS.
 */
export function buildCookie(req, { name, value, maxAge, httpOnly = true, sameSite = 'Lax' }) {
  const attributes = [`${name}=${value}`, 'Path=/', `SameSite=${sameSite}`, `Max-Age=${maxAge}`];
  if (httpOnly) attributes.push('HttpOnly');
  if (isSecureRequest(req)) attributes.push('Secure');
  return attributes.join('; ');
}

/** Reads a cookie from either a Node req or an Edge Request. */
export function readCookie(req, name) {
  const header = req?.headers?.get?.('cookie') ?? req?.headers?.cookie ?? '';
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim() || null;
    }
  }
  return null;
}