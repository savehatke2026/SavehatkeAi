/* ============================================================
   SaveHatke AI — conversation context.

   Layer 4 of the engine. Gives the assistant just enough short-term
   memory to resolve follow-ups:

     User:  "Show me Nike coupons."
     AI:    "Here are 3 live listings …"
     User:  "Which one expires first?"
                     ^ "which one" = the Nike results just returned

   Design constraints, all deliberate:

   * BOUNDED. A fixed number of turns, a TTL, and a hard cap on the number
     of tracked conversations. Nothing grows without limit.

   * SCOPED PER USER. The storage key is derived from the authenticated
     user id AND the conversation id, so one caller can never read or
     influence another caller's context even if they guess a conversation
     id. The conversation id itself is validated, not trusted.

   * NOT THE ONLY SOURCE OF TRUTH. This is an in-memory cache on a
     serverless runtime, so it disappears on a cold start. The engine
     therefore also rebuilds context from the conversation history the
     client already sends, which is the durable input. Memory is an
     optimisation, never a requirement.

   * NO PERMANENT PERSONAL MEMORY. Nothing is persisted, nothing is
     profiled, and sensitive shapes are stripped before storing.

   * NOT AN AUTHORIZATION INPUT. Nothing here is used to decide what a
     user may see. Identity and permissions come from the session, always.
   ============================================================ */

import { getAIConfig } from './config.js';

