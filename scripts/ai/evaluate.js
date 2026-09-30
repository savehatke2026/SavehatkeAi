/* ============================================================
   scripts/ai/evaluate.js

   Step 4 of the training pipeline. Measures the engine against held-out
   data and prints a report with every failure listed, so a regression is
   visible rather than inferred.

   Six metrics, matching what the engine actually claims to do:

     intent accuracy          did we understand the question?
     entity accuracy          did we pull the right brand/price/id out?
     tool-selection accuracy  did we choose the right lookup?
     unknown-query accuracy   did we refuse to guess?
     security rejection       did we block what must be blocked, and only
                              that? (both directions are measured)
     response accuracy        is the answer non-empty, leak-free and free
                              of invented data?

   Build-time only. Run with: npm run ai:eval
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetModelCache, loadModel } from '../../server/services/ai/modelLoader.js';
import { classifyIntent } from '../../server/services/ai/intentEngine.js';
import { inspectInput, inspectOutput } from '../../server/services/ai/securityEngine.js';
import { toolForIntent, runTool, toolSummary } from '../../server/services/ai/toolRouter.js';
import { composeResponse } from '../../server/services/ai/responseEngine.js';
import { retrieveKnowledge } from '../../server/services/ai/knowledgeEngine.js';
import { resetContexts, updateContext, getContext, resolveEntities } from '../../server/services/ai/contextManager.js';
import { runSaveHatkeAI } from '../../server/services/ai/savehatkeAI.js';
import { sourceFingerprint } from './sources.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const compiledPath = path.join(ROOT, 'data', 'ai', 'training', 'compiled.json');
if (!fs.existsSync(compiledPath)) {
  console.error('evaluate: data/ai/training/compiled.json is missing — run `npm run ai:prepare` first.');
  process.exit(1);
}
const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));

/* compiled.json is committed so this script runs on a fresh checkout, which
   means it can lag behind the fixtures. Scoring stale data would report an
   accuracy that describes the previous revision, so refuse rather than
   mislead. A content fingerprint is used instead of a timestamp because a
   clone stamps every file with the checkout time. */
{
  const current = sourceFingerprint();
  if (compiled.fingerprint && compiled.fingerprint !== current) {
    console.error('evaluate: compiled.json is stale — the fixtures changed since it was built.');
    console.error(`  compiled: ${compiled.fingerprint}`);
    console.error(`  current:  ${current}`);
    console.error('  Run `npm run ai:build` first.');
    process.exit(1);
  }
}

const FAILURES = [];
const results = [];

function record(metric, name, ok, detail) {
  results.push({ metric, name, ok, detail });
  if (!ok) FAILURES.push({ metric, name, detail });
}

function pct(passed, total) {
  return total ? `${((passed / total) * 100).toFixed(1)}%` : 'n/a';
}

function summarize(metric) {
  const rows = results.filter((r) => r.metric === metric);
  const passed = rows.filter((r) => r.ok).length;
  return { metric, passed, total: rows.length, accuracy: pct(passed, rows.length) };
}

const bundle = loadModel();
if (bundle.degraded) {
  console.error(`evaluate: model is degraded (${bundle.reason}) — run the pipeline first.`);
  process.exit(1);
}

console.log('SaveHatke AI — evaluation');
console.log(`model: ${bundle.model?.algorithm || 'unknown'} · ${bundle.classifier.intents.length} intents · ` +
  `${bundle.vocabulary.size} tokens · trained ${bundle.model?.trainedAt || 'unknown'}\n`);

/* ============================================================
   1. Intent accuracy (held-out)
   ============================================================ */

for (const row of compiled.eval.intents) {
  const result = classifyIntent(row.text, { bundle });
  record('intent', row.text, result.intent === row.intent,
    `expected ${row.intent}, got ${result.intent} (${result.confidence})`);
}

/* ============================================================
   2. Entity accuracy (held-out, subset match)
   ============================================================ */

