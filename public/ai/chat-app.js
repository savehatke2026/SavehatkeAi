/* ============================================================
   SaveHatke AI — chat controller.

   Orchestrates one authorized chat session end to end, entirely against
   the AIEngine abstraction:

     capability check → load model → per turn:
        detect + run tools (calculator) → assemble bounded context
        (+ memory, + running summary) → stream tokens from the on-device
        model → render Markdown → persist locally.

   The real model runs on-device (WebGPU). When a device cannot run it and
   a self-hosted server runtime is configured, this falls back to that
   runtime via /api/chat — never to a rule-based engine, and never
   pretending a model answered when it did not.
   ============================================================ */

import { detectCapabilities } from './capabilities.js';
import { loadModelConfig } from './model-config.js';
import { createEngine } from './engine.js';
import { buildSystemPrompt } from './prompt.js';
import { buildContext } from './context.js';
import { calculatorTool, extractExpression } from './tools/calculator.js';
import { memoryForPrompt, getMemoryState, addMemory, deleteMemory, setMemoryEnabled } from './memory.js';
import { renderMarkdown, wireCodeCopy } from './markdown.js';

const S = window.SaveHatke;

/* ---------------- element refs ---------------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const dom = {};
let engine = null;
let modelConfig = null;
let mode = 'webllm';          // 'webllm' | 'server' | 'blocked'
let modelLoaded = false;
let loadingPromise = null;
let generating = false;

const history = [];           // {role, content} full transcript for context
let summary = '';
let summarizedUpTo = 0;
let conversationId = null;     // server-side (Sheets) conversation id, lazily created

/* ---------------- boot ---------------- */
S.ready.then(async () => {
  cacheDom();

  if (!S.session.isSignedIn()) {
    if (S.session.authenticated()) {
      const reason = S.session.denialReason() || 'not_listed';
      window.location.replace('access-restricted.html?reason=' + encodeURIComponent(reason));
    } else {
      window.location.replace('login.html?next=chat.html');
    }
    return;
  }

  wireEvents();
  modelConfig = await loadModelConfig();
  await decideMode();
});

function cacheDom() {
  dom.form = $('composer');
  dom.input = $('chat-input');
  dom.send = $('composer-send');
  dom.stop = $('composer-stop');
  dom.thread = $('chat-thread');
  dom.scroll = $('chat-scroll');
  dom.intro = $('chat-intro');
  dom.status = $('model-status');
  dom.statusText = $('model-status-text');
  dom.progressBar = $('model-progress-bar');
  dom.loadBtn = $('model-load-btn');
  dom.newChat = $('new-chat');
  dom.memoryBtn = $('memory-btn');
  dom.memoryDialog = $('memory-dialog');
}

/* ---------------- mode decision (honest capability gating) ----------------

   The server owns the runtime choice. This build ships one real engine:
   the on-device WebGPU model ('browser-webllm'). When that runtime is
   selected we probe WebGPU and, only if it is genuinely usable, offer to
   load the model. If it is not usable we fall back to the operator's
   self-hosted server runtime when one is configured — never to a
   rule-based engine, and never pretending the on-device model answered.  */
async function decideMode() {
  const canUseServer = Boolean(modelConfig.serverFallbackAvailable);

  if (modelConfig.runtime === 'browser-webllm') {
    const caps = await detectCapabilities();
    if (caps.webgpu && caps.adapter) {
      mode = 'webllm';
      engine = createEngine(modelConfig);
      showLoadPrompt();
      return;
    }
    if (canUseServer) {
      mode = 'server';
      setStatus('This device can\'t run the on-device model (' + caps.reason
        + ') — using SaveHatke\'s self-hosted model runtime instead.', { hideAfter: 7000 });
      return;
    }
    blockWith(caps.reason + ' No self-hosted runtime is configured as a fallback, '
      + 'so on-device generation is required here.');
    return;
  }

  // A non-browser runtime was configured by the operator. This client build
  // has no in-browser engine for it, so route to the server runtime.
  if (canUseServer) {
    mode = 'server';
    setStatus('Using SaveHatke\'s self-hosted model runtime.', { hideAfter: 3500 });
    return;
  }
  blockWith('The configured model runtime "' + modelConfig.runtime
    + '" needs a self-hosted server runtime, which is not configured.');
}

function blockWith(message) {
  mode = 'blocked';
  setStatus(message, { persistent: true, tone: 'error' });
  if (dom.loadBtn) dom.loadBtn.hidden = true;
  dom.input.disabled = true;
  dom.send.disabled = true;
  dom.input.placeholder = 'AI model unavailable on this browser.';
}

