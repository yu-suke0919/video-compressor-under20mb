// Service Worker（オフライン対応）
'use strict';

const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'allow' });

test('このアプリの古いキャッシュだけ消し、同じドメインの別アプリのキャッシュは残す', async ({ page }) => {
  // Service Worker が入る前に、別アプリのキャッシュと、このアプリの古い版のキャッシュを作っておく
  await page.goto('/manifest.json');
  await page.evaluate(async () => {
    await (await caches.open('other-app-cache')).put('/x', new Response('x'));
    await caches.open('video-compressor-under20mb-v1');
  });
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  const keys = await page.evaluate(() => caches.keys());
  expect(keys).toContain('other-app-cache');
  expect(keys).not.toContain('video-compressor-under20mb-v1');
  expect(keys.filter(k => k.startsWith('video-compressor-under20mb-'))).toHaveLength(1);
});

test('一度開けば、ネットにつながっていなくても起動できる', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('h1')).toHaveText('アップロード不要の動画圧縮');
  expect(await page.evaluate(() => typeof window.Mediabunny)).toBe('object');
});
