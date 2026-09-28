// うまくいかないときの動き（別のアプリへの切り替え・読み込みの失敗・互換モードの失敗とキャンセル・画面を暗くしない設定）
// 実機でしか起きないことは、ブラウザの関数を差し替えて同じ状況を作る
'use strict';

const { test, expect } = require('@playwright/test');
const { PROFILES, open, pick, compress, ui, outputInfo, setTrim, canEncodeAac } = require('./helpers');

// 画面の表示・非表示を、テストから切り替えられるようにする
async function controllableVisibility(page) {
  await page.addInitScript(() => {
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => window.__vis !== 'visible', configurable: true });
    window.__setVis = v => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')); };
  });
}
const setVis = (page, v) => page.evaluate(v => window.__setVis(v), v);

// 1回目の変換を、指定のしかたで失敗させる
function failFirstConversion(page, how) {
  return page.evaluate(how => {
    const C = window.Mediabunny.Conversion.prototype, orig = C.execute;
    let first = true;
    C.execute = function () {
      if (!first) return orig.call(this);
      first = false;
      if (how === 'hang') return new Promise(() => {});   // 裏に回って止まったまま
      if (how === 'late') {
        // 実機と同じ順番：先に失敗し、その0.1秒後に画面が隠れた知らせが届く
        return new Promise((res, rej) => {
          setTimeout(() => rej(new DOMException('Decoder failure', 'EncodingError')), 1500);
          setTimeout(() => window.__setVis('hidden'), 1600);
        });
      }
      return new Promise((res, rej) => setTimeout(() => rej(new DOMException('Decoder failure', 'EncodingError')), how === 'quick' ? 300 : 1500));
    };
  }, how);
}

test.describe('別のアプリへの切り替え（iPhone で圧縮が壊れる）', () => {
  test.beforeEach(async ({ page }) => { await controllableVisibility(page); });

  const expectRetriedFast = async page => {
    const u = await ui(page);
    expect(u.diag).toContain('画面に戻ってから最初からやり直し（fast・1回目）');
    expect(u.outInfo).not.toContain('互換モード');
    expect(u.hasOut).toBe(true);
  };

  test('切り替え中に失敗したら、戻ってから高速モードで最初からやり直す', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'fail');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(500); await setVis(page, 'hidden');
    await page.waitForTimeout(2500); await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running);
    await expectRetriedFast(page);
  });

  test('失敗の直後に画面が隠れた知らせが届く場合（実機の順番）も、やり直す', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'late');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForFunction(() => window.__vis === 'hidden');
    await page.waitForTimeout(2500); await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running);
    await expectRetriedFast(page);
  });

  test('戻っても止まったままなら、3秒で見切ってやり直す', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'hang');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(800); await setVis(page, 'hidden');
    await page.waitForTimeout(1500); await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 30000 });
    expect((await ui(page)).diag).toContain('進捗が3秒止まったため中断');
    await expectRetriedFast(page);
  });

  test('戻ってやり直しても止まったままなら、3秒で見切って互換モードに切り替える', async ({ page }) => {
    await open(page, '?mode=quality');
    // iPhone で、戻ったあとも高速モードが固まったままになる状況（1回目も2回目も進まない）
    await page.evaluate(() => {
      const C = window.Mediabunny.Conversion.prototype, orig = C.execute;
      let n = 0;
      C.execute = function () { return n++ < 2 ? new Promise(() => {}) : orig.call(this); };
    });
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(800); await setVis(page, 'hidden');
    await page.waitForTimeout(1500); await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 90000 });
    const u = await ui(page);
    expect(u.diag).toContain('画面に戻ってから最初からやり直し（fast・1回目）');
    expect(u.diag).toContain('止めた処理の後片付け');
    expect(u.diag).toContain('確認: 動画の読み込み OK');
    expect(u.diag.split('進捗が3秒止まったため中断').length - 1).toBe(2);   // 2回目も20秒待たずに見切る
    expect(u.diag).toContain('互換モードに切り替え');
    expect(u.outInfo).toContain('互換モード');
    expect(u.hasOut).toBe(true);
  });

  test('戻ったときにデコーダーが固まっていたら、互換モードを試さず、開き直すよう案内する', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'hang');
    await pick(page, 'small-5mb.mp4');
    // 裏に回ったらデコーダーが固まる（iPhone の実機で、Safari を開き直すまで応答しなくなった）
    await page.evaluate(() => {
      const orig = VideoDecoder.isConfigSupported.bind(VideoDecoder);
      VideoDecoder.isConfigSupported = c => (window.__vis === 'hidden' || window.__stuck) ? (window.__stuck = true, new Promise(() => {})) : orig(c);
      document.addEventListener('visibilitychange', () => { if (window.__vis === 'hidden') window.__stuck = true; });
    });
    await page.click('#runBtn');
    await page.waitForTimeout(800); await setVis(page, 'hidden');
    await page.waitForTimeout(1500); await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 40000 });
    const u = await ui(page);
    expect(u.diag).toContain('確認: デコーダー 応答なし');
    expect(u.diag).toContain('画面に戻ったあと、デコーダーが応答しない');
    expect(u.diag).not.toContain('進捗が3秒止まった');   // 止まったと判断するのを待たずに案内する
    expect(u.diag).not.toContain('互換モードに切り替え');
    expect(u.outWarn).toContain('開き直してから');
    expect(u.hasOut).toBe(false);
  });

  test('知らせがないままページが止められていた場合も、やり直す', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'fail');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(700);
    await page.evaluate(() => { const t = Date.now(); while (Date.now() - t < 4000) { /* ページが止められている */ } });
    await page.waitForFunction(() => !window.__compressor.state.running);
    await expectRetriedFast(page);
  });

  test('切り替えていないのに失敗したら、今までどおり互換モードに切り替える', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'quick');
    await pick(page, 'small-5mb.mp4');
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('互換モードに切り替え');
    expect(u.outInfo).toContain('互換モード');
    expect(u.diag).not.toContain('元の音声をそのまま使えない');   // 映像の失敗では音声を外さない
  });

  test('やり直しを待っている間のキャンセルは、すぐ効く', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'late');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForFunction(() => window.__vis === 'hidden');
    await page.waitForTimeout(300);
    await page.click('#runBtn');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 3000 });
    const u = await ui(page);
    expect(u.hasOut).toBe(false);
    expect(u.diag).toContain('キャンセル');
  });
});

