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
  expect(first.samples).toHaveLength(5);   // 45秒の動画は5か所
  for (const bps of first.samples) expect(bps).toBeGreaterThan(0);
  expect(await diag(page)).toMatch(/試し圧縮 1280x720@30 .* 指定 .* → 実測 [^・]+・[^・]+・[^・]+・[^・]+・[^・（]+（/);
  expect(await diag(page)).toMatch(/予想（試し圧縮から）/);
  expect((await ui(page)).planInfo).toMatch(/予想.*（試し圧縮）$/);

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

test('予想の計算：場面ごとに「指定」と「実測」の大きい方を平均し、「◯MB以内に圧縮」では収まるように下げる', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const st = { res: '1080', mode: 'quality', targetMB: 20, targetBytes: 20000000, halfFps: false, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const meta = { width: 1920, height: 1080, duration: 60, fps: 60 };
    const plan = s => c.makePlan(meta, { start: 0, end: 60 }, Object.assign({}, st, s), none, 500000000);
    const heavy = [1400000, 5900000, 11600000];   // iPhone の実機で測った値
    const light = [300000, 400000, 500000];       // 指定を守るエンコーダー
    const q = c.applyProbe(plan({}), heavy);
    const size70 = c.applyProbe(plan({ mode: 'size', targetMB: 70, targetBytes: 70000000 }), heavy);
    const sizeOver = c.applyProbe(plan({ mode: 'size', targetMB: 40, targetBytes: 40000000 }), heavy);
    const easy = c.applyProbe(plan({ mode: 'size' }), light);
    return {
      mid: c.probedBps(4050000, heavy), q, size70, sizeOver, easy, plain: plan({ mode: 'size', targetMB: 70, targetBytes: 70000000 }),
      ranges: [c.probeRanges(60).length, c.probeRanges(15).length, c.probeRanges(3).length, c.probeRanges(1)]
    };
  });
  expect(r.mid).toBe(Math.round((4050000 + 5900000 + 11600000) / 3));
  // なるべく圧縮：指定はそのまま、予想だけ直す
  expect(r.q.videoBitrate).toBe(4050000);
  expect(r.q.probed).toBe(true);
  expect(r.q.estBytes).toBe(Math.round(r.mid * 60 / 8));
  // 70MB以内：計画のまま（約9Mbps）だと超える見込みなので、見込みが予算に収まるいちばん高い値（約7.8Mbps）に下げる
  expect(r.plain.videoBitrate).toBeGreaterThan(8500000);
  expect(r.size70.videoBitrate).toBeLessThan(r.plain.videoBitrate);
  expect(r.size70.videoBitrate).toBeGreaterThan(7700000);
  expect(r.size70.probeOver).toBe(false);
  expect(r.size70.estBytes).toBeLessThanOrEqual(70000000 * 0.97);
  expect(r.size70.estBytes).toBeGreaterThan(70000000 * 0.97 * 0.99);
  // 40MB以内：下限（4.05Mbps）でも 7.2Mbps の見込みで収まらない → 下限で圧縮し、知らせる（押せなくはしない）
  expect(r.sizeOver.probeOver).toBe(true);
  expect(r.sizeOver.videoBitrate).toBe(4050000);
  expect(r.sizeOver.unreachable).toBe(false);
  // 指定を守るエンコーダーでは何も変えない
  expect(r.easy.videoBitrate).toBe(4050000);
  expect(r.easy.probeOver).toBe(false);
  // 試す場所の数：60秒は5か所、15秒は3か所、3秒は1か所、1秒の動画は全体
  expect(r.ranges.slice(0, 3)).toEqual([5, 3, 1]);
  expect(r.ranges[3]).toEqual([{ start: 0, end: 1 }]);
});

test('「◯MB以内に圧縮」で収まらない見込みなら、押す前に知らせる（押すことはできる）', async ({ page }) => {
  await open(page, '?probe=on&res=1080&fps=source&mode=size&target=30');
  await pick(page, '1080p60-45s.mp4');
  await page.waitForFunction(() => Object.keys(window.__compressor.probe.results).length > 0, null, { timeout: 120000 });
  // テストの動画では収まる見込みになるので、試し圧縮の結果を重い映像のものに差し替えて出し直す
  await page.evaluate(() => {
    const p = window.__compressor.probe;
    Object.keys(p.results).forEach(k => { p.results[k] = { samples: [20000000, 30000000, 40000000] }; });
    document.getElementById('targetSize').dispatchEvent(new Event('input', { bubbles: true }));
  });
  const u = await ui(page);
  expect(u.planWarn).toMatch(/試し圧縮の結果、この設定では30MBに収まらない見込みです（予想.*）。30fpsにするか、720pにするか、範囲を短くしてください。/);
  expect(u.planInfo).toMatch(/（試し圧縮）$/);
  expect(u.runDisabled).toBe(false);
});
