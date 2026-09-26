/*
 * Service Worker
 * すべてのアセットをキャッシュし、2回目以降はオフラインでも起動できるようにする。
 * 本番はキャッシュ優先（速く起動し、更新は裏で取得して次に開いたときに反映）。
 * ブランチのプレビューと手元の確認環境はネット優先（更新がすぐ反映され、つながらないときだけキャッシュを使う）。
 * ドメイン直下でもサブディレクトリでも動くよう、
 * パスはこのファイルの位置からの相対パスで解決する。
 */
'use strict';

var CACHE = 'video-compressor-under20mb-v72';
var NETWORK_TIMEOUT_MS = 3000;   // ネット優先のとき、ネットの応答をこれだけ待ってからキャッシュを使う

// Cloudflare Pages のプレビュー（<ブランチ名>.<プロジェクト名>.pages.dev）と手元の確認環境だけネット優先にする
var HOST = self.location.hostname;
var NETWORK_FIRST = (/\.pages\.dev$/.test(HOST) && HOST.split('.').length > 3) ||
  HOST === 'localhost' || HOST === '127.0.0.1';

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
  // 動画は範囲指定（Range）で少しずつ読まれる。キャッシュから丸ごと返すと Safari で再生できないので、
  // Service Worker を通さずネットから直接読む（動画はキャッシュしないので、オフラインでは再生できない）
  if (req.headers.has('range') || /\.mp4$/i.test(url.pathname)) return;

  event.respondWith(NETWORK_FIRST ? networkFirst(req) : cacheFirst(req));
});

// キャッシュに無いときの代わり（ページ遷移はトップに逃がす）
function fromCache(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (cached) {
    if (cached) return cached;
    if (req.mode === 'navigate') {
      return caches.match(new URL('./index.html', self.registration.scope).toString());
    }
    return null;
  });
}
function offlineResponse() {
  return new Response('オフラインです', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
// 取得できたらキャッシュも更新する
function fetchAndStore(req) {
  return fetch(req).then(function (res) {
    if (res && res.status === 200 && res.type === 'basic') {   // 一部だけの応答（206）はキャッシュできない
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
    }
    return res;
  });
}

// キャッシュ優先（本番）: キャッシュがあればすぐ返し、裏でキャッシュを更新する（次に開いたときに反映）
function cacheFirst(req) {
  var network = fetchAndStore(req).catch(function () { return null; });
  return caches.match(req, { ignoreSearch: true }).then(function (cached) {
    if (cached) return cached;
    return network.then(function (res) {
      return res || fromCache(req).then(function (fallback) { return fallback || offlineResponse(); });
    });
  });
}

// ネット優先（プレビュー）: 更新したらすぐ新しい版になる。
// オフラインのときや、一定時間応答がないときはキャッシュから返す（オフラインでも起動できる）
function networkFirst(req) {
  return new Promise(function (resolve) {
    var settled = false;
    function finish(res) {
      if (settled) return;
      settled = true;
      resolve(res || offlineResponse());
    }
    fetchAndStore(req).then(finish, function () { fromCache(req).then(finish); });
    // 電波が弱いなどで応答が遅いときは、キャッシュがあればそちらで先に表示する
    setTimeout(function () {
      if (settled) return;
      fromCache(req).then(function (cached) { if (cached) finish(cached); });
    }, NETWORK_TIMEOUT_MS);
  });
}
