/* HisabOne service worker — enables install as an app; network-first, no offline caching
   (compliance data must always be fresh). */
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(){ /* pass-through */ });
