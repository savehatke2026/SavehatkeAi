/* ============================================================
   GET /api/ai/config

   Hands the browser the NON-SECRET model configuration it needs to run
   SaveHatke AI on-device (model id, context/output limits, sampling,
   optional self-hosted model host). Gated behind the same authorization as
   the chat endpoint: only a signed-in, whitelisted account gets it.

   No secret is ever returned here — a model id and a temperature are safe
   to expose; credentials are not, and none are read in this path.
   ============================================================ */

import { authorizeRequest } from '../../lib/authorize.js';
import { json, requireMethod } from '../../lib/http.js';
import { getModelConfig } from '../../server/services/ai/modelConfig.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  const wrongMethod = requireMethod(req, 'GET');
  if (wrongMethod) return wrongMethod;

  // Identity + whitelist. Nothing about the model is disclosed to an
  // unauthorized caller.
  const auth = await authorizeRequest(req);
  if (!auth.ok) return auth.response;

  return json({ model: getModelConfig() });
}
