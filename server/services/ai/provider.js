/* ============================================================
   SaveHatke AI — provider abstraction.

   /api/chat talks to a PROVIDER, not to an engine. Two exist:

     SAVEHATKE_AI    the custom lightweight engine (default)
     UPSTREAM_MODEL  the pre-existing OpenAI-compatible endpoint

   The point of the indirection is that the custom engine was introduced
   without deleting what came before. Gemini is not implemented as its own
   provider because this repository has no Gemini SDK or credential — the
   `GEMINI` value is accepted as an alias for UPSTREAM_MODEL, which is what
   a Gemini OpenAI-compatible endpoint would use. That keeps the provider
   list the spec asks for without pretending to a capability that is not
   present.

   The browser cannot tell which provider answered: both return the same
   { reply, source } shape, and neither exposes a credential.
   ============================================================ */

import { getAIConfig, PROVIDERS } from './config.js';
import { runSaveHatkeAI } from './savehatkeAI.js';

/** Accepted AI_PROVIDER values, including documented aliases. */
export const PROVIDER_ALIASES = Object.freeze({
  SAVEHATKE_AI: PROVIDERS.SAVEHATKE_AI,
  SAVEHATKE: PROVIDERS.SAVEHATKE_AI,
  CUSTOM: PROVIDERS.SAVEHATKE_AI,
  UPSTREAM_MODEL: PROVIDERS.UPSTREAM_MODEL,
  UPSTREAM: PROVIDERS.UPSTREAM_MODEL,
  MODEL: PROVIDERS.UPSTREAM_MODEL,
  OPENAI: PROVIDERS.UPSTREAM_MODEL,
  GEMINI: PROVIDERS.UPSTREAM_MODEL,
});

/** Resolves the configured provider, or null when it is not usable.
 *
 * @param {object} aiConfig the engine config (AI_* variables)
 * @param {object} serverConfig the application config, which owns the legacy
 *   upstream endpoint variables (SAVEHATKE_MODEL_API_URL and friends). The
 *   two are separate on purpose: the engine knows nothing about the host
 *   application, and the host knows nothing about how the engine scores.
 */
export function resolveProvider(aiConfig = getAIConfig(), serverConfig = {}) {
  const upstreamReady = Boolean(serverConfig.modelApiUrl);

  // The master switch off means "do not use the custom engine", which is a
  // request for the upstream path — not for no answer at all. When no
  // upstream is configured the caller falls back to the preview engine.
  if (!aiConfig.enabled) {
    return upstreamReady ? PROVIDERS.UPSTREAM_MODEL : PROVIDERS.SAVEHATKE_AI;
  }

  const requested = PROVIDER_ALIASES[aiConfig.provider] || PROVIDERS.SAVEHATKE_AI;
  if (requested === PROVIDERS.UPSTREAM_MODEL) {
    // Asking for the upstream provider without an endpoint would otherwise
    // fail every request; fall back to the custom engine instead.
    return upstreamReady ? PROVIDERS.UPSTREAM_MODEL : PROVIDERS.SAVEHATKE_AI;
  }
  return PROVIDERS.SAVEHATKE_AI;
}

/* ---------------- upstream (pre-existing behaviour) ---------------- */

/**
 * Calls the configured OpenAI-compatible endpoint. Unchanged from the
 * original implementation, moved here so /api/chat no longer contains
 * provider logic.
 *
 * @param {object} aiConfig engine config — supplies the timeout
 * @param {object} serverConfig application config — supplies the endpoint
 * @param {object[]} messages the conversation to forward
 */
export async function callUpstream(aiConfig, serverConfig, messages) {
  const response = await fetch(serverConfig.modelApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serverConfig.modelApiKey}`,
    },
    body: JSON.stringify({
      model: serverConfig.modelName || undefined,
      messages,
      // AI_MAX_TOKENS. Ignored by the custom engine, which does not generate
      // tokens, but honoured here where it means something.
      max_tokens: aiConfig.maxTokens,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(aiConfig.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Model provider failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const body = await response.json();
  const reply = body?.choices?.[0]?.message?.content ?? body?.reply ?? body?.content ?? '';
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('Model provider returned an empty response');
  }
  return reply.trim();
}

/* ---------------- unified entry point ---------------- */

/**
 * Produces a reply for one turn.
 *
 * @param {{
 *   message:string, history:object[], user:{email:string,name:string},
 *   conversationId:string, authHeaders?:object, bundle?:object
 * }} input
 * @param {object} serverConfig application config, used only when the
 *   upstream provider is selected
 * @returns {Promise<{reply:string, source:string, meta:object}>}
 */
export async function generateReply(input, serverConfig = {}) {
  const config = getAIConfig();
  const provider = resolveProvider(config, serverConfig);

  if (provider === PROVIDERS.UPSTREAM_MODEL) {
    // The upstream path keeps its original contract: the conversation is
    // forwarded, because a general model has no other context. It is bounded
    // by AI_MAX_CONTEXT so a long session cannot grow the request without
    // limit — the history array holds individual messages, hence 2x.
    const history = (input.history || []).slice(-(config.maxContext * 2));
    const messages = [...history, { role: 'user', content: input.message }];
    const reply = await callUpstream(config, serverConfig, messages);
    return { reply, source: 'model', meta: { provider } };
  }

  const result = await runSaveHatkeAI(input);
  return { reply: result.reply, source: result.source, meta: result.meta };
}

export { PROVIDERS };
