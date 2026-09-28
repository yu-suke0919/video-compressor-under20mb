// 画面の状態（圧縮後・やり直し・キャンセル）、ファイル名の例、設定の保存、使い方
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui } = require('./helpers');

const settingIds = ['res720', 'res1080', 'modeQuality', 'modeSize', 'targetSize', 'halfFps', 'audioOn', 'autoRun', 'nameOn', 'resetSettings'];
const disabledStates = page => page.evaluate(ids => ids.map(id => document.getElementById(id).disabled), settingIds);

test('圧縮後は「やり直す」になり、設定を変えられず、共有できる。やり直すと元に戻る', async ({ page }) => {
  await open(page);
  await pick(page, '720p-60s.mp4');
  expect(await disabledStates(page)).toEqual(settingIds.map(() => false));
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
  expect(await disabledStates(page)).toEqual(settingIds.map(() => false));
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
  await page.click('details.settings:not(#diagBox) > summary');
  await page.check('#nameOn');
  const preview = () => page.textContent('#namePreview');
  expect(await preview()).toMatch(/^\d{8}_720p-20MB\.mp4$/);   // 既定は 日付・自由入力（空）・圧縮オプション

  await page.fill('#nameList li[data-key="text1"] input.name-text', 'クリップ');
  expect(await preview()).toMatch(/^\d{8}_クリップ_720p-20MB\.mp4$/);

  await page.click('label[for="res1080"]');   // 設定を変えると圧縮オプションの部分も変わる
  expect(await preview()).toMatch(/^\d{8}_クリップ_1080p-20MB\.mp4$/);

  // 並べ替え（項目の並びは 日付・日付+時間・自由入力… なので、2回上げると日付より前になる）
  await page.click('#nameList li[data-key="text1"] button[data-move="up"]');
  await page.click('#nameList li[data-key="text1"] button[data-move="up"]');
  expect(await preview()).toMatch(/^クリップ_\d{8}_1080p-20MB\.mp4$/);

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

test('使い方：全15枚で、最後までスワイプすると最後の点が選ばれる', async ({ page }) => {
  await open(page);
  await page.click('#helpBtn');
  const info = await page.evaluate(() => ({
    slides: document.getElementById('helpSlides').children.length,
    dots: document.getElementById('helpDots').children.length,
    hint: document.getElementById('helpHint').textContent,
    last: document.querySelector('#helpSlides > :last-child .card-title').textContent
  }));
  expect(info.slides).toBe(15);
  expect(info.dots).toBe(15);
  expect(info.hint).toContain('全15枚');
  expect(info.last).toBe('更新情報');
  await page.evaluate(() => { const s = document.getElementById('helpSlides'); s.scrollLeft = s.scrollWidth; });
  await expect(page.locator('#helpDots button').nth(14)).toHaveAttribute('aria-current', 'true');
});
