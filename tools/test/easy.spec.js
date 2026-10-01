// 簡単モード（easy.html）：1. 圧縮の仕方を選ぶ → 2. 動画を選んでトリミング → 3. 共有・保存 の3ステップ
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, setTrim, outputInfo } = require('./helpers');

// 簡単モードを開き、端末の対応状況を調べ終わるまで待つ（予圧縮は probe= を指定したとき以外は止める）
async function openEasy(page, query = '?probe=off') {
  await page.goto('/easy' + query);
  await page.waitForFunction(() => /対応 VideoEncoder=/.test(document.getElementById('diagOut').value));
}
const currentStep = page => page.evaluate(() => [1, 2, 3].filter(i => document.getElementById('step' + i).classList.contains('is-current')));
const settings = page => page.evaluate(() => window.__compressor.readSettings());
const plan = page => page.evaluate(() => { const p = window.__compressor.state.plan; return { w: p.width, h: p.height, fps: Math.round(p.outFps), mode: p.mode, bps: p.videoBitrate }; });
async function compressEasy(page) {
  await page.click('#runBtn');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 5 * 60 * 1000 });
}

test('なるべく圧縮：720p・30fps・指定ビットレートの初期値で圧縮し、3 で共有・保存を出す', async ({ page }) => {
  await openEasy(page);
  expect(await currentStep(page)).toEqual([1]);
  expect(await page.isVisible('#pickBtn')).toBe(false);   // 先に圧縮の仕方を選ぶ
  await page.click('.choice[data-preset="quality"]');
  expect(await currentStep(page)).toEqual([2]);
  expect(await page.textContent('#easyModeName')).toBe('なるべく圧縮');
  const s = await settings(page);
  expect([s.res, s.mode, s.halfFps, s.minBitrate['720'], s.targetMB]).toEqual(['720', 'quality', true, 1200000, 20]);

  await pick(page, '1080p60-45s.mp4');
  expect(await plan(page)).toEqual({ w: 1280, h: 720, fps: 30, mode: 'quality', bps: 1200000 });
  await setTrim(page, 0, 5);
  await compressEasy(page);
  expect(await currentStep(page)).toEqual([3]);
  expect(await page.textContent('#step3Title')).toBe('できました！共有・保存してください');
  expect(await page.isEnabled('#shareBtn')).toBe(true);
  expect(await page.isVisible('#easyMore')).toBe(true);
  const info = await outputInfo(page);
  expect([info.width, info.height]).toEqual([1280, 720]);

  // 範囲を変えてやり直す → 2 に戻り、圧縮した動画は消える
  await page.click('#easyBack');
  expect(await currentStep(page)).toEqual([2]);
  expect(await page.evaluate(() => window.__compressor.state.out)).toBe(null);
  expect(await page.isEnabled('#trimStart')).toBe(true);
});

test('画質優先：元の画質と fps のまま（最大1080p）、20MB以内に圧縮する', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="size"]');
  const s = await settings(page);
  expect([s.mode, s.halfFps, s.minBitrate['1080'], s.targetMB]).toEqual(['size', false, 2700000, 20]);
  // 1080p60 は 1080p・60fps のまま
  await pick(page, '1080p60-45s.mp4');
  let p = await plan(page);
  expect([p.w, p.h, p.fps, p.mode]).toEqual([1920, 1080, 60, 'size']);
  // 画面録画（886×1920）は元の解像度のまま
  await pick(page, 'screenrec-886x1920.mp4');
  p = await plan(page);
  expect([p.w, p.h]).toEqual([886, 1920]);
  // 4K は 1080p まで
  await pick(page, '4k-15s.mp4');
  p = await plan(page);
  expect(Math.min(p.w, p.h)).toBe(1080);
  await compressEasy(page);
  expect(await currentStep(page)).toEqual([3]);
  const info = await outputInfo(page);
  expect(info.size).toBeLessThan(20 * 1000 * 1000);
  expect(Math.min(info.width, info.height)).toBe(1080);
});

test('目標以下の動画は、圧縮せずにそのまま共有・保存へ進める', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="size"]');
  await pick(page, 'small-5mb.mp4');
  expect(await page.isVisible('#easyPass')).toBe(true);
  await page.click('#easyPass');
  expect(await currentStep(page)).toEqual([3]);
  expect(await page.textContent('#step3Title')).toBe('圧縮しなくても送れます。共有・保存してください');
  expect(await page.isEnabled('#shareBtn')).toBe(true);
});

test('予圧縮が済んでいれば、押したらすぐ出す（なるべく圧縮）', async ({ page }) => {
  await openEasy(page, '');
  await page.click('.choice[data-preset="quality"]');
  await pick(page, '720p-60s.mp4');
  await page.waitForFunction(() => { const p = window.__compressor.precomp().pre; return p && p.done; }, null, { timeout: 120000 });
  expect(await page.isVisible('#easyQuick')).toBe(true);
  expect(await page.textContent('#easyQuick')).toMatch(/^[\d.]+MBで即出力するよ$/);
  await compressEasy(page);
  expect(await page.inputValue('#diagOut')).toMatch(/予圧縮を使う（完了済み）/);
  expect(await currentStep(page)).toEqual([3]);
});

test('圧縮中にキャンセルしたら 2 に戻る。手順の帯で 1 に戻って選び直せる', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="quality"]');
  await pick(page, 'long-5min.mp4');
  await page.click('#runBtn');
  await page.waitForFunction(() => document.getElementById('step3').classList.contains('is-current'));
  expect(await page.isVisible('#easyCancel')).toBe(true);
  expect(await page.isDisabled('.steps li[data-step="1"] button')).toBe(true);   // 圧縮中は戻れない
  await page.click('#easyCancel');
  await page.waitForFunction(() => document.getElementById('step2').classList.contains('is-current'), null, { timeout: 30000 });
  await page.click('.steps li[data-step="1"] button');
  expect(await currentStep(page)).toEqual([1]);
  await page.click('.choice[data-preset="size"]');
  expect((await settings(page)).mode).toBe('size');
  expect(await page.evaluate(() => !!window.__compressor.state.meta)).toBe(true);   // 選んだ動画はそのまま
});

test('簡単モードは、アプリの画面の保存してある設定を使わず、変えもしない', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    localStorage.setItem('video-compressor-under20mb:settings', JSON.stringify({ res: '1080', mode: 'size', target: 50, min720: 800, halfFps: false }));
  });
  const before = await page.evaluate(() => localStorage.getItem('video-compressor-under20mb:settings'));
  await openEasy(page);
  await page.click('.choice[data-preset="quality"]');
  const s = await settings(page);
  expect([s.res, s.mode, s.targetMB, s.minBitrate['720'], s.halfFps]).toEqual(['720', 'quality', 20, 1200000, true]);
  await page.click('.steps li[data-step="1"] button');
  await page.click('.choice[data-preset="size"]');
  expect(await page.evaluate(() => localStorage.getItem('video-compressor-under20mb:settings'))).toBe(before);
});

test('アプリの画面に簡単モードへのリンクがあり、動画を選んだら（「別の動画」と並ばないよう）隠す', async ({ page }) => {
  await open(page);
  expect(await page.getAttribute('#easyLink', 'href')).toBe('./easy');
  expect(await page.isVisible('#easyLink')).toBe(true);
  await pick(page, 'small-5mb.mp4');
  expect(await page.isVisible('#easyLink')).toBe(false);
  await page.goto('/easy');
  expect(await page.title()).toContain('かんたん圧縮');
});
