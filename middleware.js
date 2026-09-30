/* ============================================================
   SaveHatke AI — middleware (Vercel Routing Middleware, Edge runtime).

   Server-side gate for the chatbot and account pages. This is the piece
   that makes "hide the UI" unnecessary: a signed-out or revoked visitor
   is refused before the page is ever served.

   It performs the FULL check — identity AND whitelist — because the
   whitelist client in lib/ is built on WebCrypto + fetch and therefore
   runs on the Edge runtime too. Same code, same decision as the API.

   Static assets and public marketing pages are untouched.

   Note: this is defence in depth, not the only line. Every protected API
   route independently re-authorizes the request (lib/authorize.js), so
   bypassing the page gate still gets you a 401/403 from the API.
   ============================================================ */

import { getConfig } from './lib/config.js';
import { readSessionCookie, verifySessionToken } from './lib/session.js';
import { checkWhitelist } from './lib/whitelist.js';

/** Pages that require a signed-in, whitelisted user. */
const PROTECTED = new Set(['/chat.html', '/dashboard.html', '/profile.html']);

export const config = {
  matcher: ['/chat.html', '/dashboard.html', '/profile.html'],
};

export default async function middleware(req) {
  const url = new URL(req.url);
  if (!PROTECTED.has(url.pathname)) return;

  const settings = getConfig();

  // Without a secret nothing can be verified. Send the visitor to the login
  // page rather than letting a protected page render on an unverifiable
  // session. (A misconfigured server is surfaced there by /api/auth/config.)
  const session = settings.sessionSecret
    ? await verifySessionToken(readSessionCookie(req), settings.sessionSecret)
    : null;

  if (session) {
    // Signed in — now confirm they are still allowed in. A user flipped to
    // "disabled" in the sheet is refused here within the cache TTL, even
    // though their cookie is still cryptographically valid.
    const access = await checkWhitelist(session.email);
    if (access.authorized) return;

    const denied = new URL('/access-restricted.html', url.origin);
    denied.searchParams.set('reason', access.reason);
    return Response.redirect(denied, 302);
  }

  const loginUrl = new URL('/login.html', url.origin);
  // `next` is validated as a same-site relative path before use, so this
  // cannot be turned into an open redirect.
  loginUrl.searchParams.set('next', url.pathname.replace(/^\//, ''));
  return Response.redirect(loginUrl, 302);
}