/* ============================================================
   SaveHatke AI — Google Sheet whitelist.

   Reads the whitelist with a service account (server-side only) and caches
   the parsed result in memory for a short TTL.

   Why cache: every protected request performs an authorization check, and
   calling the Sheets API each time would be slow and burn quota for a list
   that changes rarely.

   Why the TTL is short (default 60s): it bounds how long a whitelist edit
   takes to take effect. Adding a user or flipping them to "disabled" goes
   live within the TTL with no redeploy. Nothing is cached permanently, and
   a cold start re-reads the sheet — the safe direction to fail in.

   Written on WebCrypto + fetch (no Node-only APIs) so the Edge middleware
   and the Node.js API routes make the exact same authorization decision.
   ============================================================ */

import { getConfig } from './config.js';
import { getServiceAccountToken } from './googleAuth.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/* ---------------- in-memory snapshot ---------------- */
let snapshot = null;   // { entries: Map<email, status>, fetchedAt: number }
let inFlight = null;   // de-duplicates concurrent refreshes

/** "1AbC..." or a full Sheets URL are both accepted. */
function normalizeSheetId(raw) {
  const value = String(raw || '').trim();
  const fromUrl = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return fromUrl ? fromUrl[1] : value;
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase();
}

function looksLikeHeader(cell) {
  return ['email', 'mail', 'e-mail', 'emailaddress', 'useremail'].includes(cell);
}

/**
 * Turns the raw `values` grid into an email → status map.
 * Expected columns: A = Email, B = Status.
 */
export function parseRows(rows) {
  const entries = new Map();
  if (!Array.isArray(rows)) return entries;

  rows.forEach((row, index) => {
    if (!Array.isArray(row)) return;
    const email = normalizeEmail(row[0]);
    if (!email) return;

    // The sheet is hand-maintained, so tolerate a header row anywhere near
    // the top (blank spacer rows and titles above the table are common).
    if (index <= 2 && looksLikeHeader(email)) return;
    // Anything else that isn't an email address is skipped rather than
    // stored as a bogus identity.
    if (!email.includes('@')) return;

    // A row with no Status is treated as NOT authorized rather than
    // silently allowed.
    entries.set(email, normalizeStatus(row[1]) || 'missing');
  });

  return entries;
}

/* ---------------- fetch ---------------- */
async function fetchWhitelist() {
  const config = getConfig();
  const sheetId = normalizeSheetId(config.sheetId);
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not configured');

  const accessToken = await getServiceAccountToken({
    clientEmail: config.serviceAccountEmail,
    privateKey: config.serviceAccountPrivateKey,
    scope: SHEETS_SCOPE,
  });

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(config.sheetRange)}?majorDimension=ROWS`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Google Sheets request failed (${response.status}): ${detail.slice(0, 200)}`
    );
  }

  const body = await response.json();
  return parseRows(body.values);
}

/* ---------------- cache orchestration ---------------- */
async function refresh() {
  if (!inFlight) {
    inFlight = fetchWhitelist()
      .then((entries) => {
        snapshot = { entries, fetchedAt: Date.now() };
        return snapshot;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Forces the next lookup to hit Google. Used by tests; never called in request paths. */
export function resetWhitelistCache() {
  snapshot = null;
  inFlight = null;
}

/** Test seam: inject a snapshot without touching Google. */
export function __setWhitelistSnapshot(entries, fetchedAt = Date.now()) {
  snapshot = { entries, fetchedAt };
}

/**
 * Looks the email up in the whitelist.
 * @param {string} rawEmail - a email already verified server-side. Never a
 *   value supplied directly by the browser.
 * @returns {Promise<{authorized:boolean, reason:string, status:string|null}>}
 *   reason: 'active' | 'not_listed' | 'disabled' | 'unavailable'
 */
export async function checkWhitelist(rawEmail) {
  const config = getConfig();
  const email = normalizeEmail(rawEmail);

  if (!email) return { authorized: false, reason: 'not_listed', status: null };

  const now = Date.now();
  const ttlMs = config.whitelistTtlSeconds * 1000;
  let current = snapshot && now - snapshot.fetchedAt < ttlMs ? snapshot : null;

  if (!current) {
    try {
      current = await refresh();
    } catch (error) {
      console.error('[savehatke] whitelist refresh failed:', error.message);
      // Fall back to a recent snapshot so a temporary Google outage does not
      // lock out already-authorized users. Bounded by the grace window.
      const graceMs = config.whitelistStaleGraceSeconds * 1000;
      if (snapshot && now - snapshot.fetchedAt < graceMs) {
        current = snapshot;
      } else {
        return { authorized: false, reason: 'unavailable', status: null };
      }
    }
  }

  const status = current?.entries?.get(email) ?? null;

  if (status === null) return { authorized: false, reason: 'not_listed', status: null };
  if (status === 'active') return { authorized: true, reason: 'active', status };
  return { authorized: false, reason: 'disabled', status };
}