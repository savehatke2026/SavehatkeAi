/* ============================================================
   SaveHatke AI — built-in preview reply engine.

   Used by /api/chat when no model provider is configured. This is the
   same lightweight keyword engine that shipped in the original
   front-end, moved server-side so that even the fallback path goes
   through the authorization-gated API instead of running in the browser.

   Replace it by setting SAVEHATKE_MODEL_API_URL; this file then becomes
   dormant. It exists so the product is fully explorable before you pay
   for a model endpoint.
   ============================================================ */

export function previewReply(message, history = []) {
  const text = String(message || '').toLowerCase();
  const turn = history.filter((m) => m && m.role === 'user').length;

  if (/api|key|integrat|embed|website|widget/.test(text)) {
    return 'API access is available to signed-in accounts. Open your dashboard, generate a key under API Keys, then send requests to the SaveHatke AI endpoint with that key in the Authorization header.';
  }
  if (/price|pricing|cost|plan|paid|free/.test(text)) {
    return 'There is no pricing page here — SaveHatke AI is your own platform. Usage limits and plans can be configured from your backend whenever you are ready to define them.';
  }
  if (/who are you|what are you|your name/.test(text)) {
    return 'I am SaveHatke AI, a lightweight assistant you can use directly or connect to your own website and applications through the API.';
  }
  if (/help|can you|what can/.test(text)) {
    return 'I can answer questions, help you find information, and assist you with tasks. Signed-in accounts also get API keys for connecting this assistant to their own products.';
  }
  if (/account|dashboard|profile|login|sign in/.test(text)) {
    return 'Sign in to reach your dashboard, where you can manage API keys, account information, and security settings.';
  }
  if (/hi|hello|hey|good (morning|evening|afternoon)/.test(text) && turn <= 1) {
    return 'Hello. What would you like to work on?';
  }
  if (/thank/.test(text)) {
    return 'Happy to help. Anything else you want to work through?';
  }
  if (text.length < 3) {
    return 'Could you add a little more detail? I will take it from there.';
  }
  return (
    'Here is what I have on that: ' +
    String(message).trim().replace(/\s+/g, ' ') +
    '. This preview runs on local responses — connect your model endpoint by setting SAVEHATKE_MODEL_API_URL and it will answer with your own backend.'
  );
}