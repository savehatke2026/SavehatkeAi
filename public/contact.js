/* ============================================================
   SaveHatke AI — contact.js
   Contact form validation. Replace the submit handler body with a
   POST to your mail or ticketing endpoint to go live.
   ============================================================ */
(function () {
  'use strict';

  var S = window.SaveHatke;
  if (!S) return;

  var $ = S.util.$;
  var form = $('#contact-form');
  if (!form) return;

  var nameInput = $('#c-name');
  var emailInput = $('#c-email');
  var messageInput = $('#c-message');
  var submitBtn = $('#contact-submit');
  var note = $('#contact-note');
  var noteText = $('#contact-note-text');

  function setError(input, message) {
    var target = document.querySelector('[data-error-for="' + input.name + '"]');
    if (target) target.textContent = message || '';
    input.classList.toggle('has-error', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function showNote(message) {
    note.hidden = !message;
    noteText.textContent = message || '';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    [nameInput, emailInput, messageInput].forEach(function (i) { setError(i, ''); });
    showNote('');

    var ok = true;

    if (!nameInput.value.trim()) { setError(nameInput, 'Please enter your name.'); ok = false; }

    var email = emailInput.value.trim();
    if (!email) {
      setError(emailInput, 'Please enter your email.');
      ok = false;
    } else if (!S.util.isValidEmail(email)) {
      setError(emailInput, 'Please enter a valid email address.');
      ok = false;
    }

    if (messageInput.value.trim().length < 10) {
      setError(messageInput, 'Please add a little more detail.');
      ok = false;
    }

    if (!ok) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    // Front-end only for now — no request is made.
    window.setTimeout(function () {
      form.reset();
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send message';
      showNote('Thanks — this form is not connected to a mailbox yet, so nothing was sent. Wire it up in contact.js to receive messages.');
    }, 500);
  });

  [nameInput, emailInput, messageInput].forEach(function (input) {
    input.addEventListener('input', function () { setError(input, ''); });
  });
})();