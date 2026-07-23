(() => {
  'use strict';

  const get = (id) => document.getElementById(id);
  let transitionTimer = 0;

  function setImportant(node, property, value) {
    if (node) node.style.setProperty(property, value, 'important');
  }

  function resetToTop() {
    const shell = get('appShell');
    const main = document.querySelector('.main-content');
    const active = document.querySelector('.view.active');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (shell) shell.scrollTop = 0;
    if (main) main.scrollTop = 0;
    if (active) active.scrollTop = 0;
  }

  function lock() {
    const auth = get('authScreen');
    const shell = get('appShell');
    document.documentElement.classList.add('lso-auth-locked');
    if (document.body) delete document.body.dataset.authenticated;

    if (shell) {
      shell.classList.add('hidden', 'auth-locked');
      shell.hidden = true;
      shell.setAttribute('hidden', '');
      shell.setAttribute('inert', '');
      shell.setAttribute('aria-hidden', 'true');
      setImportant(shell, 'display', 'none');
      setImportant(shell, 'visibility', 'hidden');
      setImportant(shell, 'pointer-events', 'none');
    }

    if (auth) {
      auth.classList.remove('hidden');
      auth.hidden = false;
      auth.removeAttribute('hidden');
      auth.removeAttribute('inert');
      auth.setAttribute('aria-hidden', 'false');
      ['display','visibility','pointer-events','position','inset','width','height','min-height','overflow','opacity'].forEach((name) => auth.style.removeProperty(name));
    }
  }

  function unlock() {
    const authenticated = document.body?.dataset.authenticated === 'true' && Boolean(window.LSOCurrentAccount);
    if (!authenticated) {
      lock();
      return;
    }

    const auth = get('authScreen');
    const shell = get('appShell');
    if (!shell) return;

    if (auth) {
      auth.classList.add('hidden');
      auth.hidden = true;
      auth.setAttribute('hidden', '');
      auth.setAttribute('inert', '');
      auth.setAttribute('aria-hidden', 'true');
      setImportant(auth, 'display', 'none');
      setImportant(auth, 'visibility', 'hidden');
      setImportant(auth, 'pointer-events', 'none');
      setImportant(auth, 'position', 'fixed');
      setImportant(auth, 'inset', '0');
      setImportant(auth, 'width', '0');
      setImportant(auth, 'height', '0');
      setImportant(auth, 'min-height', '0');
      setImportant(auth, 'overflow', 'hidden');
      setImportant(auth, 'opacity', '0');
    }

    shell.classList.remove('hidden', 'auth-locked');
    shell.hidden = false;
    shell.removeAttribute('hidden');
    shell.removeAttribute('inert');
    shell.setAttribute('aria-hidden', 'false');
    setImportant(shell, 'display', matchMedia('(max-width: 920px)').matches ? 'block' : 'grid');
    setImportant(shell, 'visibility', 'visible');
    setImportant(shell, 'pointer-events', 'auto');
    setImportant(shell, 'position', 'relative');
    setImportant(shell, 'inset', 'auto');
    setImportant(shell, 'width', '100%');
    setImportant(shell, 'height', 'auto');
    setImportant(shell, 'min-height', '100dvh');
    setImportant(shell, 'max-width', 'none');
    setImportant(shell, 'max-height', 'none');
    setImportant(shell, 'overflow', 'visible');
    setImportant(shell, 'opacity', '1');
    setImportant(shell, 'content-visibility', 'visible');
    document.documentElement.classList.remove('lso-auth-locked');

    clearTimeout(transitionTimer);
    resetToTop();
    requestAnimationFrame(() => {
      resetToTop();
      requestAnimationFrame(resetToTop);
    });
    transitionTimer = window.setTimeout(resetToTop, 350);
  }

  function synchronize() {
    if (document.body?.dataset.authenticated === 'true' && window.LSOCurrentAccount) unlock();
    else lock();
  }

  function initialize() {
    const body = document.body;
    if (!body) return;
    new MutationObserver(synchronize).observe(body, { attributes: true, attributeFilter: ['data-authenticated'] });
    window.addEventListener('lso:auth-changed', () => requestAnimationFrame(synchronize));
    window.addEventListener('pageshow', synchronize);
    window.addEventListener('resize', () => {
      if (body.dataset.authenticated === 'true' && window.LSOCurrentAccount) unlock();
    });
    synchronize();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
