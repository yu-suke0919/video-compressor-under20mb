// 画面の状態（圧縮後・やり直し・キャンセル）、ファイル名の例、設定の保存、使い方
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui, setTrim } = require('./helpers');

const settingIds = ['res720', 'res1080', 'modeQuality', 'modeSize', 'targetSize', 'halfFps', 'audioOn', 'autoRun', 'nameOn', 'resetSettings'];
const disabledStates = page => page.evaluate(ids => ids.map(id => document.getElementById(id).disabled), settingIds);

test('圧縮後は「やり直す」になり、設定を変えられず、共有できる。やり直すと元に戻る', async ({ page }) => {
  await open(page);
  await pick(page, '720p-60s.mp4');
  const small = settingIds.map(id => id === 'res1080');   // 720p の動画では 1080p だけ選べない
  expect(await disabledStates(page)).toEqual(small);
  await compress(page);
  let u = await ui(page);
  expect(u.runText).toBe('やり直す');
  expect(u.runDisabled).toBe(false);
  expect(u.shareDisabled).toBe(false);
  expect(await disabledStates(page)).toEqual(settingIds.map(() => true));
  expect(await page.isDisabled('#trimStart')).toBe(true);
  expect(await page.evaluate(() => document.getElementById('outBox').classList.contains('is-large'))).toBe(true);

  await page.click('#runBtn');   // やり直す
  u = await ui(page);
  expect(u.runText).toBe('圧縮する');
  expect(u.hasOut).toBe(false);
  expect(u.shareDisabled).toBe(true);
  expect(await disabledStates(page)).toEqual(small);
});

test('圧縮中に「キャンセル」を押すと、すぐ元の状態に戻る', async ({ page }) => {
  await open(page, '?target=10');   // 目標以下の動画は元のまま渡せる（結果がある）ので、目標を動画より小さくする
  await pick(page, '1080p60-10s.mp4');   // 縮小するので時間がかかる
  await page.click('#runBtn');
  await page.waitForTimeout(1000);
  expect((await ui(page)).runText).toBe('キャンセル');
  const t0 = Date.now();
  await page.click('#runBtn');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 5000 });
  expect(Date.now() - t0).toBeLessThan(3000);
  const u = await ui(page);
  expect(u.runText).toBe('圧縮する');
  expect(u.hasOut).toBe(false);
  expect(u.diag).toContain('キャンセル');
  expect(await page.isHidden('#progressWrap')).toBe(true);
  // キャンセルのあと、もう一度圧縮できる
  await setQualityAndCompress(page);
});

async function setQualityAndCompress(page) {
  await page.click('label[for="modeQuality"]');
  await compress(page);
  expect((await ui(page)).runText).toBe('やり直す');
}

test('ファイル名の例は、設定を変えるたびに更新される', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.querySelector('details.settings:not(#diagBox)').open = true; });   // 詳細設定（設定のステップでは開いたまま）
  await page.check('#nameOn');
  const preview = () => page.textContent('#namePreview');
  expect(await preview()).toMatch(/^\d{8}_720p_20MB\.mp4$/);   // 既定は 日付・自由入力（空）・圧縮オプション

  await page.fill('#nameList li[data-key="text1"] input.name-text', 'クリップ');
  expect(await preview()).toMatch(/^\d{8}_クリップ_720p_20MB\.mp4$/);

  await page.click('label[for="res1080"]');   // 設定を変えると圧縮オプションの部分も変わる
  expect(await preview()).toMatch(/^\d{8}_クリップ_1080p_20MB\.mp4$/);

  // 並べ替え（項目の並びは 日付・日付+時間・自由入力… なので、2回上げると日付より前になる）
  await page.click('#nameList li[data-key="text1"] button[data-move="up"]');
  await page.click('#nameList li[data-key="text1"] button[data-move="up"]');
  expect(await preview()).toMatch(/^クリップ_\d{8}_1080p_20MB\.mp4$/);

  // 項目を選ぶ：日付と日付+時間はどちらか1つだけ。元のファイル名も使える
  await page.check('#nameList li[data-key="datetime"] input.name-use');
  expect(await page.isChecked('#nameList li[data-key="date"] input.name-use')).toBe(false);
  expect(await preview()).toMatch(/^クリップ_\d{14}_1080p_20MB\.mp4$/);
  await page.check('#nameList li[data-key="orig"] input.name-use');
  await pick(page, 'small-5mb.mp4');   // 720p の動画（1080p は選べず、720p として計画する）
  expect(await preview()).toMatch(/^クリップ_\d{14}_720p_20MB_small-5mb\.mp4$/);
  await page.uncheck('#nameList li[data-key="text1"] input.name-use');
  expect(await preview()).toMatch(/^\d{14}_720p_20MB_small-5mb\.mp4$/);

  await page.uncheck('#nameOn');
  expect(await page.isHidden('#nameBox')).toBe(true);
});

