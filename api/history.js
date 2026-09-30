/* ============================================================
   /api/history   (GET | POST)

   Server-side persistence for the authorized user's own conversations,
   backed by Google Sheets (lib/googleSheets.js). This is the only path the
   browser uses to store or read chat history; the browser never touches
   Sheets directly, and every row is scoped to the verified session email so
   one account can never read another's transcripts.

     POST  { conversationId?, isFirstTurn?, title?, messages:[{role,content}], usage? }
           → { ok, persisted, conversationId }
     GET   ?conversationId=…  → { ok, messages:[…] }        (that conversation)
     GET                      → { ok, conversations:[…] }   (this user's list)

   Fail-safe: when the data sheet is not provisioned the endpoint still
   returns 200 with persisted:false, so the chat UI's best-effort calls never
   surface an error. Credentials never leave the server.
   ============================================================ */

import { authorizeRequest } from '../lib/authorize.js';
import { fail, json, readJson, sameOrigin } from '../lib/http.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import {
  isConfigured,
  createConversation,
  saveMessage,
  getMessages,
  getConversations,
  saveUsage,
} from '../lib/googleSheets.js';

export const config = { runtime: 'nodejs' };

const RATE_LIMIT = { limit: 60, windowSeconds: 60 };
const MAX_MESSAGES_PER_CALL = 2;
const MAX_CONTENT_CHARS = 24000;

export default async function handler(req) {
  if (!sameOrigin(req)) return fail(403, 'bad_origin', 'Request origin was rejected.');

  // Identity + whitelist, exactly like /api/chat. Nothing persists for an
  // unauthorized caller, and the email is taken from the verified session.
  const auth = await authorizeRequest(req);
  if (!auth.ok) return auth.response;
  const email = auth.user.email;

  /* -------- read -------- */
  if (req.method === 'GET') {
    if (!isConfigured()) {
      return json({ ok: true, configured: false, conversations: [], messages: [] });
    }
    const url = new URL(req.url);
    const conversationId = (url.searchParams.get('conversationId') || '').trim().slice(0, 64);
    if (conversationId) {
      const messages = await getMessages(conversationId, email);
      return json({ ok: true, configured: true, conversationId, messages });
    }
    const conversations = await getConversations(email);
    return json({ ok: true, configured: true, conversations });
  }

  /* -------- write -------- */
  if (req.method === 'POST') {
    const { allowed, retryAfterSeconds } = checkRateLimit(`history:${email}`, RATE_LIMIT);
    if (!allowed) {
      return json(
        { ok: false, code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
      );
    }

    // Storage not provisioned yet: acknowledge without persisting so the
    // client's fire-and-forget call is a clean no-op rather than an error.
    if (!isConfigured()) {
      return json({ ok: true, persisted: false, reason: 'storage_unconfigured' });
    }

    const body = await readJson(req);
    let conversationId =
      typeof body.conversationId === 'string' && body.conversationId.trim()
        ? body.conversationId.trim().slice(0, 64)
        : '';
    const title = typeof body.title === 'string' && body.title.trim()
      ? body.title.slice(0, 200)
      : 'New chat';

    // Validate + bound the messages. Only the last user/assistant pair per call.
    const raw = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES_PER_CALL) : [];
    const messages = [];
    for (const m of raw) {
      const role = m && (m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null);
      const content = m && typeof m.content === 'string' ? m.content.slice(0, MAX_CONTENT_CHARS) : '';
      if (role && content.trim()) messages.push({ role, content });
    }
    if (!messages.length) return fail(400, 'empty', 'Nothing to persist.');

    // Create the Conversations row on the first turn (or when the client sent
    // no id at all). The client owns the id so later turns append to it.
    if (!conversationId || body.isFirstTurn) {
      const created = await createConversation({ email, title, ...(conversationId ? { id: conversationId } : {}) });
      conversationId = created.id;
    }

    const messageIds = [];
    for (const m of messages) {
      const res = await saveMessage({ conversationId, email, role: m.role, content: m.content });
      if (res.id) messageIds.push(res.id);
    }

    // Best-effort usage telemetry; a failure here must not fail the request.
    if (body.usage && typeof body.usage === 'object') {
      await saveUsage({
        email,
        conversationId,
        event: String(body.usage.event || 'turn').slice(0, 40),
        model: String(body.usage.model || '').slice(0, 80),
        promptChars: Number(body.usage.promptChars) || '',
        completionChars: Number(body.usage.completionChars) || '',
        ms: Number(body.usage.ms) || '',
      });
    }

    return json({ ok: true, persisted: true, conversationId, messageIds });
  }

  return fail(405, 'method_not_allowed', 'Use GET or POST.');
}
