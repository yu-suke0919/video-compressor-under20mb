// 元の動画をそのまま渡してよいか（位置情報・音声を取り除く必要があるとき）と、トリミングのみ（再圧縮なし）の書き出し
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui, outputInfo, setTrim, LOCATION_KEY } = require('./helpers');

test.describe('位置情報', () => {
  for (const file of ['location-xyz.mov', 'location-iphone.mp4']) {
    test(`位置情報付き（${file}）：元のまま渡さず、位置情報を除いて書き出す`, async ({ page }) => {
      await open(page);
      await pick(page, file);
      const u = await ui(page);
      expect(u.meta.hasLocation).toBe(true);
      expect(u.original).toBe(false);
      expect(u.planWarn).toContain('位置情報が含まれている動画です');
      expect(u.planInfo).toContain('/再圧縮なし\n→ ');
      expect(u.planInfo).toContain('（予想・位置情報を除いて元のまま）');
      await compress(page);
      const out = await outputInfo(page);
      expect(out.rawTagKeys.filter(k => LOCATION_KEY.test(k))).toEqual([]);
      expect((await ui(page)).outInfo).toContain('位置情報を除いて元のまま');
    });
  }

  test('互換モードに切り替わっても、位置情報ありを引き継ぐ', async ({ page }) => {
    await open(page);
    // 映像をデコードできない端末のふりをする（位置情報は高速モードで読める）
    await page.evaluate(() => {
      const orig = Mediabunny.Input.prototype.getPrimaryVideoTrack;
      Mediabunny.Input.prototype.getPrimaryVideoTrack = function () {
        return orig.call(this).then(t => { if (t) t.canDecode = () => Promise.resolve(false); return t; });
      };
    });
    await pick(page, 'location-xyz.mov');
    const u = await ui(page);
    expect(u.engine).toBe('compat');
    expect(u.meta.hasLocation).toBe(true);
    expect(u.original).toBe(false);
    expect(u.planWarn).toContain('位置情報が含まれている動画です');
  });

  test('メタデータを読めず位置情報が分からないときも、元のまま渡さない', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { Mediabunny.Input.prototype.getMetadataTags = () => Promise.reject(new Error('読めない')); });
    await pick(page, 'small-5mb.mp4');
    const u = await ui(page);
    expect(u.meta.hasLocation).toBe(null);
    expect(u.original).toBe(false);
  });

  test('互換モードの動画（位置情報を調べられない）は、目標以下でも元のまま渡さない', async ({ page }) => {
    await open(page);
    await pick(page, 'vp9.webm');
    const u = await ui(page);
    expect(u.engine).toBe('compat');
    expect(u.meta.hasLocation).toBe(null);
    expect(u.original).toBe(false);
  });
});

test.describe('音声をオフにしたとき', () => {
  test('元のまま渡さず、音声を除いて元のまま書き出す', async ({ page }) => {
    await open(page, '?audio=off');
    await pick(page, 'small-5mb.mp4');
    const u = await ui(page);
    expect(u.original).toBe(false);
    expect(u.planInfo).toContain('（予想・音声を除いて元のまま）');
    await compress(page);
    const out = await outputInfo(page);
    expect(out.audioCodec).toBe(null);
    expect(out.sameAsInput).toBe(false);
  });

  test('「動画を選んだらすぐ圧縮」でも音声を除く', async ({ page }) => {
    await open(page, '?audio=off&auto=on');
    await pick(page, 'small-5mb.mp4');
    await page.waitForFunction(() => !window.__compressor.state.running && !!window.__compressor.state.out);
    const out = await outputInfo(page);
    expect(out.original).toBe(false);
    expect(out.audioCodec).toBe(null);
  });

  test('元の動画に音声がなければ、元のまま渡せる', async ({ page }) => {
    await open(page, '?audio=off');
    await pick(page, 'oneframe.mp4');
    expect((await ui(page)).original).toBe(true);
  });
});

test.describe('全体かどうかの判定とトリミングのみ', () => {
  test('終わりをほんの少し（0.05秒以内）動かしただけなら、全体として扱う', async ({ page }) => {
    await open(page);
    await pick(page, 'small-5mb.mp4');
    const dur = (await ui(page)).meta.duration;
    await setTrim(page, null, dur - 0.03);
    expect((await ui(page)).original).toBe(true);
    await setTrim(page, null, dur - 1);
    const u = await ui(page);
    expect(u.original).toBe(false);
    expect(u.planInfo).toContain('（予想・トリミングのみ）');
  });

  test('再圧縮では収まらなくても、トリミングのみで収まるなら実行できる', async ({ page }) => {
    await open(page, '?target=2');
    await pick(page, 'lowrate-60s-noaudio.mp4');   // 1分で約2.5MB（元のビットレートが低い）
    await setTrim(page, 0, 40);
    const u = await ui(page);
    expect(u.planInfo).toContain('（予想・トリミングのみ）');
    expect(u.runDisabled).toBe(false);
    await compress(page);
    const out = await outputInfo(page);
    expect(out.size).toBeLessThan(2 * 1000 * 1000);
    expect(Math.abs(out.duration - 40)).toBeLessThan(3);
    expect((await ui(page)).outInfo).toContain('トリミングのみ（再圧縮なし）');
  });
});