test.describe('デコーダーを確かめている間に裏に回った', () => {
  test.beforeEach(async ({ page }) => { await controllableVisibility(page); });

  test('固まったと決めつけず、戻ってから確かめ直す', async ({ page }) => {
    await page.addInitScript(() => {
      window.__hangDecoder = false;
      const orig = VideoDecoder.isConfigSupported.bind(VideoDecoder);
      VideoDecoder.isConfigSupported = c => window.__hangDecoder ? new Promise(() => {}) : orig(c);   // 裏では応答しない
    });
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'hang');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__hangDecoder = true; });
    await setVis(page, 'hidden');
    await page.waitForTimeout(1500); await setVis(page, 'visible');
    // 戻ったら確かめ始める（応答しない）
    await page.waitForFunction(() => /画面に戻った/.test(document.getElementById('diagOut').value), null, { timeout: 20000 });
    await page.waitForTimeout(1000);
    await setVis(page, 'hidden');    // 確かめている途中で、また裏に回る
    await page.evaluate(() => { window.__hangDecoder = false; });
    await page.waitForTimeout(300);
    await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 60000 });
    const u = await ui(page);
    expect(u.diag).toContain('確かめている間に画面から離れたため、戻ってから確かめ直す');
    expect(u.diag).toContain('確認: デコーダー OK');
    expect(u.outWarn).not.toContain('開き直して');
    expect(u.hasOut).toBe(true);
  });
});

