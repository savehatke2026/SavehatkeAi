/* ============================================================
   scripts/ai/buildVocabulary.js

   Step 2 of the training pipeline. Builds the token vocabulary (with
   document frequencies and inverse document frequencies) from the compiled
   dataset and writes server/models/ai/vocabulary.json.

   The vocabulary is what makes the runtime classifier's feature space
   stable: a token that is not in here is treated as unseen at inference
   time, so the model cannot drift just because someone typed a new word.

   Build-time only. Never runs during a request.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../../server/services/ai/tokenizer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/* A token must appear in at least this many examples to enter the
   vocabulary. 1 keeps Hinglish words that only show up once or twice. */
const MIN_DF = 1;
/* Tokens longer than this are almost always ids or typos. */
const MAX_TOKEN_LENGTH = 24;

const compiledPath = path.join(ROOT, 'data', 'ai', 'training', 'compiled.json');
if (!fs.existsSync(compiledPath)) {
  console.error('buildVocabulary: data/ai/training/compiled.json is missing — run `npm run ai:prepare` first.');
  process.exit(1);
}
const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));

/* The idf here is computed over INTENTS, not over individual examples.

   That is the important detail. If document frequency were counted per
   example, a word like "tell" would look rare and therefore highly
   informative, when in truth it appears in several unrelated intents and
   cannot distinguish between them. Counting per intent means a token's
   weight reflects how well it separates one intent from another, which is
   the only thing the classifier cares about.

   `counts` still records raw occurrence frequency, for reporting. */
const documents = [];
const counts = new Map();

for (const group of compiled.training) {
  const intentTokens = new Set();
  for (const text of group.examples) {
    for (const token of analyze(text).keywords) {
      if (!token || token.length > MAX_TOKEN_LENGTH) continue;
      intentTokens.add(token);
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  documents.push([...intentTokens]);
}

const df = new Map();
for (const tokens of documents) {
  for (const token of tokens) df.set(token, (df.get(token) || 0) + 1);
}

const totalDocs = documents.length;
const tokens = {};
let id = 0;
const ordered = [...df.keys()].sort();

for (const token of ordered) {
  const docFreq = df.get(token);
  if (docFreq < MIN_DF) continue;
  tokens[token] = {
    id: id++,
    df: docFreq,
    // Smoothed idf, always positive.
    idf: Number((Math.log((totalDocs + 1) / (docFreq + 1)) + 1).toFixed(6)),
    count: counts.get(token) || 0,
  };
}

const vocabulary = {
  version: '2.0.0',
  builtAt: new Date().toISOString(),
  minDf: MIN_DF,
  dfUnit: 'intent',
  documents: totalDocs,
  examples: compiled.training.reduce((sum, group) => sum + group.examples.length, 0),
  size: Object.keys(tokens).length,
  tokens,
};

const outDir = path.join(ROOT, 'server', 'models', 'ai');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'vocabulary.json');
fs.writeFileSync(outPath, JSON.stringify(vocabulary, null, 2) + '\n', 'utf8');

/* ---------------- report ---------------- */

const sorted = Object.entries(tokens).sort((a, b) => b[1].count - a[1].count);
const hinglishSamples = sorted
  .filter(([token]) => /^(kharid|bech|dikha|dhoond|kitna|milega|paisa|wapas|kaise|nahi|band|sakta|mera|meri)/.test(token))
  .slice(0, 8)
  .map(([token, meta]) => `${token}(${meta.count})`);

console.log('buildVocabulary: OK');
console.log(`  intents (documents) ${totalDocs}`);
console.log(`  vocabulary size   ${vocabulary.size}`);
console.log(`  top tokens        ${sorted.slice(0, 10).map(([t, m]) => `${t}(${m.count})`).join(' ')}`);
console.log(`  most spread       ${Object.entries(tokens).sort((a, b) => b[1].df - a[1].df).slice(0, 8).map(([t, m]) => `${t}(df${m.df})`).join(' ')}`);
console.log(`  most specific     ${Object.entries(tokens).sort((a, b) => a[1].df - b[1].df).slice(0, 8).map(([t, m]) => `${t}(df${m.df})`).join(' ')}`);
console.log(`  hinglish samples  ${hinglishSamples.length ? hinglishSamples.join(' ') : '(none)'}`);
console.log(`  wrote ${path.relative(ROOT, outPath)}`);

if (vocabulary.size < 50) {
  console.error('buildVocabulary: vocabulary is suspiciously small — check the training data.');
  process.exit(1);
}
