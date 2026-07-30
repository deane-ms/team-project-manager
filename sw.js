// Deliberately does no caching -- this app's data changes constantly via live Firestore sync,
// and a stale cache would be worse than no offline support at all. It also exists so it never
// fights the version.txt-polling auto-reload mechanism in index.html, which relies on every
// request for index.html/version.txt reaching the network uncached. This worker exists solely
// so browsers that require a registered service worker as an installability signal see one.
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
