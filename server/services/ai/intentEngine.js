/* ============================================================
   SaveHatke AI — intent engine.

   Layer 2 of the engine. Turns a token stream into:
     { intent, confidence, entities }

   The classifier is a TF-IDF centroid model with cosine similarity:

     * every training example becomes an L2-normalised TF-IDF vector;
     * each intent is the L2-normalised mean of its examples' vectors;
     * a message is scored by cosine similarity against each centroid.

   Why this and not Naive Bayes: cosine similarity produces an
   interpretable 0..1 score with a useful spread for short text, which is
   exactly what the confidence thresholds need. A per-token likelihood
   model flattens into a narrow band on 3-6 word messages and loses the
   separation entirely.

   On top of the statistical score sits a rule layer of high-precision
   regexes from data/ai/intents.json. Rules never decide alone: they
   confirm a confident guess, or rescue a genuinely ambiguous one.

   Confidence policy — enforced here, honoured by the tool router:
     >= AI_HIGH_CONFIDENCE      high    → tools may run
     >= AI_CONFIDENCE_THRESHOLD medium  → tools may run ONLY on a rule match
     <  AI_CONFIDENCE_THRESHOLD low     → never run a tool; ask the user

   Nothing here touches the network, the database or the user's identity.
   ============================================================ */

import { getAIConfig } from './config.js';
import { loadModel } from './modelLoader.js';
import { analyze, detectBrandsAndCategories, stem } from './tokenizer.js';

const UNKNOWN = 'UNKNOWN';

/* A rule must be at least this long before it is allowed to override the
   classifier. Short patterns like "\bsee you\b" are useful as confirmation
   but too blunt to overrule a statistical result. */
const MIN_RULE_SPECIFICITY = 10;

/* ---------------- when may a rule overrule the classifier? ----------------

   The rule layer exists to RESCUE the classifier, never to contradict it
   when the classifier is sure. Two hand-written cases need rescuing:

     "good to see you"          GOODBYE 0.740  → GREETING (the \bsee you\b
                                                 pattern fires on a greeting)
     "what is my account balance"  PAYOUT_LADDER 0.567 → ACCOUNT

   Both are cases where the classifier's own best match is weak or plainly
   wrong. But the same override mechanism silently corrupts cases where the
   classifier is right and confident:

     "can i change the photo on my account"   PROFILE 1.000 → ACCOUNT
     "i am worried someone got into my account" SECURITY 0.848 → ACCOUNT
     "i would like to list a coupon for sale"   SELL_COUPON 0.787 → SEARCH

   In each of those a broad rule (ACCOUNT matches on "my account"; SEARCH
   matches on "list") overruled a near-exact statistical match. The
   distinguishing signal is not the rule, it is the classifier's own
   confidence, so the override is gated on two independent tests and is
   allowed only when BOTH say the classifier is unsure:

     * absolute — the top similarity is low in its own right, or
     * relative — the rule's intent is almost as well supported as the top,
                    meaning the classifier is genuinely torn between them.

   With the thresholds below, all three corrupting cases fail both tests
   (1.000/0.848/0.787 all exceed ABS, and their rule intents sit at
   0.688/0.465/0.640 of the top, under RATIO), while both rescues pass.

   An exact token-set match overrides both tests: if the message is
   literally a phrasing the model was trained on, no regex is better
   evidence. "where is my payout" is a PAYOUT_STATUS training example at
   similarity 1.0, yet WEBSITE_NAVIGATION's "\bwhere\b" pattern sits at 0.76
   of that — close enough to pass the relative test and steal the turn. */
const RULE_OVERRIDE_MAX_SIMILARITY = 0.76;
const RULE_OVERRIDE_MIN_RATIO = 0.7;

function ruleMayOverride(topSimilarity, ruleSimilarity, topExact) {
  if (topExact) return false;
  if (!(topSimilarity > 0)) return true;
  if (topSimilarity < RULE_OVERRIDE_MAX_SIMILARITY) return true;
  return ruleSimilarity >= topSimilarity * RULE_OVERRIDE_MIN_RATIO;
}

/* Intents whose subject is open-vocabulary: the user names a thing that no
   fixed list can enumerate, and the live data source is the authority on
   whether it exists. See the coverage gate in classifyIntent. */
const OPEN_VOCABULARY_INTENTS = new Set(['SEARCH_COUPON']);

