/* ============================================================
   tests/sheets.test.mjs — unit tests for the Google Sheets persistence
   layer (lib/googleSheets.js).

   These are pure/offline tests: the data store is forced UNCONFIGURED so
   no network call is ever made. They verify (1) the row<->object mapping is
   correct and reversible, (2) A1 range quoting, and (3) that every reader
   and writer degrades safely to []/skipped when the sheet is not set up —
   the property the chat UI's best-effort persistence depends on.

   Live read/write against a real spreadsheet needs a provisioned data sheet
   and a service account with the read+write scope, and is verified
   separately (see AUTH-SETUP notes).
   ============================================================ */

import assert from 'node:assert/strict';

// Force "unconfigured" BEFORE the module is imported. getConfig() re-reads
// process.env on every call, so clearing these guarantees isConfigured()===
// false and every network path short-circuits.
for (const k of [
  'SAVEHATKE_DATA_SHEET_ID', 'GOOGLE_SHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON',
]) delete process.env[k];

const S = await import('../lib/googleSheets.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' — ' + e.message); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' — ' + e.message); failed++; }
}

/* -------- schema -------- */
check('every tab defines a non-empty ordered column list', () => {
  for (const [tab, cols] of Object.entries(S.TAB_COLUMNS)) {
    assert.ok(Array.isArray(cols) && cols.length > 0, tab + ' has no columns');
    assert.ok(cols.every((c) => typeof c === 'string' && c), tab + ' has a bad column');
  }
});
check('Messages carries conversation, owner, role and content', () => {
  for (const c of ['id', 'conversationId', 'email', 'role', 'content', 'createdAt']) {
    assert.ok(S.TAB_COLUMNS.Messages.includes(c), 'missing ' + c);
  }
});

/* -------- A1 quoting -------- */
check('quoteTab leaves a bare word alone', () => {
  assert.equal(S.quoteTab('Messages'), 'Messages');
});
check('quoteTab wraps a name with a space', () => {
  assert.equal(S.quoteTab('My Tab'), "'My Tab'");
});
check("quoteTab doubles an apostrophe", () => {
  assert.equal(S.quoteTab("a'b"), "'a''b'");
});
check('tabRange builds the full A1 range', () => {
  assert.equal(S.tabRange('Messages'), 'Messages!A:Z');
  assert.equal(S.tabRange('My Tab', 'A:F'), "'My Tab'!A:F");
});

/* -------- row <-> object -------- */
check('rowFromObject then objectFromRow round-trips', () => {
  const obj = { id: '1', conversationId: 'c1', email: 'a@x.com', role: 'user', content: 'hi', createdAt: 't' };
  const row = S.rowFromObject('Messages', obj);
  assert.equal(row.length, S.TAB_COLUMNS.Messages.length);
  assert.deepEqual(S.objectFromRow('Messages', row), obj);
});
check('rowFromObject serialises booleans, objects and nulls', () => {
  const row = S.rowFromObject('Memory', { id: 'm', email: 'a@x.com', text: 'note', enabled: true, createdAt: null });
  const [, , , enabled, createdAt] = row;
  assert.equal(enabled, 'TRUE');
  assert.equal(createdAt, '');
});
check('rowFromObject rejects an unknown tab', () => {
  assert.throws(() => S.rowFromObject('Nope', {}), /Unknown sheet tab/);
});
check('isHeaderRow detects the header, not data', () => {
  assert.equal(S.isHeaderRow('Users', ['email', 'name']), true);
  assert.equal(S.isHeaderRow('Users', ['a@x.com', 'Ana']), false);
});
check('newId is prefixed and unique', () => {
  const a = S.newId('msg');
  const b = S.newId('msg');
  assert.ok(a.startsWith('msg_') && b.startsWith('msg_'));
  assert.notEqual(a, b);
});

/* -------- fail-safe when unconfigured (no network) -------- */
check('isConfigured() is false with no data sheet', () => {
  assert.equal(S.isConfigured(), false);
});
await checkAsync('writers no-op (skipped) when unconfigured', async () => {
  for (const res of [
    await S.appendRow('Messages', { id: '1' }),
    await S.saveMessage({ conversationId: 'c', email: 'a@x.com', role: 'user', content: 'x' }),
    await S.saveMemory({ email: 'a@x.com', text: 'x' }),
    await S.saveUsage({ email: 'a@x.com' }),
    await S.saveFeedback({ email: 'a@x.com', rating: 'up' }),
    await S.logToolCall({ email: 'a@x.com', tool: 'calc' }),
    await S.logError({ scope: 't', message: 'm' }),
    await S.upsertUser({ email: 'a@x.com' }),
  ]) {
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
  }
});
await checkAsync('readers return [] / null when unconfigured', async () => {
  assert.deepEqual(await S.readRows('Messages'), []);
  assert.deepEqual(await S.getMessages('c', 'a@x.com'), []);
  assert.deepEqual(await S.getConversations('a@x.com'), []);
  assert.deepEqual(await S.getMemory('a@x.com'), []);
  assert.equal(await S.getUser('a@x.com'), null);
});

/* -------- summary -------- */
console.log('\n============================================================');
console.log(`sheets.test: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed ? 1 : 0);
