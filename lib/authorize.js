/* ============================================================
   SaveHatke AI — request authorization.

   Two independent questions, answered in this order:
     1. Identity  — is there a valid, unexpired session cookie?
     2. Access    — is that identity still on the Sheets whitelist?

   Keeping them separate is what lets an admin revoke someone by editing
   the sheet: the cookie stays technically valid, but step 2 fails and the
   request is refused on the very next call.
   ============================================================ */

import { getConfig, missingConfig } from './config.js';
import { fail } from './http.js';
import { readSessionCookie, verifySessionToken } from './session.js';
import { checkWhitelist } from './whitelist.js';

const STATUS_FOR_REASON = {
  not_listed: 403,
  disabled: 403,
  unavailable: 503,
};

const MESSAGE_FOR_REASON = {
  not_listed: 'This Google account is not authorized for SaveHatke AI.',
  disabled: 'Access for this Google account has been disabled.',
  unavailable: 'Authorization is temporarily unavailable. Please try again.',
};

/**
 * Resolves the caller.
 * @returns {Promise<
 *   {ok:true, user:{email:string,name:string,sub:string}} |
 *   {ok:false, response:Response}
 * >}
 */
export async function authorizeRequest(req) {
  const config = getConfig();

  const missing = missingConfig(config);
  // Only the auth-critical variables matter here; the model endpoint is
  // validated where it is actually used.
  const authMissing = missing.filter((name) => !name.startsWith('SAVEHATKE_MODEL'));
  if (authMissing.length) {
    console.error('[savehatke] missing configuration:', authMissing.join(', '));
    return {
      ok: false,
      response: fail(
        500,
        'server_misconfigured',
        'SaveHatke AI is not fully configured on the server.'
      ),
    };
  }

  const token = readSessionCookie(req);
  const session = await verifySessionToken(token, config.sessionSecret);
  if (!session) {
    return {
      ok: false,
      response: fail(401, 'unauthenticated', 'Please sign in to continue.'),
    };
  }

  const access = await checkWhitelist(session.email);
  if (!access.authorized) {
    // A revoked user keeps a valid cookie but loses access immediately.
    return {
      ok: false,
      response: fail(
        STATUS_FOR_REASON[access.reason] ?? 403,
        access.reason,
        MESSAGE_FOR_REASON[access.reason] ?? 'Access denied.'
      ),
    };
  }

  return {
    ok: true,
    user: { email: session.email, name: session.name, sub: session.sub },
  };
}

/**
 * Identity only — no whitelist check.
 * Used by /api/auth/session, which must be able to tell the page *why*
 * access was refused (not listed vs disabled) rather than just "no".
 */
export async function identifyRequest(req) {
  const config = getConfig();
  if (!config.sessionSecret) {
    return {
      ok: false,
      response: fail(500, 'server_misconfigured', 'SaveHatke AI is not fully configured on the server.'),
    };
  }

  const session = await verifySessionToken(readSessionCookie(req), config.sessionSecret);
  if (!session) {
    return {
      ok: false,
      response: fail(401, 'unauthenticated', 'Please sign in to continue.'),
    };
  }

  return { ok: true, user: { email: session.email, name: session.name, sub: session.sub } };
}