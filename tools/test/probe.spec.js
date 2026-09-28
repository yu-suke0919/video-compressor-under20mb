// 試し圧縮（動画を読み込んだら、今の解像度・fps で下げられるビットレートの限界を測る）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui } = require('./helpers');

const diag = page => page.inputValue('#diagOut');
const probeDone = (page, key) => page.waitForFunction(k => !!window.__compressor.probe.results[k], key, { timeout: 120000 });

test('読み込んだら今の設定で測り、設定を変えたらその設定でも測る', async ({ page }) => {
  await open(page, '?probe=on');
  await pick(page, '1080p60-45s.mp4');   // 初期設定は 720p・30fps
  await probeDone(page, '1280x720@30');
  const first = await page.evaluate(() => window.__compressor.probe.results['1280x720@30']);
  expect(first.bps).toBeGreaterThan(0);
  expect(await diag(page)).toMatch(/試し圧縮 1280x720@30 .* 指定 .* → 実測 .*（.*・.*・.*）/);   // 3か所
  expect(await diag(page)).toMatch(/予想（試し圧縮から）/);

  // 60fps のままにすると、その設定で測り直す（前の結果は残す）
  await page.click('details.settings:not(#diagBox) > summary');
  await page.uncheck('#halfFps');
  await probeDone(page, '1280x720@60');
  expect(await page.evaluate(() => Object.keys(window.__compressor.probe.results).sort())).toEqual(['1280x720@30', '1280x720@60']);
});

test('測っている途中で「圧縮する」を押すと、測るのを止めて圧縮する', async ({ page }) => {
  await open(page, '?probe=on');
  await pick(page, '720p-60s.mp4');
  await page.waitForFunction(() => !!window.__compressor.probe.job, null, { timeout: 30000 });
  await compress(page);
  const u = await ui(page);
  expect(await diag(page)).toMatch(/試し圧縮を中断（圧縮を開始）/);
  expect(await diag(page)).toMatch(/完了 /);
  expect(await page.evaluate(() => window.__compressor.probe.job)).toBe(null);
  expect(u.hasOut).toBe(true);
  expect(u.outWarn).toBe('');
});

test('「動画を選んだらすぐ圧縮」がオンのとき・probe=off のときは測らない', async ({ page }) => {
  await open(page, '?probe=on&auto=on');
  await pick(page, 'small-5mb.mp4');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  expect(await diag(page)).not.toMatch(/試し圧縮/);

  await open(page);   // probe=off
  await pick(page, '720p-60s.mp4');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__compressor.probe.job)).toBe(null);
  expect(await diag(page)).not.toMatch(/試し圧縮/);
});
