/* ============================================================
   scripts/ai/train.js

   Step 3 of the training pipeline. Trains the intent classifier.

   The model is a TF-IDF k-NN classifier:

     * each training example → L2-normalised sublinear TF-IDF vector
     * inference             → mean cosine similarity to the closest few
                               examples of each intent, then softmax

   Why k-NN rather than centroids: a short message scored against the mean
   vector of a whole class is systematically under-confident, because the
   mean of 15 different phrasings shares few tokens with any one of them.
   Scoring against the nearest examples gives a similarity that actually
   reflects "have I seen something like this?".

   It is chosen deliberately:
     * a few hundred kilobytes, not gigabytes
     * trains in well under a second on a CPU
     * inference is ~300 sparse dot products, well under a millisecond
     * cosine gives an interpretable 0..1 score with enough spread for the
       confidence thresholds in config.js to mean something

   `vectorize` and `cosine` are imported from the runtime engine rather
   than reimplemented, so training and inference can never drift apart.

   It writes:
     server/models/ai/weights/classifier.json   the learned parameters
     server/models/ai/model.json                metadata for the runtime
     server/models/ai/intents.json              the intent definition snapshot

   Build-time only. NEVER runs during a request.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../../server/services/ai/tokenizer.js';
import { vectorize, cosine } from '../../server/services/ai/intentEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MODEL_DIR = path.join(ROOT, 'server', 'models', 'ai');

/* Weights below this are noise; dropping them keeps the artefact small
   without measurably changing a cosine score. */
const WEIGHT_FLOOR = 0.001;

/* How many neighbours per class contribute to a score. */
const NEIGHBOURS = 3;

