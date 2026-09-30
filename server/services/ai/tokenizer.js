/* ============================================================
   SaveHatke AI — tokenizer.

   Layer 1 of the engine. Turns a raw message into a normalised token
   stream the classifier and the knowledge index can both consume.

   It deliberately handles three registers:
     * English
     * common Indian English
     * simple Hindi / Hinglish

   Design rules:
     * Entities that carry meaning are extracted BEFORE normalisation, so
       prices, dates, ids, emails and URLs are never destroyed by
       lowercasing or punctuation stripping.
     * Hinglish is not "translated away" — the canonical English token is
       ADDED alongside the original, so both forms contribute features.
     * Everything here is pure and dependency-free: it runs identically in
       the training scripts and in the request path.
   ============================================================ */

/* ---------------- brand + category lexicon ----------------
   Longest-first matching, so "nykaa fashion" beats "nykaa". */

export const BRANDS = Object.freeze([
  ['nykaa fashion', 'Nykaa Fashion'],
  ['book my show', 'BookMyShow'],
  ['bookmyshow', 'BookMyShow'],
  ['tata cliq', 'Tata CLiQ'],
  ['tatacliq', 'Tata CLiQ'],
  ['bigbasket', 'BigBasket'],
  ['big basket', 'BigBasket'],
  ['makemytrip', 'MakeMyTrip'],
  ['make my trip', 'MakeMyTrip'],
  ['firstcry', 'FirstCry'],
  ['decathlon', 'Decathlon'],
  ['lenskart', 'Lenskart'],
  ['snapdeal', 'Snapdeal'],
  ['myntra', 'Myntra'],
  ['flipkart', 'Flipkart'],
  ['flipcart', 'Flipkart'],
  ['amazon', 'Amazon'],
  ['swiggy', 'Swiggy'],
  ['swigy', 'Swiggy'],
  ['zomato', 'Zomato'],
  ['nykaa', 'Nykaa'],
  ['nyka', 'Nykaa'],
  ['meesho', 'Meesho'],
  ['ajio', 'Ajio'],
  ['croma', 'Croma'],
  ['dominos', 'Dominos'],
  ["domino's", 'Dominos'],
  ['pvr', 'PVR'],
  ['nike', 'Nike'],
  ['adidas', 'Adidas'],
  ['puma', 'Puma'],
  ['uber', 'Uber'],
  ['ola', 'Ola'],
  ['zara', 'Zara'],
  ['hm', 'H&M'],
  ['ikea', 'IKEA'],
  ['pepperfry', 'Pepperfry'],
]);

export const CATEGORIES = Object.freeze([
  ['fashion', 'fashion'],
  ['clothing', 'fashion'],
  ['apparel', 'fashion'],
  ['beauty', 'beauty'],
  ['cosmetic', 'beauty'],
  ['skincare', 'beauty'],
  ['food', 'food'],
  ['restaurant', 'food'],
  ['dining', 'food'],
  ['travel', 'travel'],
  ['flight', 'travel'],
  ['hotel', 'travel'],
  ['electronics', 'electronics'],
  ['gadget', 'electronics'],
  ['mobile', 'electronics'],
  ['entertainment', 'entertainment'],
  ['movie', 'entertainment'],
  ['grocery', 'grocery'],
  ['shopping', 'shopping'],
  ['recharge', 'recharge'],
  ['fitness', 'fitness'],
  ['footwear', 'fashion'],
  ['shoes', 'fashion'],
]);

/* ---------------- register normalisation ----------------
   Token → extra canonical tokens. The original token is kept. */

