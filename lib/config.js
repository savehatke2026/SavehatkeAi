/* ============================================================
   SaveHatke AI — server configuration.

   Read only inside /api/** and /middleware.js, both of which run on the
   server. This module must never be imported by browser code.
   ============================================================ */

const textEncoder = new TextEncoder();

function env(name) {
  const value = globalThis.process?.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function envInt(name, fallback) {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** base64 (standard or url-safe) → string, without depending on Buffer. */
function base64ToString(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Service-account private keys are stored with literal "\n" escapes in most
 * hosting dashboards. Normalise both forms into a real PEM.
 */
function normalizePrivateKey(raw) {
  if (!raw) return '';
  let key = raw.trim();
  // A full JSON blob was pasted instead of the bare key.
  if (key.startsWith('{')) {
    try {
      key = JSON.parse(key).private_key || '';
    } catch {
      return '';
    }
  }
  return key.replace(/\\n/g, '\n').trim();
}

/**
 * Accepts either discrete GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY
 * variables, or a single base64/JSON GOOGLE_SERVICE_ACCOUNT_JSON blob (what
 * the Google Cloud console hands you).
 */
function serviceAccount() {
  const blob = env('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (blob) {
    try {
      const json = blob.trim().startsWith('{') ? blob : base64ToString(blob);
      const parsed = JSON.parse(json);
      return {
        clientEmail: String(parsed.client_email || '').trim(),
        privateKey: normalizePrivateKey(parsed.private_key || ''),
      };
    } catch {
      return { clientEmail: '', privateKey: '' };
    }
  }
  return {
    clientEmail: env('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: normalizePrivateKey(env('GOOGLE_PRIVATE_KEY')),
  };
}

export function getConfig() {
  const account = serviceAccount();
  return {
    googleClientId: env('GOOGLE_CLIENT_ID'),
    // Required for the authorization-code exchange in lib/oauth.js. Without
    // it the token request goes out as `client_secret=undefined` and Google
    // answers invalid_client, so a deploy missing this cannot sign anyone in.
    googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
    sheetId: env('GOOGLE_SHEET_ID'),
    // Defaults to the first two columns of the first tab. Override to pin an
    // explicit tab, e.g. GOOGLE_SHEET_RANGE="Whitelist!A:B".
    sheetRange: env('GOOGLE_SHEET_RANGE') || 'A:B',
    serviceAccountEmail: account.clientEmail,
    serviceAccountPrivateKey: account.privateKey,
    sessionSecret: env('SESSION_SECRET'),
    // Identity cookie lifetime. Authorization is re-checked far more often
    // than this (whitelistTtlSeconds), so a revoked user loses access long
    // before the session itself expires.
    sessionMaxAgeSeconds: envInt('SESSION_MAX_AGE_SECONDS', 60 * 60 * 24 * 7),
    nonceMaxAgeSeconds: envInt('LOGIN_NONCE_MAX_AGE_SECONDS', 600),
    whitelistTtlSeconds: envInt('WHITELIST_CACHE_TTL_SECONDS', 60),
    // How long a previously fetched snapshot may still be trusted if Google
    // Sheets is briefly unreachable, so a blip doesn't lock everyone out.
    whitelistStaleGraceSeconds: envInt('WHITELIST_STALE_GRACE_SECONDS', 120),
    // Upstream model endpoint for the chatbot (see /api/chat).
    modelApiUrl: env('SAVEHATKE_MODEL_API_URL'),
    modelApiKey: env('SAVEHATKE_MODEL_API_KEY'),
    modelName: env('SAVEHATKE_MODEL_NAME'),
  };
}

/** Names of required variables that are missing, for a precise startup error. */
export function missingConfig(config = getConfig()) {
  const missing = [];
  if (!config.googleClientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.googleClientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (!config.sheetId) missing.push('GOOGLE_SHEET_ID');
  if (!config.serviceAccountEmail) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL (or GOOGLE_SERVICE_ACCOUNT_JSON)');
  }
  if (!config.serviceAccountPrivateKey) {
    missing.push('GOOGLE_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON)');
  }
  return missing;
}

export const encoder = textEncoder;