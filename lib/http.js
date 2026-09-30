/* ============================================================
   SaveHatke AI — HTTP helpers for API routes.

   Small, dependency-free helpers shared by every endpoint: JSON
   responses, cookie headers, and a uniform error shape so the browser
   always gets `{ error, code }` back instead of an HTML error page.
   ============================================================ */

/** JSON response with optional Set-Cookie headers. */
export function json(body, { status = 200, cookies = [], headers = {} } = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  // Auth responses are per-user and must never be cached by a CDN.
  responseHeaders.set('Cache-Control', 'no-store, max-age=0');

  const list = Array.isArray(cookies) ? cookies : [cookies];
  for (const cookie of list) {
    if (cookie) responseHeaders.append('Set-Cookie', cookie);
  }

  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

/** Uniform error response. `code` is for the UI; `message` is for logs/users. */
export function fail(status, code, message) {
  return json({ error: message || code, code }, { status });
}

/** Parses a JSON request body, tolerating an empty or malformed body. */
export async function readJson(req) {
  try {
    return (await req.json()) ?? {};
  } catch {
    return {};
  }
}

/**
 * Rejects cross-site POSTs. The session cookie is SameSite=Lax, but an
 * explicit origin check costs nothing and blocks a class of CSRF bugs
 * before the cookie is ever inspected.
 */
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // same-origin fetches may omit Origin
  const host = req.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Method guard; returns a ready 405 response when it does not match. */
export function requireMethod(req, method) {
  if (req.method === method) return null;
  return fail(405, 'method_not_allowed', `Use ${method} for this endpoint`);
}