test('設定はこの端末に保存され、URL に設定があるときは使わない', async ({ page }) => {
  await open(page);
  await page.click('label[for="res1080"]');
  await page.waitForTimeout(100);
  await open(page);
  expect(await page.isChecked('#res1080')).toBe(true);
  await open(page, '?mode=quality');   // URL に設定がある → 保存した設定は使わず、初期値＋URL
  expect(await page.isChecked('#res720')).toBe(true);
  expect(await page.isChecked('#modeQuality')).toBe(true);
});

test('使い方：全17枚で、最後までスワイプすると最後の点が選ばれる', async ({ page }) => {
  await open(page);
  await page.click('#helpBtn');
  const info = await page.evaluate(() => ({
    slides: document.getElementById('helpSlides').children.length,
    dots: document.getElementById('helpDots').children.length,
    hint: document.getElementById('helpHint').textContent,
    last: document.querySelector('#helpSlides > :last-child .card-title').textContent
  }));
  expect(info.slides).toBe(17);
  expect(info.dots).toBe(17);
  expect(info.hint).toContain('全17枚');
  expect(info.last).toBe('更新情報');
  await page.evaluate(() => { const s = document.getElementById('helpSlides'); s.scrollLeft = s.scrollWidth; });
  await expect(page.locator('#helpDots button').nth(16)).toHaveAttribute('aria-current', 'true');
});

test('「◯MB以内に圧縮」で目標の8割以下に仕上がったら、小さく済んだわけを出す', async ({ page }) => {
  await open(page, '?mode=size&target=100');
  await pick(page, '1080p60-45s.mp4');   // 720p・30fps にするので、トリミングのみにはならない
  await setTrim(page, 0, 4);
  await compress(page);
  const size = await page.evaluate(() => window.__compressor.state.out.blob.size);
  expect(size).toBeLessThanOrEqual(80000000);
  expect(await page.isVisible('#outNote')).toBe(true);
  expect(await page.textContent('#outNote')).toBe('これ以上大きくしても画質はほぼ上がらないため、' + (size / 1000000).toFixed(1) + 'MBに抑えました。');
  // やり直すと消える。「なるべく圧縮」では出さない
  await page.click('#runBtn');
  expect(await page.isVisible('#outNote')).toBe(false);
  await page.click('label[for="modeQuality"]');
  await compress(page);
  expect(await page.isVisible('#outNote')).toBe(false);
});

test('診断情報に、ファイル名の欄に入れた名前や、選んだ動画の名前を書かない（拡張子のない名前でも）', async ({ page }) => {
  const SECRET = 'ひみつの名前_旅行';
  await open(page);
  // 拡張子のない名前の動画（中身は MP4）
  const fs = require('fs');
  await page.setInputFiles('#file', { name: SECRET, mimeType: 'video/mp4', buffer: fs.readFileSync(require('./helpers').video('small-5mb.mp4')) });
  await page.waitForFunction(() => { const s = window.__compressor.state; return !s.busy && !!(s.meta || s.loadError); });
  await page.evaluate(() => { document.getElementById('adjMenu').open = true; });
  await page.fill('#adjName', SECRET);
  await page.dispatchEvent('#adjName', 'change');
  const d = (await ui(page)).diag;
  expect(d).not.toContain(SECRET);
  expect(d).toContain('動画を選択 拡張子不明 video/mp4');
  expect(d).toContain('2 で変更 ファイル名（入力あり）');
});