const SYNONYMS = Object.freeze({
  /* Hinglish verbs and question words */
  kharidna: ['buy'], kharid: ['buy'], kharido: ['buy'], kharidne: ['buy'], kharidi: ['buy'],
  bechna: ['sell'], bech: ['sell'], becho: ['sell'], bechena: ['sell'], bec: ['sell'],
  dikhao: ['show'], dikha: ['show'], dikhado: ['show'], dikhaiye: ['show'], dikhaye: ['show'],
  dhoondo: ['find'], dhoond: ['find'], dhundh: ['find'], khojo: ['find'],
  batao: ['tell'], bata: ['tell'], bataiye: ['tell'], bataye: ['tell'],
  kitna: ['how', 'much'], kitne: ['how', 'much'], kitni: ['how', 'much'],
  kab: ['when'], kaha: ['where'], kahan: ['where'], kaise: ['how'], kese: ['how'], kaun: ['who'],
  milega: ['get'], milegi: ['get'], milta: ['get'], mile: ['get'],
  paisa: ['money'], paise: ['money'], rupaye: ['money'], rupya: ['money'],
  wapas: ['back'], wapasi: ['back'], refund: ['refund'],
  mera: ['my'], meri: ['my'], mere: ['my'], mujhe: ['me'], mujhko: ['me'],
  aap: ['you'], tum: ['you'], apna: ['my'],
  nahi: ['not'], nhi: ['not'], mat: ['not'],
  chalu: ['active'], chal: ['active'],
  band: ['down', 'closed'], kyu: ['why'], kyun: ['why'], kyon: ['why'],
  hua: ['happened'], huva: ['happened'], hoga: ['will'], hoga: ['will'],
  sakta: ['can'], sakte: ['can'], sakti: ['can'], skta: ['can'],
  hai: ['is'], hain: ['is'], hu: ['am'], hun: ['am'], ho: ['is'],
  sab: ['all'], kuch: ['something'], bhi: ['also'], abhi: ['now'], ab: ['now'],
  jaldi: ['fast'], dhanyavaad: ['thanks'], shukriya: ['thanks'],
  theek: ['ok'], thik: ['ok'], accha: ['ok'], acha: ['ok'],
  kam: ['less', 'low'], jyada: ['more', 'high'], zyada: ['more', 'high'],
  pehle: ['first', 'before'], baad: ['after'], aakhri: ['last'], akhri: ['last'],

  /* Indian-English and common misspellings */
  coupen: ['coupon'], cupon: ['coupon'], coupan: ['coupon'], coupn: ['coupon'], couponss: ['coupons'],
  payot: ['payout'], payput: ['payout'], payuot: ['payout'],
  eligibilty: ['eligibility'], elgibility: ['eligibility'], eligiblity: ['eligibility'],
  submision: ['submission'], submittion: ['submission'],
  aproved: ['approved'], approv: ['approve'], apruved: ['approved'],
  puchase: ['purchase'], purchse: ['purchase'], purhcase: ['purchase'],
  tiket: ['ticket'], tikets: ['tickets'], tickit: ['ticket'],
  ernings: ['earnings'], earnigs: ['earnings'],
  wats: ['what'], wat: ['what'], hw: ['how'], wht: ['what'],
  pls: ['please'], plz: ['please'], plz: ['please'],
  accnt: ['account'], acount: ['account'], acct: ['account'],
  passwrd: ['password'], pasword: ['password'],
  securty: ['security'], secuirty: ['security'],
  maitenance: ['maintenance'], maintainance: ['maintenance'], maintainence: ['maintenance'],
  traker: ['tracker'], trakcer: ['tracker'],
  delte: ['delete'], delet: ['delete'],
  cancle: ['cancel'], canc: ['cancel'],

  /* Colloquial greetings and valedictions */
  hiya: ['hi', 'hey'], heya: ['hey'], howdy: ['hi'],
  ttyl: ['bye'], cya: ['bye'], gnight: ['good', 'night'], gn: ['good', 'night'],
  farewell: ['bye'], later: ['bye'],
  thnx: ['thanks'], thanx: ['thanks'], thnks: ['thanks'], cheers: ['thanks'],
  grateful: ['thanks', 'thank'], ton: ['lot'], appreciated: ['appreciate'],

  /* Ordinary paraphrases that carry no SaveHatke-specific vocabulary but
     are common ways of asking the same thing. */
  qualify: ['eligible', 'eligibility'], qualified: ['eligible'], qualifies: ['eligible'],
  permitted: ['allowed', 'allow'], permit: ['allowed'],
  capable: ['can', 'able'], abilities: ['ability'], capability: ['ability'],
  procedure: ['process'], specifics: ['detail'], specific: ['detail'],
  rundown: ['overview', 'explain'], concept: ['work'], platform: ['website'],
  service: ['website'], offer: ['have', 'provide'],
  responding: ['respond', 'down'], unresponsive: ['down'], unavailable: ['down'],
  broken: ['down', 'error'], downtime: ['down', 'maintenance'],
  slab: ['tier', 'ladder'], slabs: ['tier', 'ladder'], threshold: ['minimum', 'tier'],
  thresholds: ['minimum', 'tier'], cycle: ['schedule'], structure: ['schedule'],
  frequently: ['often'], worth: ['value'], soonest: ['expire', 'first'],
  declined: ['rejected', 'reject'], accepted: ['approved', 'approve'],
  transferred: ['transfer', 'payment'], received: ['receive', 'get'],
  processing: ['process'], billed: ['charge'], double: ['twice'],
  sent: ['submit', 'send'], listed: ['list'], reviewed: ['review'],

  /* Irregular verb forms the suffix stripper cannot reach. "brought" and
     "bring" are different tokens to any suffix rule, so "what did my
     coupons bring in" and "what have my coupons brought in" would otherwise
     share nothing. */
  brought: ['bring'], bringing: ['bring'], brings: ['bring'],
  made: ['make'], earning: ['earn'], earned: ['earn'],
  /* "pull up the coupons" is the same request as "show me the coupons". */
  pull: ['show'], pulling: ['show'], pulled: ['show'],
  /* "something cheaper than 300" is a price ceiling. */
  cheaper: ['cheap', 'under'], cheapest: ['cheap', 'under'],
});

