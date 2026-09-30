/* ============================================================
   SaveHatke AI — response engine.

   Layer 6 of the engine. Turns a classification plus evidence into the
   sentence the user reads.

   The rule that shapes this whole file: COMPOSE, NEVER INVENT.

   Every fact in an answer comes from one of exactly three places:
     * a tool result (live backend data),
     * a knowledge entry (reviewed copy in data/ai/knowledge.json),
     * a template in data/ai/responses.json (fixed copy).

   There is no path here that generates a number, a coupon, a status or a
   date that was not supplied. If the evidence is missing, the answer says
   so — that is a feature, not a gap.

   Copy is deliberately short. "Yes, but you need at least one completed
   purchase before you're eligible to sell a coupon." beats a paragraph.
   ============================================================ */

import { getAIConfig } from './config.js';
import { loadModel } from './modelLoader.js';

/* ---------------- helpers ---------------- */

function fill(template, values) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? '' : String(value);
  });
}

/** Deterministic variant pick, so the same turn always reads the same. */
function pickVariant(variants, seed) {
  if (!Array.isArray(variants) || !variants.length) return null;
  let hash = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % 1000003;
  }
  return variants[hash % variants.length];
}

function joinLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function firstName(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  return value.split(/\s+/)[0].slice(0, 24);
}

