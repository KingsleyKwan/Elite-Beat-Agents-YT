/* Minimal SW for A2HS / installability — cache shell only, never YT media */
const CACHE = "ouendan-yt-shell-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/chart.js",
  "./js/beatdetect.js",
  "./js/yt.js",
  "./js/game.js",
  "./js/main.js",
  "./sample-chart.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache YouTube / googlevideo
  if (url.hostname.includes("youtube") || url.hostname.includes("googlevideo") || url.hostname.includes("ytimg")) {
    return;
  }
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => res).catch(() => hit))
  );
});