/* The idf given to a token the model has never seen. Rare by definition,
   so it is treated as maximally informative. Shared with the knowledge
   engine, which uses the same convention. The vocabulary's idf is computed
   per INTENT, so the ceiling here is the idf of a token unique to one
   intent. */
export const MAX_IDF = 4;

/* ---------------- vector maths ----------------
   `vectorize` and `cosine` are exported because scripts/ai/train.js uses
   the identical functions to build the centroids. Keeping one
   implementation is what guarantees training and inference agree. */

/**
 * L2-normalised sublinear TF-IDF vector over a vocabulary.
 *
 * @param {string[]} tokens
 * @param {{tokens:Object}} vocabulary
 * @returns {Map<string, number>}
 */
export function vectorize(tokens, vocabulary) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);

  const vector = new Map();
  let norm = 0;
  for (const [token, count] of tf) {
    const entry = vocabulary?.tokens?.[token];
    if (!entry) continue; // out-of-vocabulary tokens carry no centroid weight
    const weight = (1 + Math.log(count)) * entry.idf;
    vector.set(token, weight);
    norm += weight * weight;
  }

  norm = Math.sqrt(norm);
  if (!norm) return new Map();
  for (const [token, weight] of vector) vector.set(token, weight / norm);
  return vector;
}

/** Cosine similarity. Both sides are expected to be L2-normalised. */
export function cosine(vector, centroid) {
  let dot = 0;
  const isMap = centroid instanceof Map;
  for (const [token, weight] of vector) {
    const other = isMap ? centroid.get(token) : centroid?.[token];
    if (other) dot += weight * other;
  }
  return dot;
}

/**
 * How much of the message the model actually recognises, weighted by how
 * informative each token is. An unknown word counts as maximally
 * informative, so a message full of unknown words scores near zero.
 *
 * `recognised` holds tokens the tokenizer's own gazetteer matched — brand and
 * category names. They count as known even when the intent vocabulary has
 * never seen them, because the engine DID recognise them. Without this,
 * "show me adidas coupons" scores coverage 0.49 and is thrown away as
 * uncertain, purely because the training data happens to mention Nike and
 * not Adidas. A brand name is the single most common word in a coupon search,
 * so treating an unrecognised one as noise breaks the main use case.
 */
function tokenCoverage(tokens, vocabulary, recognised) {
  let known = 0;
  let total = 0;
  for (const token of tokens) {
    const entry = vocabulary?.tokens?.[token];
    const idf = entry ? entry.idf : MAX_IDF;
    total += idf;
    if (entry || recognised?.has(token)) known += idf;
  }
  return total ? known / total : 0;
}

/* A token is an "anchor" when it is specific to a small number of intents.
   One anchor is enough to answer; a message whose only recognised words are
   spread across many intents ("tell", "how", "what") is not answerable even
   if the distribution looks peaked. */
const ANCHOR_MAX_DF = 2;

function hasAnchor(tokens, vocabulary) {
  for (const token of tokens) {
    const entry = vocabulary?.tokens?.[token];
    if (entry && entry.df <= ANCHOR_MAX_DF) return true;
  }
  return false;
}

/* The anchor gate is a proxy for "do we actually understand this?", and the
   classifier's own distribution answers that question directly. When one
   intent is both highly likely and clearly separated from the runner-up, a
   missing rare token is not a reason to refuse.

   Regression: "how much can i earn" scored EARNINGS 0.920 against a runner-up
   of 0.045 — the model is certain — and was still refused, because "earn"
   appears in three intents' training data and so fails the df<=2 anchor test.
   The user was asked to rephrase one of the most natural questions a seller
   can ask. "how does earning work" (0.913 / 0.031) failed the same way.

   This does not open the door to off-topic answers. The coverage gate is
   applied independently below and is the real separator: every off-topic case
   in the held-out set scores coverage 0.00-0.67, while every one of these
   questions scores 1.00. A peaked distribution over a message full of unknown
   words is exactly the false confidence the coverage gate exists to catch —
   "who won the world cup in 2011" is peaked at 0.964 and stays refused. */
const ANCHOR_EXEMPT_MIN_MARGIN = 0.25;

function isDecisive(ranking, config) {
  const top = ranking[0];
  if (!top) return false;
  const second = ranking[1]?.score ?? 0;
  return top.score >= config.highConfidence
    && (top.score - second) >= ANCHOR_EXEMPT_MIN_MARGIN;
}

/* ---------------- rule layer ---------------- */