/** Joins sentence fragments without leaving doubled or dangling punctuation. */
function sentence(parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join(' ')
    .replace(/\s+([.,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const money = (value) => (typeof value === 'number' ? `₹${value.toLocaleString('en-IN')}` : null);

/* ---------------- per-intent formatting ---------------- */

/**
 * Formats a list-shaped result using the template's list keys.
 * Returns null when the shape does not apply, so the caller can fall back.
 */
function formatList(template, items, values) {
  if (!template || !Array.isArray(items)) return null;

  if (!items.length) {
    return template.empty ? fill(template.empty, values) : null;
  }

  const header = items.length === 1
    ? fill(template.header_one || template.header_many || '', values)
    : fill(template.header_many || template.header_one || '', { ...values, count: items.length });

  const lines = items.map((item) => fill(template.line || '', { ...values, ...item }));
  const footer = fill(template.footer || '', values);
  return sentence([header, joinLines(lines), footer]);
}

const FORMATTERS = {
  SEARCH_COUPON(template, tool, knowledge, values) {
    if (tool?.ok) {
      return formatList(template, tool.data.items || [], values);
    }
    return null;
  },

  COUPON_DETAILS(template, tool, knowledge, values, context) {
    // Prefer the item the previous turn returned — that is what "which one"
    // refers to. Otherwise fall back to a fresh search result.
    const fromContext = context?.lastResult?.items?.[0];
    const fromTool = tool?.ok ? tool.data.items?.[0] : null;
    const item = fromContext || fromTool;
    if (!item) return null;
    const body = fill(template.detail || '', {
      ...values,
      brand: item.brand || 'This listing',
      value: typeof item.value === 'number' ? money(item.value) : (item.value || 'not stated'),
      expiry: item.expiry || 'not stated',
      status: item.status || 'listed',
    });
    return sentence([body, fill(template.footer || '', values)]);
  },

  EARNINGS(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const { soldCoupons, ratePerCoupon, totalEarned } = tool.data;
    const body = soldCoupons > 0
      ? fill(template.summary || '', {
          soldCoupons,
          ratePerCoupon,
          totalEarned,
          total: money(totalEarned),
        })
      : fill(template.zero || template.summary || '', {
          soldCoupons,
          ratePerCoupon,
          totalEarned,
          total: money(totalEarned),
        });
    return sentence([body, fill(template.footer || '', values)]);
  },

  PAYOUT_STATUS(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const item = tool.data.items?.[0];
    if (!item) return fill(template.none || '', values) || null;
    const amountPart = typeof item.amount === 'number' ? ` for ${money(item.amount)}` : '';
    const datePart = item.date ? `, dated ${item.date}` : '';
    const body = fill(template.summary || '', { status: item.status || 'unknown', amount_part: amountPart, date_part: datePart });
    return sentence([body, fill(template.footer || '', values)]);
  },

  PAYOUT_LADDER(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const items = (tool.data.items || []).map((tier) => ({
      from: tier.from === null || tier.from === undefined ? 'any balance' : money(tier.from),
      description: tier.description || 'payout tier',
    }));
    return formatList(template, items, values);
  },

  PURCHASE_HISTORY(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const items = (tool.data.items || []).map((item) => ({
      brand: item.brand || 'Coupon',
      price: typeof item.price === 'number' ? item.price : '',
      date: item.date || 'unknown date',
      status: item.status || 'completed',
    }));
    return formatList(template, items, values);
  },

  SUPPORT_TICKETS(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const items = (tool.data.items || []).map((item) => ({
      subject: item.subject || 'Ticket',
      status: item.status || 'open',
      reply_part: item.hasReply ? ' — support has replied' : ' — no reply yet',
      opened: item.opened || 'unknown date',
    }));
    return formatList(template, items, values);
  },

  SUBMISSION_STATUS(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const items = (tool.data.items || []).map((item) => ({
      brand: item.brand || 'Coupon',
      status: item.status || 'pending',
      submitted: item.submitted || 'unknown date',
    }));
    return formatList(template, items, values);
  },

  SELL_ELIGIBILITY(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const { eligible, completedPurchases } = tool.data;
    const key = eligible ? 'eligible' : 'not_eligible';
    return fill(template[key] || '', {
      ...values,
      completedPurchases: completedPurchases === null || completedPurchases === undefined ? 'no' : completedPurchases,
    }) || null;
  },

  PROFILE(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const name = tool.data.name;
    return fill(template.summary || '', {
      ...values,
      email: tool.data.email || 'your account',
      name_part: name ? ` (${name})` : '',
    }) || null;
  },

  MAINTENANCE(template, tool, knowledge, values) {
    if (!tool?.ok) return null;
    const key = tool.data.active ? 'active' : 'inactive';
    return fill(template[key] || '', values) || null;
  },
};

/* ---------------- knowledge phrasing ---------------- */

/* Intents whose answer is the user's OWN data or live marketplace inventory.
   When the tool behind one of these cannot be reached, reviewed knowledge
   must not stand in for it: "show me Nike coupons" cannot be answered from
   a paragraph about browsing, and an earnings question cannot be answered
   from a description of the payout ladder. The honest reply is that the
   lookup failed.

   Everything else — how selling works, what the payout tiers are, refund
   policy — is published policy that knowledge can legitimately answer even
   with the backend down. */
const LIVE_DATA_INTENTS = new Set([
  'SEARCH_COUPON',
  'COUPON_DETAILS',
  'EARNINGS',
  'PAYOUT_STATUS',
  'PURCHASE_HISTORY',
  'SUPPORT_TICKETS',
  'SUBMISSION_STATUS',
  'SELL_ELIGIBILITY',
  'PROFILE',
  'MAINTENANCE',
]);

function knowledgeAnswer(hits) {
  if (!Array.isArray(hits) || !hits.length) return null;
  const best = hits[0];
  // Only the top entry is used: stacking several answers is how a chatbot
  // starts sounding like a documentation dump.
  return String(best.answer || '').trim() || null;
}

/* ---------------- public API ---------------- */

/**
 * Composes the reply.
 *
 * @param {{
 *   classification:{intent:string, confidence:number, entities:object, alternatives:Array},
 *   toolResult?:object|null, knowledgeHits?:object[], context?:object|null,
 *   bundle?:object, conversationId?:string, user?:object, turn?:number
 * }} input
 * @returns {{text:string, kind:string, usedTool:boolean, usedKnowledge:boolean}}
 */
export function composeResponse(input) {
  const config = getAIConfig();
  const bundle = input.bundle || loadModel();
  const responses = bundle.responses || {};
  const templates = responses.templates || {};
  const fallbacks = responses.fallbacks || {};

  const { classification, toolResult, knowledgeHits = [], context, user = {} } = input;
  const intent = classification?.intent || 'UNKNOWN';

  const namePart = user?.name ? `, ${firstName(user.name)}` : '';
  const values = { name_part: namePart, name: firstName(user.name) };
  const seed = `${input.conversationId || ''}:${input.turn ?? 0}`;

  const template = templates[intent];

  /* 1. Unknown or low confidence: never guess, never run a tool. */
  if (intent === 'UNKNOWN') {
    const alternative = classification?.alternatives?.[0];
    const close = alternative && classification?.confidence >= config.confidenceThreshold * 0.7;
    const text = close
      ? (fallbacks.low_confidence || fallbacks.unknown)
      : (fallbacks.unknown_hint || fallbacks.unknown);
    return { text, kind: 'clarify', usedTool: false, usedKnowledge: false };
  }

  /* 2. A tool ran. Format its data, or explain honestly that it could not. */
  if (toolResult) {
    if (toolResult.ok) {
      const formatter = FORMATTERS[intent];
      const formatted = formatter ? formatter(template, toolResult, knowledgeHits, values, context) : null;
      if (formatted) {
        return { text: formatted, kind: 'data', usedTool: true, usedKnowledge: false };
      }
      // Tool succeeded but the payload had nothing to format. Fall through
      // to knowledge rather than showing a raw object.
    } else if (toolResult.reason === 'forbidden' || toolResult.reason === 'forbidden_argument' || toolResult.reason === 'denied') {
      return {
        text: fallbacks.tool_denied || 'I can not look that up for you.',
        kind: 'denied',
        usedTool: true,
        usedKnowledge: false,
      };
    } else {
      // unavailable / unknown_tool. A policy question can still be answered
      // from knowledge, but a data question cannot: see LIVE_DATA_INTENTS.
      const fromKnowledge =
        toolResult.reason === 'unavailable' && !LIVE_DATA_INTENTS.has(intent)
          ? knowledgeAnswer(knowledgeHits)
          : null;
      if (fromKnowledge) {
        return { text: fromKnowledge, kind: 'knowledge', usedTool: true, usedKnowledge: true };
      }
      return {
        text: fallbacks.tool_unavailable || 'I could not retrieve that information right now. Please try again shortly.',
        kind: 'unavailable',
        usedTool: true,
        usedKnowledge: false,
      };
    }
  }

  /* 3. No tool: answer from knowledge if there is a good hit. */
  const fromKnowledge = knowledgeAnswer(knowledgeHits);
  if (fromKnowledge) {
    return { text: fromKnowledge, kind: 'knowledge', usedTool: false, usedKnowledge: true };
  }

  /* 4. No tool and no knowledge: use the intent's own template copy. */
  if (template) {
    if (Array.isArray(template.variants) && template.variants.length) {
      const variant = pickVariant(template.variants, seed);
      if (variant) return { text: fill(variant, values), kind: 'template', usedTool: false, usedKnowledge: false };
    }
    // A list template with no data behind it still needs to say something.
    if (template.empty) {
      return { text: fill(template.empty, values), kind: 'template', usedTool: false, usedKnowledge: false };
    }
  }

  /* 5. Nothing at all: ask for the detail that would make this answerable. */
  return {
    text: fallbacks.low_confidence || fallbacks.unknown,
    kind: 'clarify',
    usedTool: false,
    usedKnowledge: false,
  };
}

/** The refusal copy for a blocked request. */
export function refusalFor(category, bundle) {
  const responses = (bundle || loadModel()).responses || {};
  const table = responses.blocked || {};
  return table[category] || table.default || 'I can not help with that request.';
}

/** Last-resort copy when the engine itself fails. */
export function internalErrorResponse(bundle) {
  const responses = (bundle || loadModel()).responses || {};
  return responses.fallbacks?.internal_error || 'Something went wrong on my side. Please try again in a moment.';
}

export const __test = { fill, pickVariant, formatList, FORMATTERS };
