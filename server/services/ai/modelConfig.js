/* ============================================================
   SaveHatke AI — model configuration (server-owned, browser-exposed).

   The real model runs in the browser (WebGPU/WebLLM), but its
   configuration is owned by the server so nothing is hardcoded in client
   code and a model swap needs no frontend change. This module reads the
   MODEL_* environment variables and produces a plain, NON-SECRET object
   that /api/ai/config hands to the browser after the caller has been
   authorized.

   Nothing here is a secret: a model id, a context size and a temperature
   are safe to expose to an authorized user. Credentials never pass through
   this module.
   ============================================================ */

function env(name) {
  const value = globalThis.process?.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function envFloat(name, fallback, { min = 0, max = 2 } = {}) {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * The public model configuration.
 *
 * `runtime` names how inference actually happens, so the UI never has to
 * guess and can never claim a capability that is not wired:
 *   - "browser-webllm"  a real open-weight model runs in the user's browser
 *                       over WebGPU. Prompts never leave the device.
 *   - "server-upstream" a self-hosted OpenAI-compatible runtime answers via
 *                       /api/chat (see SAVEHATKE_MODEL_API_URL). Use this for
 *                       a stronger model on separate inference hardware.
 *
 * When SAVEHATKE_MODEL_API_URL is set, the browser is told a server runtime
 * exists so it can fall back to it when the device has no WebGPU — without
 * ever falling back to a rule-based engine.
 */
export function getModelConfig() {
  const serverUpstreamReady = Boolean(env('SAVEHATKE_MODEL_API_URL'));

  return Object.freeze({
    // Primary inference runtime for the browser client.
    runtime: (env('MODEL_RUNTIME') || 'browser-webllm').toLowerCase(),

    // The open-weight model the browser loads. Must be an id WebLLM knows
    // (see prebuiltAppConfig). Chosen for intelligence-per-resource, not size.
    modelId: env('MODEL_NAME') || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    // Human-facing label shown in the UI. The id is an implementation detail.
    modelLabel: env('MODEL_LABEL') || 'SaveHatke AI (Qwen2.5 1.5B, on-device)',
    modelFormat: env('MODEL_FORMAT') || 'MLC-q4f16_1',

    // Generation limits. Real knobs the browser engine honours.
    contextSize: envInt('MODEL_CONTEXT_SIZE', 4096, { min: 512, max: 32768 }),
    maxOutputTokens: envInt('MODEL_MAX_OUTPUT_TOKENS', 1024, { min: 16, max: 8192 }),
    temperature: envFloat('MODEL_TEMPERATURE', 0.7, { min: 0, max: 2 }),
    topP: envFloat('MODEL_TOP_P', 0.95, { min: 0, max: 1 }),
    // WebLLM's sampler does not take a raw top_k; it is exposed for the
    // future server/upstream runtime and documented as such.
    topK: envInt('MODEL_TOP_K', 40, { min: 0, max: 1000 }),

    // Optional override for where the model weights/libs are fetched from.
    // Empty = WebLLM's default (its published model host). Set this to a
    // self-hosted mirror to remove the last third-party dependency and make
    // the deployment fully self-controlled.
    modelHost: env('MODEL_HOST'),

    // Whether a self-hosted server runtime is available as a fallback for
    // devices without WebGPU. Never exposes the URL or any key.
    serverFallbackAvailable: serverUpstreamReady,
  });
}
