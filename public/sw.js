/*
 * Service Worker
 * すべてのアセットをキャッシュし、2回目以降はオフラインで起動できるようにする。
 * ドメイン直下でもサブディレクトリでも動くよう、
 * パスはこのファイルの位置からの相対パスで解決する。
 */
'use strict';

var CACHE = 'video-compressor-under20mb-v8';

// registration の scope（= このファイルが置かれたディレクトリ）を基準にする
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './vendor/mediabunny.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
].map(function (path) { return new URL(path, self.registration.scope).toString(); });

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      // キャッシュ優先（オフラインで確実に起動させるため）。
      // 取得できたら裏でキャッシュを更新する。
      var network = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return null;
      });

      if (cached) return cached;

      return network.then(function (res) {
        if (res) return res;
        // オフラインでキャッシュにも無い場合、ページ遷移はトップに逃がす
        if (req.mode === 'navigate') {
          return caches.match(new URL('./index.html', self.registration.scope).toString());
        }
        return new Response('オフラインです', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});
