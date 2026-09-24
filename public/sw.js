/*
 * Service Worker
 * すべてのアセットをキャッシュし、2回目以降はオフラインでも起動できるようにする。
 * 本番はキャッシュ優先（速く起動し、更新は裏で取得して次に開いたときに反映）。
 * ブランチのプレビューと手元の確認環境はネット優先（更新がすぐ反映され、つながらないときだけキャッシュを使う）。
 * ドメイン直下でもサブディレクトリでも動くよう、
 * パスはこのファイルの位置からの相対パスで解決する。
 */
'use strict';

var CACHE = 'video-compressor-under20mb-v36';
var SHARE_CACHE = 'shared-video';   // 共有メニューから受け取った動画を、アプリが読み込むまで置いておく場所
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
        return (k === CACHE || k === SHARE_CACHE) ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Android の共有メニューから送られてきた動画（manifest.json の share_target）
  if (req.method === 'POST' && url.pathname === new URL('./share-target', self.registration.scope).pathname) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  event.respondWith(NETWORK_FIRST ? networkFirst(req) : cacheFirst(req));
});

// 共有された動画を一時保存して、アプリの画面を開く（アプリが読み込んだら消す）
function receiveShare(req) {
  var home = new URL('./', self.registration.scope);
  return req.formData().then(function (form) {
    var file = form.getAll('video').filter(function (f) { return f && typeof f !== 'string'; })[0];
    if (!file) return null;
    return caches.open(SHARE_CACHE).then(function (cache) {
      return cache.put(new URL('./shared-video', self.registration.scope).toString(), new Response(file, {
        headers: { 'Content-Type': file.type || 'video/mp4', 'X-File-Name': encodeURIComponent(file.name || 'video.mp4') }
      }));
    }).then(function () { return file; });
  }).then(function (file) {
    if (file) home.searchParams.set('shared', '1');
    return Response.redirect(home.toString(), 303);
  }, function () {
    return Response.redirect(home.toString(), 303);
  });
}

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
    if (res && res.ok && res.type === 'basic') {
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
