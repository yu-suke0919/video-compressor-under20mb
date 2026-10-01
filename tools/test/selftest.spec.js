// 自己テストのページ（selftest.html）：テスト用の動画を作り、iframe で開いたアプリで圧縮して判定する流れが、最後まで動くこと
'use strict';

const { test, expect } = require('@playwright/test');

test('自動テストが最後まで動き、失敗がない', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  await page.goto('/selftest.html');
  await page.click('#autoBtn');
  await page.waitForFunction(() => /^(\d+)\/\1 件完了/.test(document.getElementById('summary').textContent), null, { timeout: 14 * 60 * 1000 });
  const results = await page.evaluate(() => window.__selftest.results.map(r => ({ title: r.title, status: r.status, detail: r.detail })));
  const failed = results.filter(r => r.status === 'ng');
  if (failed.length) console.log(await page.evaluate(() => window.__selftest.resultText()));
  expect(failed).toEqual([]);
  expect(results.length).toBe(13);
  expect(await page.isDisabled('#copyBtn')).toBe(false);
});

test('手元の動画でも試せる', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.goto('/selftest.html');
  await page.setInputFiles('#file', require('./helpers').video('720p-60s.mp4'));
  await page.waitForFunction(() => /^2\/2 件完了/.test(document.getElementById('summary').textContent), null, { timeout: 4 * 60 * 1000 });
  const results = await page.evaluate(() => window.__selftest.results.map(r => ({ title: r.title, status: r.status, detail: r.detail })));
  expect(results.filter(r => r.status === 'ng')).toEqual([]);
  expect(results[0].title).toContain('1280×720');
});

test('予圧縮のテストが最後まで動き、失敗がない', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  await page.goto('/selftest.html');
  await page.click('#preBtn');
  await page.waitForFunction(() => /^6\/6 件完了/.test(document.getElementById('summary').textContent), null, { timeout: 9 * 60 * 1000 });
  const results = await page.evaluate(() => window.__selftest.results.map(r => ({ title: r.title, status: r.status, detail: r.detail })));
  console.log(await page.evaluate(() => window.__selftest.resultText()));
  expect(results.filter(r => r.status === 'ng')).toEqual([]);
  expect(results.filter(r => r.status === 'ok').length).toBeGreaterThanOrEqual(4);
});

test('新しい画面（3ステップ）のテストが最後まで動き、失敗がない', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  await page.goto('/selftest.html');
  await page.click('#easyBtn');
  await page.waitForFunction(() => /^9\/9 件完了/.test(document.getElementById('summary').textContent), null, { timeout: 9 * 60 * 1000 });
  const results = await page.evaluate(() => window.__selftest.results.map(r => ({ title: r.title, status: r.status, detail: r.detail })));
  console.log(await page.evaluate(() => window.__selftest.resultText()));
  expect(results.filter(r => r.status === 'ng')).toEqual([]);
  expect(results.filter(r => r.status === 'ok').length).toBeGreaterThanOrEqual(8);
});
