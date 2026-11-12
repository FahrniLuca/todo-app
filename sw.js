// Service Worker: hält die App offline verfügbar (App-Dateien im Cache).
// Die Aufgaben selbst liegen im localStorage der App und werden beim nächsten
// Online-Moment mit GitHub synchronisiert.
const CACHE = 'todo-app-v12';
const ASSETS = ['./', './index.html', './parser.js', './app.js', './voice.js', './styles.css', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './icon-1024.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // GitHub-API nie cachen
  // Stale-while-revalidate: sofort aus dem Cache, im Hintergrund aktualisieren
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});

// Push-Mitteilungen (von der GitHub-Action gesendet)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'To-Do', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'To-Do', {
    body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow ? self.clients.openWindow((e.notification.data && e.notification.data.url) || './') : null;
  }));
});
