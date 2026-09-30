/* ============================================================
   SaveHatke AI — chat.js
   Chat interface. Sends through SaveHatke.chat.send() in core.js,
   which currently resolves local placeholder replies. Swap that
   function for a real model endpoint and this file needs no changes.
   ============================================================ */
(function () {
  'use strict';

  var S = window.SaveHatke;
  if (!S) return;

  var $ = S.util.$;

  var form = $('#composer');
  var input = $('#chat-input');
  var sendBtn = $('#composer-send');
  var thread = $('#chat-thread');
  var scroll = $('#chat-scroll');
  var intro = $('#chat-intro');
  var clearBtn = $('#clear-chat');

  var history = [];
  var pending = 0;
  // Replies are chained so a message sent while another is still being
  // answered is queued instead of dropped, and replies stay in order.
  var queue = Promise.resolve();
  // Bumped by "Clear chat" so replies already in flight are discarded
  // instead of landing in the emptied thread.
  var generation = 0;

  /* ---------------- rendering ---------------- */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function addMessage(role, text, variant) {
    var msg = el('div', 'msg' + (role === 'user' ? ' msg-user' : ''));
    var bubble = el('div', 'bubble ' + (role === 'user' ? 'bubble-user' : (variant === 'error' ? 'bubble-error' : 'bubble-bot')));
    bubble.textContent = text;
    msg.appendChild(bubble);
    thread.appendChild(msg);
    return bubble;
  }

  function addTyping() {
    var msg = el('div', 'msg');
    var bubble = el('div', 'bubble bubble-bot');
    var dots = el('span', 'typing');
    dots.innerHTML = '<span></span><span></span><span></span>';
    bubble.appendChild(dots);
    msg.appendChild(bubble);
    thread.appendChild(msg);
    return msg;
  }

  function scrollToEnd() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function saveHistory() {
    // Conversations are kept with the local account, keyed by the verified
    // email, so two Google accounts on one machine never share history.
    if (!S.session.isSignedIn()) return;
    var account = S.account.get();
    if (!account) return;
    account.chats = (account.chats || []).concat(history.slice(-40));
    account.chats = account.chats.slice(-80);
    S.account.save(account);
  }

  /* ---------------- autosize composer ---------------- */
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  }

  /* ---------------- send flow ---------------- */
  function send(text) {
    var message = String(text || '').trim();
    if (!message) return;

    if (intro) intro.hidden = true;

    history.push({ role: 'user', content: message });
    addMessage('user', message);
    input.value = '';
    autosize();
    scrollToEnd();

    pending++;
    sendBtn.disabled = true;
    var typing = addTyping();
    scrollToEnd();

    var gen = generation;
    queue = queue
      .then(function () { return S.chat.send(message, history); })
      .then(function (reply) {
        if (gen !== generation) return;
        typing.remove();
        var body = (reply && reply.content) || reply || 'No response.';
        history.push({ role: 'assistant', content: body });
        addMessage('assistant', body);
        saveHistory();
      })
      .catch(function (err) {
        if (gen !== generation) return;
        typing.remove();
        addMessage('assistant', 'Something went wrong sending that message. ' + (err && err.message ? err.message : ''), 'error');
      })
      .finally(function () {
        typing.remove();
        pending--;
        if (pending === 0) {
          sendBtn.disabled = false;
          scrollToEnd();
        }
        if (window.matchMedia('(pointer: fine)').matches) input.focus();
      });
  }

  /* ---------------- events ---------------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    send(input.value);
  });

  input.addEventListener('input', autosize);

  // Enter sends, Shift+Enter adds a line
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });

  S.util.$$('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      send(chip.getAttribute('data-prompt') || chip.textContent);
    });
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      history = [];
      queue = Promise.resolve();
      pending = 0;
      generation++;
      sendBtn.disabled = false;
      thread.innerHTML = '';
      if (intro) intro.hidden = false;
      input.focus();
    });
  }

  // Autofocus on pointer-fine devices only, so mobile keyboards
  // don't cover the screen on arrival.
  //
  // The chatbot is for authorized accounts only. The server has already
  // refused unauthorized visitors (middleware + /api/chat), so this guard
  // exists to avoid a pointless focus and to send anyone who slipped
  // through to the right page rather than showing a dead composer.
  S.ready.then(function () {
    if (!S.session.isSignedIn()) {
      if (S.session.authenticated()) {
        var reason = S.session.denialReason() || 'not_listed';
        window.location.replace('access-restricted.html?reason=' + encodeURIComponent(reason));
      } else {
        window.location.replace('login.html?next=chat.html');
      }
      return;
    }
    if (window.matchMedia('(pointer: fine)').matches) input.focus();
  });
})();