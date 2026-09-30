/* ============================================================
   SaveHatke AI — WebLLM (WebGPU) engine.

   A REAL open-weight language model running entirely in the user's
   browser through WebGPU. No prompt ever leaves the device; there is no
   server inference and no third-party AI API. Model code is served from
   this origin (public/vendor/web-llm); model parameters are fetched once from
   the configured model host and cached by the browser for later visits.

   Inference runs in a Web Worker so token generation never freezes the UI.
   The worker (webllm.worker.js) hosts the actual engine; this module is the
   main-thread client that speaks the shared AIEngine interface.
   ============================================================ */

import * as webllm from '../vendor/web-llm/index.js';

export function createWebLLMEngine(modelConfig) {
  let engine = null;
  let status = 'idle';
  let loadError = null;

  async function load(onProgress) {
    if (status === 'ready') return;
    status = 'loading';
    loadError = null;
    try {
      const worker = new Worker(new URL('./webllm.worker.js', import.meta.url), {
        type: 'module',
      });
      engine = await webllm.CreateWebWorkerMLCEngine(worker, modelConfig.modelId, {
        initProgressCallback: (report) => {
          if (typeof onProgress === 'function') {
            onProgress({
              progress: report.progress,          // 0..1
              text: report.text || '',             // human-readable stage
            });
          }
        },
        logLevel: 'WARN',
      });
      status = 'ready';
    } catch (error) {
      status = 'error';
      loadError = error;
      throw error;
    }
  }

  function ensureReady() {
    if (status !== 'ready' || !engine) {
      throw new Error('The model is not loaded yet.');
    }
  }

  /* Real token streaming. Yields content deltas as the model decodes them.
     Honours the model's generation limits from the server-owned config. */
  async function* streamResponse(messages, opts = {}) {
    ensureReady();
    const completion = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: opts.temperature ?? modelConfig.temperature,
      top_p: opts.topP ?? modelConfig.topP,
      max_tokens: opts.maxTokens ?? modelConfig.maxOutputTokens,
      stream_options: { include_usage: false },
    });
    for await (const chunk of completion) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async function generateResponse(messages, opts = {}) {
    let out = '';
    for await (const delta of streamResponse(messages, opts)) out += delta;
    return out;
  }

  async function summarize(text) {
    ensureReady();
    const messages = [
      {
        role: 'system',
        content: 'Summarise the following conversation in 2-4 sentences, '
          + 'preserving names, decisions, and open questions. Output only the summary.',
      },
      { role: 'user', content: String(text || '').slice(0, 8000) },
    ];
    return (await generateResponse(messages, { maxTokens: 200, temperature: 0.3 })).trim();
  }

  async function generateTitle(firstUserMessage) {
    ensureReady();
    const messages = [
      {
        role: 'system',
        content: 'Give a short, specific chat title (3-6 words) for the user\'s '
          + 'first message. No quotes, no trailing punctuation. Output only the title.',
      },
      { role: 'user', content: String(firstUserMessage || '').slice(0, 500) },
    ];
    const title = (await generateResponse(messages, { maxTokens: 24, temperature: 0.4 }))
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .split('\n')[0]
      .slice(0, 60);
    return title || 'New chat';
  }

  function interrupt() {
    if (engine && typeof engine.interruptGenerate === 'function') {
      engine.interruptGenerate();
    }
  }

  return {
    load,
    streamResponse,
    generateResponse,
    summarize,
    generateTitle,
    interrupt,
    get status() { return status; },
    get error() { return loadError; },
    get modelId() { return modelConfig.modelId; },
  };
}
