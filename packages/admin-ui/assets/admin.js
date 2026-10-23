// SPDX-License-Identifier: Apache-2.0
// agility-bridge admin UI (P4-03): optional enhancements only. Every page works without this file. Loaded as a static
// asset (`script-src 'self'` + SRI); no inline handlers, no HTML sinks (Trusted Types are enforced).
(() => {
  document.documentElement.classList.add('js');

  // Copy buttons: <button type="button" data-copy="<element id>" hidden>. Shown only when the clipboard API exists.
  const canCopy = Boolean(navigator.clipboard && window.isSecureContext);
  for (const button of document.querySelectorAll('button[data-copy]')) {
    if (!canCopy) continue;
    const target = document.getElementById(button.getAttribute('data-copy') || '');
    if (!target) continue;
    button.hidden = false;
    const label = button.textContent;
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(target.textContent || '').then(
        () => {
          button.textContent = 'Copied';
          setTimeout(() => {
            button.textContent = label;
          }, 2000);
        },
        () => {
          button.textContent = 'Copy failed: select the text instead';
        },
      );
    });
  }

  // Owner setup page: the single-use code arrives in the URL fragment, which no server or log ever sees. Move it into
  // the form field and remove it from the address bar. Without this script the code can be pasted.
  const setup = document.querySelector('input[data-setup-code]');
  const match = /^#(ab_setup_[0-9a-f]{64})$/.exec(location.hash);
  if (setup && match) {
    setup.value = match[1];
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {
      // an address bar that cannot change is not a failure
    }
  }
})();