function compileRules(intents) {
  const compiled = [];
  if (!intents) return compiled;
  for (const [intent, def] of Object.entries(intents)) {
    const patterns = Array.isArray(def.patterns) ? def.patterns : [];
    for (const source of patterns) {
      try {
        compiled.push({ intent, source, re: new RegExp(source, 'i') });
      } catch {
        // A bad pattern must never take the engine down; it is simply skipped.
      }
    }
  }
  return compiled;
}

function matchRules(text, rules) {
  return rules.filter((rule) => rule.re.test(text));
}

/* ---------------- classifier ---------------- */

function softmax(values, temperature) {
  const scaled = values.map((v) => v * temperature);
  const max = Math.max(...scaled);
  let sum = 0;
  const exps = scaled.map((v) => {
    const e = Math.exp(v - max);
    sum += e;
    return e;
  });
  return exps.map((e) => e / (sum || 1));
}

/* Whether two sparse vectors cover exactly the same tokens. Both sides only
   ever contain in-vocabulary tokens, so this asks "is the part of the message
   the model understands identical to a training example?" — which is the
   strongest non-rule evidence available. */
function sameKeySet(queryKeys, exampleVector) {
  const keys =
    exampleVector instanceof Map ? [...exampleVector.keys()] : Object.keys(exampleVector);
  if (keys.length !== queryKeys.size) return false;
  for (const key of keys) if (!queryKeys.has(key)) return false;
  return true;
}

/**
 * Scores every intent and returns the ranked distribution.
 *
 * Scoring is nearest-neighbour rather than centroid-based: each intent is
 * scored by its single closest training example. For short messages this is
 * markedly better than a centroid, because a 3-token query against a 4-token
 * example that shares 3 tokens scores ~0.8, while the same query against the
 * 40-token mean of the whole class scores ~0.2 — under-confident to the point
 * of being useless.
 *
 * Each entry also reports `exact`, meaning the winning example has the same
 * token set as the query. classifyIntent uses that to bypass the heuristic
 * gates below.
 *
 * @returns {{ranking:Array<{intent:string,score:number,similarity:number,exact:boolean}>,
 *            coverage:number, inVocabulary:number, totalTokens:number}}
 */
function scoreIntents(tokens, bundle, config, recognised) {
  const vocabulary = bundle.vocabulary;
  const classifier = bundle.classifier;

  const coverage = tokenCoverage(tokens, vocabulary, recognised);
  const vector = classifier ? vectorize(tokens, vocabulary) : new Map();

  if (!classifier || !vector.size) {
    return { ranking: [], coverage, inVocabulary: 0, totalTokens: tokens.length };
  }

  const examples = classifier.examples || {};
  const queryKeys = new Set(vector.keys());

  // "Exact" must mean the message matched an example in full. The vector only
  // holds in-vocabulary tokens, so a message whose words are mostly unknown
  // projects down to a tiny vector that can coincide with an unrelated
  // example: "how do i cook biryani" reduces to {how} and would exactly match
  // the example "how are you". Requiring every content token to be known is
  // what makes the flag mean what it says.
  const allKnown = tokens.every((token) => Boolean(vocabulary?.tokens?.[token]));

  const scored = classifier.intents.map((intent) => {
    const vectors = examples[intent] || [];
    if (!vectors.length) return { similarity: 0, exact: false };
    // Nearest-neighbour similarity, not a mean. Averaging the top few
    // neighbours dilutes a single strong match with zero-similarity ones:
    // "catch you soon" matches "catch you later" at 0.71, but the mean over
    // three neighbours drops it to 0.24 and the intent is lost.
    let best = 0;
    let exact = false;
    for (const exampleVector of vectors) {
      const score = cosine(vector, exampleVector);
      if (score > best) {
        best = score;
        exact = allKnown && sameKeySet(queryKeys, exampleVector);
      }
    }
    return { similarity: best, exact };
  });

  const probs = softmax(
    scored.map((s) => s.similarity),
    config.confidenceTemperature
  );

  const ranking = classifier.intents
    .map((intent, index) => ({
      intent,
      score: Number(probs[index].toFixed(6)),
      similarity: Number(scored[index].similarity.toFixed(4)),
      exact: scored[index].exact,
    }))
    .sort((a, b) => b.score - a.score);

  return { ranking, coverage, inVocabulary: vector.size, totalTokens: tokens.length };
}

/* ---------------- entity extraction ---------------- */

const DIRECTION_MAX = /(under|below|less than|less then|upto|up to|max|maximum|cheaper|within|se\s+kam|kam)\s*$/i;
const DIRECTION_MIN = /(over|above|more than|greater|minimum|min|at least|se\s+(zyada|jyada|adhik)|zyada|jyada)\s*$/i;

