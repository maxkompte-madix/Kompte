// Service worker : l'appli s'ouvre instantanément (fichiers en cache) et se met à jour
// en arrière-plan. Les données, elles, viennent toujours de Supabase.
const CACHE = 'kompte-v49';
const SHELL = ['./', 'index.html', 'style.css?v=49', 'app.js?v=49', 'manifest.webmanifest', 'icons/app-192.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;
  // Réseau d'abord (dernière version, sans le cache HTTP de 10 min), cache si hors ligne.
  event.respondWith(fetch(event.request.url, { cache: 'no-cache' }).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