test.describe('デコーダーが固まっている（iPhone で、圧縮中に別のアプリに切り替えたあと）', () => {
  const hangDecoder = page => page.evaluate(() => { VideoDecoder.isConfigSupported = () => new Promise(() => {}); });

  test('動画を選んだとき：解析で止まり続けず、開き直すよう案内する', async ({ page }) => {
    await page.addInitScript(() => { VideoDecoder.isConfigSupported = () => new Promise(() => {}); });
    await open(page);
    await pick(page, 'small-5mb.mp4');
    const u = await ui(page);
    expect(u.planWarn).toContain('開き直してから');
    expect(await page.textContent('#planWarn b')).toBe('ブラウザをタスクキルしてください！');   // 太字で先に出す
    expect(u.engine).not.toBe('compat');
    expect(u.pickVisible).toBe(true);
  });

  test('圧縮を始めるとき：準備で止まり続けず、互換モードも試さず、開き直すよう案内する', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, 'small-5mb.mp4');
    await hangDecoder(page);
    const t0 = Date.now();
    await page.click('#runBtn');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 20000 });
    expect(Date.now() - t0).toBeLessThan(10000);
    const u = await ui(page);
    expect(u.diag).toContain('デコーダーが応答しない');
    expect(u.diag).not.toContain('互換モードに切り替え');
    expect(u.outWarn).toContain('開き直してから');
    expect(await page.textContent('#outWarn b')).toBe('ブラウザをタスクキルしてください！');
  });

  test('圧縮を始めるときの確認中でも、キャンセルはすぐ効く', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, 'small-5mb.mp4');
    await hangDecoder(page);
    await page.click('#runBtn');
    await page.waitForTimeout(500);
    await page.click('#runBtn');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 3000 });
    expect((await ui(page)).outWarn).not.toContain('開き直して');
  });
});

