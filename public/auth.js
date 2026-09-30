/* ============================================================
   SaveHatke AI — auth.js
   Google-only sign-in (OAuth 2.0 Authorization Code flow).

   Flow:
     1. Click "Continue with Google" → navigate to /api/auth/login
     2. The server mints state + nonce + PKCE verifier into a signed
        HttpOnly cookie and redirects to Google
     3. Google redirects back to /api/auth/callback, which verifies
        everything, checks the whitelist, and sets the session cookie
     4. The user lands on the chatbot, or on the Access Restricted page

   There is deliberately no email/password path: this site never handles a
   password, and it loads no third-party script on the login page.

   The browser is a bystander here. It never sees a client secret, a
   nonce, a PKCE verifier, or a raw Google token, and it makes no
   authorization decision of its own.
   ============================================================ */
(function () {
  'use strict';

  var S = window.SaveHatke;
  if (!S) return;

  var $ = S.util.$;
  var button = $('#google-signin');
  if (!button) return;

  var note = $('#form-note');
  var noteText = $('#form-note-text');
  var params = new URLSearchParams(window.location.search);

  /** Same-site relative page targets only — blocks open redirects. */
  function destination() {
    var next = params.get('next');
    if (next && /^[a-z0-9._-]+\.html([#?].*)?$/i.test(next)) return next;
    return 'chat.html';
  }

  function showNote(message) {
    note.hidden = !message;
    noteText.textContent = message || '';
  }

  /** Friendly copy for the ?error= codes the callback redirects back with. */
  var MESSAGES = {
    cancelled: 'Google sign-in was cancelled. Try again when you are ready.',
    expired: 'That sign-in attempt expired. Please try again.',
    invalid_request: 'That sign-in link was incomplete. Please try again.',
    google_error: 'Google could not complete the sign-in. Please try again.',
    signin_failed: 'We could not verify your Google account. Please try again.',
    state_mismatch: 'That sign-in attempt could not be verified. Please try again.',
  };

  var errorCode = params.get('error');
  if (errorCode) {
    showNote(MESSAGES[errorCode] || 'Sign-in failed. Please try again.');
    // Keep the URL clean so a refresh does not re-show a stale error.
    if (window.history.replaceState) {
      var url = new URL(window.location.href);
      url.searchParams.delete('error');
      window.history.replaceState(null, '', url);
    }
  }

  button.addEventListener('click', function () {
    button.disabled = true;
    button.classList.add('is-busy');
    showNote('');

    // Hand off to the server. Everything security-relevant happens there.
    var target = '/api/auth/login?next=' + encodeURIComponent(destination());
    window.location.href = target;
  });

  // Already signed in? The chatbot is more useful than this page. Wait for
  // the server's answer rather than trusting anything local.
  S.ready.then(function () {
    if (S.session.isSignedIn() && !params.get('stay')) {
      window.location.replace(destination());
      return;
    }
    // Authenticated but not authorized: send them to the explanation page.
    if (S.session.authenticated && S.session.authenticated() && !S.session.isSignedIn()) {
      var reason = S.session.denialReason ? S.session.denialReason() : 'not_listed';
      window.location.replace('access-restricted.html?reason=' + encodeURIComponent(reason || 'not_listed'));
      return;
    }
    // Surface a deploy-time misconfiguration instead of a dead button.
    S.auth.config().then(function (settings) {
      if (settings && settings.configured === false) {
        showNote(
          'Google sign-in is not configured on the server yet' +
          (settings.missing && settings.missing.length
            ? ' (missing ' + settings.missing.join(', ') + ').'
            : '.')
        );
      }
    }).catch(function () { /* non-fatal: the button still works */ });
  });
})();