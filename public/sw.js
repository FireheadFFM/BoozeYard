// Minimaler Service Worker: macht die App installierbar, speichert nichts zwischen
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
