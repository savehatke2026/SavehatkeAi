/* ============================================================
   GET /api/auth/login?next=chat.html

   Starts a Google sign-in. Mints state + nonce + PKCE verifier, stores
   them in a signed HttpOnly cookie, and redirects the browser to Google.

   Nothing sensitive is placed in the URL: the browser only ever sees a
   random `state` value, which is useless without the cookie.
   ============================================================ */

import { getConfig, missingConfig } from '../../lib/config.js';
import { buildCookie } from '../../lib/cookies.js';
import { fail } from '../../lib/http.js';
import { STATE_COOKIE, beginLogin } from '../../lib/oauth.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  if (req.method !== 'GET') {
    return fail(405, 'method_not_allowed', 'Use GET for this endpoint');
  }

  const settings = getConfig();

  // Report a misconfigured deploy precisely — this is the most common
  // setup problem and a generic error would waste a lot of time.
  const missing = missingConfig(settings);
  if (missing.length) {
    console.error('[savehatke] /api/auth/login missing:', missing.join(', '));
    return fail(
      500,
      'server_misconfigured',
      `Sign-in is not configured yet (missing ${missing.join(', ')}).`
    );
  }

  const url = new URL(req.url);
  const { redirectTo, cookieValue } = await beginLogin(
    req,
    url.searchParams.get('next')
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      'Set-Cookie': buildCookie(req, {
        name: STATE_COOKIE,
        value: cookieValue,
        maxAge: settings.nonceMaxAgeSeconds,
      }),
      'Cache-Control': 'no-store',
    },
  });
}