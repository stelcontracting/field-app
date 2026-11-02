/* STEL Field offline copy.
   Everything comes from the cache first, so the app opens instantly on Starlink, one
   bar or none, and never sits waiting on a dying connection. A new version downloads
   quietly in the background whenever there's internet (bump CACHE to ship one) and
   lands next open. Records live in IndexedDB, not here, so clearing caches never
   touches them. */
var CACHE = "stel-field-v7";
var TILES = "stel-field-tiles-v1";
var TILE_LIMIT = 1500;
var FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./calc.js",
  "./rates.js",
  "./logo.js",
  "./sync.js",
  "./app.js",
  "./manifest.webmanifest",
  "./favicon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./data/products.json",
  "./data/meta.json",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./vendor/jspdf.umd.min.js",
  "./vendor/images/layers.png",
  "./vendor/images/layers-2x.png",
  "./vendor/images/marker-icon.png",
  "./vendor/images/marker-icon-2x.png",
  "./vendor/images/marker-shadow.png"
];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  /* addAll is all or nothing: a half-downloaded update never replaces a working copy */
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: "reload" }); }));
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      /* stelcontracting.github.io is one address shared by all the STEL apps, and
         they all see each other's caches: only ever clear this app's own old ones */
      return Promise.all(keys.map(function (k) {
        return k.indexOf("stel-field-") === 0 && k !== CACHE && k !== TILES ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Map pictures land here as they're viewed, so a paddock looked at on Starlink still
   shows with no internet. Oldest squares go first once the limit is reached. */
function trimTiles(c) {
  return c.keys().then(function (keys) {
    if (keys.length <= TILE_LIMIT) return;
    return Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(function (k) { return c.delete(k); }));
  });
}

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);

  if (url.hostname === "spatial-img.information.qld.gov.au") {
    e.respondWith(caches.open(TILES).then(function (c) {
      return c.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (res) {
          if (res && res.status === 200) c.put(e.request, res.clone()).then(function () { return trimTiles(c); });
          return res;
        });
      });
    }));
    return;
  }

  /* anything else off this site (lot lookups, forecasts, labels) needs live internet */
  if (url.origin !== self.location.origin) return;
  var isPage = e.request.mode === "navigate";
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(isPage ? "./index.html" : e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request);
    });
  }));
});
