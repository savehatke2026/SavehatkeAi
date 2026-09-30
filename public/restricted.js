/* ============================================================
   SaveHatke AI — restricted.js

   Shown when a Google account authenticated successfully but is not (or
   is no longer) on the whitelist.

   The page is reached from two places — the middleware redirect, which
   passes ?reason=, and an in-app API refusal — so it renders the reason
   from the URL and reconfirms it against /api/auth/session.
   ============================================================ */
(function () {
  'use strict';

  var S = window.SaveHatke;
  if (!S) return;

  var $ = S.util.$;
  var params = new URLSearchParams(window.location.search);
  var reason = params.get('reason') || '';

  var COPY = {
    not_listed: {
      title: 'Access restricted',
      message: 'This Google account is not authorized for SaveHatke AI.',
    },
    disabled: {
      title: 'Access disabled',
      message: 'Access for this Google account has been disabled.',
    },
    unavailable: {
      title: 'Temporarily unavailable',
      message: 'Authorization could not be checked just now. Please try again in a moment.',
    },
  };

  function apply(key) {
    var copy = COPY[key] || COPY.not_listed;
    $('#denial-title').textContent = copy.title;
    $('#denial-message').textContent = copy.message;
    // Only a real identity is worth showing back to the user.
    if (key === 'unavailable') $('#denial-detail').hidden = true;
  }

  apply(reason);

  // Reconfirm against the server: the query string is user-editable, and a
  // now-authorized user should not be stuck on this page.
  S.ready.then(function () {
    if (S.session.isSignedIn()) {
      window.location.replace('dashboard.html');
      return;
    }

    var serverReason = S.session.denialReason();
    if (serverReason) {
      reason = serverReason;
      apply(serverReason);
    }
    if (S.session.authenticated()) {
      // Prefer the server's answer for which account was refused, since the
      // query string is user-editable.
      var email = S.session.deniedEmail() || (params.get('email') || '').trim();
      if (email) {
        $('#denial-email').textContent = email;
        $('#denial-detail').hidden = false;
      }
    }
  });

  $('#switch-account').addEventListener('click', function () {
    var button = this;
    button.disabled = true;
    button.textContent = 'Signing out…';
    // Clear the session first, otherwise the login page would bounce back
    // here because the user is still "signed in".
    S.session.signOut().then(function () {
      window.location.href = 'login.html';
    });
  });
})();