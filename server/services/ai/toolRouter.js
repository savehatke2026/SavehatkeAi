/* ============================================================
   SaveHatke AI — tool router.

   Layer 5 of the engine. The ONLY way the assistant can obtain a fact
   about the user, a coupon or a payout.

   Three rules make this safe, and all three are enforced here rather than
   trusted to the caller:

   1. IDENTITY COMES FROM THE SESSION. Every user-specific tool reads the
      caller's identity from the server-side context that /api/chat built
      from the verified session cookie. Arguments named email, userId,
      sellerId, accountId, sub or token are REFUSED, not ignored — if a
      request tries to name another account, that is a signal worth
      logging, and the call fails closed.

   2. THE BACKEND IS THE AUTHORITY. Tools do not touch a database. They
      call the existing SaveHatke application API, forwarding the caller's
      own session cookie so the backend re-authorizes the request exactly
      as it would for the browser. The AI never sees a credential.

   3. NO FABRICATION. If a live source is not configured, times out or
      errors, the tool returns { ok:false, reason:'unavailable' } and the
      response engine says so. It never guesses a number, a coupon, a
      payout or a ticket.

   Permissions are enforced twice: the registry declares a level, and the
   router refuses anything above AUTHENTICATED_USER. ADMIN_ONLY tools are
   defined below specifically so that refusal is testable — the chatbot
   must not reach them even when the signed-in user is an administrator.
   ============================================================ */

import { getAIConfig, PERMISSIONS } from './config.js';
import { searchKnowledge } from './knowledgeEngine.js';

/* ---------------- permission helpers ---------------- */

const ALLOWED_FOR_CHATBOT = new Set([PERMISSIONS.PUBLIC, PERMISSIONS.AUTHENTICATED_USER]);

/** Argument names that would let a caller impersonate someone else. */
const FORBIDDEN_ARGUMENTS = new Set([
  'email', 'useremail', 'user_id', 'userid', 'seller_id', 'sellerid',
  'account_id', 'accountid', 'sub', 'token', 'session', 'sessionid',
  'session_id', 'cookie', 'authorization', 'auth', 'apikey', 'api_key',
  'role', 'isadmin', 'is_admin', 'admin',
]);

/* ---------------- live data source ---------------- */

/**
 * Calls the SaveHatke application API.
 *
 * @param {string} path
 * @param {{ query?:object, context:object, method?:string, body?:object }} options
 */
