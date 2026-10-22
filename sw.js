/**
 * Service Worker - Sistema de Encargos, Envíos y Apartados
 * Manejo de modo Offline, Control de Versiones del App Shell y Actualizaciones Seguras.
 */

const APP_VERSION = 'v1.5.9';
const CACHE_NAME = `encargos-cache-${APP_VERSION}`;

// Assets esenciales para funcionamiento 100% autónomo sin internet
const STATIC_ASSETS = [
  './',
  './index.html',
  './index.css',
  './manifest.json',
  './src/app.js',
  './src/services/storage.service.js',
  './src/services/customer.service.js',
  './src/services/order.service.js',
  './src/services/print.service.js',
  './src/services/notification.service.js',
  './src/services/cloud.service.js',
  './src/services/sync.service.js',
  './src/services/supabase.service.js',
  './src/services/destination.service.js',
  './src/services/auth.service.js'
];

// 1. INSTALACIÓN: Precaché de todos los recursos del App Shell y activación inmediata
self.addEventListener('install', (event) => {
  console.log(`[SW] Instalando Service Worker versión: ${APP_VERSION}`);
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-cacheando assets estáticos esenciales...');
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

// 2. ACTIVACIÓN: Limpieza de versiones de caché antiguas
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activando Service Worker versión: ${APP_VERSION}`);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName.startsWith('encargos-cache-')) {
            console.log(`[SW] Eliminando caché obsoleta: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// 3. FETCH: Estrategia Stale-While-Revalidate con Fallback Offline Robusto
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Solo interceptar peticiones GET
  if (request.method !== 'GET') {
    return;
  }

  // No interceptar peticiones a la API de Supabase, Firebase o Google Maps
  const url = new URL(request.url);
  if (url.origin.includes('supabase.co') || url.origin.includes('firebaseio.com') || url.origin.includes('google.com') || url.origin.includes('goo.gl')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      // Si está en caché, lo servimos de inmediato y en segundo plano intentamos actualizarlo
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Sin conexión: si no hay caché, retornar fallback navegable si es documento HTML
          if (request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
        });

      return cachedResponse || fetchPromise;
    })
  );
});

// 4. MENSAJERÍA: Forzar actualización inmediata cuando el usuario hace clic en "Actualizar"
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Recibido SKIP_WAITING. Tomando el control de la nueva versión.');
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});
