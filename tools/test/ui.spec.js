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
  await open(page);
  await pick(page, '1080p60-45s.mp4');   // 縮小するので時間がかかる
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
  await setTrim(page, 0, 10);
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
