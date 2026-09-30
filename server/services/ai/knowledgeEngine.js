/* ============================================================
   SaveHatke AI — knowledge engine.

   Layer 3 of the engine. A lightweight retrieval system over
   data/ai/knowledge.json.

   The point of retrieval is that we do NOT stuff the whole knowledge base
   into a prompt. Only the entries that actually relate to what was asked
   are returned, ranked, and capped at AI_KNOWLEDGE_TOP_K.

   Scoring is deliberately transparent rather than learned — it is four
   signals, weighted and summed:

     keyword overlap   (idf-weighted)  the strongest signal
     token overlap     (idf-weighted)  catches paraphrases the keywords miss
     intent match                      the classifier already told us
     category match                    the intent's expected topic area

   Preprocessing is memoised per loaded model bundle, so a warm runtime
   pays for tokenisation once, not once per request.
   ============================================================ */

import { getAIConfig } from './config.js';
import { loadModel } from './modelLoader.js';
import { analyze, stem, STOPWORD_SET, NEGATION_SET } from './tokenizer.js';

/** @type {WeakMap<object, Map<string, object>>} */
const preparedCache = new WeakMap();

const WEIGHTS = Object.freeze({
  keyword: 0.55,
  token: 0.30,
  intent: 0.20,
  category: 0.10,
});

function idfFor(token, bundle) {
  const entry = bundle.vocabulary?.tokens?.[token];
  // An unknown token is informative by definition — it is rare — so it gets
  // the maximum useful weight rather than zero.
  return entry ? Math.max(0.5, entry.idf) : 3;
}

function contentTokens(text) {
  return (analyze(text).stemmed || []).filter(
    (token) => token.length > 1 && (NEGATION_SET.has(token) || !STOPWORD_SET.has(token))
  );
}

/** Preprocesses every entry once per bundle. */
function preparedEntries(bundle) {
  let prepared = preparedCache.get(bundle);
  if (prepared) return prepared;

  prepared = new Map();
  for (const entry of bundle.knowledge || []) {
    if (!entry || entry.enabled === false || typeof entry.answer !== 'string') continue;

    const keywords = (entry.keywords || []).map((k) => stem(String(k).toLowerCase()));
    const keywordSet = new Set(keywords);
    const keywordWeight = keywords.reduce((sum, k) => sum + idfFor(k, bundle), 0) || 1;

    // Question + answer text, minus the keywords (already counted).
    const bodyTokens = [...new Set(contentTokens(`${entry.question} ${entry.answer}`))]
      .filter((token) => !keywordSet.has(token));
    const bodyWeight = bodyTokens.reduce((sum, t) => sum + idfFor(t, bundle), 0) || 1;

    prepared.set(entry.id, {
      entry,
      keywordSet,
      keywordWeight,
      bodyTokens,
      bodyWeight,
      intents: new Set(entry.intents || []),
      category: entry.category,
    });
  }

  preparedCache.set(bundle, prepared);
  return prepared;
}

/**
 * Ranks knowledge entries for a query.
 *
 * @param {{
 *   message?:string, query?:string, intent?:string|null,
 *   entities?:object, bundle?:object, limit?:number
 * }} options
 * @returns {Array<{id:string, category:string, question:string, answer:string,
 *                  score:number, signals:object, verified:boolean}>}
 */
export function retrieveKnowledge(options = {}) {
  const config = getAIConfig();
  const bundle = options.bundle || loadModel();
  const limit = options.limit ?? config.knowledgeTopK;
  const minScore = options.minScore ?? config.knowledgeMinScore;

  if (bundle.degraded || !bundle.knowledge?.length) return [];

  const text = options.query || options.message || '';
  const analysis = analyze(text);
  const queryTokens = new Set(
    (analysis.stemmed || []).filter(
      (token) => token.length > 1 && (NEGATION_SET.has(token) || !STOPWORD_SET.has(token))
    )
  );
  const intent = options.intent || null;

  // The intent's expected topic areas, from data/ai/intents.json.
  const intentDef = intent ? bundle.intents?.intents?.[intent] : null;
  const expectedCategories = new Set(intentDef?.knowledgeCategories || []);

  if (!queryTokens.size && !intent) return [];

  const results = [];
  for (const prepared of preparedEntries(bundle).values()) {
    const { entry, keywordSet, keywordWeight, bodyTokens, bodyWeight, intents, category } = prepared;

    let matchedKeywordWeight = 0;
    const matchedKeywords = [];
    for (const token of queryTokens) {
      if (keywordSet.has(token)) {
        matchedKeywordWeight += idfFor(token, bundle);
        matchedKeywords.push(token);
      }
    }

    let matchedBodyWeight = 0;
    for (const token of bodyTokens) {
      if (queryTokens.has(token)) matchedBodyWeight += idfFor(token, bundle);
    }

    const intentMatch = intent ? intents.has(intent) : false;
    const categoryMatch = expectedCategories.has(category);

    // Candidate gate: lexical overlap OR an intent match. This is what stops
    // the intent boost from surfacing an unrelated entry on its own.
    if (!matchedKeywords.length && matchedBodyWeight === 0 && !intentMatch) continue;

    const keywordScore = matchedKeywordWeight / keywordWeight;
    const tokenScore = matchedBodyWeight / bodyWeight;

    const raw =
      WEIGHTS.keyword * keywordScore +
      WEIGHTS.token * tokenScore +
      (intentMatch ? WEIGHTS.intent : 0) +
      (categoryMatch ? WEIGHTS.category : 0);

    const score = Number(Math.min(1, raw).toFixed(4));
    if (score < minScore) continue;

    results.push({
      id: entry.id,
      category,
      question: entry.question,
      answer: entry.answer,
      verified: entry.verified !== false,
      score,
      signals: {
        keywords: matchedKeywords.slice(0, 8),
        keywordScore: Number(keywordScore.toFixed(3)),
        tokenScore: Number(tokenScore.toFixed(3)),
        intentMatch,
        categoryMatch,
      },
    });
  }

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, limit);
}

/** The single best hit, or null. */
export function bestKnowledge(options = {}) {
  return retrieveKnowledge({ ...options, limit: 1 })[0] || null;
}

/**
 * Free-text knowledge search, used by the `search_knowledge` tool and the
 * FAQ intent. Slightly more permissive than retrieval: it will fall back to
 * a plain substring scan so a user searching for a distinctive word
 * ("whitelist") always gets something back.
 */
export function searchKnowledge(query, { bundle, limit = 3 } = {}) {
  const resolved = bundle || loadModel();
  if (resolved.degraded || !resolved.knowledge?.length) return [];

  const ranked = retrieveKnowledge({ query, bundle: resolved, limit });
  if (ranked.length) return ranked;

  const needle = String(query || '').toLowerCase().trim();
  if (needle.length < 3) return [];

  return resolved.knowledge
    .filter((entry) => entry && entry.enabled !== false)
    .filter((entry) => {
      const haystack = `${entry.question} ${entry.answer} ${(entry.keywords || []).join(' ')}`.toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      verified: entry.verified !== false,
      score: 0.2,
      signals: { keywords: [needle], substring: true },
    }));
}

/** Which knowledge entries belong to an intent, ignoring the query text. */
export function knowledgeForIntent(intent, { bundle, limit = 3 } = {}) {
  return retrieveKnowledge({ intent, query: '', bundle, limit });
}

export function resetKnowledgeCache() {
  // The cache is keyed by bundle object; dropping the model cache is enough
  // for tests because the next loadModel() returns a new bundle object.
}
