(() => {
  'use strict';

  const installButton = document.getElementById('installAppButton');
  const connectionBanner = document.getElementById('connectionBanner');
  let deferredInstallPrompt = null;
  let refreshing = false;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function showConnectionBanner(message, state = 'offline') {
    if (!connectionBanner) return;
    connectionBanner.textContent = message;
    connectionBanner.dataset.state = state;
    connectionBanner.classList.remove('hidden');
  }

  function hideConnectionBanner() {
    connectionBanner?.classList.add('hidden');
  }

  function updateConnectivity() {
    if (navigator.onLine) {
      showConnectionBanner('Connection restored. Online database access is available.', 'online');
      window.setTimeout(hideConnectionBanner, 2200);
    } else {
      showConnectionBanner('You are offline. Cached website screens remain available, but database actions require a connection.', 'offline');
    }
  }

  async function installApplication() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton?.classList.add('hidden');
  }

  function registerInstallEvents() {
    if (!installButton || isStandalone()) return;

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.classList.remove('hidden');
    });

    installButton.addEventListener('click', installApplication);
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      installButton.classList.add('hidden');
      window.LSOApp?.showToast?.('LSO System was installed successfully.');
    });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const isSecureContextForPwa = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!isSecureContextForPwa) return;

    try {
      const hadController = Boolean(navigator.serviceWorker.controller);
      const registration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            window.LSOApp?.showToast?.('A website update is ready. Reload the page to use it.');
          }
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    } catch (error) {
      console.warn('PWA service worker registration failed:', error);
    }
  }

  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);
  registerInstallEvents();
  registerServiceWorker();
  if (!navigator.onLine) updateConnectivity();
})();
