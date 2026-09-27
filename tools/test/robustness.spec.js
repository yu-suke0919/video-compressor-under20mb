// うまくいかないときの動き（別のアプリへの切り替え・読み込みの失敗・互換モードの失敗とキャンセル・画面を暗くしない設定）
// 実機でしか起きないことは、ブラウザの関数を差し替えて同じ状況を作る
'use strict';

const { test, expect } = require('@playwright/test');
const { PROFILES, open, pick, compress, ui } = require('./helpers');

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

  test('戻っても止まったままなら、6秒で見切ってやり直す', async ({ page }) => {
    await open(page, '?mode=quality');
    await failFirstConversion(page, 'hang');
    await pick(page, 'small-5mb.mp4');
    await page.click('#runBtn');
    await page.waitForTimeout(800); await setVis(page, 'hidden');
    await page.waitForTimeout(1500); await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 30000 });
    expect((await ui(page)).diag).toContain('進捗が6秒止まったため中断');
    await expectRetriedFast(page);
  });

  test('戻ってやり直しても止まったままなら、6秒で見切って互換モードに切り替える', async ({ page }) => {
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
    expect(u.diag.split('進捗が6秒止まったため中断').length - 1).toBe(2);   // 2回目も20秒待たずに見切る
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

test.describe('iPhone：画面が隠れたら、デコーダーが固まる前に止める', () => {
  test.use(PROFILES.ios);
  test.beforeEach(async ({ page }) => { await controllableVisibility(page); });

  test('隠れたらすぐ止め、戻ったら最初からやり直して最後まで圧縮する', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, '720p-60s.mp4');
    await page.click('#runBtn');
    await page.waitForFunction(() => /進捗 10%/.test(document.getElementById('diagOut').value), null, { timeout: 30000 });
    await setVis(page, 'hidden');
    await page.waitForTimeout(300);
    expect((await ui(page)).diag).toContain('画面から離れたため、動画の処理をいったん止める');
    await page.waitForTimeout(2000);
    await setVis(page, 'visible');
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
    const u = await ui(page);
    expect(u.diag).toContain('画面に戻ってから最初からやり直し（fast・1回目）');
    expect(u.diag).toContain('確認: デコーダー OK');
    expect(u.outInfo).not.toContain('互換モード');
    expect(u.hasOut).toBe(true);
  });

  test('何度切り替えても、そのたびにやり直す（回数の上限で互換モードにしない）', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, '720p-60s.mp4');
    await page.click('#runBtn');
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1000);
      await setVis(page, 'hidden');
      await page.waitForTimeout(300);
      await setVis(page, 'visible');
    }
    await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
    const u = await ui(page);
    expect(u.diag).toContain('最初からやり直し（fast・4回目）');
    expect(u.outInfo).not.toContain('互換モード');
    expect(u.hasOut).toBe(true);
  });
});

test.describe('動画を選んだときにデコーダーが固まっている', () => {
  test('解析で止まり続けず、開き直すよう案内する', async ({ page }) => {
    await page.addInitScript(() => { VideoDecoder.isConfigSupported = () => new Promise(() => {}); });
    await open(page);
    await pick(page, 'small-5mb.mp4');
    const u = await ui(page);
    expect(u.planWarn).toContain('開き直してから');
    expect(u.engine).not.toBe('compat');
    expect(u.pickVisible).toBe(true);
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
