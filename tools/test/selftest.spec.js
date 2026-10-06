// 自己テストのページ（selftest.html）：テスト用の動画を作り、iframe で開いたアプリで圧縮して判定する流れが、最後まで動くこと
'use strict';

const { test, expect } = require('@playwright/test');

test('自動テスト（圧縮の結果・先行圧縮・3ステップの画面）が最後まで動き、失敗がない', async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);
  await page.goto('/selftest.html');
  await page.click('#autoBtn');
  await page.waitForFunction(() => /^(\d+)\/\1 件完了/.test(document.getElementById('summary').textContent), null, { timeout: 29 * 60 * 1000 });
  const results = await page.evaluate(() => window.__selftest.results.map(r => ({ title: r.title, status: r.status, detail: r.detail })));
  const failed = results.filter(r => r.status === 'ng');
  if (failed.length) console.log(await page.evaluate(() => window.__selftest.resultText()));
  expect(failed).toEqual([]);
  const pre = results.filter(r => r.title.startsWith('先行圧縮: '));
  const easy = results.filter(r => r.title.startsWith('3ステップ: '));
  expect(results.length - pre.length - easy.length).toBe(14);   // 圧縮の結果
  expect(pre.length).toBe(6);
  expect(pre.filter(r => r.status === 'ok').length).toBeGreaterThanOrEqual(4);   // 端末が速いと、途中で押す場面を作れず「注意」になる
  expect(easy.length).toBe(9);
  expect(easy.filter(r => r.status === 'ok').length).toBeGreaterThanOrEqual(8);
  expect(await page.isDisabled('#copyBtn')).toBe(false);
});

test('手元の動画でも試せる', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.goto('/selftest.html');
  await page.setInputFiles('#file', require('./helpers').video('small-5mb.mp4'));   // 720p・10秒（3回圧縮するので短い動画で）
  await page.waitForFunction(() => /^3\/3 件完了/.test(document.getElementById('summary').textContent), null, { timeout: 4 * 60 * 1000 });
  const results = await page.evaluate(() => window.__selftest.results.map(r => ({ title: r.title, status: r.status, detail: r.detail })));
  expect(results.filter(r => r.status === 'ng')).toEqual([]);
  expect(results[0].title).toContain('1280×720');
});
