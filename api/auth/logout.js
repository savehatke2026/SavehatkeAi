/* ============================================================
   POST /api/auth/logout

   Clears the session and nonce cookies. Always succeeds, even when the
   caller was not signed in — signing out should never be able to fail.
   ============================================================ */

import { json, requireMethod, sameOrigin } from '../../lib/http.js';
import { clearedSessionCookie } from '../../lib/session.js';
import { STATE_COOKIE } from '../../lib/oauth.js';
import { buildCookie } from '../../lib/cookies.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  const wrongMethod = requireMethod(req, 'POST');
  if (wrongMethod) return wrongMethod;

  if (!sameOrigin(req)) {
    return json({ ok: false }, { status: 403 });
  }

  return json(
    { ok: true },
    { cookies: [clearedSessionCookie(req), buildCookie(req, { name: STATE_COOKIE, value: '', maxAge: 0 })] }
  );
}