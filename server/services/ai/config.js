/* ============================================================
   SaveHatke AI — engine configuration.

   Every tunable lives here so the engine has one source of truth, and
   every value comes from the environment with a safe default. Nothing is
   hardcoded, and no secret is ever read in this file.

   Server-side only. Never imported by anything under public/.
   ============================================================ */

/** Provider identifiers. SAVEHATKE_AI is the default and needs no network. */
export const PROVIDERS = Object.freeze({
  SAVEHATKE_AI: 'SAVEHATKE_AI',
  UPSTREAM_MODEL: 'UPSTREAM_MODEL',
});

/** Permission levels. The chatbot may only ever expose the first two. */
export const PERMISSIONS = Object.freeze({
  PUBLIC: 'PUBLIC',
  AUTHENTICATED_USER: 'AUTHENTICATED_USER',
  ADMIN_ONLY: 'ADMIN_ONLY',
});

function env(name) {
  const value = globalThis.process?.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function envFloat(name, fallback, { min = 0, max = 1 } = {}) {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function envBool(name, fallback) {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

/**
 * @returns {Readonly<object>} the resolved engine configuration
 */
export function getAIConfig() {
  const providerRaw = env('AI_PROVIDER').toUpperCase();
  const provider = Object.values(PROVIDERS).includes(providerRaw)
    ? providerRaw
    : PROVIDERS.SAVEHATKE_AI;

  return Object.freeze({
    /* ---- master switch ---- */
    enabled: envBool('AI_ENABLED', true),
    provider,

    /* ---- model artefacts ---- */
    // Optional override; modelLoader falls back to server/models/ai next to
    // this file. Relative paths are resolved from the repository root.
    modelPath: env('AI_MODEL_PATH'),

    /* ---- generation limits ---- */
    // These three apply to the UPSTREAM provider (AI_PROVIDER=UPSTREAM_MODEL).
    // The custom engine does not generate tokens and does not forward a
    // transcript, so it has no use for them — but a value that is read
    // nowhere is worse than no value at all, so they are honoured on the
    // path where they mean something rather than left as decoration.
    maxTokens: envInt('AI_MAX_TOKENS', 320, { min: 16, max: 4096 }),
    maxContext: envInt('AI_MAX_CONTEXT', 12, { min: 1, max: 100 }),
    // Enforced by /api/chat as the per-message ceiling.
    maxMessageLength: envInt('AI_MAX_MESSAGE_LENGTH', 4000, { min: 64, max: 32000 }),
    toolRounds: envInt('AI_TOOL_ROUNDS', 2, { min: 0, max: 5 }),
    // Timeout for the upstream provider call, in milliseconds.
    timeoutMs: envInt('AI_TIMEOUT', 8000, { min: 250, max: 60000 }),

    /* ---- confidence ---- */
    // Below `medium` the engine asks for clarification instead of guessing.
    confidenceThreshold: envFloat('AI_CONFIDENCE_THRESHOLD', 0.55),
    highConfidence: envFloat('AI_HIGH_CONFIDENCE', 0.8),
    // Sharpness of the softmax over centroid cosine similarity. Cosine
    // similarities for short text cluster in a narrow band (a good match
    // sits near 0.5, a poor one near 0.15), so the scores are amplified
    // before normalising. Raise to be more decisive, lower to be more
    // willing to say "I'm not sure".
    confidenceTemperature: envFloat('AI_CONFIDENCE_TEMPERATURE', 9.0, { min: 0.1, max: 50 }),
    // Minimum idf-weighted share of in-vocabulary tokens before a result is
    // trusted. A message full of unknown words scores low here no matter how
    // peaked the distribution looks — this is the main guard against
    // answering an off-topic question.
    minTokenCoverage: envFloat('AI_MIN_TOKEN_COVERAGE', 0.5),

    /* ---- knowledge retrieval ---- */
    knowledgeTopK: envInt('AI_KNOWLEDGE_TOP_K', 3, { min: 1, max: 10 }),
    knowledgeMinScore: envFloat('AI_KNOWLEDGE_MIN_SCORE', 0.18),

    /* ---- conversation context ---- */
    // How long a conversation's short-term context is retained. The context
    // is deliberately shallow — the previous turn only — so there is no
    // "how many turns" knob: nothing reads one, and an unread setting is
    // worse than an absent one.
    contextTtlSeconds: envInt('AI_CONTEXT_TTL_SECONDS', 1800, { min: 30, max: 86400 }),
    contextMaxConversations: envInt('AI_CONTEXT_MAX_CONVERSATIONS', 5000, { min: 10, max: 200000 }),

    /* ---- live data sources (see toolRouter) ---- */
    // Base URL of the SaveHatke application API the tools are allowed to call.
    // When unset, user-data tools report "unavailable" instead of guessing.
    apiBaseUrl: env('AI_API_BASE_URL'),
    apiTimeoutMs: envInt('AI_API_TIMEOUT', 4000, { min: 250, max: 30000 }),
    // Flat seller rate, in rupees, per sold eligible coupon. This is the
    // single source of truth for the earnings calculation.
    sellerRatePerCoupon: envInt('AI_SELLER_RATE_PER_COUPON', 10, { min: 0, max: 100000 }),

    /* ---- observability ---- */
    // 'silent' | 'info' | 'debug'. Structured per-turn metadata only: never a
    // message body, an entity value or a credential.
    logLevel: (env('AI_LOG_LEVEL') || 'info').toLowerCase(),
  });
}

/** Names of AI variables that are set but unusable, for a precise warning. */
export function aiConfigWarnings(config = getAIConfig()) {
  const warnings = [];
  if (!config.enabled) warnings.push('AI_ENABLED is off — /api/chat will fall back to the legacy provider path.');
  if (config.provider === PROVIDERS.UPSTREAM_MODEL) {
    warnings.push('AI_PROVIDER=UPSTREAM_MODEL — the custom engine is bypassed for generation.');
  }
  if (!config.apiBaseUrl) {
    // The quietest failure mode the engine has. Everything still works, every
    // test still passes, and every question about the user's own account
    // answers "I couldn't retrieve that" — with nothing anywhere saying why.
    warnings.push(
      'AI_API_BASE_URL is unset — questions about earnings, payouts, purchases '
      + 'and tickets will answer "unavailable" instead of fetching live data.',
    );
  } else if (!/^https?:\/\//i.test(config.apiBaseUrl)) {
    warnings.push('AI_API_BASE_URL is not an http(s) URL — live-data tools will report unavailable.');
  }
  if (config.confidenceThreshold >= config.highConfidence) {
    warnings.push('AI_CONFIDENCE_THRESHOLD must be below AI_HIGH_CONFIDENCE.');
  }
  return warnings;
}