function showLoadPrompt() {
  setStatus(modelConfig.modelLabel + ' runs privately on your device. The first '
    + 'load downloads the model once (~1 GB) and is then cached.', { persistent: true });
  if (dom.loadBtn) {
    dom.loadBtn.hidden = false;
    dom.loadBtn.textContent = 'Load SaveHatke AI';
  }
}

/* ---------------- model loading ---------------- */
function ensureLoaded() {
  if (modelLoaded) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  if (dom.loadBtn) dom.loadBtn.hidden = true;

  setProgress(0);
  setStatus('Loading ' + modelConfig.modelLabel + '…', { persistent: true, showBar: true });

  loadingPromise = engine.load((report) => {
    const pct = Math.max(0, Math.min(100, Math.round((report.progress || 0) * 100)));
    setProgress(pct);
    setStatus(report.text || ('Loading model… ' + pct + '%'), { persistent: true, showBar: true });
  }).then(() => {
    modelLoaded = true;
    setStatus(modelConfig.modelLabel + ' is ready — running privately on your device.',
      { hideAfter: 3500 });
  }).catch((error) => {
    loadingPromise = null;
    setStatus('Could not load the on-device model: '
      + (error && error.message ? error.message : 'unknown error')
      + '. Check that hardware acceleration is enabled and reload.',
      { persistent: true, tone: 'error' });
    throw error;
  });
  return loadingPromise;
}

/* ---------------- status / progress UI ---------------- */
function setStatus(text, { hideAfter = 0, tone = '', showBar = false } = {}) {
  if (!dom.status) return;
  dom.status.hidden = false;
  dom.status.dataset.tone = tone;
  dom.statusText.textContent = text;
  dom.status.classList.toggle('has-bar', showBar);
  if (hideAfter) {
    setTimeout(() => {
      if (dom.statusText.textContent === text) dom.status.hidden = true;
    }, hideAfter);
  }
}

function setProgress(pct) {
  if (dom.progressBar) dom.progressBar.style.width = pct + '%';
}

/* ---------------- rendering ---------------- */
function scrollToEnd() { dom.scroll.scrollTop = dom.scroll.scrollHeight; }

function addUserMessage(text) {
  const wrap = el('div', 'msg msg-user');
  const bubble = el('div', 'bubble bubble-user');
  bubble.textContent = text;
  wrap.appendChild(bubble);
  dom.thread.appendChild(wrap);
  scrollToEnd();
}

function addAssistantMessage() {
  const wrap = el('div', 'msg');
  const bubble = el('div', 'bubble bubble-bot');
  const body = el('div', 'md');
  bubble.appendChild(body);
  wrap.appendChild(bubble);
  dom.thread.appendChild(wrap);
  scrollToEnd();
  return { wrap, bubble, body };
}

function addTyping() {
  const wrap = el('div', 'msg');
  const bubble = el('div', 'bubble bubble-bot');
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  wrap.appendChild(bubble);
  dom.thread.appendChild(wrap);
  scrollToEnd();
  return wrap;
}

function addControls(node, rawText) {
  const bar = el('div', 'msg-controls');
  const copy = el('button', 'msg-ctl', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(rawText).catch(() => {});
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
  });
  const regen = el('button', 'msg-ctl', 'Regenerate');
  regen.type = 'button';
  regen.addEventListener('click', () => regenerate());
  const up = el('button', 'msg-ctl', '\u{1F44D}');
  up.type = 'button';
  up.title = 'Helpful';
  up.addEventListener('click', () => recordFeedback('up', rawText, up, down));
  const down = el('button', 'msg-ctl', '\u{1F44E}');
  down.type = 'button';
  down.title = 'Not helpful';
  down.addEventListener('click', () => recordFeedback('down', rawText, up, down));
  bar.append(copy, regen, up, down);
  node.wrap.appendChild(bar);
}

function recordFeedback(rating, text, up, down) {
  try {
    const key = 'savehatke.ai.feedback.v1';
    const list = JSON.parse(window.localStorage.getItem(key) || '[]');
    list.push({ rating, at: new Date().toISOString(), preview: String(text).slice(0, 120) });
    window.localStorage.setItem(key, JSON.stringify(list.slice(-200)));
  } catch { /* best effort */ }
  up.classList.toggle('is-active', rating === 'up');
  down.classList.toggle('is-active', rating === 'down');
  S.ui.toast('Thanks for the feedback.');
}

/* ---------------- composer state ---------------- */
function setGenerating(on) {
  generating = on;
  if (dom.send) dom.send.hidden = on;
  if (dom.stop) dom.stop.hidden = !on;
  if (dom.input) dom.input.disabled = false; // let the user type the next turn
}

function currentUserName() {
  const session = S.session.get();
  if (!session) return '';
  return session.name || (session.email ? session.email.split('@')[0] : '');
}

function currentEmail() {
  const session = S.session.get();
  return session ? session.email : '';
}

