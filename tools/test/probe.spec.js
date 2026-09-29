// 試し圧縮（動画を読み込んだら、今の解像度・fps で下げられるビットレートの限界を測る）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui, setTrim } = require('./helpers');

const diag = page => page.inputValue('#diagOut');

test('読み込んだら今の設定で1か所ずつ測って予想を出し直し、設定を変えたらその設定でも測る', async ({ page }) => {
  await open(page, '?probe=on');
  await pick(page, '1080p60-45s.mp4');   // 初期設定は 720p・30fps。45秒なので 8か所
  const count = () => page.evaluate(() => ((window.__compressor.probe.results['1280x720@30'] || {}).samples || []).length);
  await page.waitForFunction(() => ((window.__compressor.probe.results['1280x720@30'] || {}).samples || []).length === 1, null, { timeout: 60000 });
  expect((await ui(page)).planInfo).toMatch(/予想.*（試し圧縮 1\/8）$/);   // 1か所目で予想が出る
  await page.waitForFunction(() => window.__compressor.probe.results['1280x720@30'].samples.length === 8 && !window.__compressor.probe.jobs.length, null, { timeout: 120000 });
  expect(await count()).toBe(8);
  const starts = await page.evaluate(() => window.__compressor.probe.results['1280x720@30'].samples.map(x => x.start));
  // 最初・最後・真ん中の順（1か所2秒なので、最後は 45-2=43秒から）
  expect(starts[0]).toBe(0);
  expect(starts[1]).toBeCloseTo(43, 0);
  expect(starts[2]).toBeCloseTo(21.5, 0);
  for (const x of await page.evaluate(() => window.__compressor.probe.results['1280x720@30'].samples)) expect(x.bps).toBeGreaterThan(0);
  expect((await ui(page)).planInfo).toMatch(/予想.*（試し圧縮 8\/8）$/);
  expect(await diag(page)).toMatch(/試し圧縮 1280x720@30 21\.\d-23\.\ds 指定 .* → /);
  expect(await diag(page)).toMatch(/予想（試し圧縮 8\/8・[\d.]+秒）/);

  // 60fps のままにすると、その設定で測り直す（前の結果は残す）
  await page.click('details.settings:not(#diagBox) > summary');
  await page.uncheck('#halfFps');
  await page.waitForFunction(() => !!window.__compressor.probe.results['1280x720@60'], null, { timeout: 60000 });
  expect(await count()).toBe(8);
});

test('範囲を縮めたら、範囲の中の実測だけで予想し、足りない所を測り足す', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');   // 「◯MB以内」だと、この動画はトリミングのみになる
  await pick(page, '720p-60s.mp4');
  await page.waitForFunction(() => { const r = window.__compressor.probe.results['1280x720@30']; return r && r.samples.length === 10 && !window.__compressor.probe.jobs.length; }, null, { timeout: 180000 });
  await setTrim(page, 0, 20);   // 20秒 → 3か所。全体を測ったときの実測（0秒・約9秒…）は使い、足りなければ測り足す
  await page.waitForFunction(() => !window.__compressor.probe.jobs.length && !window.__compressor.probe.timer, null, { timeout: 60000 });
  const inside = await page.evaluate(() => window.__compressor.probe.results['1280x720@30'].samples.filter(x => (x.start + x.end) / 2 <= 20).length);
  expect(inside).toBeGreaterThanOrEqual(3);
  expect((await ui(page)).planInfo).toMatch(/（試し圧縮 3\/3）$/);
});

