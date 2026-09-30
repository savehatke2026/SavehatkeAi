/* ============================================================
   GET /api/auth/session

   Tells the page who the caller is, and whether they are currently
   authorized. Called on every page load, so it must stay cheap: the
   whitelist lookup is served from the short-TTL cache.

   The 200-with-`authorized:false` shape is deliberate. A user whose
   access was revoked should land on a clear explanation, not a bare 401
   that the UI can only render as "something went wrong".
   ============================================================ */

import { identifyRequest } from '../../lib/authorize.js';
import { json, requireMethod } from '../../lib/http.js';
import { checkWhitelist } from '../../lib/whitelist.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  const wrongMethod = requireMethod(req, 'GET');
  if (wrongMethod) return wrongMethod;

  // Not signed in at all — expected for every ordinary visitor, so answer
  // plainly rather than logging an error.
  const identity = await identifyRequest(req);
  if (!identity.ok) {
    return json({ authenticated: false, authorized: false });
  }

  const access = await checkWhitelist(identity.user.email);

  return json({
    authenticated: true,
    authorized: access.authorized,
    reason: access.reason,
    // The profile is returned ONLY when authorized, so the front-end cannot
    // render account details for someone who is not allowed in.
    user: access.authorized
      ? { email: identity.user.email, name: identity.user.name }
      : null,
    // Included in the denial case solely so the restricted page can name
    // the account that was refused.
    email: identity.user.email,
  });
}