test.describe('圧縮中の注意（別のアプリに切り替えない）', () => {
  const noteVisible = page => page.evaluate(() => {
    const el = document.getElementById('progressNote');
    return !el.classList.contains('hidden') && el.offsetParent !== null;
  });
  test.describe('iPhone', () => {
    test.use(PROFILES.ios);
    test('圧縮中は出す', async ({ page }) => {
      await open(page);
      await pick(page, '1080p60-45s.mp4');
      await page.click('#runBtn');
      await page.waitForTimeout(500);
      expect(await noteVisible(page)).toBe(true);
      await page.click('#runBtn');   // キャンセル
    });
  });
  test('iPhone 以外では出さない', async ({ page }) => {
    await open(page);
    await pick(page, '1080p60-45s.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(500);
    expect(await noteVisible(page)).toBe(false);
    await page.click('#runBtn');
  });
});

test.describe('エンコーダーが可変ビットレートの指定を守らない（Android の実機であった）', () => {
  // VBR のときだけ、指定の3倍のビットレートで書き出すエンコーダー
  const greedyVbr = page => page.addInitScript(() => {
    window.__modes = [];
    const orig = VideoEncoder.prototype.configure;
    VideoEncoder.prototype.configure = function (c) {
      window.__modes.push(c.bitrateMode || 'variable');
      if (c.bitrateMode !== 'constant' && c.bitrate) c = Object.assign({}, c, { bitrate: c.bitrate * 3 });
      return orig.call(this, c);
    };
  });

  test('目標を超えたら、固定ビットレート（CBR）に切り替えて目標に収める', async ({ page }) => {
    await greedyVbr(page);
    await open(page, '?mode=size&target=3&audio=off');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('→ 固定ビットレート（CBR）に切り替え');
    expect(u.diag).toMatch(/再圧縮 映像 .+（CBR）/);
    const info = await outputInfo(page);
    expect(info.size).toBeLessThan(3 * 1000 * 1000);
    expect(await page.evaluate(() => window.__modes.includes('constant'))).toBe(true);
  });

  test('ハードウェアの CBR が使えない端末では、ソフトウェアの CBR に切り替える', async ({ page }) => {
    await greedyVbr(page);
    // その Android と同じく、ハードウェアは VBR だけ使える（テストの Chrome にはハードウェアがないので、ソフトウェアで代わりに動かす）
    await page.addInitScript(() => {
      const soft = c => Object.assign({}, c, { hardwareAcceleration: 'no-preference' });
      const orig = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = c => {
        if (c.hardwareAcceleration !== 'prefer-hardware') return orig(c);
        if (c.bitrateMode === 'constant') return Promise.resolve({ supported: false, config: c });
        return orig(soft(c)).then(r => Object.assign({}, r, { config: c }));
      };
      const configure = VideoEncoder.prototype.configure;
      VideoEncoder.prototype.configure = function (c) { return configure.call(this, c.hardwareAcceleration === 'prefer-hardware' ? soft(c) : c); };
    });
    await open(page, '?mode=size&target=3&audio=off');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('エンコード設定 avc/prefer-hardware/constant → 使えない');
    expect(u.diag).toContain('エンコード設定 avc/no-preference/constant → 使える');
    expect((await outputInfo(page)).size).toBeLessThan(3 * 1000 * 1000);
  });

  test('なるべく圧縮で約2倍以上になったら、CBR でもう一度圧縮して小さい方を使う', async ({ page }) => {
    await greedyVbr(page);
    await open(page, '?mode=quality&audio=off');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('→ 固定ビットレート（CBR）で圧縮し直し');
    expect(u.outInfo).toContain('CBR');
    // 指定（1200kbps）の3倍で書き出した VBR の結果より、かなり小さい
    expect((await outputInfo(page)).size).toBeLessThan(1200 * 1000 * 10 / 8 * 1.5);
  });

  test('CBR での圧縮し直しに失敗しても、エラーにせず最初の結果を使う', async ({ page }) => {
    await greedyVbr(page);
    await open(page, '?mode=quality&audio=off');
    await page.evaluate(() => {   // 2回目（CBR）の変換だけ失敗させる
      const C = window.Mediabunny.Conversion.prototype, orig = C.execute;
      let n = 0;
      C.execute = function () { return ++n === 2 ? Promise.reject(new Error('encoder failed')) : orig.call(this); };
    });
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('→ 固定ビットレート（CBR）で圧縮し直し');
    expect(u.diag).toContain('圧縮し直しに失敗したため、前の結果を使う');
    expect(u.diag).not.toContain('互換モードに切り替え');
    expect(u.hasOut).toBe(true);
    expect(u.outWarn).not.toContain('エラー');
  });

  test('◯MB以内に圧縮で圧縮し直しに失敗したら、前の結果を使い、目標を超えたことを知らせる', async ({ page }) => {
    await greedyVbr(page);
    await open(page, '?mode=size&target=3&audio=off');
    await page.evaluate(() => {
      const C = window.Mediabunny.Conversion.prototype, orig = C.execute;
      let n = 0;
      C.execute = function () { return ++n === 2 ? Promise.reject(new Error('encoder failed')) : orig.call(this); };
    });
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('圧縮し直しに失敗したため、前の結果を使う');
    expect(u.hasOut).toBe(true);
    expect(u.outWarn).toContain('目標サイズに圧縮できません');
  });

  test('なるべく圧縮で20秒より長いときは、時間がかかるので CBR で圧縮し直さない', async ({ page }) => {
    await greedyVbr(page);
    await open(page, '?mode=quality&audio=off');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 25);
    await compress(page);
    expect((await ui(page)).diag).not.toContain('CBR）で圧縮し直し');
  });

  test('なるべく圧縮で、指定を守るエンコーダーなら CBR で圧縮し直さない', async ({ page }) => {
    await open(page, '?mode=quality&audio=off');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    expect((await ui(page)).diag).not.toContain('CBR）で圧縮し直し');
  });

  test('指定を守るエンコーダーなら、可変ビットレート（VBR）のまま', async ({ page }) => {
    await open(page, '?mode=size&target=3&audio=off');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 10);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).not.toContain('固定ビットレート（CBR）に切り替え');
    expect((await outputInfo(page)).size).toBeLessThan(3 * 1000 * 1000);
  });
});