test('測っている途中で「圧縮する」を押すと、測るのを止めて圧縮する', async ({ page }) => {
  await open(page, '?probe=on');
  await pick(page, '720p-60s.mp4');
  await page.waitForFunction(() => !!window.__compressor.probe.jobs.length, null, { timeout: 30000 });
  await compress(page);
  const u = await ui(page);
  expect(await diag(page)).toMatch(/試し圧縮を中断（圧縮を開始）/);
  expect(await diag(page)).toMatch(/完了 /);
  expect(await page.evaluate(() => window.__compressor.probe.jobs.length)).toBe(0);
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
  expect(await page.evaluate(() => window.__compressor.probe.jobs.length)).toBe(0);
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
      wanted: [60, 15, 3, 1, 200].map(len => c.probeWanted({ trimStart: 0, trimEnd: len })),
      order: (() => {
        // 範囲 0〜60秒を測り切るまで、次に測る場所を順に取り出す
        const pl = { trimStart: 0, trimEnd: 60 }, samples = [];
        for (let r; (r = c.nextProbeRange(pl, samples));) samples.push(Object.assign({ bps: 1 }, r));
        // その実測で、範囲を 30.5〜40.5秒に縮めたとき（2か所ほしい。中にあるのは 36.25秒の1か所）に次に測る場所
        const next = c.nextProbeRange({ trimStart: 30.5, trimEnd: 40.5 }, samples);
        const short = c.nextProbeRange({ trimStart: 5, trimEnd: 5.5 }, []);
        return { starts: samples.map(x => x.start), next, short };
      })()
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
  // 測る数：6秒ごとに1か所（最大12か所）
  expect(r.wanted).toEqual([10, 3, 1, 1, 12]);
  // 測る順番：最初・最後・真ん中・1/4・3/4・1/8…（範囲 0〜60秒、1か所2秒なので 0〜58秒の間）
  expect(r.order.starts).toEqual([0, 58, 29, 14.5, 43.5, 7.25, 21.75, 36.25, 50.75, 3.625]);
  // 最初（30.5秒）はすぐ近く（29秒）を測ってあるので飛ばし、最後（38.5秒）を測る
  expect(r.order.next).toEqual({ start: 38.5, end: 40.5 });
  // 範囲が1か所の長さより短いときは、範囲全体を測る
  expect(r.order.short).toEqual({ start: 5, end: 5.5 });
});

test('「◯MB以内に圧縮」で収まらない見込みなら、押す前に知らせる（押すことはできる）', async ({ page }) => {
  await open(page, '?probe=on&res=1080&fps=source&mode=size&target=30');
  await pick(page, '1080p60-45s.mp4');
  await page.waitForFunction(() => Object.keys(window.__compressor.probe.results).length > 0, null, { timeout: 120000 });
  // テストの動画では収まる見込みになるので、試し圧縮の結果を重い映像のものに差し替えて出し直す
  await page.evaluate(() => {
    const p = window.__compressor.probe;
    // 重い実測を3か所入れ、それ以上は測らないようにする
    Object.keys(p.results).forEach(k => {
      p.results[k] = { failed: true, samples: [0, 20, 40].map((t, i) => ({ start: t, end: t + 2, bps: [20000000, 30000000, 40000000][i] })) };
    });
    document.getElementById('targetSize').dispatchEvent(new Event('input', { bubbles: true }));
  });
  const u = await ui(page);
  expect(u.planWarn).toMatch(/試し圧縮の結果、この設定では30MBに収まらない見込みです（予想.*）。30fpsにするか、720pにするか、範囲を短くしてください。/);
  expect(u.planInfo).toMatch(/（試し圧縮 3\/8）$/);
  expect(u.runDisabled).toBe(false);
});

test('probe=2 のときは2か所を同時に測り、同じ場所を2回測らない', async ({ page }) => {
  await open(page, '?probe=2');
  await pick(page, '1080p60-45s.mp4');
  let most = 0;
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(() => ({ jobs: window.__compressor.probe.jobs.length, n: ((window.__compressor.probe.results['1280x720@30'] || {}).samples || []).length }));
    most = Math.max(most, s.jobs);
    if (s.n === 8 && !s.jobs) break;
    await page.waitForTimeout(100);
  }
  expect(most).toBe(2);
  const starts = await page.evaluate(() => window.__compressor.probe.results['1280x720@30'].samples.map(x => Math.round(x.start * 10) / 10).sort((a, b) => a - b));
  expect(starts).toHaveLength(8);
  expect(new Set(starts).size).toBe(8);   // 同じ場所を2回測らない
  expect(await diag(page)).toMatch(/→ .*（.*・同時2）/);
  expect(await diag(page)).toMatch(/予想（試し圧縮 8\/8・[\d.]+秒）/);
  expect((await ui(page)).planInfo).toMatch(/（試し圧縮 8\/8）$/);
});