/** @type {Map<string, object>} */
const conversations = new Map();

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/* Shapes that must never be retained, even transiently. */
const SENSITIVE_IN_TEXT = [
  /\bsh_session=[^\s;]+/gi,
  /\bsh_oauth=[^\s;]+/gi,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bsh_live_[A-Za-z0-9]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

/** Strips anything sensitive before it is remembered. */
export function sanitizeForContext(value, maxLength = 500) {
  let out = typeof value === 'string' ? value : String(value ?? '');
  for (const re of SENSITIVE_IN_TEXT) out = out.replace(re, '[redacted]');
  return out.slice(0, maxLength);
}

/** Validates a client-supplied conversation id. */
export function normalizeConversationId(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_ID.test(value) ? value : null;
}

/**
 * The storage key. Mixing in the user id is what makes cross-user reads
 * impossible: the same conversation id from two accounts lands in two
 * different buckets.
 */
function storageKey(userId, conversationId) {
  return `${sanitizeForContext(userId, 80)}::${conversationId}`;
}

function sweep(now, config) {
  if (conversations.size < config.contextMaxConversations) return;
  for (const [key, entry] of conversations) {
    if (now - entry.updatedAt > config.contextTtlSeconds * 1000) conversations.delete(key);
  }
  // Still too big after TTL eviction: drop the oldest entries.
  if (conversations.size >= config.contextMaxConversations) {
    const ordered = [...conversations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const excess = conversations.size - config.contextMaxConversations + 1;
    for (let i = 0; i < excess; i++) conversations.delete(ordered[i][0]);
  }
}

function blankContext() {
  return {
    updatedAt: Date.now(),
    lastIntent: null,
    lastEntities: {},
    // The most recent successful lookup, so "which one" / "that one" / "and
    // the cheaper ones" can resolve against it.
    lastResult: null,
    lastTool: null,
    lastBrand: null,
    lastCategory: null,
    turnCount: 0,
  };
}

/**
 * Loads the stored context, or null when there is none (cold start, expiry
 * or a new conversation).
 */
export function getContext(userId, conversationId) {
  const config = getAIConfig();
  const now = Date.now();
  sweep(now, config);

  const key = storageKey(userId, conversationId);
  const entry = conversations.get(key);
  if (!entry) return null;
  if (now - entry.updatedAt > config.contextTtlSeconds * 1000) {
    conversations.delete(key);
    return null;
  }
  return entry;
}

/**
 * Rebuilds a usable context from the client-supplied history when the
 * in-memory entry is gone. Only the previous user turn is re-read, and the
 * caller supplies the classification for it, so this stays cheap.
 */
export function rebuildFromHistory(history, classifyPrevious) {
  const context = blankContext();
  const userTurns = (history || []).filter((turn) => turn && turn.role === 'user');
  context.turnCount = userTurns.length;
  if (!userTurns.length) return context;

  const previous = userTurns[userTurns.length - 1];
  if (typeof classifyPrevious === 'function') {
    try {
      const classification = classifyPrevious(previous.content);
      if (classification && classification.intent) {
        context.lastIntent = classification.intent;
        context.lastEntities = classification.entities || {};
        context.lastBrand = context.lastEntities.brand || null;
        context.lastCategory = context.lastEntities.category || null;
      }
    } catch {
      // A failed rebuild just means less context, never a failed request.
    }
  }
  return context;
}

/**
 * Writes the state for this turn.
 *
 * @param {string} userId
 * @param {string} conversationId
 * @param {{intent?:string, entities?:object, tool?:string, result?:object, history?:object[]}} update
 */
export function updateContext(userId, conversationId, update = {}) {
  const config = getAIConfig();
  const key = storageKey(userId, conversationId);
  const now = Date.now();
  sweep(now, config);

  const entry = conversations.get(key) || blankContext();
  entry.updatedAt = now;
  entry.turnCount = (update.history || []).filter((t) => t && t.role === 'user').length || entry.turnCount + 1;

  if (update.intent) entry.lastIntent = update.intent;

  // Entity carry-over: a follow-up that names no brand inherits the brand
  // from the previous turn. This is what makes "Under 200?" work after
  // "Any Nykaa coupons?".
  const entities = update.entities || {};
  const merged = { ...entry.lastEntities };
  for (const [key2, value] of Object.entries(entities)) {
    if (key2 === 'searchQuery') continue;          // always regenerate
    if (value === null || value === undefined) continue;
    merged[key2] = value;
  }
  entry.lastEntities = merged;
  entry.lastBrand = merged.brand || null;
  entry.lastCategory = merged.category || null;

  if (update.tool) entry.lastTool = update.tool;
  if (update.result) {
    // Only a bounded, non-sensitive projection is retained.
    entry.lastResult = {
      tool: update.tool || null,
      at: now,
      count: Array.isArray(update.result.items) ? update.result.items.length : undefined,
      items: Array.isArray(update.result.items)
        ? update.result.items.slice(0, 10).map((item) => ({
            id: item.id ? sanitizeForContext(item.id, 40) : undefined,
            brand: item.brand ? sanitizeForContext(item.brand, 40) : undefined,
            value: item.value !== undefined ? item.value : undefined,
            expiry: item.expiry ? sanitizeForContext(item.expiry, 32) : undefined,
            status: item.status ? sanitizeForContext(item.status, 32) : undefined,
          }))
        : undefined,
      summary: update.result.summary ? sanitizeForContext(update.result.summary, 240) : undefined,
    };
  }

  conversations.set(key, entry);
  return entry;
}

/**
 * Entities for this turn: the fresh extraction, back-filled from the
 * previous turn where the user relied on context.
 *
 * @param {object} currentEntities
 * @param {object|null} context
 * @param {string[]} inheritKeys
 */
export function resolveEntities(currentEntities, context, inheritKeys = ['brand', 'category']) {
  const resolved = { ...(currentEntities || {}) };
  if (!context || !context.lastEntities) return resolved;
  for (const key of inheritKeys) {
    if (resolved[key] === undefined && context.lastEntities[key] !== undefined) {
      resolved[key] = context.lastEntities[key];
      resolved.inherited = true;
    }
  }
  return resolved;
}

/** Whether the message is a follow-up that leans on the previous result. */
export function refersToPreviousResult(message) {
  return /\b(which one|which of them|that one|this one|the first one|the last one|the second one|the cheapest|the earliest|it|they|them|those|these|and the|what about|how about|uske|unme|inko)\b/i
    .test(String(message || ''));
}

/** Test and maintenance helper. */
export function resetContexts() {
  conversations.clear();
}

export function contextStats() {
  return { tracked: conversations.size };
}