const DATE_TOKEN_RE = /date_([a-z_]+)/g;
const DATE_WORD_RE = /\b(today|tomorrow|yesterday|tonight|this week|next week|last week|this month|next month|last month|this year|last year)\b/i;
const MONTH_DAY_RE = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;
const DAY_MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*(\d{1,2})\b/i;

function toNumber(raw) {
  const value = Number.parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Pulls money amounts and their direction out of the normalised text. */
function extractPrices(normalized, rawText) {
  const out = {};
  const moneyRe = /money(\d+(?:\.\d+)?)/g;
  let match;

  while ((match = moneyRe.exec(normalized)) !== null) {
    const amount = toNumber(match[1]);
    if (amount === null) continue;
    const prefix = normalized.slice(Math.max(0, match.index - 26), match.index).trim();
    if (DIRECTION_MAX.test(prefix)) out.maxPrice = amount;
    else if (DIRECTION_MIN.test(prefix)) out.minPrice = amount;
    else if (out.price === undefined) out.price = amount;
  }

  // Hinglish "100 se kam" / "500 se zyada" has no currency marker, so the
  // money normaliser never fires for it. Catch it on the raw text.
  const hinglish = rawText.match(/(\d[\d,]*)\s*(?:rupees?|rupaye)?\s*se\s*(kam|zyada|jyada|adhik)/i);
  if (hinglish) {
    const amount = toNumber(hinglish[1]);
    if (amount !== null) {
      if (/kam/i.test(hinglish[2])) out.maxPrice = amount;
      else out.minPrice = amount;
    }
  }

  // A direction word followed by a bare number — "under 400", "below 1500",
  // "over 500" — carries no currency marker at all, so it never becomes a
  // money token. Without this, "show me Lenskart coupons below 400" loses
  // the 400 entirely.
  if (out.maxPrice === undefined) {
    const max = rawText.match(
      /\b(?:under|below|less than|less then|upto|up to|max|maximum|cheaper than|within)\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)/i
    );
    if (max) {
      const amount = toNumber(max[1]);
      if (amount !== null) out.maxPrice = amount;
    }
  }
  if (out.minPrice === undefined) {
    const min = rawText.match(
      /\b(?:over|above|more than|greater than|minimum|min|at least)\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)/i
    );
    if (min) {
      const amount = toNumber(min[1]);
      if (amount !== null) out.minPrice = amount;
    }
  }

  // "worth 300" / "valued at 300" — value wording with no currency symbol.
  if (out.price === undefined) {
    const worth = rawText.match(/\b(?:worth|valued at|value of|costing|costs?)\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)/i);
    if (worth) {
      const amount = toNumber(worth[1]);
      if (amount !== null) out.price = amount;
    }
  }

  return out;
}

/** Finds dates, either as a relative phrase or an explicit day/month. */
function extractDates(normalized, rawText) {
  const out = {};
  const tokens = [...normalized.matchAll(DATE_TOKEN_RE)].map((m) => m[1].replace(/_/g, ' '));
  if (tokens.length) {
    const first = tokens[0];
    if (/week|month|year/.test(first)) out.dateRange = first;
    else out.date = first;
  }
  if (!out.date && !out.dateRange) {
    const word = rawText.match(DATE_WORD_RE);
    if (word) {
      const value = word[1].toLowerCase();
      if (/week|month|year/.test(value)) out.dateRange = value;
      else out.date = value;
    }
  }
  const monthDay = rawText.match(MONTH_DAY_RE);
  if (monthDay) out.date = `${monthDay[1]} ${monthDay[2]}`;
  const dayMonth = rawText.match(DAY_MONTH_RE);
  if (dayMonth) out.date = `${dayMonth[2]} ${dayMonth[1]}`;
  return out;
}

function extractPlatform(normalized) {
  if (/\bapp\b|\bmobile\b|\bandroid\b|\bios\b|\bphone\b/.test(normalized)) return 'app';
  if (/\bwebsite\b|\bsite\b|\bweb\b|\bdesktop\b|\bbrowser\b|\bpage\b/.test(normalized)) return 'website';
  return null;
}

/**
 * @param {string} rawText
 * @returns {object} sparse entity map — absent keys are simply not present
 */