/* ---------------- stopwords ----------------
   Negations are deliberately KEPT: they flip meaning. */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'by', 'with',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as', 'it', 'its', 'be', 'been',
  'being', 'was', 'were', 'am', 'are', 'is', 'do', 'does', 'did', 'done', 'have',
  'has', 'had', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'me', 'my', 'mine', 'you', 'your', 'yours', 'i', 'we', 'our', 'us', 'they',
  'them', 'their', 'he', 'she', 'him', 'her', 'this', 'these', 'those', 'there',
  'here', 'just', 'very', 'really', 'also', 'too', 'get', 'got', 'please', 'ok',
  'okay', 'now', 'any', 'some', 'about', 'into', 'out', 'up', 'down', 'again',
  'one', 'two', 'three', 's', 't',
]);

const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'cannot', 'cant', 'dont', 'doesnt', 'didnt', 'wont']);

/* ---------------- protected entity extraction ---------------- */

const PROTECTED_PATTERNS = [
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, token: 'emailtoken' },
  { name: 'url', re: /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi, token: 'urltoken' },
  // SaveHatke listing / coupon identifiers, e.g. SH-A1B2C3
  { name: 'couponId', re: /\bSH-[A-Z0-9]{4,}\b/gi, token: 'couponidtoken' },
  { name: 'ticketId', re: /\b(?:TKT|TICKET)[-\s]?(\d{2,})\b/gi, token: 'ticketidtoken' },
];

const MONEY_RE = /(?:₹|rs\.?|inr)\s*([\d][\d,]*(?:\.\d+)?)|([\d][\d,]*(?:\.\d+)?)\s*(?:rupees|rs\b|inr\b|₹)/gi;

const DATE_WORDS = [
  'today', 'tomorrow', 'yesterday', 'tonight',
  'this week', 'next week', 'last week',
  'this month', 'next month', 'last month',
  'this year', 'last year',
];

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

/* ---------------- stemming ---------------- */

/* Words that end in -ing but are not gerunds. Without this list the
   suffix rule turns "something" into "someth", "nothing" into "noth" and
   "morning" into "morn" — the tokens stop being words, and a user typing
   "something cheaper" no longer shares any token with "anything under 500".
   They are left intact so the synonym map and the training data can still
   recognise them. */
const NOT_GERUNDS = new Set([
  'something', 'nothing', 'anything', 'everything',
  'morning', 'evening', 'during', 'ceiling', 'darling', 'housing', 'sibling',
  'string', 'spring', 'savings', 'innings', 'outing', 'being',
]);

/**
 * Very light suffix stripping. Intentionally conservative: it must never
 * turn a real word into something that collides with another intent's
 * vocabulary, so short words are left alone.
 */
export function stem(word) {
  const w = String(word || '');
  if (w.length <= 4) return w;
  if (NEGATIONS.has(w)) return w;
  if (NOT_GERUNDS.has(w)) return w;

  // Plurals of -ing forms first, so "earnings" → "earn" and "listings" → "list".
  if (w.length > 6 && w.endsWith('ings')) return w.slice(0, -4);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length >= 5 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1);
  }
  return w;
}

