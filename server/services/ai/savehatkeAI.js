/* ============================================================
   SaveHatke AI — the engine.

   The orchestrator. One turn, start to finish:

     message
       ↓ securityEngine.inspectInput      refuse disclosure attempts first
       ↓ contextManager                   recall the last turn if we can
       ↓ intentEngine                     intent + entities + confidence
       ↓ toolRouter                       live data, session-scoped identity
       ↓ knowledgeEngine                  policy and documentation answers
       ↓ responseEngine                   compose from evidence only
       ↓ securityEngine.inspectOutput     scrub anything that must not leave
       ↓ reply

   Two invariants worth stating plainly:

   * The engine is NOT the authority. It never asserts a fact about the
     user's account that a backend call did not return. When the backend is
     unreachable it says so instead of estimating.

   * A blocked request never reaches the intent layer. Refusing before
     classification means an injection attempt cannot influence which tool
     would have run, which is the whole point.

   This module is pure orchestration — no fs, no network of its own, no
   database. That keeps it testable and keeps the serverless surface small.
   ============================================================ */

import { getAIConfig, aiConfigWarnings } from './config.js';
import { loadModel } from './modelLoader.js';
import { inspectInput, inspectOutput, scrubForLog } from './securityEngine.js';
import { classifyIntent, isActionable, UNKNOWN_INTENT } from './intentEngine.js';
import {
  getContext, rebuildFromHistory, updateContext, resolveEntities, normalizeConversationId,
} from './contextManager.js';
import { retrieveKnowledge } from './knowledgeEngine.js';
import { runTool, toolForIntent } from './toolRouter.js';
import { composeResponse, refusalFor, internalErrorResponse } from './responseEngine.js';

/** Tool result keys that make a useful context to carry into the next turn. */
const CONTEXT_CARRYING_TOOLS = new Set(['search_coupons', 'check_submissions', 'check_purchases', 'check_support_tickets']);

/** Intents whose entities are worth inheriting on a follow-up. */
const ENTITY_INHERIT_KEYS = ['brand', 'category', 'maxPrice', 'minPrice', 'couponId'];

/* One structured line per turn: metadata only. Never a message body, an
   entity value, a coupon code, a token or a payout detail. */
function logTurn(entry, config) {
  if (config.logLevel === 'silent') return;
  console.log(`[savehatke][ai] ${JSON.stringify(entry)}`);
}

/* Misconfiguration is reported once per process, on the first turn.
   Doing it here rather than in an entry point means the serverless cold
   start and the dev server both get it, and neither has to remember to.
   A warning that is never emitted is indistinguishable from no warning at
   all, which is how the unset-API-URL case went unnoticed. */
let configWarningsEmitted = false;

function warnAboutConfig(config) {
  if (configWarningsEmitted) return;
  configWarningsEmitted = true;
  for (const warning of aiConfigWarnings(config)) {
    console.warn(`[savehatke][ai] config: ${warning}`);
  }
}

/** Test hook: lets a suite observe the first-turn warning more than once. */
export function resetConfigWarnings() {
  configWarningsEmitted = false;
}

/**
 * Runs one turn of the engine.
 *
 * @param {{
 *   message:string, history?:object[], user:{email:string,name:string,sub?:string},
 *   conversationId?:string, authHeaders?:{cookie?:string, authorization?:string},
 *   bundle?:object
 * }} input
 * @returns {Promise<{
 *   reply:string, source:string, blocked:boolean, intent:string, confidence:number,
 *   entities:object, toolsUsed:string[], usedKnowledge:boolean, degraded:boolean,
 *   meta:object
 * }>}
 */
