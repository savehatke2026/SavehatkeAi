/* ============================================================
   SaveHatke AI — model loader.

   Loads the trained artefacts and the retrieval data ONCE per warm
   runtime and hands out the cached copy. This is what keeps a serverless
   cold start cheap and a warm request free of disk I/O.

   Two deliberate behaviours:

   1. Graceful degradation. If an artefact is missing or corrupt the
      loader does not throw. It returns a `degraded` bundle and the engine
      falls back to its rule + knowledge layer, so /api/chat keeps working
      on a fresh clone or a partially-deployed instance. A chatbot that
      500s because a JSON file was not bundled is worse than one that
      answers slightly less cleverly.

   2. Nothing is loaded from the network, and nothing is written to disk
      at request time. Training is a build step, never a request step.

   Node runtime only (uses node:fs). Imported by api/chat.js, which
   declares `runtime: 'nodejs'`.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAIConfig } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Default artefact location: <repo>/server/models/ai */
const DEFAULT_MODEL_DIR = path.resolve(HERE, '..', '..', 'models', 'ai');
/* Default data location: <repo>/data/ai */
const DEFAULT_DATA_DIR = path.resolve(HERE, '..', '..', '..', 'data', 'ai');

/** @type {null | object} */
let cache = null;

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'not found' };
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function resolveDirs() {
  const config = getAIConfig();
  if (config.modelPath) {
    const base = path.isAbsolute(config.modelPath)
      ? config.modelPath
      : path.resolve(process.cwd(), config.modelPath);
    return { modelDir: base, dataDir: DEFAULT_DATA_DIR, overridden: true };
  }
  return { modelDir: DEFAULT_MODEL_DIR, dataDir: DEFAULT_DATA_DIR, overridden: false };
}

/** A working but untrained bundle, used when artefacts are unavailable. */
function degradedBundle(reason, dirs) {
  return {
    degraded: true,
    reason,
    loadedAt: Date.now(),
    modelDir: dirs.modelDir,
    dataDir: dirs.dataDir,
    model: null,
    vocabulary: null,
    classifier: null,
    intents: null,
    knowledge: [],
    responses: null,
    warnings: [`model artefacts unavailable (${reason}); running on rules + knowledge only`],
  };
}

/**
 * @returns {{
 *   degraded:boolean, reason?:string, loadedAt:number, modelDir:string,
 *   dataDir:string, model:object|null, vocabulary:object|null,
 *   classifier:object|null, intents:object|null, knowledge:object[],
 *   responses:object|null, warnings:string[]
 * }}
 */
export function loadModel() {
  if (cache) return cache;

  const dirs = resolveDirs();
  const warnings = [];

  const modelRead = readJsonFile(path.join(dirs.modelDir, 'model.json'));
  const classifierRead = readJsonFile(path.join(dirs.modelDir, 'weights', 'classifier.json'));
  const vocabularyRead = readJsonFile(path.join(dirs.modelDir, 'vocabulary.json'));
  const intentsRead = readJsonFile(path.join(dirs.modelDir, 'intents.json'));

  const knowledgeRead = readJsonFile(path.join(dirs.dataDir, 'knowledge.json'));
  const responsesRead = readJsonFile(path.join(dirs.dataDir, 'responses.json'));

  // The classifier is the only artefact the engine genuinely needs to be
  // "trained". Without it we degrade instead of failing.
  if (!classifierRead.ok) {
    cache = degradedBundle(`classifier ${classifierRead.error}`, dirs);
    return cache;
  }
  if (!vocabularyRead.ok) {
    cache = degradedBundle(`vocabulary ${vocabularyRead.error}`, dirs);
    return cache;
  }

  if (!modelRead.ok) warnings.push(`model.json ${modelRead.error} — using classifier defaults`);
  if (!intentsRead.ok) warnings.push(`intents.json ${intentsRead.error} — rule layer disabled`);
  if (!knowledgeRead.ok) warnings.push(`knowledge.json ${knowledgeRead.error} — retrieval disabled`);
  if (!responsesRead.ok) warnings.push(`responses.json ${responsesRead.error} — templates unavailable`);

  const intents = intentsRead.ok ? intentsRead.value : null;
  const responses = responsesRead.ok ? responsesRead.value : null;

  if (!responses) {
    // Without templates the engine cannot phrase an answer safely, so this
    // counts as degraded rather than merely warned about.
    cache = degradedBundle('responses.json unavailable', dirs);
    cache.warnings = warnings;
    return cache;
  }

  cache = {
    degraded: false,
    loadedAt: Date.now(),
    modelDir: dirs.modelDir,
    dataDir: dirs.dataDir,
    overridden: dirs.overridden,
    model: modelRead.ok ? modelRead.value : null,
    vocabulary: vocabularyRead.value,
    classifier: classifierRead.value,
    intents,
    knowledge: knowledgeRead.ok ? (knowledgeRead.value.entries || []) : [],
    responses,
    warnings,
  };

  return cache;
}

/**
 * Merges an admin-managed knowledge overlay on top of the file-based
 * knowledge base. The existing SaveHatke admin chatbot knowledge stays
 * authoritative for its own entries: an overlay entry with the same id
 * replaces the file entry, and new ids are appended.
 *
 * @param {object[]} overlay
 */
export function withKnowledgeOverlay(overlay) {
  const base = loadModel();
  if (!Array.isArray(overlay) || !overlay.length) return base;
  if (base.degraded) return base;

  const merged = new Map(base.knowledge.map((entry) => [entry.id, entry]));
  for (const entry of overlay) {
    if (entry && typeof entry.id === 'string') merged.set(entry.id, entry);
  }

  return { ...base, knowledge: [...merged.values()], knowledgeOverlayApplied: overlay.length };
}

/** Drops the cache. Used by tests and by the build scripts. */
export function resetModelCache() {
  cache = null;
}

/** Diagnostic summary — safe to log: no user data, no secrets. */
export function modelSummary() {
  const bundle = loadModel();
  if (bundle.degraded) return { degraded: true, reason: bundle.reason };
  return {
    degraded: false,
    trainedAt: bundle.model?.trainedAt || bundle.classifier?.trainedAt || null,
    intents: bundle.classifier?.intents?.length ?? 0,
    vocabularySize: bundle.vocabulary?.size ?? 0,
    trainingExamples: bundle.classifier?.totalExamples ?? 0,
    knowledgeEntries: bundle.knowledge.length,
    warnings: bundle.warnings,
  };
}