async function callLive(path, options) {
  const config = getAIConfig();
  const { context, query } = options;

  if (!config.apiBaseUrl) {
    return { ok: false, reason: 'unavailable', detail: 'AI_API_BASE_URL is not configured' };
  }

  let url;
  try {
    url = new URL(path, config.apiBaseUrl);
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'AI_API_BASE_URL is not a valid base URL' };
  }

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers = { Accept: 'application/json' };
  // Forward the caller's own session so the backend authorizes the request
  // as that user. The engine never mints or holds a credential of its own.
  if (context?.authHeaders?.cookie) headers.Cookie = context.authHeaders.cookie;
  if (context?.authHeaders?.authorization) headers.Authorization = context.authHeaders.authorization;

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'denied', detail: `upstream ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, reason: 'unavailable', detail: `upstream ${response.status}` };
    }

    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { ok: false, reason: 'unavailable', detail: 'upstream returned a non-object body' };
    }
    return { ok: true, body };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      reason: 'unavailable',
      detail: timedOut ? 'upstream timed out' : 'upstream request failed',
    };
  }
}

/** Upstream payloads vary in shape; normalise without inventing anything. */
function pickArray(body, keys) {
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.results)) return body.results;
  return null;
}

function pickNumber(body, keys) {
  for (const key of keys) {
    const value = body?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function shortText(value, max = 48) {
  if (value === undefined || value === null) return '';
  // Only primitives are accepted. A malformed payload can put an object or an
  // array here, and String() would turn it into "[object Object]" and render
  // it straight to the user — exactly the raw JS value the response engine
  // must never emit.
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return shortText(value, 24);
  return date.toISOString().slice(0, 10);
}

/* ---------------- earnings ----------------
   The canonical earnings model for a SaveHatke seller is:

       totalEarned = ratePerCoupon × soldCoupons        (ratePerCoupon = ₹10)

   It is NOT sellingPrice × soldCoupons. A seller is paid a flat rate per
   coupon that actually sells; the coupon's face value is irrelevant to
   what the seller earns.

   The rate comes from config (AI_SELLER_RATE_PER_COUPON, default 10) and
   the sold count comes from the live backend. When the backend also
   reports a total we recompute it and mark `recomputed: true` rather than
   echoing a figure that may have been derived with the wrong formula.
   -------------------------------------------------------------------- */

export function computeEarnings({ soldCoupons, ratePerCoupon }) {
  const sold = Number.isFinite(soldCoupons) ? Math.max(0, Math.trunc(soldCoupons)) : null;
  // AI_SELLER_RATE_PER_COUPON is the single source of truth for the rate.
  const rate = Number.isFinite(ratePerCoupon) ? ratePerCoupon : getAIConfig().sellerRatePerCoupon;
  if (sold === null) return null;
  return {
    soldCoupons: sold,
    ratePerCoupon: rate,
    totalEarned: sold * rate,
    currency: 'INR',
    formula: 'totalEarned = ratePerCoupon × soldCoupons',
  };
}

/** Counts coupons that have actually sold, from whatever the backend returns. */
function countSold(items) {
  if (!Array.isArray(items)) return null;
  return items.filter((item) => {
    const status = String(item?.status ?? item?.state ?? '').toLowerCase();
    return status === 'sold' || status === 'redeemed' || status === 'completed' || status === 'approved_sold';
  }).length;
}

/* ---------------- tool definitions ---------------- */

export const TOOLS = {
  /* ---- PUBLIC ---- */

  search_coupons: {
    permission: PERMISSIONS.PUBLIC,
    description: 'Search live coupon listings by brand, category, price range or expiry.',
    params: ['brand', 'category', 'maxPrice', 'minPrice', 'expiresBefore', 'query', 'limit'],
    source: 'live',
    async handler(args, context) {
      const live = await callLive('/api/coupons', {
        context,
        query: {
          brand: args.brand,
          category: args.category,
          maxPrice: args.maxPrice,
          minPrice: args.minPrice,
          expiresBefore: args.expiresBefore,
          q: args.query,
          limit: args.limit ?? 5,
        },
      });
      if (!live.ok) return live;

      const raw = pickArray(live.body, ['coupons', 'items', 'listings', 'results']);
      if (!raw) return { ok: false, reason: 'unavailable', detail: 'coupon payload had no list' };

      // Project to the fields the response engine needs, and NEVER include a
      // coupon code: codes are released by the purchase flow, not by chat.
      const items = raw.slice(0, 10).map((item) => ({
        id: item.id ?? item.couponId ?? item._id,
        brand: shortText(item.brand ?? item.merchant ?? item.store, 40),
        category: shortText(item.category, 32),
        value: pickNumber(item, ['value', 'faceValue', 'amount', 'discountValue']) ?? shortText(item.value, 16),
        price: pickNumber(item, ['price', 'sellingPrice', 'askPrice']),
        expiry: formatDate(item.expiry ?? item.expiresAt ?? item.validTill),
        status: shortText(item.status ?? item.state, 24),
      }));

      return { ok: true, source: 'live', data: { items, count: items.length, truncated: raw.length > items.length } };
    },
  },

  search_knowledge: {
    permission: PERMISSIONS.PUBLIC,
    description: 'Look up SaveHatke documentation and policy answers.',
    params: ['query', 'limit'],
    source: 'local',
    async handler(args, context) {
      const hits = searchKnowledge(args.query, { bundle: context.bundle, limit: args.limit ?? 3 });
      return { ok: true, source: 'local', data: { items: hits, count: hits.length } };
    },
  },

  check_payout_ladder: {
    permission: PERMISSIONS.PUBLIC,
    description: 'The published payout ladder: thresholds, tiers and schedule.',
    params: [],
    source: 'live',
    async handler(_args, context) {
      const live = await callLive('/api/payouts/ladder', { context });
      if (!live.ok) return live;
      const raw = pickArray(live.body, ['ladder', 'tiers', 'thresholds', 'items']);
      if (!raw) return { ok: false, reason: 'unavailable', detail: 'ladder payload had no list' };
      const items = raw.slice(0, 10).map((tier) => ({
        from: pickNumber(tier, ['from', 'min', 'minimum', 'threshold']),
        description: shortText(tier.description ?? tier.label ?? tier.name ?? tier.note, 120),
      }));
      return { ok: true, source: 'live', data: { items, count: items.length } };
    },
  },

  get_maintenance_status: {
    permission: PERMISSIONS.PUBLIC,
    description: 'Whether SaveHatke is currently in a maintenance window.',
    params: [],
    source: 'live',
    async handler(_args, context) {
      const live = await callLive('/api/status', { context });
      if (!live.ok) return live;
      const active = live.body?.maintenance ?? live.body?.active ?? live.body?.maintenanceMode;
      if (typeof active !== 'boolean') {
        return { ok: false, reason: 'unavailable', detail: 'status payload had no maintenance flag' };
      }
      return { ok: true, source: 'live', data: { active, message: shortText(live.body?.message, 200) } };
    },
  },

  /* ---- AUTHENTICATED_USER ---- */

  check_earnings: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'The caller\'s own earnings: sold coupons, flat rate and total.',
    params: [],
    source: 'live',
    async handler(_args, context) {
      const config = getAIConfig();
      const live = await callLive('/api/payouts/earnings', { context });
      if (!live.ok) return live;

      // Prefer an explicit sold count; otherwise derive it from the listing
      // statuses the backend returned.
      const items = pickArray(live.body, ['coupons', 'items', 'sold', 'listings']);
      const soldCoupons = pickNumber(live.body, ['soldCoupons', 'sold', 'soldCount', 'completedCount'])
        ?? countSold(items);

      const earnings = computeEarnings({
        soldCoupons,
        ratePerCoupon: config.sellerRatePerCoupon,
      });
      if (!earnings) {
        return { ok: false, reason: 'unavailable', detail: 'earnings payload had no sold-coupon count' };
      }

      const reportedTotal = pickNumber(live.body, ['totalEarned', 'total', 'earnings', 'amount']);
      return {
        ok: true,
        source: 'live',
        data: {
          ...earnings,
          // Surfaced so a mismatch between the backend's total and the
          // canonical formula is visible rather than silently swallowed.
          recomputed: reportedTotal !== null && reportedTotal !== earnings.totalEarned,
          reportedTotal,
        },
      };
    },
  },

  check_submissions: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'The caller\'s own coupon submissions and their review status.',
    params: ['ticketId', 'limit'],
    source: 'live',
    async handler(args, context) {
      const live = await callLive('/api/coupons/submissions', {
        context,
        query: { id: args.ticketId, limit: args.limit ?? 5 },
      });
      if (!live.ok) return live;
      const raw = pickArray(live.body, ['submissions', 'items', 'coupons']);
      if (!raw) return { ok: false, reason: 'unavailable', detail: 'submissions payload had no list' };
      const items = raw.slice(0, 10).map((item) => ({
        id: shortText(item.id ?? item.submissionId, 40),
        brand: shortText(item.brand ?? item.merchant, 40),
        status: shortText(item.status ?? item.state, 24),
        submitted: formatDate(item.createdAt ?? item.submittedAt),
      }));
      return { ok: true, source: 'live', data: { items, count: items.length } };
    },
  },

  check_payout_status: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'The caller\'s own latest payout status.',
    params: [],
    source: 'live',
    async handler(_args, context) {
      const live = await callLive('/api/payouts', { context });
      if (!live.ok) return live;
      const raw = pickArray(live.body, ['payouts', 'items']);
      const latest = raw?.[0] || live.body?.payout || live.body?.latest;
      if (!latest) {
        // An empty list is a real answer, not a failure.
        return { ok: true, source: 'live', data: { items: [], count: 0, none: true } };
      }
      const amount = pickNumber(latest, ['amount', 'total', 'value']);
      return {
        ok: true,
        source: 'live',
        data: {
          items: [{
            status: shortText(latest.status ?? latest.state, 32),
            amount,
            currency: shortText(latest.currency, 8) || 'INR',
            date: formatDate(latest.processedAt ?? latest.paidAt ?? latest.createdAt),
          }],
          count: 1,
        },
      };
    },
  },

  check_purchases: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'The caller\'s own purchase history.',
    params: ['limit'],
    source: 'live',
    async handler(args, context) {
      const live = await callLive('/api/payments/history', {
        context,
        query: { limit: args.limit ?? 5 },
      });
      if (!live.ok) return live;
      const raw = pickArray(live.body, ['purchases', 'orders', 'items', 'payments']);
      if (!raw) return { ok: false, reason: 'unavailable', detail: 'purchase payload had no list' };
      const items = raw.slice(0, 10).map((item) => ({
        id: shortText(item.id ?? item.orderId ?? item.paymentId, 40),
        brand: shortText(item.brand ?? item.merchant, 40),
        price: pickNumber(item, ['price', 'amount', 'paid']),
        status: shortText(item.status ?? item.state, 24),
        date: formatDate(item.createdAt ?? item.paidAt ?? item.date),
      }));
      return { ok: true, source: 'live', data: { items, count: items.length } };
    },
  },

  check_support_tickets: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'The caller\'s own support tickets and whether support replied.',
    params: ['ticketId', 'limit'],
    source: 'live',
    async handler(args, context) {
      const live = await callLive('/api/support/tickets', {
        context,
        query: { id: args.ticketId, limit: args.limit ?? 5 },
      });
      if (!live.ok) return live;
      const raw = pickArray(live.body, ['tickets', 'items']);
      if (!raw) return { ok: false, reason: 'unavailable', detail: 'ticket payload had no list' };
      const items = raw.slice(0, 10).map((item) => {
        const replies = item.replies ?? item.responses ?? item.messages;
        const hasReply = Array.isArray(replies)
          ? replies.length > 0
          : Boolean(item.replied ?? item.hasReply ?? item.lastReplyAt);
        return {
          id: shortText(item.id ?? item.ticketId, 40),
          subject: shortText(item.subject ?? item.title ?? item.topic, 80),
          status: shortText(item.status ?? item.state, 24),
          hasReply,
          opened: formatDate(item.createdAt ?? item.openedAt),
        };
      });
      return { ok: true, source: 'live', data: { items, count: items.length } };
    },
  },

  check_sell_eligibility: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'Whether the caller meets the requirement to sell coupons.',
    params: [],
    source: 'live',
    async handler(_args, context) {
      const live = await callLive('/api/coupons/sell-eligibility', { context });
      if (!live.ok) return live;

      const completedPurchases = pickNumber(live.body, [
        'completedPurchases', 'purchases', 'completedOrders', 'orderCount',
      ]);
      const explicit = live.body?.eligible ?? live.body?.canSell;

      if (typeof explicit === 'boolean') {
        return {
          ok: true,
          source: 'live',
          data: { eligible: explicit, completedPurchases, requirement: 'at least 1 completed purchase' },
        };
      }
      if (completedPurchases !== null) {
        return {
          ok: true,
          source: 'live',
          data: {
            eligible: completedPurchases >= 1,
            completedPurchases,
            requirement: 'at least 1 completed purchase',
          },
        };
      }
      return { ok: false, reason: 'unavailable', detail: 'eligibility payload had no usable field' };
    },
  },

  get_user_profile: {
    permission: PERMISSIONS.AUTHENTICATED_USER,
    description: 'The caller\'s own profile, from the verified session.',
    params: [],
    source: 'session',
    async handler(_args, context) {
      // Answerable from the session itself — no upstream call needed, and no
      // opportunity to read anyone else's profile.
      const user = context?.user || {};
      return {
        ok: true,
        source: 'session',
        data: { email: shortText(user.email, 120), name: shortText(user.name, 80) },
      };
    },
  },

  /* ---- ADMIN_ONLY ----
     Defined so that the refusal above is testable. The chatbot must never
     reach these, even for an administrator. */

  admin_list_users: {
    permission: PERMISSIONS.ADMIN_ONLY,
    description: 'List all accounts. Not reachable from chat.',
    params: [],
    source: 'live',
    async handler() {
      return { ok: false, reason: 'forbidden', detail: 'admin tools are not exposed to the chatbot' };
    },
  },

  admin_approve_coupon: {
    permission: PERMISSIONS.ADMIN_ONLY,
    description: 'Approve a coupon submission. Not reachable from chat.',
    params: ['couponId'],
    source: 'live',
    async handler() {
      return { ok: false, reason: 'forbidden', detail: 'admin tools are not exposed to the chatbot' };
    },
  },
};

/* ---------------- router ---------------- */

/**
 * Validates arguments: unknown keys are dropped, identity keys are fatal.
 * @returns {{ok:boolean, args?:object, reason?:string, detail?:string}}
 */
export function validateArguments(name, rawArgs) {
  const definition = TOOLS[name];
  if (!definition) return { ok: false, reason: 'unknown_tool', detail: `no tool named ${name}` };

  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  for (const key of Object.keys(args)) {
    if (FORBIDDEN_ARGUMENTS.has(String(key).toLowerCase())) {
      // Fail closed and loudly: this is an impersonation attempt.
      return {
        ok: false,
        reason: 'forbidden_argument',
        detail: `identity argument "${key}" is not accepted`,
      };
    }
  }

  const allowed = new Set(definition.params);
  const clean = {};
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      clean[key] = value.slice(0, 200);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === 'boolean') {
      clean[key] = value;
    }
  }
  return { ok: true, args: clean };
}

/**
 * Runs a tool.
 *
 * @param {string} name
 * @param {object} args
 * @param {{ user:{email:string,name:string}, authHeaders?:object, bundle?:object,
 *           conversationId?:string }} context
 * @returns {Promise<{ok:boolean, tool:string, permission:string, source:string,
 *                    reason?:string, detail?:string, data?:any, latencyMs:number}>}
 */
export async function runTool(name, args, context) {
  const startedAt = Date.now();
  const definition = TOOLS[name];

  const finish = (result) => ({
    tool: name,
    permission: definition?.permission || 'UNKNOWN',
    source: definition?.source || 'unknown',
    latencyMs: Date.now() - startedAt,
    ...result,
  });

  if (!definition) {
    return finish({ ok: false, reason: 'unknown_tool', detail: `no tool named ${name}` });
  }

  // Gate 1: the chatbot may only ever use PUBLIC or AUTHENTICATED_USER tools.
  if (!ALLOWED_FOR_CHATBOT.has(definition.permission)) {
    return finish({ ok: false, reason: 'forbidden', detail: `${definition.permission} tools are not exposed to the chatbot` });
  }

  // Gate 2: a user-specific tool needs a session identity, and it comes from
  // the server context, never from the arguments.
  if (definition.permission === PERMISSIONS.AUTHENTICATED_USER && !context?.user?.email) {
    return finish({ ok: false, reason: 'denied', detail: 'no authenticated identity in context' });
  }

  const validated = validateArguments(name, args);
  if (!validated.ok) return finish({ ok: false, reason: validated.reason, detail: validated.detail });

  try {
    const result = await definition.handler(validated.args, context);
    return finish(result);
  } catch (error) {
    // A tool must never take the request down with it.
    return finish({ ok: false, reason: 'unavailable', detail: `tool threw: ${error?.message || 'unknown error'}` });
  }
}

/** Which tool, if any, serves an intent. */
export function toolForIntent(intent, bundle) {
  const definition = bundle?.intents?.intents?.[intent];
  return definition?.tool || null;
}

export function toolSummary() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    permission: def.permission,
    exposed: ALLOWED_FOR_CHATBOT.has(def.permission),
    source: def.source,
    params: def.params,
  }));
}

export const __test = { FORBIDDEN_ARGUMENTS, ALLOWED_FOR_CHATBOT, callLive, countSold };