test.describe('元の音声をそのままコピーできない（音声の設定データが壊れた動画など）', () => {
  test('互換モードにせず、音声を作り直すか外して、高速モードのままやり直す', async ({ page }) => {
    await open(page, '?mode=quality');
    // 音声をそのままコピーする変換だけ、Mediabunny が音声の形式を不正として止める（自己テストで実際に起きた失敗）
    await page.evaluate(() => {
      const C = window.Mediabunny.Conversion, init = C.init.bind(C);
      C.init = async opts => {
        const conv = await init(opts);
        if (opts.audio && opts.audio.codec === 'aac' && !opts.audio.forceTranscode) {
          conv.execute = () => Promise.reject(new TypeError('Audio chunk metadata decoder configuration codec string for AAC must be a valid AAC codec string'));
        }
        return conv;
      };
    });
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 5);
    await compress(page);
    const u = await ui(page);
    expect(u.diag).toContain('失敗（fast）TypeError: Audio chunk');
    expect(u.diag).toMatch(/元の音声をそのまま使えないため、(音声を AAC に作り直して|音声を外して)高速モードでやり直し/);
    expect(u.diag).not.toContain('互換モードに切り替え');
    expect(u.hasOut).toBe(true);
    const info = await outputInfo(page);
    if (await canEncodeAac(page)) {
      expect(info.audioCodec).toBe('aac');   // 作り直した
    } else {
      expect(info.audioCodec).toBe(null);    // 外した（この Chrome は AAC で書き出せない）
      expect(u.outWarn).toContain('元の動画の音声をそのまま使えなかったため、音声なしで圧縮しました。');
    }
  });
});

test.describe('Android で選んだ直後に読めない（NotReadableError）', () => {
  test.use(PROFILES.android);
  const failReads = (page, n) => page.addInitScript(n => {
    window.__fails = n;
    const ab = Blob.prototype.arrayBuffer, st = Blob.prototype.stream;
    Blob.prototype.arrayBuffer = function () {
      if (window.__fails > 0 && this.size > 1000) { window.__fails--; return Promise.reject(new DOMException('could not be read', 'NotReadableError')); }
      return ab.call(this);
    };
    Blob.prototype.stream = function () {
      if (window.__fails > 0 && this.size > 1000) { window.__fails--; return new ReadableStream({ start(c) { c.error(new TypeError('network error')); } }); }
      return st.call(this);
    };
  }, n);

  test('1回だけ読めなければ、自動で読み直して読み込める', async ({ page }) => {
    await failReads(page, 1);
    await open(page);
    await pick(page, 'small-5mb.mp4');
    const u = await ui(page);
    expect(u.meta).not.toBe(null);
    expect(u.diag).toContain('読み直しで成功');
  });

  test('ずっと読めなければ、互換モードを試さず「もう一度同じ動画を選んで」と案内する', async ({ page }) => {
    await failReads(page, 100);
    await open(page);
    await pick(page, 'small-5mb.mp4');
    const u = await ui(page);
    expect(u.planWarn).toContain('動画をうまく受け取れませんでした');
    expect(u.engine).not.toBe('compat');
    expect(u.pickVisible).toBe(true);
  });
});

