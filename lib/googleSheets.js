/* ============================================================
   SaveHatke AI — Google Sheets persistence layer.

   Google Sheets is the PRIMARY database (no SQL/NoSQL service is added).
   This module is the ONLY place that reads and writes application data on
   Sheets; API routes call these functions, never the Sheets REST API
   directly, and browser code never touches Sheets at all.

   Design rules that make this deploy-safe:
     - It is FAIL-SAFE. When the data sheet or the service account is not
       configured, every writer no-ops with { ok:false, skipped:true } and
       every reader returns []. The app keeps working (the on-device model
       and auth do not depend on it); persistence simply does not happen
       until the operator provisions the sheet. Nothing throws into a request.
     - It reuses the existing WebCrypto + fetch service-account flow
       (lib/googleAuth.js) with the read+write `spreadsheets` scope. The
       read-only whitelist keeps its own scope; tokens are cached per scope.
     - Identity is server-supplied. Callers pass the verified session email;
       this module never trusts an email from the browser body.

   Tabs (one worksheet each; create them in the data spreadsheet):
     Users, Conversations, Messages, Memory, Usage, Feedback, ToolCalls,
     Errors, Settings. Column order per tab is TAB_COLUMNS below — the first
     row of each tab may be a header; readers skip a leading header row.
   ============================================================ */

import { getConfig } from './config.js';
import { getServiceAccountToken } from './googleAuth.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/* ---------------- schema ---------------- */
/** Canonical column order per tab. Objects map to rows by this order. */
export const TAB_COLUMNS = Object.freeze({
  Users:         ['email', 'name', 'sub', 'createdAt', 'lastSeenAt'],
  Conversations: ['id', 'email', 'title', 'createdAt', 'updatedAt'],
  Messages:      ['id', 'conversationId', 'email', 'role', 'content', 'createdAt'],
  Memory:        ['id', 'email', 'text', 'enabled', 'createdAt'],
  Usage:         ['id', 'email', 'conversationId', 'event', 'model', 'promptChars', 'completionChars', 'ms', 'createdAt'],
  Feedback:      ['id', 'email', 'conversationId', 'messageId', 'rating', 'preview', 'createdAt'],
  ToolCalls:     ['id', 'email', 'conversationId', 'tool', 'input', 'ok', 'output', 'ms', 'createdAt'],
  Errors:        ['id', 'email', 'scope', 'message', 'detail', 'createdAt'],
  Settings:      ['key', 'value', 'updatedAt'],
});