/* ---------------- main entry points ---------------- */

/**
 * Pulls out the entity-bearing spans that normalisation must not damage.
 * @returns {{text:string, entities:object}}
 */
export function extractProtected(text) {
  let working = String(text || '');
  const entities = { email: [], url: [], couponId: [], ticketId: [] };

  for (const { name, re, token } of PROTECTED_PATTERNS) {
    working = working.replace(re, (match, group1) => {
      const value = name === 'ticketId' && group1 ? group1 : match;
      entities[name].push(value);
      // Keep a stable placeholder token so the classifier still sees that an
      // id/email/url was present, without memorising the value.
      return ` ${token} `;
    });
  }

  return { text: working, entities };
}

/** Normalises money, dates and whitespace, and unifies typographic chars. */
export function normalizeText(text) {
  let out = String(text || '')
    .normalize('NFC')
    // Curly quotes / dashes / currency to ASCII equivalents.
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u20B9/g, ' ₹ ')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();

  // Money → "money <digits>", preserving the number for entity extraction.
  out = out.replace(MONEY_RE, (_match, prefixed, suffixed) => {
    const digits = (prefixed || suffixed || '').replace(/,/g, '');
    return ` money${digits} `;
  });

  // Multi-word date phrases → a single canonical token.
  for (const phrase of DATE_WORDS) {
    const re = new RegExp(`\\b${phrase.replace(/ /g, '\\s+')}\\b`, 'gi');
    out = out.replace(re, ` date_${phrase.replace(/ /g, '_')} `);
  }

  return out.replace(/\s+/g, ' ').trim();
}

/** Adds canonical synonyms for Hinglish / misspelled tokens. */
export function expandSynonyms(tokens) {
  const expanded = [];
  for (const token of tokens) {
    expanded.push(token);
    const extra = SYNONYMS[token];
    if (extra) expanded.push(...extra);
  }
  return expanded;
}

/**
 * Full analysis of a message.
 *
 * @param {string} raw
 * @returns {{
 *   raw:string, normalized:string, tokens:string[], stemmed:string[],
 *   keywords:string[], entities:object, coverageTokens:number
 * }}
 */
export function analyze(raw) {
  const { text: protectedText, entities } = extractProtected(raw);
  const normalized = normalizeText(protectedText).toLowerCase();

  const rawTokens = normalized.match(/[a-z0-9_]+/g) || [];
  const expanded = expandSynonyms(rawTokens);
  const stemmed = expanded.map(stem).filter(Boolean);

  // `keywords` is what retrieval uses: stopwords and length-1 noise removed,
  // but negations preserved.
  const keywords = stemmed.filter(
    (token) => (token.length > 1 || /[0-9]/.test(token)) && (NEGATIONS.has(token) || !STOPWORDS.has(token))
  );

  return {
    raw: String(raw || ''),
    normalized,
    tokens: expanded,
    stemmed,
    keywords,
    entities,
    coverageTokens: stemmed.length,
  };
}

/** Convenience: the classifier feature vector for a message. */
export function tokenize(raw) {
  return analyze(raw).stemmed;
}

/** Term frequencies, used by the vocabulary builder and the classifier. */
export function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

/** Finds brands and categories mentioned in a message. */
export function detectBrandsAndCategories(normalizedText) {
  const haystack = ` ${String(normalizedText || '').toLowerCase()} `;
  const brands = [];
  const categories = [];

  for (const [alias, canonical] of BRANDS) {
    if (haystack.includes(` ${alias} `) || haystack.includes(`${alias} `)) {
      if (!brands.includes(canonical)) brands.push(canonical);
    }
  }
  for (const [alias, canonical] of CATEGORIES) {
    const re = new RegExp(`\\b${alias}\\w*\\b`);
    if (re.test(haystack)) {
      if (!categories.includes(canonical)) categories.push(canonical);
    }
  }
  return { brands, categories };
}

export const MONTH_NAMES = Object.freeze(MONTHS);
export const STOPWORD_SET = STOPWORDS;
export const NEGATION_SET = NEGATIONS;
