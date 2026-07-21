'use strict';

const CACHE_VERSION = 'lso-website-v20260721-duty-punch-separate-approval-2';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const scopeUrl = new URL('./', self.location.href);
const appShellUrl = new URL('index.html', scopeUrl).toString();

const CORE_PATHS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './website-enhancements.css',
  './duty-roster-layout.css',
  './access-control.css',
  './branding.css',
  './login-page.css',
  './contract-maker-v3.css',
  './dashboard-v2.css',
  './monthly-report.css',
  './supabase-config.js',
  './branding.js',
  './cloud.js',
  './app.js',
  './auth.js',
  './management.js',
  './ui-enhancements.js',
  './dashboard-enhancements.js',
  './workflow-upgrades.js',
  './attendance-governance.js',
  './duty-hours.js',
  './pdf-lib.min.js',
  './monthly-report-template-data.js',
  './monthly-report.js',
  './contract-template-data.js',
  './contract-maker.js',
  './dashboard-intelligence.js',
  './permissions.js',
  './pwa.js',
  './favicon.ico',
  './favicon-32x32.png',
  './apple-touch-icon.png',
  './android-chrome-192x192.png',
  './android-chrome-512x512.png',
  './maskable-icon-512x512.png',
  './lso-logo.png',
  './lso-mark.png'
];

const CORE_URLS = CORE_PATHS.map((path) => new URL(path, scopeUrl).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(CORE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('lso-website-') && ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request, { ignoreSearch: true }))
      || (await caches.match(appShellUrl, { ignoreSearch: true }))
      || Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || network || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Database/auth requests must always remain live and are never cached.
  if (url.hostname.endsWith('.supabase.co')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
