/* ============================================================
   scripts/ai/prepareData.js

   Step 1 of the training pipeline. Validates every data file and compiles
   them into one dataset the later steps consume.

   What it checks:
     * every training intent exists in data/ai/intents.json
     * no intent is trained on with an empty example list
     * knowledge entries are well formed and their intents exist
     * response templates exist for every intent that needs one
     * NO private data has leaked into the training set (emails, tokens,
       keys, phone numbers, account numbers, real coupon codes)

   It writes data/ai/training/compiled.json and exits non-zero on error, so
   `npm run ai:prepare` fails loudly rather than training on bad input.

   NEVER run this during a request. It is a build-time script.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { sourceFingerprint } from './sources.js';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DATA = path.join(ROOT, 'data', 'ai');

/* Identifiers that exist purely to exercise entity extraction. Anything
   else that looks like a real coupon code is a leak and fails the build. */
const SYNTHETIC_ID_ALLOWLIST = new Set(['SH-EXAMPLE1', 'SH-EXAMPLE2']);

/* Email domains that cannot belong to a real person, so a fixture may use
   them without leaking anyone's address: RFC 2606 reserves example.com/net/org
   for documentation, and savehatke.com is the platform itself. This exists
   because the cross-user-data check needs a *different* address to test
   against, and that test would otherwise trip the leak guard below. */
const SYNTHETIC_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'savehatke.com',
]);

