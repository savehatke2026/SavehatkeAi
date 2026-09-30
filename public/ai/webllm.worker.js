/* ============================================================
   SaveHatke AI — WebLLM worker.

   Hosts the actual model engine off the main thread so decoding never
   freezes the interface. The main thread talks to it through the
   WebWorkerMLCEngine client (see webllm-engine.js). This file is loaded as
   a module worker from this origin, so it stays under script-src 'self'.
   ============================================================ */

import * as webllm from '../vendor/web-llm/index.js';

const handler = new webllm.WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
