/* ============================================================
   SaveHatke AI — user memory.

   Optional, user-controlled long-term memory. Stored per verified account
   in localStorage (namespaced by email), never auto-populated with
   sensitive data: the user adds notes deliberately. Full control — view,
   edit, delete, disable — is exposed so the assistant never "remembers"
   anything the user has not chosen to save.

   Persisting memory to the Google Sheets `Memory` tab is a documented
   next step; until that server path exists, this stays local and the UI
   says so rather than implying a server round-trip.
   ============================================================ */

const PREFIX = 'savehatke.ai.memory.v1:';

function keyFor(email) {
  return email ? PREFIX + String(email).toLowerCase() : null;
}

function read(email) {
  const key = keyFor(email);
  if (!key) return { enabled: true, items: [] };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { enabled: true, items: [] };
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return { enabled: true, items: [] };
  }
}

function write(email, state) {
  const key = keyFor(email);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage full or unavailable — memory is best-effort, not critical */
  }
}

export function getMemoryState(email) {
  return read(email);
}

/** Memory text to inject into the system prompt, or '' when disabled/empty. */
export function memoryForPrompt(email) {
  const state = read(email);
  if (!state.enabled || !state.items.length) return '';
  return state.items.map((item, i) => `${i + 1}. ${item.text}`).join('\n');
}

export function addMemory(email, text) {
  const value = String(text || '').trim().slice(0, 500);
  if (!value) return read(email);
  const state = read(email);
  state.items.push({ id: cryptoId(), text: value, createdAt: new Date().toISOString() });
  state.items = state.items.slice(-50);
  write(email, state);
  return state;
}

export function updateMemory(email, id, text) {
  const state = read(email);
  const item = state.items.find((m) => m.id === id);
  if (item) {
    item.text = String(text || '').trim().slice(0, 500);
    item.updatedAt = new Date().toISOString();
    write(email, state);
  }
  return state;
}

export function deleteMemory(email, id) {
  const state = read(email);
  state.items = state.items.filter((m) => m.id !== id);
  write(email, state);
  return state;
}

export function setMemoryEnabled(email, enabled) {
  const state = read(email);
  state.enabled = Boolean(enabled);
  write(email, state);
  return state;
}

export function clearMemory(email) {
  const state = { enabled: read(email).enabled, items: [] };
  write(email, state);
  return state;
}

function cryptoId() {
  if (window.crypto && window.crypto.getRandomValues) {
    const b = new Uint8Array(8);
    window.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 18);
}