test.describe('互換モード', () => {
  test('エンコーダーの設定で失敗しても、プレビューの動画の操作ボタンと音を元に戻す', async ({ page }) => {
    await page.addInitScript(() => {
      VideoEncoder.prototype.configure = function () { throw new DOMException('configure failed', 'NotSupportedError'); };
    });
    await open(page, '?mode=quality');
    await pick(page, 'small-5mb.mp4');
    await page.evaluate(() => { window.__compressor.state.engine = 'compat'; });
    await compress(page);
    const u = await ui(page);
    expect(u.hasOut).toBe(false);
    expect(u.outWarn).toContain('configure failed');
    expect(await page.evaluate(() => { const v = document.getElementById('srcVideo'); return { controls: v.controls, muted: v.muted }; }))
      .toEqual({ controls: true, muted: false });
  });

  test('「音声を残す」をオフで始めたら、互換モードに切り替わっても音声を入れない（圧縮中は設定を初期値に戻せない）', async ({ page }) => {
    // 互換モードで AAC の音声を作れる端末にする（この Chrome は AAC で書き出せないので、書き出す真似をする）
    await page.addInitScript(() => {
      window.AudioEncoder = class {
        constructor(init) { this.init = init; this.state = 'unconfigured'; this.first = true; }
        get encodeQueueSize() { return 0; }
        configure(c) { this.c = c; this.state = 'configured'; }
        encode(ad) {
          const chunk = new EncodedAudioChunk({ type: 'key', timestamp: ad.timestamp, duration: Math.round(ad.numberOfFrames / ad.sampleRate * 1e6), data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]) });
          const meta = this.first ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: this.c.sampleRate, numberOfChannels: this.c.numberOfChannels, description: new Uint8Array([0x11, 0x90]) } } : undefined;
          this.first = false;
          this.init.output(chunk, meta);
        }
        flush() { return Promise.resolve(); }
        close() { this.state = 'closed'; }
        static isConfigSupported(c) { return Promise.resolve({ supported: true, config: c }); }
      };
    });
    await open(page, '?mode=quality&audio=off');
    await failFirstConversion(page, 'quick');   // 高速モードで失敗して、互換モードに切り替わる
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(100);
    expect(await page.isDisabled('#resetSettings')).toBe(true);
    await page.evaluate(() => document.getElementById('resetSettings').click());   // 押せないことを確かめる
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
    const u = await ui(page);
    expect(u.diag).toContain('互換モードに切り替え');
    expect(await page.isChecked('#audioOn')).toBe(false);   // 初期値（オン）に戻っていない
    expect((await outputInfo(page)).audioCodec).toBe(null);
  });

  test('最後の書き出し（flush）で失敗したら、20秒止まらずにすぐエラーにする', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = VideoEncoder.prototype.flush; let n = 0;
      VideoEncoder.prototype.flush = function () { return n++ === 0 ? Promise.reject(new DOMException('flush failed', 'EncodingError')) : orig.call(this); };
    });
    await open(page, '?audio=off');
    await pick(page, 'vp9.webm');   // 12秒の動画（互換モードは再生しながら処理する）
    const t0 = Date.now();
    await compress(page);
    expect(Date.now() - t0).toBeLessThan(25000);   // 以前は最後まで進んでから20秒止まっていた
    expect((await ui(page)).outWarn).toContain('flush failed');
  });

  test('準備中（エンコード設定の確認中）にキャンセルしたら、プレビューの動画に触れない', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = c => new Promise(r => setTimeout(() => r(orig(c)), 2000));
    });
    await open(page);
    await pick(page, 'vp9.webm');
    await page.evaluate(() => {
      window.__touched = false;
      new MutationObserver(() => { if (!document.getElementById('srcVideo').controls) window.__touched = true; })
        .observe(document.getElementById('srcVideo'), { attributes: true });
    });
    await page.click('#runBtn');
    await page.waitForTimeout(500);
    await page.click('#runBtn');   // キャンセル
    await page.waitForTimeout(4000);
    expect(await page.evaluate(() => window.__touched)).toBe(false);
    expect((await ui(page)).running).toBe(false);
  });

  test('iPhone の AudioEncoder が AAC の設定データの代わりに esds ごと出しても、正しい AAC として書き出す', async ({ page }) => {
    // iPhone の Safari と同じく、description に esds の中身（39バイト）を入れてくる AudioEncoder
    await page.addInitScript(() => {
      const ESDS = new Uint8Array([0x03, 0x80, 0x80, 0x80, 0x22, 0, 0, 0, 0x04, 0x80, 0x80, 0x80, 0x14, 0x40, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x05, 0x80, 0x80, 0x80, 0x02, 0x11, 0x90, 0x06, 0x80, 0x80, 0x80, 0x01, 0x02]);
      class SafariLikeAudioEncoder {
        constructor(init) { this.init = init; this.state = 'unconfigured'; this.first = true; }
        get encodeQueueSize() { return 0; }
        configure(c) { this.c = c; this.state = 'configured'; }
        encode(ad) {
          const chunk = new EncodedAudioChunk({ type: 'key', timestamp: ad.timestamp, duration: Math.round(ad.numberOfFrames / ad.sampleRate * 1e6), data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]) });
          const meta = this.first ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: this.c.sampleRate, numberOfChannels: this.c.numberOfChannels, description: ESDS } } : undefined;
          this.first = false;
          this.init.output(chunk, meta);
        }
        flush() { return Promise.resolve(); }
        close() { this.state = 'closed'; }
        static isConfigSupported(c) { return Promise.resolve({ supported: true, config: c }); }
      }
      window.AudioEncoder = SafariLikeAudioEncoder;
    });
    await open(page, '?mode=quality');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 4);
    await page.evaluate(() => { window.__compressor.state.engine = 'compat'; });   // 互換モードで圧縮する
    await compress(page);
    const u = await ui(page);
    expect(u.outInfo).toContain('互換モード');
    expect(u.diag).toContain('音声の設定データを作り直した（エンコーダーが出したもの: 39バイト）');
    const audio = await page.evaluate(async () => {
      const M = window.Mediabunny, o = window.__compressor.state.out;
      const input = new M.Input({ source: new M.BlobSource(o.blob), formats: [M.MP4, M.QTFF] });
      const a = await input.getPrimaryAudioTrack();
      return a ? { codec: await a.getCodecParameterString(), rate: a.sampleRate, ch: a.numberOfChannels } : null;
    });
    expect(audio).toEqual({ codec: 'mp4a.40.2', rate: 48000, ch: 2 });
  });

  test.describe('iPhone の低電力モード', () => {
    test.use(PROFILES.ios);
    test('動画の再生を断られたら、低電力モードをオフにするよう案内する', async ({ page }) => {
      // 低電力モードの iPhone と同じく、音を消していても再生させない
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('The request is not allowed by the user agent', 'NotAllowedError'));
      });
      await open(page, '?mode=quality');
      await pick(page, 'small-5mb.mp4');
      await page.evaluate(() => { window.__compressor.state.engine = 'compat'; });
      await compress(page);
      const u = await ui(page);
      expect(u.diag).toContain('再生できない NotAllowedError');
      expect(u.outWarn).toContain('低電力モードがオンのときは再生できないことがあるので、オフにしてから');
    });
  });

  test('動画を選び直しても、読み込みの待ち受けが溜まらない', async ({ page }) => {
    await page.addInitScript(() => {
      window.__listeners = {};
      const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (t, f, o) {
        if (this instanceof HTMLVideoElement && this.id === 'srcVideo') {
          const set = (window.__listeners[t] = window.__listeners[t] || new Set());
          set.add(f);
          if (o && o.once) add.call(this, t, function () { set.delete(f); }, o);
        }
        return add.call(this, t, f, o);
      };
      EventTarget.prototype.removeEventListener = function (t, f, o) {
        if (this instanceof HTMLVideoElement && this.id === 'srcVideo' && window.__listeners[t]) window.__listeners[t].delete(f);
        return rem.call(this, t, f, o);
      };
    });
    await open(page);
    const count = () => page.evaluate(() => ['loadedmetadata', 'durationchange', 'error'].map(k => (window.__listeners[k] || new Set()).size));
    await pick(page, 'vp9.webm');
    const once = await count();
    await pick(page, 'vp9.webm');
    await pick(page, 'vp9.webm');
    expect(await count()).toEqual(once);   // 何回選んでも増えない
  });
});