/* ---------------- config ---------------- */
function env(name) {
  const value = globalThis.process?.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** The data spreadsheet id. Defaults to GOOGLE_SHEET_ID (the whitelist book). */
function dataSheetId() {
  return env('SAVEHATKE_DATA_SHEET_ID') || getConfig().sheetId;
}

/** True only when a write is actually possible. Callers rely on this. */
export function isConfigured() {
  const config = getConfig();
  return Boolean(dataSheetId() && config.serviceAccountEmail && config.serviceAccountPrivateKey);
}

/* ---------------- pure helpers (unit-tested, no network) ---------------- */

/** A1 tab reference, quoted when the name is not a bare word. */
export function quoteTab(tab) {
  return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${String(tab).replace(/'/g, "''")}'`;
}

/** `Tab!A:Z` range for a tab. */
export function tabRange(tab, cols = 'A:Z') {
  return `${quoteTab(tab)}!${cols}`;
}

/** Object → row array, in the tab's canonical column order. */
export function rowFromObject(tab, obj) {
  const cols = TAB_COLUMNS[tab];
  if (!cols) throw new Error(`Unknown sheet tab: ${tab}`);
  return cols.map((key) => {
    const value = obj ? obj[key] : undefined;
    if (value == null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return String(value);
  });
}

/** Row array → object, in the tab's canonical column order. */
export function objectFromRow(tab, row) {
  const cols = TAB_COLUMNS[tab];
  if (!cols) throw new Error(`Unknown sheet tab: ${tab}`);
  const out = {};
  cols.forEach((key, i) => {
    out[key] = row && row[i] != null ? row[i] : '';
  });
  return out;
}

/** True when a row looks like the header (its first cell equals the first column name). */
export function isHeaderRow(tab, row) {
  const cols = TAB_COLUMNS[tab];
  if (!cols || !Array.isArray(row)) return false;
  return String(row[0] || '').trim().toLowerCase() === cols[0].toLowerCase();
}

let idCounter = 0;
/** Short, collision-resistant id (time + random + monotonic counter). */
export function newId(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e6;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------------- low-level Sheets REST (network) ---------------- */
async function accessToken() {
  const config = getConfig();
  return getServiceAccountToken({
    clientEmail: config.serviceAccountEmail,
    privateKey: config.serviceAccountPrivateKey,
    scope: SHEETS_SCOPE,
  });
}

async function sheetsFetch(path, init = {}) {
  const id = dataSheetId();
  const token = await accessToken();
  const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Sheets ${init.method || 'GET'} failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * All rows of a tab as objects (header row skipped). Returns [] when the
 * store is unconfigured or the tab is empty. Never throws into a request.
 */
export async function readRows(tab, cols = 'A:Z') {
  if (!isConfigured()) return [];
  try {
    const body = await sheetsFetch(
      `/values/${encodeURIComponent(tabRange(tab, cols))}?majorDimension=ROWS`,
      { method: 'GET' }
    );
    const rows = Array.isArray(body.values) ? body.values : [];
    return rows
      .filter((row, i) => !(i === 0 && isHeaderRow(tab, row)))
      .filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim() !== ''))
      .map((row) => objectFromRow(tab, row));
  } catch (error) {
    console.error(`[savehatke] sheets read ${tab} failed:`, error.message);
    return [];
  }
}

/** Appends one object as a row. No-ops (skipped) when unconfigured. */
export async function appendRow(tab, obj) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'storage_unconfigured' };
  try {
    const values = [rowFromObject(tab, obj)];
    await sheetsFetch(
      `/values/${encodeURIComponent(tabRange(tab))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values }) }
    );
    return { ok: true };
  } catch (error) {
    console.error(`[savehatke] sheets append ${tab} failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

/* ---------------- typed API (the spec's service layer) ----------------
   Every function is fail-safe: readers return [] / null, writers return
   { ok:false, skipped:true } when the store is not configured.            */

/* Users */
export async function getUser(email) {
  const target = String(email || '').toLowerCase();
  if (!target) return null;
  const rows = await readRows('Users');
  return rows.find((u) => String(u.email || '').toLowerCase() === target) || null;
}

/** Records the user on first sight; refreshes lastSeenAt on later visits. */
export async function upsertUser({ email, name = '', sub = '' }) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'storage_unconfigured' };
  const existing = await getUser(email);
  if (existing) return { ok: true, created: false };
  return {
    ok: (await appendRow('Users', {
      email: String(email || '').toLowerCase(),
      name, sub, createdAt: nowIso(), lastSeenAt: nowIso(),
    })).ok,
    created: true,
  };
}

/* Conversations */
export async function createConversation({ email, title = 'New chat', id = newId('conv') }) {
  const res = await appendRow('Conversations', {
    id, email: String(email || '').toLowerCase(), title,
    createdAt: nowIso(), updatedAt: nowIso(),
  });
  return { ...res, id };
}

export async function getConversations(email) {
  const target = String(email || '').toLowerCase();
  const rows = await readRows('Conversations');
  return rows
    .filter((c) => String(c.email || '').toLowerCase() === target)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/* Messages */
export async function saveMessage({ conversationId, email, role, content, id = newId('msg') }) {
  const res = await appendRow('Messages', {
    id, conversationId, email: String(email || '').toLowerCase(),
    role, content, createdAt: nowIso(),
  });
  return { ...res, id };
}

/** Messages for one conversation, scoped to the owning user (isolation). */
export async function getMessages(conversationId, email) {
  const owner = String(email || '').toLowerCase();
  const rows = await readRows('Messages');
  return rows
    .filter((m) => m.conversationId === conversationId
      && (!owner || String(m.email || '').toLowerCase() === owner))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/* Memory */
export async function getMemory(email) {
  const target = String(email || '').toLowerCase();
  const rows = await readRows('Memory');
  return rows.filter((m) => String(m.email || '').toLowerCase() === target);
}

export async function saveMemory({ email, text, enabled = true, id = newId('mem') }) {
  const res = await appendRow('Memory', {
    id, email: String(email || '').toLowerCase(),
    text, enabled, createdAt: nowIso(),
  });
  return { ...res, id };
}

/* Usage / Feedback / ToolCalls / Errors — append-only telemetry. */
export async function saveUsage(row) {
  return appendRow('Usage', { id: newId('use'), createdAt: nowIso(), ...row });
}

export async function saveFeedback(row) {
  return appendRow('Feedback', { id: newId('fb'), createdAt: nowIso(), ...row });
}

export async function logToolCall(row) {
  return appendRow('ToolCalls', { id: newId('tc'), createdAt: nowIso(), ...row });
}

export async function logError(row) {
  return appendRow('Errors', { id: newId('err'), createdAt: nowIso(), ...row });
}
