/* ============================================================
   SaveHatke AI — integration tests against stubbed endpoints (dev-only).

   Everything that needs a real HTTP round trip, so that the paths which only
   exist in production are exercised rather than assumed.

   The engine's central claim is that it never invents anything: every fact
   about the user's account or the marketplace comes from the application
   API. The rest of the suite exercises the case where that API is ABSENT
   and the engine must say so. This file exercises the opposite case.

   A stub SaveHatke API is started on a random port and AI_API_BASE_URL is
   pointed at it, so the whole tool path runs for real: the request that
   goes out, the identity it carries, the payload that comes back, the
   projection into a reply, and the earnings arithmetic.

   What this pins:
     * the caller's own session is forwarded, and nothing else is
     * search filters reach the API as query parameters
     * a coupon code in the upstream payload can never reach the reply
     * earnings is rate x sold, even when the backend reports another total
     * a 403 from upstream is a refusal, not a silent guess
     * a malformed payload degrades to "unavailable", never to a crash
     * the upstream model provider still works, and honours its config

   Run with:  npm run test:ai-live
   ============================================================ */

import http from 'node:http';

import { loadModel } from '../server/services/ai/modelLoader.js';
import { runSaveHatkeAI } from '../server/services/ai/savehatkeAI.js';
import { resetContexts } from '../server/services/ai/contextManager.js';
import { generateReply, resolveProvider, PROVIDERS } from '../server/services/ai/provider.js';
import { getAIConfig } from '../server/services/ai/config.js';

/* ---------------- tiny harness (matches tests/backend.test.mjs) ---------------- */
let pass = 0;
let fail = 0;
const lines = [];

function check(name, ok, detail) {
  if (ok) { pass++; lines.push(`PASS | ${name}`); }
  else { fail++; lines.push(`FAIL | ${name}${detail ? ` | ${detail}` : ''}`); }
}

function section(title) {
  lines.push('', `--- ${title} ---`);
}

/* ---------------- stub SaveHatke API ---------------- */

/** Every request the stub received, so the outgoing call can be asserted on. */
const received = [];

/** Per-path responses. A handler may be a function of the request. */
let routes = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  received.push({
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    cookie: req.headers.cookie || '',
    authorization: req.headers.authorization || '',
  });

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const { status = 200, body = {} } = typeof handler === 'function' ? handler(req, url) : handler;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

/* Point the engine at the stub for the duration of this file. */
const PREVIOUS_BASE = process.env.AI_API_BASE_URL;
const PREVIOUS_LOG = process.env.AI_LOG_LEVEL;
process.env.AI_API_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.AI_LOG_LEVEL = 'silent';

const bundle = loadModel();
const user = { email: 'live@savehatke.example', name: 'Live', sub: 'live-sub' };
const authHeaders = { cookie: 'sh_session=stub-session-token' };

/** Runs one turn against the stub. */
async function turn(message, conversationId = 'live') {
  return runSaveHatkeAI({
    message, user, conversationId, bundle, authHeaders,
  });
}

/** The most recent request the stub saw for a path. */
const lastRequest = (path) => [...received].reverse().find((r) => r.path === path);

/* ============================================================
   1. Identity forwarding
   ============================================================ */
section('Identity forwarding');
{
  resetContexts();
  routes = {
    '/api/coupons': { body: { coupons: [] } },
  };
  received.length = 0;

  await turn('show me nike coupons', 'live-identity');

  const sent = lastRequest('/api/coupons');
  check('the application API was called', Boolean(sent), 'no request reached the stub');
  check("the caller's own session cookie was forwarded",
    sent?.cookie === 'sh_session=stub-session-token', String(sent?.cookie));
  check('no credential is minted by the engine',
    !sent?.authorization, String(sent?.authorization));
}

/* ============================================================
   2. Search: filters reach the API, results reach the reply
   ============================================================ */
section('Coupon search');
{
  resetContexts();
  routes = {
    '/api/coupons': {
      body: {
        coupons: [
          {
            id: 'c1',
            brand: 'Nike',
            category: 'Footwear',
            value: 500,
            price: 250,
            expiry: '2026-10-01',
            status: 'listed',
            // A code the upstream should never have sent, and the reply must
            // never carry. The projection drops it structurally.
            code: 'SH-SECRET1',
            couponCode: 'SH-SECRET1',
          },
          { id: 'c2', brand: 'Adidas', value: 300, price: 150, expiry: '2026-11-05', status: 'listed' },
        ],
      },
    },
  };
  received.length = 0;

  const result = await turn('show me nike coupons under 500', 'live-search');

  const sent = lastRequest('/api/coupons');
  check('the brand filter reached the API as a query parameter',
    sent?.query?.brand === 'Nike', JSON.stringify(sent?.query));
  check('the price ceiling reached the API as a query parameter',
    sent?.query?.maxPrice === '500', JSON.stringify(sent?.query));

  check('the intent is SEARCH_COUPON', result.intent === 'SEARCH_COUPON', result.intent);
  check('the reply is built from live data, not knowledge',
    result.usedKnowledge === false, String(result.usedKnowledge));
  check('the reply names the live listing', /Nike/.test(result.reply), result.reply);
  check('the reply carries the listing value', /500/.test(result.reply), result.reply);
  check('the reply reports both listings', /2 live listings/.test(result.reply), result.reply);

  // The whole point of gating codes behind purchase.
  check('the coupon code from upstream never reaches the reply',
    !/SH-SECRET1/.test(result.reply), result.reply);
  check('no coupon-code-shaped token reaches the reply',
    (result.reply.match(/\bSH-[A-Z0-9]{4,}\b/g) || []).length === 0, result.reply);

  // Nothing about the raw payload leaks through.
  check('the reply leaks no upstream field names',
    !/couponCode|"id"|_id/.test(result.reply), result.reply);
}

