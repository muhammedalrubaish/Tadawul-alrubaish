// Service Worker لتطبيق «رصد» — تثبيت على الشاشة الرئيسية + عمل دون اتصال
const CACHE = 'rasad-v19';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // أسعار حية: دائماً من الشبكة (لا تخزين)
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // التنقل: الشبكة أولاً ثم النسخة المخزّنة عند انقطاع الاتصال
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('/', copy));
        return res;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  // بقية الأصول: من المخزن أولاً مع تحديث في الخلفية
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(cached => {
        const net = fetch(req).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
  }
});
