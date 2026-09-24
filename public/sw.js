/*
 * Service Worker
 * すべてのアセットをキャッシュし、2回目以降はオフラインでも起動できるようにする。
 * 読み込みはネット優先（更新がすぐ反映される）で、つながらないときだけキャッシュを使う。
 * ドメイン直下でもサブディレクトリでも動くよう、
 * パスはこのファイルの位置からの相対パスで解決する。
 */
'use strict';

var CACHE = 'video-compressor-under20mb-v18';
var NETWORK_TIMEOUT_MS = 3000;   // ネットの応答をこれだけ待ってからキャッシュを使う

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

  // ネット優先（更新したらすぐ新しい版になるように）。取得できたらキャッシュも更新する。
  // オフラインのときや、一定時間応答がないときはキャッシュから返す（オフラインでも起動できる）
  event.respondWith(new Promise(function (resolve) {
    var settled = false;
    function fromCache() {
      return caches.match(req, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        // キャッシュにも無い場合、ページ遷移はトップに逃がす
        if (req.mode === 'navigate') {
          return caches.match(new URL('./index.html', self.registration.scope).toString());
        }
        return null;
      });
    }
    function finish(res) {
      if (settled) return;
      settled = true;
      resolve(res || new Response('オフラインです', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }));
    }
    var network = fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    });
    network.then(finish, function () { fromCache().then(finish); });
    // 電波が弱いなどで応答が遅いときは、キャッシュがあればそちらで先に表示する
    setTimeout(function () {
      if (settled) return;
      fromCache().then(function (cached) { if (cached) finish(cached); });
    }, NETWORK_TIMEOUT_MS);
  }));
});