/* ============================================================
   3. An empty result says so, rather than falling back to knowledge
   ============================================================ */
section('Empty result');
{
  resetContexts();
  routes = { '/api/coupons': { body: { coupons: [] } } };

  const result = await turn('show me nike coupons', 'live-empty');
  check('an empty live result is reported as empty',
    /couldn't find any live listings/i.test(result.reply), result.reply);
}

/* ============================================================
   4. Earnings: rate x sold, and the formula wins over the backend
   ============================================================ */
section('Earnings');
{
  resetContexts();
  routes = {
    '/api/payouts/earnings': { body: { soldCoupons: 3 } },
  };
  received.length = 0;

  const result = await turn('how much have i earned', 'live-earn');
  check('the earnings endpoint was called', Boolean(lastRequest('/api/payouts/earnings')));
  check('3 sold coupons at ₹10 is ₹30', /₹30/.test(result.reply), result.reply);
  check('the rate is stated as ₹10', /₹10/.test(result.reply), result.reply);

  // The backend reporting a different total must not change the arithmetic;
  // it is surfaced as a mismatch instead.
  resetContexts();
  routes = {
    '/api/payouts/earnings': { body: { soldCoupons: 3, totalEarned: 999 } },
  };
  const mismatch = await turn('how much have i earned', 'live-earn-mismatch');
  check('a backend total is not trusted over the formula',
    /₹30/.test(mismatch.reply) && !/₹999/.test(mismatch.reply), mismatch.reply);

  // The sold count may also be derived from listing statuses.
  resetContexts();
  routes = {
    '/api/payouts/earnings': {
      body: {
        coupons: [
          { status: 'sold' }, { status: 'sold' }, { status: 'sold' },
          { status: 'pending' }, { status: 'rejected' },
        ],
      },
    },
  };
  const derived = await turn('how much have i earned', 'live-earn-derived');
  check('the sold count is derived from listing statuses',
    /₹30/.test(derived.reply), derived.reply);

  // No sold coupons at all.
  resetContexts();
  routes = { '/api/payouts/earnings': { body: { soldCoupons: 0 } } };
  const zero = await turn('how much have i earned', 'live-earn-zero');
  check('zero sold coupons reports ₹0', /₹0/.test(zero.reply), zero.reply);
}

/* ============================================================
   5. Upstream refusals are respected
   ============================================================ */
section('Upstream refusal');
{
  resetContexts();
  routes = { '/api/payouts/earnings': { status: 403, body: { error: 'forbidden' } } };

  const result = await turn('how much have i earned', 'live-denied');
  check('a 403 from upstream does not produce an amount',
    !/₹\s?\d/.test(result.reply), result.reply);
  check('a 403 is reported as a refusal, not a lookup failure',
    /your own account|can't look up/i.test(result.reply), result.reply);
}

/* ============================================================
   6. Malformed and failing upstreams degrade safely
   ============================================================ */
section('Degradation');
{
  resetContexts();
  routes = { '/api/coupons': { body: {} } };
  const noList = await turn('show me nike coupons', 'live-nolist');
  check('a payload with no list degrades to unavailable',
    /could not|try again|shortly/i.test(noList.reply), noList.reply);

  resetContexts();
  routes = { '/api/coupons': { status: 500, body: { error: 'boom' } } };
  const boom = await turn('show me nike coupons', 'live-500');
  check('a 500 degrades to unavailable',
    /could not|try again|shortly/i.test(boom.reply), boom.reply);

  resetContexts();
  routes = { '/api/coupons': { body: 'not json at all' } };
  const garbage = await turn('show me nike coupons', 'live-garbage');
  check('a non-JSON body degrades to unavailable',
    /could not|try again|shortly/i.test(garbage.reply), garbage.reply);

  resetContexts();
  routes = {};
  const missing = await turn('show me nike coupons', 'live-404');
  check('a 404 degrades to unavailable',
    /could not|try again|shortly/i.test(missing.reply), missing.reply);

  // A wrong shape in a field must not produce a raw JS value in the copy.
  resetContexts();
  routes = {
    '/api/coupons': {
      body: { coupons: [{ brand: { nested: true }, value: null, price: undefined, expiry: null }] },
    },
  };
  const weird = await turn('show me nike coupons', 'live-weird');
  check('a malformed listing leaks no raw JS value',
    !/undefined|NaN|\[object Object\]/.test(weird.reply), weird.reply);
}

/* ============================================================
   7. The engine is not the authority
   ============================================================ */
section('Not the authority');
{
  // A search must go to the API every time; availability is never cached
  // into the model or answered from training data.
  resetContexts();
  routes = { '/api/coupons': { body: { coupons: [{ brand: 'Nike', value: 500, expiry: '2026-10-01' }] } } };
  received.length = 0;
  await turn('show me nike coupons', 'live-fresh-1');
  await turn('show me adidas coupons', 'live-fresh-2');
  const searchCalls = received.filter((r) => r.path === '/api/coupons');
  check('each search hits the live source', searchCalls.length === 2, String(searchCalls.length));
  check('the two searches carried different filters',
    searchCalls[0]?.query?.brand !== searchCalls[1]?.query?.brand,
    JSON.stringify(searchCalls.map((r) => r.query.brand)));
}

/* ============================================================
   8. The upstream provider path
   ============================================================ */
section('Upstream provider');
{
  // The provider abstraction exists so the custom engine could be introduced
  // without deleting what came before. That path is only worth keeping if it
  // still works, so it is exercised against a stub model endpoint rather than
  // assumed. Two bugs lived here: the endpoint settings were read off the
  // wrong config object, and the timeout was read under a name that did not
  // exist — both invisible until the path was actually called.
  const modelCalls = [];
  const modelServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { /* recorded raw below */ }
      modelCalls.push({ headers: req.headers, body: parsed, raw });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Upstream says hello.' } }] }));
    });
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));

  const serverConfig = {
    modelApiUrl: `http://127.0.0.1:${modelServer.address().port}/v1/chat/completions`,
    modelApiKey: 'sk-stub-key',
    modelName: 'stub-model',
  };

  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'UPSTREAM_MODEL';
  try {
    const aiConfig = getAIConfig();
    check('the provider resolves to upstream when configured',
      resolveProvider(aiConfig, serverConfig) === PROVIDERS.UPSTREAM_MODEL,
      resolveProvider(aiConfig, serverConfig));

    const history = [];
    for (let i = 0; i < 40; i++) {
      history.push({ role: 'user', content: `turn ${i}` });
      history.push({ role: 'assistant', content: `reply ${i}` });
    }

    const result = await generateReply(
      { message: 'hello there', history, user, conversationId: 'upstream' },
      serverConfig
    );

    check('the upstream reply is parsed from the response',
      result.reply === 'Upstream says hello.', result.reply);
    check('the source is reported as the model, not the engine',
      result.source === 'model', result.source);

    const call = modelCalls[0];
    check('the upstream endpoint was called once', modelCalls.length === 1, String(modelCalls.length));
    check('the API key is sent as a bearer token',
      call?.headers?.authorization === 'Bearer sk-stub-key', String(call?.headers?.authorization));
    check('AI_MAX_TOKENS is sent as max_tokens',
      call?.body?.max_tokens === aiConfig.maxTokens, JSON.stringify(call?.body?.max_tokens));
    check('the model name is forwarded',
      call?.body?.model === 'stub-model', String(call?.body?.model));

    // AI_MAX_CONTEXT bounds the forwarded transcript: 2 messages per turn.
    const sentMessages = call?.body?.messages || [];
    check('AI_MAX_CONTEXT bounds the forwarded history',
      sentMessages.length <= aiConfig.maxContext * 2 + 1,
      `${sentMessages.length} messages for maxContext ${aiConfig.maxContext}`);
    check('the newest message is the user turn, appended last',
      sentMessages[sentMessages.length - 1]?.content === 'hello there',
      JSON.stringify(sentMessages[sentMessages.length - 1]));
    check('the oldest turns were dropped, not the newest',
      !sentMessages.some((m) => m.content === 'turn 0'),
      JSON.stringify(sentMessages.slice(0, 2)));

    // A failing upstream must throw so /api/chat can answer 502, rather than
    // silently returning an empty reply.
    const failing = http.createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('upstream exploded');
    });
    await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
    let threw = false;
    try {
      await generateReply(
        { message: 'hi', history: [], user, conversationId: 'upstream-fail' },
        { ...serverConfig, modelApiUrl: `http://127.0.0.1:${failing.address().port}/v1/chat/completions` }
      );
    } catch {
      threw = true;
    }
    check('a failing upstream throws so the route can answer 502', threw);
    failing.close();
  } finally {
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
  }

  modelServer.close();
}

/* ---------------- teardown ---------------- */
server.close();
if (PREVIOUS_BASE === undefined) delete process.env.AI_API_BASE_URL;
else process.env.AI_API_BASE_URL = PREVIOUS_BASE;
if (PREVIOUS_LOG === undefined) delete process.env.AI_LOG_LEVEL;
else process.env.AI_LOG_LEVEL = PREVIOUS_LOG;

for (const line of lines) console.log(line);
console.log('', '='.repeat(60));
console.log(`ai-live.test: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));

process.exit(fail ? 1 : 0);
