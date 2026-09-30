/* ============================================================
   SaveHatke AI — core.js
   Shared runtime: server session, navbar state, Google sign-in,
   account data, API keys, toasts, reveal animations.

   Authentication is server-backed: the session lives in an HttpOnly
   cookie that JavaScript cannot read. The only way to create one is the
   server-side OAuth redirect flow — the browser is sent to
   /api/auth/login, Google returns to /api/auth/callback, and the server
   issues the cookie after verifying the identity and the whitelist.

   Account data (API keys) is still kept in per-account localStorage as a
   placeholder until key management moves server-side. It is namespaced by
   the verified email, so two Google accounts on one machine never share
   keys, and it is never treated as an authorization decision.
   ============================================================ */
(function () {
  'use strict';

  /* No session or identity value belongs in localStorage: the cookie is
     HttpOnly precisely so scripts cannot read or forge it. This only
     namespaces the placeholder account data below. */
  var ACCOUNT_PREFIX = 'savehatke.account.v1:';

  /* ---------------- storage helpers ---------------- */
  function read(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function drop(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* ---------------- tiny utilities ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function initials(name) {
    var source = String(name || '').trim();
    if (!source) return '?';
    var parts = source.split(/[\s@._-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function randomId() {
    if (window.crypto && window.crypto.getRandomValues) {
      var bytes = new Uint8Array(9);
      window.crypto.getRandomValues(bytes);
      return Array.prototype.map.call(bytes, function (b) {
        return b.toString(36).padStart(2, '0');
      }).join('').slice(0, 14);
    }
    return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
  }

  function formatDate(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  /* ---------------- HTTP ---------------- */
  function request(url, options) {
    var opts = options || {};
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || 'Request failed');
          error.code = data.code || String(response.status);
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  /* ---------------- session ----------------
     Cached in memory only. Every page load re-reads it from the server,
     which is what makes a revocation take effect on the next request. */
  var state = {
    session: null,      // { email, name, authorized, reason } | null
    loaded: false
  };

  var readyResolve;
  var ready = new Promise(function (resolve) { readyResolve = resolve; });

  function getSession() {
    return state.session && state.session.authorized ? state.session : null;
  }

  function isSignedIn() {
    return Boolean(getSession());
  }

  /**
   * Reads the session from the server.
   * @returns {Promise<{session:object|null, authorized:boolean, reason:string}>}
   */
  function loadSession() {
    return request('/api/auth/session')
      .then(function (data) {
        state.session = data.authenticated
          ? {
              // `user` is only populated when authorized; fall back to the
              // bare email so the restricted page can name the account that
              // was refused.
              email: (data.user && data.user.email) || data.email || '',
              name: (data.user && data.user.name) || '',
              authorized: Boolean(data.authorized),
              reason: data.reason || ''
            }
          : null;
        state.loaded = true;
        return { session: getSession(), authorized: data.authorized, reason: data.reason };
      })
      .catch(function () {
        // A failed lookup means "not signed in" as far as the UI is
        // concerned; the server still enforces access on every request.
        state.session = null;
        state.loaded = true;
        return { session: null, authorized: false, reason: 'unavailable' };
      });
  }

  /** Provider configuration; tells the page whether sign-in is set up. */
  function authConfig() {
    return request('/api/auth/config');
  }

  /**
   * Sends the browser to Google to begin sign-in. The server owns the
   * whole handshake (state, nonce, PKCE) and creates the session; there is
   * no credential for this script to hold or forward.
   */
  function signInWithGoogle(next) {
    window.location.href = '/api/auth/login?next=' + encodeURIComponent(next || 'chat.html');
  }

  /** Clears the server session cookie. Always resolves. */
  function signOut() {
    return request('/api/auth/logout', { method: 'POST' })
      .catch(function () { /* signing out should never fail the UI */ })
      .then(function () {
        state.session = null;
        renderNav();
      });
  }

  /* ---------------- account data ----------------
     Placeholder, per-account, browser-local. Not an authorization
     boundary — server routes never read this. */
  function accountKey() {
    var session = getSession();
    return session ? ACCOUNT_PREFIX + session.email : null;
  }

  function blankAccount(email, name) {
    return {
      email: email,
      name: name || email.split('@')[0],
      joined: new Date().toISOString(),
      keys: [],
      activity: []
    };
  }

  function getAccount() {
    var key = accountKey();
    if (!key) return null;
    return read(key, null);
  }

  function saveAccount(account) {
    var key = accountKey();
    if (!key) return null;
    write(key, account);
    return account;
  }

  /** Loads the account for the signed-in user, creating it on first run. */
  function ensureAccount() {
    var session = getSession();
    if (!session) return null;
    var account = getAccount();
    if (!account) account = blankAccount(session.email, session.name);
    // The server is the source of truth for the display name.
    if (session.name && account.name !== session.name) account.name = session.name;
    if (!account.joined) account.joined = new Date().toISOString();
    return saveAccount(account);
  }

  function recordActivity(type, label) {
    var account = getAccount();
    if (!account) return;
    account.activity = account.activity || [];
    account.activity.unshift({ type: type, label: label || '', at: new Date().toISOString() });
    account.activity = account.activity.slice(0, 60);
    saveAccount(account);
  }

  function wipeLocalData() {
    var key = accountKey();
    if (key) drop(key);
  }

  /* ---------------- API keys (placeholder, local) ----------------
     shape: { id, label, prefix, secret, created, lastUsed }        */
  function listKeys() {
    var account = getAccount();
    return account && account.keys ? account.keys.slice() : [];
  }

  function createKey(label) {
    var account = getAccount();
    if (!account) return null;
    var secret = 'sh_live_' + randomId() + randomId();
    var key = {
      id: randomId(),
      label: label || 'Website chatbot',
      prefix: secret.slice(0, 12),
      secret: secret,
      created: new Date().toISOString(),
      lastUsed: null
    };
    account.keys = account.keys || [];
    account.keys.unshift(key);
    saveAccount(account);
    recordActivity('key.created', key.label);
    return key;
  }

  function revokeKey(id) {
    var account = getAccount();
    if (!account || !account.keys) return false;
    var target = null;
    account.keys = account.keys.filter(function (k) {
      if (k.id === id) { target = k; return false; }
      return true;
    });
    saveAccount(account);
    if (target) recordActivity('key.revoked', target.label);
    return Boolean(target);
  }

  /* ---------------- toast ---------------- */
  var toastEl = null;
  var toastTimer = null;

  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 2200);
  }

  /* ---------------- navbar ---------------- */
  function renderNav() {
    var session = getSession();
    var signedIn = Boolean(session);

    $$('[data-nav-auth]').forEach(function (el) {
      var wants = el.getAttribute('data-nav-auth');
      el.hidden = signedIn ? wants !== 'user' : wants !== 'guest';
    });

    if (signedIn) {
      var label = session.name || session.email;
      $$('[data-avatar]').forEach(function (el) {
        el.textContent = initials(label);
        el.setAttribute('aria-label', 'Profile — ' + label);
        el.setAttribute('title', label);
      });
      $$('[data-user-name]').forEach(function (el) { el.textContent = session.name || session.email; });
      $$('[data-user-email]').forEach(function (el) { el.textContent = session.email; });
    }

    $$('[data-auth-only]').forEach(function (el) { el.hidden = !signedIn; });
    $$('[data-guest-only]').forEach(function (el) { el.hidden = signedIn; });
  }

  /* ---------------- header scroll + mobile menu ---------------- */
  function initChrome() {
    var header = $('[data-header]');
    if (header) {
      /* On the homepage the header floats over the dark hero band, so it has
         to stay transparent until that band has scrolled past it. Everywhere
         else a 4px threshold is enough to know the page has moved. */
      var darkHero = $('[data-dark-hero]');

      var onScroll = function () {
        var scrolled;
        if (darkHero) {
          var threshold = darkHero.offsetTop + darkHero.offsetHeight - header.offsetHeight - 8;
          scrolled = window.scrollY >= Math.max(0, threshold);
        } else {
          scrolled = window.scrollY > 4;
        }
        header.classList.toggle('is-scrolled', scrolled);
      };

      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
    }

    var menuBtn = $('#menu-btn');
    var nav = $('#site-nav');
    if (menuBtn && nav) {
      menuBtn.addEventListener('click', function () {
        var open = nav.classList.toggle('is-open');
        menuBtn.setAttribute('aria-expanded', String(open));
        menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      });
      nav.addEventListener('click', function (e) {
        if (e.target.closest('a')) {
          nav.classList.remove('is-open');
          menuBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }

  /* ---------------- reveal on scroll ---------------- */
  function initReveal() {
    var els = $$('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------------- public API ---------------- */
  var SaveHatke = {
    /* Resolves once the server session has been read. Page scripts that
       need the session must wait for this instead of reading it
       synchronously at script-parse time. */
    ready: ready,

    request: request,

    util: {
      $: $, $$: $$, initials: initials, copyText: copyText,
      formatDate: formatDate, isValidEmail: isValidEmail, randomId: randomId
    },

    session: {
      get: getSession,
      isSignedIn: isSignedIn,
      reload: loadSession,
      signOut: signOut,
      /* Set only when the user authenticated but is not authorized, so the
         page can explain why instead of pretending they are signed out. */
      denialReason: function () {
        return state.session && !state.session.authorized ? state.session.reason : '';
      },
      /* The email of an authenticated-but-refused account, for display on
         the restricted page. Empty when nobody is signed in. */
      deniedEmail: function () {
        return state.session && !state.session.authorized ? state.session.email || '' : '';
      },
      authenticated: function () {
        return Boolean(state.session);
      }
    },

    /* Google is the only sign-in method. */
    auth: {
      config: authConfig,
      signInWithGoogle: signInWithGoogle
    },

    account: {
      get: getAccount,
      ensure: ensureAccount,
      save: saveAccount,
      record: recordActivity,
      wipeLocalData: wipeLocalData
    },

    keys: {
      list: listKeys,
      create: createKey,
      revoke: revokeKey
    },

    /* The chatbot is reached ONLY through our backend, which re-checks the
       session and the whitelist before contacting any model. The browser
       holds no model credentials and cannot address the provider directly. */
    chat: {
      send: function (message, history) {
        // Drop the trailing turn the caller just appended; the server takes
        // the message separately and validates it itself.
        var prior = (history || []).slice(0, -1).map(function (turn) {
          return { role: turn.role, content: turn.content };
        });

        return request('/api/chat', {
          method: 'POST',
          body: { message: message, history: prior }
        }).then(function (data) {
          return data.reply;
        });
      }
    },

    ui: {
      toast: toast,
      renderNav: renderNav
    }
  };

  /* ---------------- boot ---------------- */
  function boot() {
    initChrome();
    initReveal();

    // The navbar depends on the session, so render it once we know.
    loadSession().then(function () {
      renderNav();
      readyResolve();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SaveHatke = SaveHatke;
})();