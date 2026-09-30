/* ============================================================
   GET /api/auth/config

   Reports whether Google sign-in is configured, so the login page can
   either offer "Continue with Google" or explain that setup is
   incomplete. No secrets are returned: with the authorization-code flow
   the browser needs no client id, no nonce and no state — it just links
   to /api/auth/login.
   ============================================================ */

import { getConfig, missingConfig } from '../../lib/config.js';
import { json, requireMethod } from '../../lib/http.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  const wrongMethod = requireMethod(req, 'GET');
  if (wrongMethod) return wrongMethod;

  const settings = getConfig();
  const missing = missingConfig(settings);

  if (missing.length) {
    console.error('[savehatke] /api/auth/config missing:', missing.join(', '));
    return json({
      configured: false,
      provider: 'google',
      signInUrl: '/api/auth/login',
      missing,
    });
  }

  return json({
    configured: true,
    provider: 'google',
    signInUrl: '/api/auth/login',
  });
}