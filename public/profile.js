/* ============================================================
   SaveHatke AI — profile.js
   Display-name editing and account data controls.

   Identity is owned by Google: the email is verified server-side and is
   read-only here. Only the display name is editable, and only locally.
   ============================================================ */
(function () {
  'use strict';

  var S = window.SaveHatke;
  if (!S) return;

  var $ = S.util.$;

  S.ready.then(function () {
    if (!S.session.isSignedIn()) {
      if (S.session.authenticated()) {
        var reason = S.session.denialReason() || 'not_listed';
        window.location.replace('access-restricted.html?reason=' + encodeURIComponent(reason));
        return;
      }
      window.location.replace('login.html?next=profile.html');
      return;
    }
    init(S.session.get());
  });

  function init(session) {
    var form = $('#profile-form');
    var nameInput = $('#p-name');
    var emailInput = $('#p-email');
    var saveBtn = $('#save-profile');

    function setError(input, message) {
      var target = document.querySelector('[data-error-for="' + input.name + '"]');
      if (target) target.textContent = message || '';
      input.classList.toggle('has-error', Boolean(message));
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    }

    /* ---------------- populate ---------------- */
    var account = S.account.ensure();
    if (!account) return;

    nameInput.value = account.name || session.name || '';
    // Read-only: the verified Google address, not an editable field.
    emailInput.value = session.email || '';
    $('#key-count').textContent = S.keys.list().length + ' active';

    /* ---------------- save ---------------- */
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      setError(nameInput, '');

      var name = nameInput.value.trim();
      if (!name) {
        setError(nameInput, 'Please enter your name.');
        return;
      }
      if (name.length > 120) {
        setError(nameInput, 'Please use 120 characters or fewer.');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      var updated = S.account.get() || account;
      updated.name = name;
      S.account.save(updated);
      S.account.record('profile.updated');

      // Update the navbar immediately; the server's copy is unchanged.
      S.ui.renderNav();
      S.ui.toast('Profile updated');

      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
    });

    nameInput.addEventListener('input', function () { setError(nameInput, ''); });

    /* ---------------- account switching ---------------- */
    var switchAccount = $('#switch-account');
    if (switchAccount) {
      switchAccount.addEventListener('click', function () {
        switchAccount.disabled = true;
        switchAccount.textContent = 'Signing out…';
        S.account.record('auth.signout');
        S.session.signOut().then(function () {
          window.location.href = 'login.html';
        });
      });
    }

    /* ---------------- danger zone ---------------- */
    var signOut = $('#sign-out');
    if (signOut) {
      signOut.addEventListener('click', function () {
        S.account.record('auth.signout');
        S.session.signOut().then(function () {
          window.location.href = 'index.html';
        });
      });
    }

    var wipe = $('#wipe-account');
    if (wipe) {
      wipe.addEventListener('click', function () {
        var sure = window.confirm(
          'Delete the SaveHatke AI data stored in this browser?\n\n' +
          'This removes your local API keys and activity on this device. ' +
          'Your Google account and server session are not affected.'
        );
        if (!sure) return;
        S.account.wipeLocalData();
        S.ui.toast('Local data deleted');
      });
    }
  }
})();