// テストで共通に使う操作と、結果の読み取り
'use strict';

const path = require('path');
const fs = require('fs');

const VIDEOS = path.join(__dirname, 'videos');

// 端末ごとの画面の大きさと名乗り（中身の処理はテストを動かす Chrome のまま。見た目と分岐だけ似せる）
const PROFILES = {
  pc: { viewport: { width: 1280, height: 900 } },
  android: {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
  },
  ios: {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
  }
};

function video(name) {
  const file = path.join(VIDEOS, name);
  if (!fs.existsSync(file)) throw new Error('テスト用の動画がありません: ' + name + '（先に npm run test:videos を実行）');
  return file;
}

// ページを開き、端末の対応状況（AAC で書き出せるかなど）を調べ終わるまで待つ
async function open(page, query = '') {
  await page.goto('/' + query);
  await page.waitForFunction(() => /対応 VideoEncoder=/.test(document.getElementById('diagOut').value));
}

// 動画を選び、読み込み（または読み込みの失敗）が終わるまで待つ
async function pick(page, name) {
  await page.setInputFiles('#file', video(name));
  await page.waitForFunction(() => {
    const s = window.__compressor.state;
    return !s.busy && !!(s.meta || s.loadError);
  }, null, { timeout: 90000 });
}

// 「圧縮する」を押し、終わるまで待つ
async function compress(page, timeout = 5 * 60 * 1000) {
  await page.click('#runBtn');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout });
}

// 画面の表示とアプリの状態
function ui(page) {
  return page.evaluate(() => {
    const s = window.__compressor.state;
    const $ = id => document.getElementById(id);
    const visible = id => !$(id).classList.contains('hidden');
    return {
      engine: s.engine, meta: s.meta, loadError: s.loadError, running: s.running,
      srcInfo: $('srcInfo').textContent, planInfo: $('planInfo').textContent, planWarn: $('planWarn').textContent,
      outInfo: $('outInfo').textContent, outWarn: $('outWarn').textContent,
      runText: $('runBtn').textContent, runDisabled: $('runBtn').disabled,
      shareDisabled: $('shareBtn').disabled, shareText: $('shareBtn').textContent.trim(),
      threeRes: $('resSeg').classList.contains('is-three'),
      pickVisible: visible('pickBtn'), srcVideoVisible: visible('srcVideo'),
      original: !!(s.out && s.out.original), hasOut: !!s.out,
      diag: $('diagOut').value
    };
  });
}

// 書き出した動画（または元のまま渡す動画）の中身を、アプリに同梱の Mediabunny で調べる
function outputInfo(page) {
  return page.evaluate(async () => {
    const o = window.__compressor.state.out;
    if (!o) return null;
    const M = window.Mediabunny;
    const input = new M.Input({ source: new M.BlobSource(o.blob), formats: [M.MP4, M.QTFF] });
    try {
      const v = await input.getPrimaryVideoTrack();
      const a = await input.getPrimaryAudioTrack();
      const tags = await input.getMetadataTags().catch(() => null);
      return {
        size: o.blob.size, name: o.name, original: !!o.original, sameAsInput: o.blob === window.__compressor.state.file,
        width: v ? v.displayWidth : null, height: v ? v.displayHeight : null, videoCodec: v ? v.codec : null,
        audioCodec: a ? a.codec : null, duration: await input.computeDuration(),
        rawTagKeys: tags && tags.raw ? Object.keys(tags.raw) : []
      };
    } finally {
      input.dispose();
    }
  });
}

// トリミングの範囲を変える（秒）
function setTrim(page, start, end) {
  return page.evaluate(([s, e]) => {
    const a = document.getElementById('trimStart'), z = document.getElementById('trimEnd');
    if (e !== null) { z.value = String(e); z.dispatchEvent(new Event('input')); }
    if (s !== null) { a.value = String(s); a.dispatchEvent(new Event('input')); }
  }, [start, end]);
}

// このブラウザが AAC で書き出せるか（Linux の Chrome はできない。Mac・Windows はできる）
function canEncodeAac(page) {
  return page.evaluate(() => window.__compressor.state.caps.aac);
}

const LOCATION_KEY = /xyz|location|gps/i;

// AAC で書き出す真似をする AudioEncoder（この Chrome は AAC で書き出せないので、互換モードの音声を試すときに使う）。
// 最初のデータに付ける設定データ（description）を選べる
const AAC_LC_48K_STEREO = [0x11, 0x90];   // 正しい設定データ（AAC-LC・48kHz・ステレオ）
// iPhone の Safari が出す、設定データの代わりの esds の中身（39バイト）
const SAFARI_ESDS = [0x03, 0x80, 0x80, 0x80, 0x22, 0, 0, 0, 0x04, 0x80, 0x80, 0x80, 0x14, 0x40, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0x05, 0x80, 0x80, 0x80, 0x02, 0x11, 0x90, 0x06, 0x80, 0x80, 0x80, 0x01, 0x02];
function fakeAacEncoder(page, description) {
  return page.addInitScript(bytes => {
    window.AudioEncoder = class {
      constructor(init) { this.init = init; this.state = 'unconfigured'; this.first = true; }
      get encodeQueueSize() { return 0; }
      configure(c) { this.c = c; this.state = 'configured'; }
      encode(ad) {
        const chunk = new EncodedAudioChunk({ type: 'key', timestamp: ad.timestamp, duration: Math.round(ad.numberOfFrames / ad.sampleRate * 1e6), data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]) });
        const meta = this.first ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: this.c.sampleRate, numberOfChannels: this.c.numberOfChannels, description: new Uint8Array(bytes) } } : undefined;
        this.first = false;
        this.init.output(chunk, meta);
      }
      flush() { return Promise.resolve(); }
      close() { this.state = 'closed'; }
      static isConfigSupported(c) { return Promise.resolve({ supported: true, config: c }); }
    };
  }, description);
}

module.exports = { PROFILES, video, open, pick, compress, ui, outputInfo, setTrim, canEncodeAac, fakeAacEncoder, AAC_LC_48K_STEREO, SAFARI_ESDS, LOCATION_KEY };
