/* ============================================================
   POST /api/chat   { message, history }

   The protected chatbot endpoint. This is the ONLY path from the browser
   to the engine:

     browser → session cookie → identity check → whitelist check
             → (this route) → provider → SaveHatke AI engine

   An unauthorized visitor cannot skip the login page and call the engine
   directly: without a valid session cookie that still maps to an active
   whitelist row, this returns 401/403 before anything is classified.

   Which engine answers is decided by the provider layer, not here. The
   browser is told nothing about it: the response is always { reply, source }
   and the frontend only ever reads `reply`. Swapping engines — including
   going back to an upstream model — therefore requires no frontend change.

   When the custom engine is switched off and no upstream endpoint is
   configured, the built-in preview engine answers instead of failing, so
   the whole authorization flow stays exercisable end-to-end. Credentials,
   prompts and weights never leave the server.
   ============================================================ */

import { authorizeRequest } from '../lib/authorize.js';
import { getConfig } from '../lib/config.js';
import { fail, json, readJson, requireMethod, sameOrigin } from '../lib/http.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { previewReply } from '../lib/preview.js';
import { getAIConfig } from '../server/services/ai/config.js';
import { generateReply } from '../server/services/ai/provider.js';

export const config = { runtime: 'nodejs' };

/** Guardrails so one request cannot burn the model budget or the event loop. */
const MAX_HISTORY_TURNS = 40;
const MAX_TOTAL_HISTORY_CHARS = 24000;
const RATE_LIMIT = { limit: 30, windowSeconds: 60 };

/** Trims and validates the conversation history sent by the browser. */
function sanitizeHistory(raw, maxMessageChars) {
  if (!Array.isArray(raw)) return [];

  const cleaned = [];
  for (const turn of raw.slice(-MAX_HISTORY_TURNS)) {
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content =
      typeof turn.content === 'string' ? turn.content.slice(0, maxMessageChars).trim() : '';
    if (!content) continue;
    cleaned.push({ role, content });
  }

  // Cap the total prompt size, dropping the oldest turns first.
  let total = cleaned.reduce((sum, turn) => sum + turn.content.length, 0);
  while (total > MAX_TOTAL_HISTORY_CHARS && cleaned.length > 1) {
    total -= cleaned[0].content.length;
    cleaned.shift();
  }

  return cleaned;
}

export default async function handler(req) {
  const wrongMethod = requireMethod(req, 'POST');
  if (wrongMethod) return wrongMethod;

  if (!sameOrigin(req)) {
    return fail(403, 'bad_origin', 'Request origin was rejected.');
  }

  // 1. Identity + authorization. Nothing upstream happens until this passes.
  const auth = await authorizeRequest(req);
  if (!auth.ok) return auth.response;

  const config = getConfig();
  // The per-message ceiling is AI_MAX_MESSAGE_LENGTH, so the engine's
  // documented limit and the route's enforcement cannot drift apart.
  const aiConfig = getAIConfig();
  const maxMessageChars = aiConfig.maxMessageLength;

  // 2. Best-effort abuse limiting, keyed per authenticated user.
  const { allowed, retryAfterSeconds } = checkRateLimit(`chat:${auth.user.email}`, RATE_LIMIT);
  if (!allowed) {
    return json(
      { error: 'Too many messages. Please slow down.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
    );
  }

  // 3. Validate input.
  const { message, history, conversationId: rawConversationId } = await readJson(req);
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return fail(400, 'empty_message', 'Please enter a message.');
  }
  if (text.length > maxMessageChars) {
    return fail(400, 'message_too_long', `Messages are limited to ${maxMessageChars} characters.`);
  }

  const conversation = sanitizeHistory(history, maxMessageChars);
  // Trust our own validated copy of the latest message over whatever the
  // client put at the end of the history array.
  const messages = conversation.length && conversation[conversation.length - 1].role === 'user' &&
    conversation[conversation.length - 1].content === text
    ? conversation
    : [...conversation, { role: 'user', content: text }];

  // Conversation scope for short-term context. It is namespaced by user
  // inside the context manager, so a shared default cannot leak between
  // accounts.
  const conversationId =
    typeof rawConversationId === 'string' && rawConversationId.trim()
      ? rawConversationId.trim().slice(0, 64)
      : 'main';

  // 4. Answer.
  const upstreamReady = Boolean(config.modelApiUrl);

  // Custom engine off and no upstream endpoint: keep the built-in preview so
  // the protected flow still works end-to-end.
  if (!aiConfig.enabled && !upstreamReady) {
    return json({ reply: previewReply(text, messages), source: 'preview' });
  }

  try {
    const result = await generateReply(
      {
        message: text,
        history: messages,
        user: auth.user,
        conversationId,
        // The caller's own credentials are forwarded so live-data tools act
        // as this user. Identity is never taken from the request body.
        authHeaders: {
          cookie: req.headers.get('cookie') || '',
          authorization: req.headers.get('authorization') || '',
        },
      },
      config
    );
    return json({ reply: result.reply, source: result.source });
  } catch (error) {
    // Log the detail, return something friendly — never leak provider
    // responses or keys to the browser.
    console.error('[savehatke] chat failed:', error.message);
    return fail(
      502,
      'model_unavailable',
      'SaveHatke AI could not reach the model right now. Please try again in a moment.'
    );
  }
}