function hideIntro() {
  if (dom.intro && !dom.intro.hidden) dom.intro.hidden = true;
}

/* ---------------- send / turn orchestration ---------------- */
async function send(text) {
  const message = String(text || '').trim();
  if (!message || generating || mode === 'blocked') return;

  hideIntro();
  history.push({ role: 'user', content: message });
  addUserMessage(message);
  dom.input.value = '';
  autosize();

  if (mode === 'server') {
    await serverGenerate();
    return;
  }

  // On-device path: block re-entry and show the stop control while the model
  // loads, then generate. ensureLoaded reports its own failures.
  setGenerating(true);
  try {
    await ensureLoaded();
  } catch {
    // Do not fabricate a reply — leave the user's turn in place so they can
    // retry once hardware acceleration is sorted out.
    setGenerating(false);
    return;
  }
  await generate();
}

/* Assembles context, runs deterministic tools, and streams a real reply
   from the on-device model. */
async function generate() {
  setGenerating(true);
  // Captured before we append the assistant reply, so persistence records the
  // user turn that prompted this generation.
  const userForPersist = (([...history].reverse().find((m) => m.role === 'user')) || {}).content || '';

  // Deterministic calculator tool: pre-compute before generation so the
  // model reasons over a verified result instead of doing shaky arithmetic.
  const toolMessages = [];
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    const expr = extractExpression(lastUser.content);
    if (expr) {
      const result = calculatorTool.run({ expression: expr });
      if (result && result.ok) {
        toolMessages.push({
          role: 'system',
          content: 'Calculator tool result (authoritative): ' + expr + ' = '
            + result.value + '. Use this exact value.',
        });
      }
    }
  }

  const systemPrompt = buildSystemPrompt({
    userName: currentUserName(),
    memory: memoryForPrompt(currentEmail()),
    today: new Date().toISOString().slice(0, 10),
  });

  const { messages, droppedCount } = buildContext({
    systemPrompt,
    history,
    summary,
    contextSize: modelConfig.contextSize,
    maxOutputTokens: modelConfig.maxOutputTokens,
  });
  // Insert any tool results right after the system prompt.
  if (toolMessages.length) messages.splice(1, 0, ...toolMessages);

  const node = addAssistantMessage();
  let raw = '';
  let stopped = false;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    node.body.innerHTML = renderMarkdown(raw);
    wireCodeCopy(node.body);
    scrollToEnd();
  };

  try {
    for await (const delta of engine.streamResponse(messages)) {
      raw += delta;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    }
  } catch (error) {
    stopped = true;
    if (!raw) {
      node.body.innerHTML = renderMarkdown('_Generation was interrupted before any '
        + 'output. ' + (error && error.message ? escapeInline(error.message) : '') + '_');
    }
  }

  flush();
  raw = raw.trim();
  if (raw) {
    history.push({ role: 'assistant', content: raw });
    addControls(node, raw);
    persistTurn(userForPersist, raw);
  } else if (!stopped) {
    node.body.innerHTML = renderMarkdown('_The model returned an empty response. '
      + 'Try rephrasing, or regenerate._');
    addControls(node, '');
  }

  setGenerating(false);
  maybeSummarize(droppedCount);
}

