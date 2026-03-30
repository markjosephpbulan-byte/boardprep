// BoardPrep PH — Service Worker
// Caches the app shell so it loads fast and works offline

const CACHE_NAME = 'boardprep-v1';
const CACHE_URLS = [
  '/',
  '/static/index.html',
  '/static/style.css',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon-192.png',
  '/static/apple-touch-icon.png',
];

// Install — cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first for API, cache first for static
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'You are offline. Please check your internet connection.' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 })
      )
    );
    return;
  }

  // For static files — cache first, then network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Cache new static files on the fly
        if (response.ok && e.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Return cached index.html for navigation when offline
        if (e.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});