test.describe('画面を暗くしない設定（Wake Lock）', () => {
  // 画面を暗くしない設定の偽物（取れるまでの時間を変えられる）
  const fakeWakeLock = (page, delay) => page.addInitScript(delay => {
    window.__locks = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => new Promise(res => setTimeout(() => {
      const l = { released: false, h: [], release() { if (!this.released) { this.released = true; this.h.forEach(f => f()); } return Promise.resolve(); },
        addEventListener(t, f) { if (t === 'release') this.h.push(f); } };
      window.__locks.push(l); res(l);
    }, delay)) } });
  }, delay);

  test('取れる前に圧縮が終わったら、取れた時点ですぐ外す', async ({ page }) => {
    await fakeWakeLock(page, 2000);
    await open(page, '?mode=quality');
    await pick(page, 'short-0.3s.mp4');
    await compress(page);
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__locks.map(l => l.released))).toEqual([true]);
  });

  test('別のアプリから戻ったら取り直し、終わったら全部外す', async ({ page }) => {
    await controllableVisibility(page);
    await fakeWakeLock(page, 0);
    await open(page, '?mode=quality');
    await pick(page, '720p-60s.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__setVis('hidden'); window.__locks.forEach(l => l.release()); });   // 裏に回ると自動で外れる
    await page.waitForTimeout(300);
    await setVis(page, 'visible');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => ({ n: window.__locks.length, active: window.__locks.filter(l => !l.released).length })))
      .toEqual({ n: 2, active: 1 });
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
    expect(await page.evaluate(() => window.__locks.filter(l => !l.released).length)).toBe(0);
  });
});
