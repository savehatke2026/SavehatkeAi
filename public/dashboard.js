/* ============================================================
   SaveHatke AI — dashboard.js
   Account overview, API key management, integration snippet,
   security actions, activity feed.

   The session comes from the server, so everything here runs after
   S.ready resolves. The middleware already blocks signed-out visitors,
   but this page re-checks anyway: a revoked user can reach it while
   their cookie is still valid.
   ============================================================ */
(function () {
  'use strict';

  var S = window.SaveHatke;
  if (!S) return;

  var $ = S.util.$;
  var $$ = S.util.$$;

  S.ready.then(function () {
    /* ---------------- access guard ---------------- */
    if (!S.session.isSignedIn()) {
      if (S.session.authenticated()) {
        // Signed in but not authorized — explain rather than loop.
        var reason = S.session.denialReason() || 'not_listed';
        window.location.replace('access-restricted.html?reason=' + encodeURIComponent(reason));
        return;
      }
      window.location.replace('login.html?next=dashboard.html');
      return;
    }

    init(S.session.get());
  });

  function init(session) {
    var account = S.account.ensure();
    if (!account) return;

    /* ---------------- account overview ---------------- */
    $('#account-joined').textContent = S.util.formatDate(account.joined);

    /* ---------------- API keys ---------------- */
    var list = $('#key-list');
    var empty = $('#key-empty');
    var revealSlot = $('#reveal-slot');

    function renderKeys() {
      var keys = S.keys.list();
      list.innerHTML = '';
      empty.hidden = keys.length > 0;

      keys.forEach(function (key) {
        var li = document.createElement('li');
        li.className = 'key-row';

        var main = document.createElement('div');
        main.className = 'key-main';

        var name = document.createElement('div');
        name.className = 'key-name';
        name.textContent = key.label;

        var meta = document.createElement('div');
        meta.className = 'key-meta';
        meta.textContent = 'Created ' + S.util.formatDate(key.created) +
          ' · Last used ' + (key.lastUsed ? S.util.formatDate(key.lastUsed) : 'never');

        main.appendChild(name);
        main.appendChild(meta);

        var value = document.createElement('code');
        value.className = 'key-value';
        value.textContent = key.prefix + '••••••••••••••••';

        var actions = document.createElement('div');
        actions.className = 'key-actions';

        var revoke = document.createElement('button');
        revoke.className = 'btn btn-danger btn-sm';
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', function () {
          if (!window.confirm('Revoke "' + key.label + '"? Applications using this key will stop working.')) return;
          S.keys.revoke(key.id);
          renderKeys();
          renderActivity();
          S.ui.toast('API key revoked');
        });

        actions.appendChild(revoke);
        li.appendChild(main);
        li.appendChild(value);
        li.appendChild(actions);
        list.appendChild(li);
      });
    }

    function showNewKey(key) {
      revealSlot.innerHTML = '';

      var box = document.createElement('div');
      box.className = 'reveal-box';

      var head = document.createElement('div');
      head.className = 'reveal-head';
      head.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
        '<span>Copy this key now — it will not be shown again.</span>';

      var body = document.createElement('div');
      body.className = 'reveal-body';

      var value = document.createElement('code');
      value.className = 'reveal-key';
      value.textContent = key.secret;

      var copy = document.createElement('button');
      copy.className = 'btn btn-secondary btn-sm';
      copy.type = 'button';
      copy.textContent = 'Copy key';
      copy.addEventListener('click', function () {
        S.util.copyText(key.secret).then(function () {
          copy.textContent = 'Copied';
          S.ui.toast('API key copied');
          window.setTimeout(function () { copy.textContent = 'Copy key'; }, 1800);
        }).catch(function () {
          S.ui.toast('Copy failed — select the key manually');
        });
      });

      var dismiss = document.createElement('button');
      dismiss.className = 'btn btn-ghost btn-sm';
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', function () { revealSlot.innerHTML = ''; });

      body.appendChild(value);
      body.appendChild(copy);
      body.appendChild(dismiss);
      box.appendChild(head);
      box.appendChild(body);
      revealSlot.appendChild(box);
    }

    $('#create-key').addEventListener('click', function () {
      var label = window.prompt('Name this key (e.g. Website chatbot)', 'Website chatbot');
      if (label === null) return;
      var key = S.keys.create(label.trim() || 'Untitled key');
      if (!key) return;
      renderKeys();
      renderActivity();
      showNewKey(key);
      S.ui.toast('API key generated');
    });

    /* ---------------- integration snippet ---------------- */
    var snippet = $('#snippet');
    var copySnippet = $('#copy-snippet');

    function currentSnippet() {
      var keys = S.keys.list();
      var placeholder = keys.length ? keys[0].prefix + '…' : 'YOUR_API_KEY';
      return snippet.textContent.replace('$SAVEHATKE_API_KEY', placeholder);
    }

    copySnippet.addEventListener('click', function () {
      S.util.copyText(currentSnippet()).then(function () {
        copySnippet.textContent = 'Copied';
        S.ui.toast('Snippet copied');
        window.setTimeout(function () { copySnippet.textContent = 'Copy'; }, 1800);
      }).catch(function () {
        S.ui.toast('Copy failed');
      });
    });

    /* ---------------- activity ---------------- */
    var activityList = $('#activity-list');
    var activityEmpty = $('#activity-empty');

    var ACTIVITY_LABELS = {
      'auth.google': 'Signed in with Google',
      'auth.signout': 'Signed out',
      'key.created': 'API key generated',
      'key.revoked': 'API key revoked',
      'profile.updated': 'Profile updated'
    };

    function renderActivity() {
      var fresh = S.account.get() || account;
      var items = (fresh.activity || []).slice(0, 8);

      activityList.innerHTML = '';
      activityEmpty.hidden = items.length > 0;

      items.forEach(function (item) {
        var li = document.createElement('li');
        li.className = 'key-row';

        var main = document.createElement('div');
        main.className = 'key-main';

        var label = document.createElement('div');
        label.className = 'key-name';
        label.textContent = ACTIVITY_LABELS[item.type] || item.type;

        var meta = document.createElement('div');
        meta.className = 'key-meta';
        meta.textContent = item.label ? item.label + ' · ' + S.util.formatDate(item.at) : S.util.formatDate(item.at);

        main.appendChild(label);
        main.appendChild(meta);
        li.appendChild(main);
        activityList.appendChild(li);
      });
    }

    /* ---------------- security ---------------- */
    var signOut = $('#sign-out-all');
    if (signOut) {
      signOut.addEventListener('click', function () {
        S.account.record('auth.signout');
        S.session.signOut().then(function () {
          window.location.href = 'index.html';
        });
      });
    }

    /* ---------------- init ---------------- */
    renderKeys();
    renderActivity();
  }
})();