for (const row of compiled.eval.entities) {
  const result = classifyIntent(row.text, { bundle });
  const expected = row.entities || {};
  const actual = result.entities || {};
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    const got = actual[key];
    if (Array.isArray(value)) {
      const missing = value.filter((v) => !(got || []).includes(v));
      if (missing.length) problems.push(`${key}: missing ${JSON.stringify(missing)}`);
    } else if (got !== value) {
      problems.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`);
    }
  }
  record('entity', row.text, problems.length === 0, problems.join('; '));
}

/* ============================================================
   3. Tool-selection accuracy
   ============================================================ */

for (const row of compiled.eval.intents) {
  const result = classifyIntent(row.text, { bundle });
  const expectedTool = toolForIntent(row.intent, bundle);
  const actualTool = result.intent === 'UNKNOWN' ? null : toolForIntent(result.intent, bundle);
  record('tool', row.text, expectedTool === actualTool,
    `expected ${expectedTool || 'none'}, got ${actualTool || 'none'} (intent ${result.intent})`);
}

/* Tool permission boundary: the chatbot must not reach ADMIN_ONLY tools,
   and identity arguments must be refused outright. */
{
  const summary = toolSummary();
  const exposed = summary.filter((t) => t.exposed).map((t) => t.name);
  const adminExposed = summary.filter((t) => t.permission === 'ADMIN_ONLY' && t.exposed);
  record('tool', 'no ADMIN_ONLY tool is exposed to the chatbot', adminExposed.length === 0,
    adminExposed.map((t) => t.name).join(', '));

  const adminCall = await runTool('admin_approve_coupon', { couponId: 'x' }, { user: { email: 'a@b.c' } });
  record('tool', 'calling an ADMIN_ONLY tool is refused', adminCall.ok === false && adminCall.reason === 'forbidden',
    `${adminCall.reason} / ${adminCall.detail}`);

  const impersonation = await runTool('check_earnings', { email: 'someone@else.com' }, { user: { email: 'a@b.c' } });
  record('tool', 'an identity argument is refused', impersonation.ok === false && impersonation.reason === 'forbidden_argument',
    `${impersonation.reason} / ${impersonation.detail}`);

  const noIdentity = await runTool('check_earnings', {}, {});
  record('tool', 'a user tool without a session identity is denied',
    noIdentity.ok === false && noIdentity.reason === 'denied', noIdentity.reason);

  const profile = await runTool('get_user_profile', {}, { user: { email: 'me@example.com', name: 'Me' } });
  record('tool', 'get_user_profile answers from the session',
    profile.ok === true && profile.data.email === 'me@example.com', JSON.stringify(profile.data));

  record('tool', 'the exposed tool set is public/user only', exposed.length > 0 && exposed.length === summary.length - 2,
    `${exposed.length} exposed of ${summary.length}`);
}

/* ============================================================
   4. Unknown-query accuracy
   ============================================================ */

for (const row of compiled.eval.unknown) {
  const result = classifyIntent(row.text, { bundle });
  record('unknown', row.text, result.intent === 'UNKNOWN',
    `expected UNKNOWN, got ${result.intent} (${result.confidence}) — ${row.reason || ''}`);
}

/* ============================================================
   5. Security: both directions
   ============================================================ */

let blocked = 0;
let allowed = 0;
/* A session identity is supplied because one of the security checks — a
   request naming someone else's email address — cannot be evaluated without
   knowing who the caller is. This is the same value the orchestrator passes
   from the verified session. */
const EVAL_SESSION_EMAIL = 'eval@example.com';
for (const row of compiled.security) {
  const result = inspectInput(row.text, { userEmail: EVAL_SESSION_EMAIL });
  const expected = row.expect === 'block';
  const ok = result.blocked === expected;
  if (expected) blocked++; else allowed++;
  record('security', `${row.category}: ${row.text}`, ok,
    expected
      ? `should have been blocked but was allowed`
      : `should have been allowed but was blocked as ${result.category}`);
}

/* The refusal copy must never leak internal detail. */
{
  const categories = [...new Set(compiled.security.filter((r) => r.expect === 'block').map((r) => r.category))];
  const blockedCopy = bundle.responses.blocked || {};
  for (const category of categories) {
    const refusal = blockedCopy[category] || blockedCopy.default || '';
    const check = inspectOutput(refusal);
    record('security', `refusal copy for ${category} is leak-free`,
      Boolean(refusal) && check.safe.length > 0 && !check.redacted,
      check.redacted ? `redacted: ${check.categories.join(', ')}` : 'ok');
  }
  record('security', 'every blocked category has its own refusal copy',
    categories.every((c) => Boolean(blockedCopy[c])),
    categories.filter((c) => !blockedCopy[c]).join(', '));
}

/* ============================================================
   6. Response accuracy
   ============================================================ */

for (const row of compiled.eval.intents) {
  const result = classifyIntent(row.text, { bundle });
  if (result.intent === 'UNKNOWN') {
    record('response', row.text, false, 'no response composed: intent was UNKNOWN');
    continue;
  }
  const knowledgeHits = retrieveKnowledge({
    message: row.text, intent: result.intent, entities: result.entities, bundle,
  });
  const toolName = toolForIntent(result.intent, bundle);
  // Evaluate the honest path: with no live source configured, a data intent
  // must say it could not retrieve the data — never invent it.
  const toolResult = toolName
    ? await runTool(toolName, {}, { user: { email: 'eval@example.com', name: 'Eval' }, bundle })
    : null;

  const composed = composeResponse({
    classification: result, toolResult, knowledgeHits, bundle,
    conversationId: 'eval', user: { name: 'Eval' }, turn: 1,
  });

  const problems = [];
  if (!composed.text || !composed.text.trim()) problems.push('empty response');
  const output = inspectOutput(composed.text);
  if (output.redacted) problems.push(`leaked: ${output.categories.join(', ')}`);
  if (/\{[a-z_]+\}/i.test(composed.text)) problems.push('unfilled template placeholder');
  if (/undefined|NaN|\[object Object\]/.test(composed.text)) problems.push('raw JS value in copy');
  record('response', row.text, problems.length === 0, problems.join('; '));
}

/* ============================================================
   7. End-to-end: multi-turn context and no fabrication
   ============================================================ */

{
  resetContexts();
  const user = { email: 'eval@example.com', name: 'Eval', sub: 'eval-sub' };
  const first = await runSaveHatkeAI({
    message: 'Show me Nike coupons', user, conversationId: 'eval-context', bundle,
  });
  record('context', 'a coupon search resolves to the right intent', first.intent === 'SEARCH_COUPON',
    first.intent);
  record('context', 'a coupon search with no live source says so instead of inventing listings',
    /could not retrieve|try again|shortly/i.test(first.reply), first.reply);

  const context = getContext('eval-sub', 'eval-context');
  record('context', 'context is stored under the user-scoped key', Boolean(context), 'no context stored');

  const resolved = resolveEntities({}, context, ['brand']);
  record('context', 'a follow-up inherits the previous brand', resolved.brand === 'Nike',
    JSON.stringify(resolved));

  const second = await runSaveHatkeAI({
    message: 'Which one expires first?', user, conversationId: 'eval-context', bundle,
  });
  record('context', 'a follow-up is classified as COUPON_DETAILS', second.intent === 'COUPON_DETAILS',
    second.intent);

  // Context must not be readable across users.
  const other = getContext('someone-else', 'eval-context');
  record('context', 'another user cannot read this context', other === null, JSON.stringify(other));
}

/* No numeric claim without a tool result. */
{
  const user = { email: 'eval@example.com', name: 'Eval', sub: 'eval-sub' };
  const reply = await runSaveHatkeAI({ message: 'How much have I earned?', user, conversationId: 'eval-earn', bundle });
  const hasInventedAmount = /₹\s?\d/.test(reply.reply) && !reply.toolsUsed.length;
  record('response', 'earnings are not invented when the live source is absent',
    !hasInventedAmount, reply.reply);
  record('response', 'earnings intent routes to check_earnings', reply.toolsUsed.includes('check_earnings'),
    JSON.stringify(reply.toolsUsed));
}

/* Earnings formula, tested directly on the tool's own arithmetic. */
{
  const { computeEarnings } = await import('../../server/services/ai/toolRouter.js');
  const five = computeEarnings({ soldCoupons: 5, ratePerCoupon: 10 });
  record('response', 'earnings = ₹10 × 5 sold coupons = ₹50',
    five.totalEarned === 50 && five.soldCoupons === 5 && five.ratePerCoupon === 10, JSON.stringify(five));

  const zero = computeEarnings({ soldCoupons: 0, ratePerCoupon: 10 });
  record('response', 'earnings with no sold coupons is ₹0', zero.totalEarned === 0, JSON.stringify(zero));

  // The bug this replaces: sellingPrice × soldCoupons.
  const wrongFormula = 500 * 5;
  record('response', 'the selling-price formula is NOT used', five.totalEarned !== wrongFormula,
    `${five.totalEarned} vs ${wrongFormula}`);
}

/* ============================================================
   Report
   ============================================================ */

const metrics = ['intent', 'entity', 'tool', 'unknown', 'security', 'response', 'context'];
const summaries = metrics.map(summarize);

console.log('metric                    passed / total     accuracy');
console.log('-------------------------------------------------------');
for (const s of summaries) {
  console.log(`${s.metric.padEnd(24)}  ${String(s.passed).padStart(4)} / ${String(s.total).padEnd(8)} ${s.accuracy}`);
}

const overall = results.filter((r) => r.ok).length;
console.log('-------------------------------------------------------');
console.log(`${'OVERALL'.padEnd(24)}  ${String(overall).padStart(4)} / ${String(results.length).padEnd(8)} ${pct(overall, results.length)}`);
console.log(`\nsecurity: ${blocked} must-block cases, ${allowed} must-allow cases`);

if (FAILURES.length) {
  console.log(`\n${FAILURES.length} failure(s):`);
  const byMetric = new Map();
  for (const f of FAILURES) {
    if (!byMetric.has(f.metric)) byMetric.set(f.metric, []);
    byMetric.get(f.metric).push(f);
  }
  for (const [metric, list] of byMetric) {
    console.log(`\n  [${metric}] ${list.length}`);
    for (const f of list.slice(0, 40)) {
      console.log(`    ✗ ${f.name}`);
      if (f.detail) console.log(`        ${f.detail}`);
    }
    if (list.length > 40) console.log(`    … and ${list.length - 40} more`);
  }
}

resetModelCache();
process.exit(FAILURES.length === 0 ? 0 : 1);