export function extractEntities(rawText) {
  const analysis = analyze(rawText);
  const normalized = analysis.normalized;
  const entities = {};

  // Brands and categories, ordered by where they appear so the leading
  // brand is the one the user actually named first.
  const { brands, categories } = detectBrandsAndCategories(normalized);
  if (brands.length) {
    const positioned = brands
      .map((brand) => ({ brand, at: normalized.toLowerCase().indexOf(brand.toLowerCase()) }))
      .sort((a, b) => (a.at === -1 ? 1e9 : a.at) - (b.at === -1 ? 1e9 : b.at));
    entities.brand = positioned[0].brand;
    if (positioned.length > 1) entities.brands = positioned.map((b) => b.brand);
  }
  if (categories.length) {
    entities.category = categories[0];
    if (categories.length > 1) entities.categories = categories;
  }

  Object.assign(entities, extractPrices(normalized, rawText));
  Object.assign(entities, extractDates(normalized, rawText));

  const platform = extractPlatform(normalized);
  if (platform) entities.platform = platform;

  // Identifiers were protected during tokenisation, so they survive intact.
  if (analysis.entities.couponId.length) entities.couponId = analysis.entities.couponId[0];
  if (analysis.entities.ticketId.length) entities.ticketId = analysis.entities.ticketId[0];

  // A residual query string for the live coupon search: the message with
  // the machinery removed, so it can be passed straight to the API.
  const searchQuery = normalized
    .replace(/money\d+(?:\.\d+)?/g, ' ')
    .replace(/date_[a-z_]+/g, ' ')
    .replace(/(email|url|couponid|ticketid)token/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (searchQuery) entities.searchQuery = searchQuery;

  return entities;
}

/* ---------------- public API ---------------- */

/**
 * Classifies a message.
 *
 * @param {string} message
 * @param {{ bundle?:object }} [options]
 * @returns {{
 *   intent:string, confidence:number, entities:object,
 *   alternatives:Array<{intent:string,score:number,similarity:number}>,
 *   rule:{matched:boolean, patterns:string[]},
 *   coverage:number, degraded:boolean
 * }}
 */
export function classifyIntent(message, options = {}) {
  const config = getAIConfig();
  const bundle = options.bundle || loadModel();
  const text = String(message || '');
  const entities = extractEntities(text);

  if (!text.trim()) {
    return {
      intent: UNKNOWN,
      confidence: 0,
      entities,
      alternatives: [],
      rule: { matched: false, patterns: [] },
      coverage: 0,
      degraded: bundle.degraded,
    };
  }

  const analysis = analyze(text);
  // Content tokens only: stopwords are removed here because they appear in
  // almost every intent and would otherwise make every message look similar.
  const features = analysis.keywords;

  // Brand and category names the gazetteer matched, in the same stemmed form
  // the token stream uses, so coverage can count them as recognised. See
  // tokenCoverage: without this, an unknown brand sinks the whole message.
  const recognised = new Set();
  const namedEntities = [
    entities.brand, entities.category,
    ...(entities.brands || []), ...(entities.categories || []),
  ];
  for (const name of namedEntities) {
    if (!name) continue;
    for (const word of String(name).toLowerCase().split(/\s+/)) {
      if (word) recognised.add(stem(word));
    }
  }

  const rules = compileRules(bundle.intents?.intents);
  const matches = matchRules(analysis.normalized, rules);
  const matchedIntents = [...new Set(matches.map((m) => m.intent))];

  // The most specific rule that fired: longest pattern, on the reasoning
  // that "\b(good|nice) to see you\b" is a stronger statement about the
  // message than "\bsee you\b", which is a substring of it.
  let ruleWinner = null;
  let ruleWinnerLength = 0;
  for (const intent of matchedIntents) {
    const longest = Math.max(...matches.filter((m) => m.intent === intent).map((m) => m.source.length));
    if (longest > ruleWinnerLength) {
      ruleWinnerLength = longest;
      ruleWinner = intent;
    }
  }

  const scored = scoreIntents(features, bundle, config, recognised);
  const top = scored.ranking[0];

  // --- Degraded mode: no trained model, so rules are all we have. ---
  if (!top) {
    if (ruleWinner) {
      return {
        intent: ruleWinner,
        confidence: 0.75,
        entities,
        alternatives: [],
        rule: { matched: true, patterns: matches.map((m) => m.source) },
        coverage: scored.coverage,
        degraded: bundle.degraded,
      };
    }
    return {
      intent: UNKNOWN,
      confidence: 0,
      entities,
      alternatives: [],
      rule: { matched: false, patterns: [] },
      coverage: scored.coverage,
      degraded: bundle.degraded,
    };
  }

  let intent = top.intent;
  let confidence = top.score;

  // An exact token-set match against a training example is deterministic
  // evidence, exactly like a rule match. It blocks the rule override below
  // and is exempt from the two heuristic gates further down. Without it,
  // "what do i need to do to purchase" — a literal training example scoring
  // similarity 1.0 — is still thrown away, because none of
  // "what/need/purchase" is individually rare enough to count as an anchor.
  const exactMatch = top.exact === true;

  const topLongest = matches
    .filter((m) => m.intent === intent)
    .reduce((max, m) => Math.max(max, m.source.length), 0);

  if (topLongest && topLongest >= ruleWinnerLength) {
    // The classifier agrees with the most specific rule that fired.
    confidence = Math.max(confidence, 0.95);
  } else if (ruleWinner && ruleWinnerLength >= MIN_RULE_SPECIFICITY) {
    // A more specific rule contradicts the classifier. The rule layer is
    // hand-written to be high precision, so it wins — but only while the
    // classifier is genuinely unsure. See ruleMayOverride above: without
    // that gate a broad rule silently overrules an exact match.
    const topSimilarity = top.similarity || 0;
    const ruleSimilarity =
      scored.ranking.find((r) => r.intent === ruleWinner)?.similarity || 0;
    if (ruleMayOverride(topSimilarity, ruleSimilarity, exactMatch)) {
      intent = ruleWinner;
      confidence = Math.max(confidence, 0.9);
    }
  }

  // A message made mostly of words the model has never seen cannot be
  // trusted, however peaked the distribution looks.
  //
  // Two exemptions apply. An exact token-set match is deterministic evidence.
  // And a coupon search is OPEN-VOCABULARY by nature: the user names a brand,
  // product or merchant, and there is no closed list of those — the gazetteer
  // cannot enumerate every brand the marketplace will ever list, and the live
  // API is the authority on whether a term exists. The structure ("show me X
  // coupons") is the evidence, and the API answers "no listings" for a term
  // it does not have. Without this, every brand outside the gazetteer was
  // refused as UNKNOWN, which is the single most common request the chatbot
  // receives. The gate still applies everywhere else, so "hello world program
  // in java" stays UNKNOWN.
  const coverageExempt =
    exactMatch || matches.some((m) => OPEN_VOCABULARY_INTENTS.has(m.intent));

  if (scored.coverage < config.minTokenCoverage && !coverageExempt) {
    confidence = Math.min(confidence, 0.5);
  }

  // No anchor token means the only recognised words are ones shared across
  // many intents. That is the "tell me a joke" case: "tell" is real
  // vocabulary but says nothing about what is being asked. A rule match is
  // exempt, because that is deterministic evidence, and so is a decisively
  // separated distribution — see isDecisive.
  if (!matches.length && !exactMatch && !hasAnchor(features, bundle.vocabulary)
      && !isDecisive(scored.ranking, config)) {
    confidence = Math.min(confidence, 0.5);
  }

  // One content word is thin evidence: "thats it for now" reduces to a
  // single shared token and would otherwise match confidently on it.
  if (features.length < 2 && !matches.length && !exactMatch) {
    confidence = Math.min(confidence, 0.5);
  }

  confidence = Number(Math.min(0.99, Math.max(0, confidence)).toFixed(4));

  if (confidence < config.confidenceThreshold) {
    return {
      intent: UNKNOWN,
      confidence,
      entities,
      alternatives: scored.ranking.slice(0, 3),
      rule: { matched: matches.length > 0, patterns: matches.map((m) => m.source) },
      coverage: scored.coverage,
      degraded: bundle.degraded,
    };
  }

  const finalMatches = matches.filter((m) => m.intent === intent);
  return {
    intent,
    confidence,
    entities,
    alternatives: scored.ranking.slice(0, 3),
    rule: { matched: finalMatches.length > 0, patterns: finalMatches.map((m) => m.source) },
    coverage: scored.coverage,
    degraded: bundle.degraded,
  };
}

/**
 * Whether a tool may be executed for this classification.
 * Medium confidence is only actionable when a deterministic rule matched.
 */
export function isActionable(classification, config = getAIConfig()) {
  if (!classification || classification.intent === UNKNOWN) return false;
  if (classification.confidence >= config.highConfidence) return true;
  return classification.confidence >= config.confidenceThreshold && classification.rule?.matched === true;
}

export { UNKNOWN as UNKNOWN_INTENT };
