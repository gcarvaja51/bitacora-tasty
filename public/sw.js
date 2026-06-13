// Service Worker — Bitácora Tasty PWA
const CACHE = 'bitacora-v1';
const ASSETS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
];

// Instalar — cachear assets estáticos
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Activar — limpiar caches viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — red primero, cache como fallback
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Llamadas a la API siempre van a la red
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Para el resto: red primero, cache como fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Guardar en cache si es exitoso
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, resClone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
