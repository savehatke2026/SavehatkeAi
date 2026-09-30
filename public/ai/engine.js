/* ============================================================
   SaveHatke AI — engine abstraction.

   The UI depends on THIS interface, never on a concrete model runtime, so
   the model can be replaced (a bigger on-device model, or a self-hosted
   server runtime) without touching the chat interface.

   An engine implements:
     load(onProgress)                   -> Promise<void>   download + init
     streamResponse(messages, opts)     -> AsyncIterable<string> of deltas
     generateResponse(messages, opts)   -> Promise<string>
     summarize(text)                    -> Promise<string>
     generateTitle(firstUserMessage)    -> Promise<string>
     interrupt()                        -> void
     get status()                       -> 'idle'|'loading'|'ready'|'error'
   ============================================================ */

import { createWebLLMEngine } from './webllm-engine.js';

/**
 * Builds the engine for the configured runtime.
 * @param {object} modelConfig  from loadModelConfig()
 * @returns {object} an AIEngine
 */
export function createEngine(modelConfig) {
  switch (modelConfig.runtime) {
    case 'browser-webllm':
      return createWebLLMEngine(modelConfig);
    default:
      // Never silently substitute a different kind of engine: fail loudly so
      // a misconfiguration cannot masquerade as a working model.
      throw new Error(
        'Unsupported MODEL_RUNTIME "' + modelConfig.runtime + '". '
        + 'This build ships the on-device WebGPU runtime ("browser-webllm").',
      );
  }
}