export async function runSaveHatkeAI(input) {
  const startedAt = Date.now();
  const config = getAIConfig();
  warnAboutConfig(config);
  const bundle = input.bundle || loadModel();
  const message = String(input.message || '');
  const history = Array.isArray(input.history) ? input.history : [];
  const conversationId = normalizeConversationId(input.conversationId) || 'default';
  const userId = input.user?.sub || input.user?.email || 'anonymous';

  const meta = {
    provider: 'SAVEHATKE_AI',
    degraded: bundle.degraded,
    reason: bundle.reason || null,
    toolsUsed: [],
    latencyMs: 0,
  };

  /* ---- 0. Master switch ---- */
  if (!config.enabled) {
    return {
      reply: 'SaveHatke AI is temporarily unavailable. Please try again shortly.',
      source: 'savehatke-ai-disabled',
      blocked: false,
      intent: UNKNOWN_INTENT,
      confidence: 0,
      entities: {},
      toolsUsed: [],
      usedKnowledge: false,
      degraded: true,
      meta,
    };
  }

  /* ---- 1. Security, before anything else can be influenced ---- */
  // The session email is passed so the engine can tell "my data" from
  // "someone else's data". It comes from the verified session, never from
  // the message, so it cannot be spoofed by what the user types.
  const inputCheck = inspectInput(message, { userEmail: input.user?.email });
  if (inputCheck.blocked) {
    const reply = refusalFor(inputCheck.category, bundle);
    logTurn({
      t: new Date().toISOString(),
      conversationId,
      blocked: true,
      category: inputCheck.category,
      intent: null,
      confidence: 0,
      tool: null,
      success: false,
      latencyMs: Date.now() - startedAt,
    }, config);
    return {
      reply,
      source: 'savehatke-ai',
      blocked: true,
      intent: UNKNOWN_INTENT,
      confidence: 0,
      entities: {},
      toolsUsed: [],
      usedKnowledge: false,
      degraded: bundle.degraded,
      meta: { ...meta, blockedCategory: inputCheck.category },
    };
  }

  /* ---- 2. Context: in-memory first, rebuilt from history on a cold start ---- */
  const stored = getContext(userId, conversationId);
  const context = stored || rebuildFromHistory(history, (previousMessage) => {
    // Only the immediately previous user turn is re-read, so this stays cheap.
    return classifyIntent(previousMessage, { bundle });
  });

  /* ---- 3. Intent + entities ---- */
  const classification = classifyIntent(message, { bundle });

  // A follow-up like "Under 200?" inherits the brand from the previous turn.
  if (context && classification.intent !== UNKNOWN_INTENT) {
    const resolved = resolveEntities(classification.entities, context, ENTITY_INHERIT_KEYS);
    if (resolved.inherited) {
      delete resolved.inherited;
      classification.entities = resolved;
    }
  }

  /* ---- 4. Tools ---- */
  const toolsUsed = [];
  let toolResult = null;

  const actionable = isActionable(classification, config);
  if (actionable && config.toolRounds > 0) {
    const toolName = toolForIntent(classification.intent, bundle);
    if (toolName) {
      // The intent's own tool first; the loop exists so a future multi-step
      // intent can chain (AI_TOOL_ROUNDS) without restructuring this.
      const queue = [toolName];
      for (let round = 0; round < config.toolRounds && queue.length; round++) {
        const current = queue.shift();
        const args = buildToolArguments(classification, context);
        const result = await runTool(current, args, {
          user: input.user,
          authHeaders: input.authHeaders,
          bundle,
          conversationId,
        });
        toolsUsed.push(current);
        toolResult = result;
        if (!result.ok) break;
      }
    }
  }

  /* ---- 5. Knowledge ---- */
  // Always retrieved: it backs the answer when no tool ran, and it is the
  // honest fallback when a policy question's live source is unavailable.
  const knowledgeHits = retrieveKnowledge({
    message,
    intent: classification.intent,
    entities: classification.entities,
    bundle,
  });

  /* ---- 6. Compose ---- */
  let composed;
  try {
    composed = composeResponse({
      classification,
      toolResult,
      knowledgeHits,
      context,
      bundle,
      conversationId,
      user: input.user,
      turn: history.filter((t) => t && t.role === 'user').length,
    });
  } catch (error) {
    composed = {
      text: internalErrorResponse(bundle),
      kind: 'error',
      usedTool: false,
      usedKnowledge: false,
    };
    meta.composeError = scrubForLog(error?.message || 'unknown');
  }

  /* ---- 7. Output security ---- */
  // Coupon codes are never allowed through chat: the purchase flow is the
  // only place that releases them, and it does so outside this engine.
  const outputCheck = inspectOutput(composed.text, { allowCouponCodes: false });
  let reply = outputCheck.safe;

  if (outputCheck.redacted && !reply) {
    // A hard failure (internal material leaked into the copy). Replace the
    // whole response rather than showing a partially-scrubbed one.
    reply = internalErrorResponse(bundle);
    meta.outputReplaced = outputCheck.categories;
  } else if (outputCheck.redacted) {
    meta.outputRedacted = outputCheck.categories;
  }

  if (!reply || !reply.trim()) {
    reply = internalErrorResponse(bundle);
    meta.emptyResponse = true;
  }

  /* ---- 8. Remember, then answer ---- */
  updateContext(userId, conversationId, {
    intent: classification.intent,
    entities: classification.entities,
    tool: toolsUsed[toolsUsed.length - 1] || null,
    result: toolResult?.ok && CONTEXT_CARRYING_TOOLS.has(toolResult.tool)
      ? toolResult.data
      : null,
    history,
  });

  meta.latencyMs = Date.now() - startedAt;

  logTurn({
    t: new Date().toISOString(),
    conversationId,
    blocked: false,
    intent: classification.intent,
    confidence: classification.confidence,
    rule: classification.rule?.matched || false,
    tool: toolsUsed[toolsUsed.length - 1] || null,
    toolOk: toolResult ? toolResult.ok : null,
    toolReason: toolResult && !toolResult.ok ? toolResult.reason : null,
    knowledge: knowledgeHits.length,
    kind: composed.kind,
    redacted: outputCheck.redacted,
    degraded: bundle.degraded,
    success: true,
    latencyMs: meta.latencyMs,
  }, config);

  return {
    reply,
    source: 'savehatke-ai',
    blocked: false,
    intent: classification.intent,
    confidence: classification.confidence,
    entities: classification.entities,
    toolsUsed,
    usedKnowledge: composed.usedKnowledge,
    degraded: bundle.degraded,
    meta,
  };
}

/**
 * Builds the tool arguments from the classification.
 *
 * Identity is deliberately absent: it is supplied by the router from the
 * session context, so there is nothing here for a caller to tamper with.
 */
function buildToolArguments(classification, context) {
  const entities = classification.entities || {};
  const args = {};

  if (entities.brand) args.brand = entities.brand;
  if (entities.category) args.category = entities.category;
  if (typeof entities.maxPrice === 'number') args.maxPrice = entities.maxPrice;
  if (typeof entities.minPrice === 'number') args.minPrice = entities.minPrice;
  if (entities.expiresBefore) args.expiresBefore = entities.expiresBefore;
  if (entities.couponId) args.couponId = entities.couponId;
  if (entities.ticketId) args.ticketId = entities.ticketId;

  // The search query is built from what the user actually asked, not from a
  // template, so a brand the lexicon does not know still reaches the API.
  if (classification.intent === 'SEARCH_COUPON' || classification.intent === 'FAQ') {
    const query = entities.searchQuery || '';
    if (query) args.query = query;
  }

  // A follow-up that named no brand should search what the previous turn
  // searched, not everything.
  if (classification.intent === 'SEARCH_COUPON' && !args.brand && context?.lastEntities?.brand) {
    args.brand = context.lastEntities.brand;
  }

  return args;
}

export { classifyIntent };