test.describe('共有・保存', () => {
  // 短い動画を圧縮して、結果を出しておく
  async function compressed(page) {
    await open(page, '?mode=quality');
    await pick(page, 'small-5mb.mp4');
    await setTrim(page, 0, 2);
    await compress(page);
    return page.evaluate(() => ({ name: window.__compressor.state.out.name, size: window.__compressor.state.out.blob.size }));
  }
  // 共有の仕組み（navigator.share / canShare）の代わり。mode … 'ok'（共有する）・'cannot'（この形式は共有できない）・'abort'（共有シートを閉じた）・'error'（失敗）
  function fakeShare(page, mode) {
    return page.addInitScript(m => {
      window.__shared = [];
      navigator.canShare = () => m !== 'cannot';
      navigator.share = data => {
        window.__shared.push(data.files.map(f => ({ name: f.name, type: f.type, size: f.size })));
        if (m === 'abort') return Promise.reject(new DOMException('closed', 'AbortError'));
        if (m === 'error') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
        return Promise.resolve();
      };
    }, mode);
  }

  test('共有の仕組みがない環境（PC）では、共有・保存のどちらも保存（ダウンロード）する', async ({ page }) => {
    await page.addInitScript(() => { delete Navigator.prototype.share; delete Navigator.prototype.canShare; });
    const out = await compressed(page);
    for (const id of ['#shareBtn', '#saveBtn']) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click(id)]);
      expect(dl.suggestedFilename()).toBe(out.name);
    }
  });

  test('共有できる端末では、書き出した動画を名前と形式つきで共有する', async ({ page }) => {
    await fakeShare(page, 'ok');
    const out = await compressed(page);
    await page.click('#shareBtn');
    await page.waitForFunction(() => window.__shared.length === 1);
    expect(await page.evaluate(() => window.__shared[0])).toEqual([{ name: out.name, type: 'video/mp4', size: out.size }]);
    expect((await ui(page)).outWarn).toBe('');
  });

  test('この形式を共有できない端末では、保存に切り替えて理由を出す', async ({ page }) => {
    await fakeShare(page, 'cannot');
    const out = await compressed(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#shareBtn')]);
    expect(dl.suggestedFilename()).toBe(out.name);
    expect((await ui(page)).outWarn).toContain('共有できないため、保存（ダウンロード）しました。');
  });

  test('共有シートを閉じただけなら、保存も注意もしない', async ({ page }) => {
    await fakeShare(page, 'abort');
    await compressed(page);
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.click('#shareBtn');
    await page.waitForFunction(() => window.__shared.length === 1);
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
    expect((await ui(page)).outWarn).toBe('');
  });

  test('共有に失敗したら、保存に切り替えて理由を出す', async ({ page }) => {
    await fakeShare(page, 'error');
    const out = await compressed(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#shareBtn')]);
    expect(dl.suggestedFilename()).toBe(out.name);
    expect((await ui(page)).outWarn).toContain('共有できなかったため、保存（ダウンロード）しました（NotAllowedError: denied）。');
  });
});

test('トリミングのバーの何もない所を触るとその位置へ動き、そのままなぞるとシークし続ける', async ({ page }) => {
  await open(page);
  await pick(page, '720p-60s.mp4');
  // バーの上の位置（0〜1）を、触る x 座標にする（つまみの幅の半分ずつ端を除いた範囲が、動画の最初から最後）
  const xAt = a => page.evaluate(a => {
    const bar = document.querySelector('.trim'), r = bar.getBoundingClientRect();
    const w = parseFloat(getComputedStyle(bar).getPropertyValue('--thumb-w')) || 44;
    return { x: r.left + w / 2 + a * (r.width - w), y: r.top + r.height / 2 };
  }, a);
  const now = () => page.evaluate(() => document.getElementById('srcVideo').currentTime);
  await page.locator('.trim').scrollIntoViewIfNeeded();
  const p1 = await xAt(0.5), p2 = await xAt(0.75);
  // 触る所はバーそのもの（つまみの input ではない）
  expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y).className, p1)).toContain('trim');
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await expect.poll(now).toBeGreaterThan(29);
  expect(await now()).toBeLessThan(31);
  await page.mouse.move(p2.x, p2.y, { steps: 4 });
  await expect.poll(now).toBeGreaterThan(44);
  await page.mouse.up();
  expect(await now()).toBeLessThan(46);
  // 範囲（つまみ）は変えない
  expect(await page.evaluate(() => [window.__compressor.state.trim.start, window.__compressor.state.trim.end])).toEqual([0, 60]);
  // 再生位置のつまみ（キーボードなどで動かしたとき）でもシークする
  await page.evaluate(() => { const s = document.getElementById('trimSeek'); s.value = '12'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(now).toBeCloseTo(12, 0);
});