function readJson(relative) {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) {
    console.error(`train: ${relative} is missing — run the earlier pipeline steps first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

const compiled = readJson('data/ai/training/compiled.json');
const vocabulary = readJson('server/models/ai/vocabulary.json');

/* ---------------- build example vectors ---------------- */

const intents = [];
const exampleCounts = new Map();
const examples = {};
let totalExamples = 0;
let skipped = 0;

for (const group of compiled.training) {
  const intent = group.intent;
  intents.push(intent);
  exampleCounts.set(intent, group.examples.length);
  examples[intent] = [];

  for (const text of group.examples) {
    totalExamples++;
    const vector = vectorize(analyze(text).keywords, vocabulary);
    if (!vector.size) {
      skipped++;
      continue;
    }
    const sparse = {};
    for (const [token, weight] of vector) {
      if (weight >= WEIGHT_FLOOR) sparse[token] = Number(weight.toFixed(6));
    }
    examples[intent].push(sparse);
  }
}

if (!totalExamples) {
  console.error('train: no training documents — check data/ai/training/intents.jsonl');
  process.exit(1);
}

/* ---------------- centroids, for the feature report only ----------------
   Not used at inference time; kept so `npm run ai:train` can print which
   tokens characterise each intent, which is the quickest way to spot a
   mislabelled example. */

const centroids = {};
for (const intent of intents) {
  const accumulator = new Map();
  for (const sparse of examples[intent]) {
    for (const [token, weight] of Object.entries(sparse)) {
      accumulator.set(token, (accumulator.get(token) || 0) + weight);
    }
  }
  let norm = 0;
  for (const weight of accumulator.values()) norm += weight * weight;
  norm = Math.sqrt(norm) || 1;
  const centroid = {};
  for (const [token, weight] of accumulator) centroid[token] = weight / norm;
  centroids[intent] = centroid;
}

/* ---------------- sanity: self-check on the training set ---------------- */

let selfCorrect = 0;
let selfTotal = 0;
const selfMisses = [];

for (const group of compiled.training) {
  for (const text of group.examples) {
    const vector = vectorize(analyze(text).keywords, vocabulary);
    if (!vector.size) continue;
    let best = null;
    let bestScore = -Infinity;
    for (const intent of intents) {
      const list = examples[intent] || [];
      if (!list.length) continue;
      const top = list
        .map((exampleVector) => cosine(vector, exampleVector))
        .sort((a, b) => b - a)
        .slice(0, NEIGHBOURS);
      const score = top.reduce((sum, value) => sum + value, 0) / top.length;
      if (score > bestScore) { bestScore = score; best = intent; }
    }
    selfTotal++;
    if (best === group.intent) selfCorrect++;
    else if (selfMisses.length < 10) selfMisses.push(`"${text}" → ${best} (expected ${group.intent})`);
  }
}

/* ---------------- strongest features, for inspection ---------------- */

const topTokens = {};
for (const intent of intents) {
  topTokens[intent] = Object.entries(centroids[intent])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([token, weight]) => ({ token, weight: Number(weight.toFixed(6)) }));
}

/* ---------------- write artefacts ---------------- */

fs.mkdirSync(path.join(MODEL_DIR, 'weights'), { recursive: true });

const classifier = {
  version: '3.0.0',
  algorithm: 'tfidf-knn-cosine',
  trainedAt: new Date().toISOString(),
  vocabularySize: vocabulary.size,
  totalExamples,
  skippedExamples: skipped,
  neighbours: NEIGHBOURS,
  weightFloor: WEIGHT_FLOOR,
  intents,
  examples,
  exampleCounts: Object.fromEntries(exampleCounts),
  topTokens,
  selfCheck: {
    correct: selfCorrect,
    total: selfTotal,
    accuracy: selfTotal ? Number((selfCorrect / selfTotal).toFixed(4)) : 0,
  },
};

const classifierPath = path.join(MODEL_DIR, 'weights', 'classifier.json');
fs.writeFileSync(classifierPath, JSON.stringify(classifier, null, 2) + '\n', 'utf8');

/* A tiny runtime manifest: the engine reads this instead of stat-ing files. */
const model = {
  version: '3.0.0',
  name: 'savehatke-ai',
  algorithm: 'tfidf-knn-cosine + rule-boost + knowledge retrieval',
  trainedAt: classifier.trainedAt,
  vocabularySize: vocabulary.size,
  intents: intents.length,
  trainingExamples: totalExamples,
  selfCheckAccuracy: classifier.selfCheck.accuracy,
  thresholds: compiled.thresholds,
  files: {
    classifier: 'weights/classifier.json',
    vocabulary: 'vocabulary.json',
    intents: 'intents.json',
    knowledge: '../../../data/ai/knowledge.json',
    responses: '../../../data/ai/responses.json',
  },
};

const modelPath = path.join(MODEL_DIR, 'model.json');
fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + '\n', 'utf8');

/* The runtime loads the intent snapshot so a trained model and its
   definitions can never get out of step. */
const intentsSnapshot = {
  version: compiled.version,
  thresholds: compiled.thresholds,
  intents: compiled.intents,
};
const intentsPath = path.join(MODEL_DIR, 'intents.json');
fs.writeFileSync(intentsPath, JSON.stringify(intentsSnapshot, null, 2) + '\n', 'utf8');

/* ---------------- report ---------------- */

console.log('train: OK');
console.log(`  algorithm         ${classifier.algorithm} (k=${NEIGHBOURS})`);
console.log(`  intents           ${intents.length}`);
console.log(`  examples          ${totalExamples}${skipped ? ` (${skipped} had no in-vocabulary tokens)` : ''}`);
console.log(`  vocabulary        ${vocabulary.size}`);
console.log(`  self-check        ${selfCorrect}/${selfTotal} (${(classifier.selfCheck.accuracy * 100).toFixed(1)}%) on the training set`);
console.log('  strongest features per intent:');
for (const intent of intents.slice(0, 6)) {
  console.log(`    ${intent.padEnd(20)} ${topTokens[intent].slice(0, 5).map((t) => t.token).join(', ')}`);
}
if (selfMisses.length) {
  console.log('  self-check misses:');
  selfMisses.forEach((m) => console.log(`    ! ${m}`));
}
console.log(`  wrote ${path.relative(ROOT, classifierPath)}`);
console.log(`  wrote ${path.relative(ROOT, modelPath)}`);
console.log(`  wrote ${path.relative(ROOT, intentsPath)}`);
console.log('\n  next: npm run ai:eval');
