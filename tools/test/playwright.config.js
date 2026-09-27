// 実際のブラウザでアプリを動かすテストの設定（npm test）
//
// H.264 と AAC を扱える Chrome が必要（オープンソース版の Chromium は H.264 を扱えない）。
//   既定: パソコンにインストールした Google Chrome（channel: 'chrome'）
//   CHROME_PATH=…  : 使う Chrome の実行ファイルを指定する（Chrome for Testing など）
//   CHROME_ARGS=…  : Chrome に渡す引数を足す（GPU のない Linux では --disable-gpu を付けると速い）
// テスト用の動画は先に npm run test:videos で作っておく。
'use strict';

const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.PORT || 8777);
const args = ['--autoplay-policy=no-user-gesture-required'].concat((process.env.CHROME_ARGS || '').split(' ').filter(Boolean));

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  timeout: 5 * 60 * 1000,
  // 動画の変換は重いので、既定では1つずつ動かす（WORKERS で変えられる）
  workers: Number(process.env.WORKERS || 1),
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:' + PORT,
    viewport: { width: 390, height: 844 },
    channel: process.env.CHROME_PATH ? undefined : 'chrome',
    launchOptions: { executablePath: process.env.CHROME_PATH || undefined, args },
    // Service Worker は既定で止める（古いキャッシュでテストが揺れないように）。sw.spec.js だけ使う
    serviceWorkers: 'block',
    acceptDownloads: true,
  },
  webServer: {
    command: 'node tools/test/server.js',
    cwd: require('path').join(__dirname, '..', '..'),
    url: 'http://127.0.0.1:' + PORT + '/',
    reuseExistingServer: true,
    env: { PORT: String(PORT) },
  },
});
