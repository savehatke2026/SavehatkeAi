/* ============================================================
   SaveHatke AI — client model configuration.

   The server owns the model configuration (see /api/ai/config). This
   module fetches it once and caches it, with a conservative default so the
   UI can still render if the config call is briefly unavailable. Nothing
   here is a secret.
   ============================================================ */

const DEFAULTS = Object.freeze({
  runtime: 'browser-webllm',
  modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  modelLabel: 'SaveHatke AI (on-device)',
  modelFormat: 'MLC-q4f16_1',
  contextSize: 4096,
  maxOutputTokens: 1024,
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  modelHost: '',
  serverFallbackAvailable: false,
});

let cached = null;

/**
 * Fetches the server-owned model configuration for the authorized user.
 * @returns {Promise<typeof DEFAULTS>}
 */
export async function loadModelConfig() {
  if (cached) return cached;
  try {
    const response = await fetch('/api/ai/config', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('config request failed (' + response.status + ')');
    const data = await response.json();
    cached = Object.freeze({ ...DEFAULTS, ...(data && data.model ? data.model : {}) });
  } catch (error) {
    // A missing config must not silently invent a different model than the
    // server intends; fall back to the documented default and let the model
    // load surface any real problem honestly.
    console.warn('[savehatke-ai] using default model config:', error.message);
    cached = DEFAULTS;
  }
  return cached;
}

export function getDefaults() {
  return DEFAULTS;
}