function isSyntheticEmail(address) {
  const at = String(address).lastIndexOf('@');
  return at !== -1 && SYNTHETIC_EMAIL_DOMAINS.has(String(address).slice(at + 1).toLowerCase());
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const LEAK_PATTERNS = [
  { name: 'email address', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: 'bearer/api key', re: /\b(sk|pk|rk)[-_][A-Za-z0-9]{8,}\b/ },
  { name: 'savehatke key', re: /\bsh_live_[A-Za-z0-9]+/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  { name: 'private key block', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: 'long digit run (account/phone)', re: /(?<!\d)\d{10,}(?!\d)/ },
  { name: 'otp-shaped field', re: /\botp\s*[:=]\s*\d{4,8}\b/i },
  { name: 'password assignment', re: /\bpassword\s*[:=]\s*\S+/i },
];

const problems = [];
const warnings = [];

function fail(message) { problems.push(message); }
function warn(message) { warnings.push(message); }

function readJson(relative) {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) {
    fail(`missing file: ${relative}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    fail(`invalid JSON in ${relative}: ${error.message}`);
    return null;
  }
}

function readJsonl(relative) {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) {
    fail(`missing file: ${relative}`);
    return [];
  }
  const out = [];
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed));
    } catch (error) {
      fail(`${relative}:${index + 1} is not valid JSON — ${error.message}`);
    }
  });
  return out;
}

/** Scans every string in a record for anything that must not be trained on. */
function leakCheck(where, value) {
  const strings = [];
  (function walk(node) {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  })(value);

  for (const text of strings) {
    // Synthetic addresses are neutralised first, so a fixture can test the
    // cross-user-data rule without tripping the real-email leak guard.
    const scrubbed = text.replace(EMAIL_RE, (address) =>
      isSyntheticEmail(address) ? '<synthetic-email>' : address
    );
    for (const { name, re } of LEAK_PATTERNS) {
      const match = scrubbed.match(re);
      if (match) fail(`${where}: contains what looks like a ${name} → "${match[0].slice(0, 40)}"`);
    }
    const codes = text.match(/\bSH-[A-Z0-9]{4,}\b/gi) || [];
    for (const code of codes) {
      if (!SYNTHETIC_ID_ALLOWLIST.has(code.toUpperCase())) {
        fail(`${where}: contains what looks like a real coupon code → "${code}"`);
      }
    }
  }
}

/* ---------------- load ---------------- */

const intentsFile = readJson('data/ai/intents.json');
const knowledgeFile = readJson('data/ai/knowledge.json');
const responsesFile = readJson('data/ai/responses.json');

const trainingRows = readJsonl('data/ai/training/intents.jsonl');
const exampleRows = readJsonl('data/ai/training/examples.jsonl');
const conversationRows = readJsonl('data/ai/training/conversations.jsonl');
const securityRows = readJsonl('data/ai/training/security.jsonl');

const evalIntentRows = readJsonl('data/ai/eval/intents.jsonl');
const evalEntityRows = readJsonl('data/ai/eval/entities.jsonl');
const evalUnknownRows = readJsonl('data/ai/eval/unknown.jsonl');

if (problems.length) {
  console.error('prepareData: cannot continue —');
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}

/* ---------------- validate ---------------- */

const intentDefs = intentsFile.intents;
const knownIntents = new Set(Object.keys(intentDefs));
const trainableIntents = new Set(
  Object.entries(intentDefs).filter(([, def]) => def.trainable !== false).map(([name]) => name)
);

/* 1. Training rows */
const byIntent = new Map();
const seenTexts = new Map();

for (const [index, row] of trainingRows.entries()) {
  const where = `training/intents.jsonl:${index + 1}`;
  if (!row || typeof row.text !== 'string' || typeof row.intent !== 'string') {
    fail(`${where}: needs string "text" and "intent"`);
    continue;
  }
  if (!knownIntents.has(row.intent)) {
    fail(`${where}: unknown intent "${row.intent}"`);
    continue;
  }
  if (!trainableIntents.has(row.intent)) {
    fail(`${where}: intent "${row.intent}" is marked trainable:false but has examples`);
    continue;
  }
  leakCheck(where, row);

  const key = row.text.trim().toLowerCase();
  if (seenTexts.has(key)) {
    warn(`duplicate training text "${row.text}" (${seenTexts.get(key)} and ${where})`);
  } else {
    seenTexts.set(key, where);
  }

  if (!byIntent.has(row.intent)) byIntent.set(row.intent, []);
  byIntent.get(row.intent).push(row.text.trim());
}

for (const intent of trainableIntents) {
  const count = byIntent.get(intent)?.length || 0;
  if (count === 0) fail(`intent "${intent}" is trainable but has no examples`);
  else if (count < 5) warn(`intent "${intent}" has only ${count} example(s); accuracy will suffer`);
}

/* 2. Entity-annotated examples */
for (const [index, row] of exampleRows.entries()) {
  const where = `training/examples.jsonl:${index + 1}`;
  if (!row || typeof row.text !== 'string' || !knownIntents.has(row.intent)) {
    fail(`${where}: needs string "text" and a known "intent"`);
    continue;
  }
  if (row.entities && typeof row.entities !== 'object') fail(`${where}: "entities" must be an object`);
  leakCheck(where, row);
}

/* 3. Conversation fixtures */
for (const [index, row] of conversationRows.entries()) {
  const where = `training/conversations.jsonl:${index + 1}`;
  if (!row || !Array.isArray(row.turns)) {
    fail(`${where}: needs a "turns" array`);
    continue;
  }
  leakCheck(where, row);
}

/* 4. Security cases — both directions must be represented */
const securityCategories = new Map();
let expectBlock = 0;
let expectAllow = 0;
for (const [index, row] of securityRows.entries()) {
  const where = `training/security.jsonl:${index + 1}`;
  if (!row || typeof row.text !== 'string' || !row.category || !row.expect) {
    fail(`${where}: needs "text", "category" and "expect"`);
    continue;
  }
  if (!['block', 'allow'].includes(row.expect)) {
    fail(`${where}: "expect" must be "block" or "allow"`);
    continue;
  }
  securityCategories.set(row.category, (securityCategories.get(row.category) || 0) + 1);
  if (row.expect === 'block') expectBlock++; else expectAllow++;
  leakCheck(where, row);
}
if (expectAllow === 0) fail('security.jsonl has no "allow" cases — over-blocking would go undetected');
if (expectBlock === 0) fail('security.jsonl has no "block" cases');

/* 5. Knowledge */
const knowledgeIds = new Set();
for (const [index, entry] of (knowledgeFile.entries || []).entries()) {
  const where = `knowledge.json[${index}]`;
  if (!entry || typeof entry.id !== 'string') { fail(`${where}: needs a string "id"`); continue; }
  if (knowledgeIds.has(entry.id)) fail(`${where}: duplicate id "${entry.id}"`);
  knowledgeIds.add(entry.id);
  if (!entry.category || typeof entry.category !== 'string') fail(`${where}: needs a "category"`);
  if (typeof entry.question !== 'string' || !entry.question) fail(`${where}: needs a "question"`);
  if (typeof entry.answer !== 'string' || !entry.answer) fail(`${where}: needs an "answer"`);
  if (!Array.isArray(entry.keywords) || !entry.keywords.length) fail(`${where}: needs non-empty "keywords"`);
  if (entry.intents) {
    for (const intent of entry.intents) {
      if (!knownIntents.has(intent)) fail(`${where}: unknown intent "${intent}"`);
    }
  }
  if (typeof entry.verified !== 'boolean') warn(`${where}: "verified" should be true or false`);
  leakCheck(where, entry);
}

/* 6. Responses */
const templates = responsesFile.templates || {};
for (const intent of trainableIntents) {
  if (!templates[intent]) warn(`responses.json has no template for intent "${intent}"`);
}
for (const name of Object.keys(templates)) {
  if (!knownIntents.has(name)) fail(`responses.json defines a template for unknown intent "${name}"`);
  // UNKNOWN is assigned by threshold, never predicted, so it is allowed to
  // carry no copy of its own — the fallback strings cover it.
  if (!trainableIntents.has(name)) continue;
  const t = templates[name];
  // A template is valid if it carries any usable copy: either a `variants`
  // list, or a keyed shape (empty / header_one / header_many / line / footer
  // / summary / rate_only / no_context …). An intent with no copy at all is
  // a hole the response engine would have to improvise around.
  const hasCopy = t && typeof t === 'object' &&
    Object.values(t).some((v) => (typeof v === 'string' && v.trim()) || (Array.isArray(v) && v.length));
  if (!hasCopy) fail(`responses.json template "${name}" has no usable copy`);
}
for (const key of ['unknown', 'low_confidence', 'tool_unavailable', 'tool_denied', 'internal_error']) {
  if (!responsesFile.fallbacks?.[key]) fail(`responses.json is missing fallback "${key}"`);
}
if (!Object.keys(responsesFile.blocked || {}).length) fail('responses.json has no blocked responses');
for (const [index, row] of evalIntentRows.entries()) {
  const where = `eval/intents.jsonl:${index + 1}`;
  if (!row || typeof row.text !== 'string' || !knownIntents.has(row.intent)) {
    fail(`${where}: needs string "text" and a known "intent"`);
    continue;
  }
  leakCheck(where, row);
}
for (const [index, row] of evalEntityRows.entries()) {
  const where = `eval/entities.jsonl:${index + 1}`;
  if (!row || typeof row.text !== 'string' || !row.entities) {
    fail(`${where}: needs string "text" and an "entities" object`);
    continue;
  }
  leakCheck(where, row);
}
for (const [index, row] of evalUnknownRows.entries()) {
  const where = `eval/unknown.jsonl:${index + 1}`;
  if (!row || typeof row.text !== 'string') { fail(`${where}: needs string "text"`); continue; }
  leakCheck(where, row);
}

/* ---------------- report ---------------- */

if (problems.length) {
  console.error(`prepareData: ${problems.length} problem(s) —`);
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}

const compiled = {
  version: intentsFile.version,
  compiledAt: new Date().toISOString(),
  // Content fingerprint of every source fixture. evaluate.js recomputes this
  // and refuses to score a stale artefact. See scripts/ai/sources.js.
  fingerprint: sourceFingerprint(),
  thresholds: intentsFile.thresholds,
  intents: intentDefs,
  training: [...byIntent.entries()].map(([intent, examples]) => ({ intent, examples })),
  examples: exampleRows,
  conversations: conversationRows,
  security: securityRows,
  knowledge: knowledgeFile.entries,
  responses: responsesFile,
  eval: {
    intents: evalIntentRows,
    entities: evalEntityRows,
    unknown: evalUnknownRows,
  },
  stats: {
    intents: trainableIntents.size,
    trainingExamples: trainingRows.length,
    entityExamples: exampleRows.length,
    conversationFixtures: conversationRows.length,
    securityCases: securityRows.length,
    knowledgeEntries: knowledgeIds.size,
    evalIntents: evalIntentRows.length,
    evalEntities: evalEntityRows.length,
    evalUnknown: evalUnknownRows.length,
  },
};

const outPath = path.join(DATA, 'training', 'compiled.json');
fs.writeFileSync(outPath, JSON.stringify(compiled, null, 2) + '\n', 'utf8');

const s = compiled.stats;
console.log('prepareData: OK');
console.log(`  intents trained        ${s.intents}`);
console.log(`  training examples      ${s.trainingExamples}`);
console.log(`  entity examples        ${s.entityExamples}`);
console.log(`  conversation fixtures  ${s.conversationFixtures}`);
console.log(`  security cases         ${s.securityCases} (${expectBlock} block / ${expectAllow} allow)`);
console.log(`  knowledge entries      ${s.knowledgeEntries}`);
console.log(`  eval sets              ${s.evalIntents} intent / ${s.evalEntities} entity / ${s.evalUnknown} unknown`);
console.log(`  security categories    ${[...securityCategories.keys()].join(', ')}`);
if (warnings.length) {
  console.log(`\n  ${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log('  ! ' + w));
}
console.log(`\n  wrote ${path.relative(ROOT, outPath)}`);
