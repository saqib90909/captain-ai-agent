// Captain web app: keeps the app's own files on the phone so it opens instantly; Google/Facebook always go online.
const CACHE = 'captain-v1';
const FILES = ['./', './index.html', './styles.css', './voice.js', './live.js', './core.js', './app.js', './manifest.json',
  './img/icon-180.png', './img/icon-192.png', './img/icon-512.png', './img/icon.png', './img/logo.png', './img/captain-hero.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // APIs: straight to the internet
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
