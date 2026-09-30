/* ============================================================
   SaveHatke AI — context assembly.

   Never sends unbounded history to the model. Builds the prompt window as:

     system prompt
     + (optional) running summary of older turns
     + the most recent turns that fit the budget
     + the current message

   The budget is expressed in tokens, estimated from characters (~4 chars
   per token is a safe rule of thumb for English/code). Real trimming, not
   decoration: older turns are dropped once the budget is reached, and the
   controller can fold them into a summary so nothing important is lost.
   ============================================================ */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {{role:string,content:string}[]} opts.history  full turn history (user/assistant), excluding system
 * @param {string} [opts.summary]        running summary of older, trimmed turns
 * @param {number} opts.contextSize      model context window in tokens
 * @param {number} opts.maxOutputTokens  tokens reserved for the reply
 * @returns {{messages:object[], droppedCount:number}}
 */
export function buildContext({ systemPrompt, history, summary = '', contextSize, maxOutputTokens }) {
  const reserve = maxOutputTokens + 256; // headroom for formatting/role overhead
  const budget = Math.max(512, contextSize - reserve);

  const system = { role: 'system', content: systemPrompt };
  let used = estimateTokens(system.content) + 4;

  const summaryMessage = summary && summary.trim()
    ? { role: 'system', content: 'Summary of earlier conversation:\n' + summary.trim() }
    : null;
  if (summaryMessage) used += estimateTokens(summaryMessage.content) + 4;

  // Walk history newest-first, keeping turns until the budget is spent.
  const kept = [];
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    const cost = estimateTokens(turn.content) + 4;
    if (used + cost > budget && kept.length > 0) {
      dropped = i + 1;
      break;
    }
    kept.unshift(turn);
    used += cost;
  }

  const messages = [system];
  if (summaryMessage) messages.push(summaryMessage);
  messages.push(...kept);
  return { messages, droppedCount: dropped };
}