function escapeInline(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* Best-effort server-side persistence of one completed turn to Google Sheets
   via /api/history. Fire-and-forget: a storage outage, or a deployment with
   no data sheet provisioned, must never disrupt the chat. The transcript
   itself always lives in `history`; this only mirrors it to the operator's
   Sheets database when one is configured. */
function persistTurn(userMsg, assistantMsg) {
  const messages = [];
  if (userMsg) messages.push({ role: 'user', content: userMsg });
  if (assistantMsg) messages.push({ role: 'assistant', content: assistantMsg });
  if (!messages.length) return;

  const firstTurn = !conversationId;
  if (!conversationId) {
    conversationId = 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  const firstUser = history.find((m) => m.role === 'user');
  const title = (firstUser ? firstUser.content : 'New chat').slice(0, 60);

  try {
    fetch('/api/history', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        isFirstTurn: firstTurn,
        title,
        messages,
        usage: {
          event: 'turn',
          model: modelConfig ? modelConfig.modelId : '',
          promptChars: userMsg ? userMsg.length : 0,
          completionChars: assistantMsg ? assistantMsg.length : 0,
        },
      }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* best effort — never block the UI */ }
}

/* Server fallback path: a real self-hosted runtime behind /api/chat. It
   returns a complete reply (no token streaming on this path), so show a
   typing indicator rather than faking a stream. */
async function serverGenerate() {
  setGenerating(true);
  const typing = addTyping();
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  try {
    const reply = await S.chat.send(lastUser ? lastUser.content : '', history);
    typing.remove();
    const node = addAssistantMessage();
    const raw = String(reply || '').trim();
    node.body.innerHTML = renderMarkdown(raw || '_The runtime returned an empty reply._');
    wireCodeCopy(node.body);
    if (raw) {
      history.push({ role: 'assistant', content: raw });
      persistTurn(lastUser ? lastUser.content : '', raw);
    }
    addControls(node, raw);
  } catch (error) {
    typing.remove();
    const node = addAssistantMessage();
    node.body.innerHTML = renderMarkdown('_Could not reach the model runtime: '
      + escapeInline((error && error.message) || 'request failed') + '_');
  } finally {
    setGenerating(false);
    scrollToEnd();
  }
}

/* Regenerate: drop the last assistant turn (transcript + DOM) and re-run
   generation for the most recent user message. */
async function regenerate() {
  if (generating) return;
  while (history.length && history[history.length - 1].role === 'assistant') {
    history.pop();
  }
  const bots = dom.thread.querySelectorAll('.msg:not(.msg-user)');
  if (bots.length) bots[bots.length - 1].remove();
  if (!history.some((m) => m.role === 'user')) return;

  if (mode === 'server') await serverGenerate();
  else await generate();
}

/* Fold trimmed-off older turns into a running summary so long conversations
   keep their thread of context without exceeding the window. Best-effort:
   a failed summary just means the older turns are gone from context. */
async function maybeSummarize(droppedCount) {
  if (mode !== 'webllm' || !modelLoaded) return;
  if (!droppedCount || droppedCount <= summarizedUpTo) return;
  const dropped = history.slice(0, droppedCount);
  try {
    const text = (summary ? 'Summary so far:\n' + summary + '\n\n' : '')
      + dropped.map((m) => m.role + ': ' + m.content).join('\n');
    const next = await engine.summarize(text);
    if (next) summary = next;
    summarizedUpTo = droppedCount;
  } catch { /* summary is best-effort */ }
}

/* ---------------- composer autosize ---------------- */
function autosize() {
  if (!dom.input) return;
  dom.input.style.height = 'auto';
  dom.input.style.height = Math.min(200, dom.input.scrollHeight) + 'px';
}

/* ---------------- memory panel ---------------- */
function openMemory() {
  if (!dom.memoryDialog) return;
  renderMemory();
  if (typeof dom.memoryDialog.showModal === 'function') dom.memoryDialog.showModal();
  else dom.memoryDialog.setAttribute('open', '');
}

function renderMemory() {
  const email = currentEmail();
  const state = getMemoryState(email);
  const listEl = $('memory-list');
  const toggle = $('memory-enabled');
  if (toggle) toggle.checked = state.enabled;
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!state.items.length) {
    listEl.appendChild(el('p', 'memory-empty',
      'No saved memory yet. Add a note the assistant should remember across chats.'));
  }
  for (const item of state.items) {
    const row = el('div', 'memory-item');
    row.appendChild(el('span', 'memory-text', item.text));
    const del = el('button', 'msg-ctl', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => { deleteMemory(email, item.id); renderMemory(); });
    row.appendChild(del);
    listEl.appendChild(row);
  }
}

/* ---------------- events ---------------- */
function wireEvents() {
  if (dom.form) {
    dom.form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(dom.input.value);
    });
  }
  if (dom.input) {
    dom.input.addEventListener('input', autosize);
    dom.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(dom.input.value);
      }
    });
  }
  if (dom.stop) {
    dom.stop.addEventListener('click', () => {
      if (generating && engine) engine.interrupt();
    });
  }
  if (dom.loadBtn) {
    dom.loadBtn.addEventListener('click', () => { ensureLoaded().catch(() => {}); });
  }
  if (dom.newChat) {
    dom.newChat.addEventListener('click', () => {
      if (generating && engine) engine.interrupt();
      history.length = 0;
      summary = '';
      summarizedUpTo = 0;
      conversationId = null;
      dom.thread.innerHTML = '';
      if (dom.intro) dom.intro.hidden = false;
      dom.input.focus();
    });
  }
  if (dom.memoryBtn) dom.memoryBtn.addEventListener('click', openMemory);

  // Suggestion chips (data-prompt) and memory dialog controls, delegated.
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-prompt]');
    if (chip) {
      send(chip.getAttribute('data-prompt'));
      return;
    }
    if (e.target.id === 'memory-add') {
      const input = $('memory-input');
      if (input && input.value.trim()) {
        addMemory(currentEmail(), input.value);
        input.value = '';
        renderMemory();
      }
    }
    if (e.target.id === 'memory-close' && dom.memoryDialog) dom.memoryDialog.close();
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'memory-enabled') {
      setMemoryEnabled(currentEmail(), e.target.checked);
    }
  });
}
