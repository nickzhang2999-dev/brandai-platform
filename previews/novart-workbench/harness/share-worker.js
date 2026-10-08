/* Ordinary-browser transport for the isolated evaluation server. No remote proxy. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin === self.location.origin || !/^https?:$/.test(url.protocol)) return;
  event.respondWith((async () => {
    const headers = new Headers();
    if (request.headers.has('content-type')) headers.set('content-type', request.headers.get('content-type'));
    const options = {method: request.method, headers, credentials: 'same-origin', cache: 'no-store'};
    if (!['GET','HEAD'].includes(request.method)) options.body = await request.arrayBuffer();
    return fetch('/share-resource?url=' + encodeURIComponent(request.url), options);
  })());
});
