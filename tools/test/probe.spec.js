// 試し圧縮と予圧縮（動画を読み込んだら実際に圧縮して測り、サイズを予想する。「なるべく圧縮」では予圧縮をそのまま使う）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui, setTrim } = require('./helpers');

const diag = page => page.inputValue('#diagOut');
const pc = (page, fn) => page.evaluate(fn);
const waitPc = (page, fn, timeout = 120000) => page.waitForFunction(fn, null, { timeout });
// 書き出した動画の長さ（秒）
const outDuration = page => page.evaluate(async () => {
  const M = window.Mediabunny, out = window.__compressor.state.out;
  const input = new M.Input({ source: new M.BlobSource(out.blob), formats: [M.MP4] });
  return input.computeDuration();
});

test('読み込んだら、元の解像度・fps で真ん中と最後を試し圧縮し、そのあと今の設定で全体を予圧縮する', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '1080p60-45s.mp4');   // 初期設定は 720p・30fps
  await waitPc(page, () => { const t = window.__compressor.precomp().trial; return t && t.samples.length >= 1; });
  expect((await ui(page)).planInfo).toMatch(/（目安）$/);
  await waitPc(page, () => window.__compressor.precomp().trial.done);
  const t = await pc(page, () => { const t = window.__compressor.precomp().trial; return { plan: [t.plan.width, t.plan.height, Math.round(t.plan.outFps)], starts: t.samples.map(x => x.start), hi: t.samples.map(x => x.hi > 0) }; });
  expect(t.plan).toEqual([1920, 1080, 60]);   // 元の解像度・fps
  expect(t.hi).toEqual([true, true]);         // 上限も測った
  expect(t.starts[0]).toBeCloseTo(21.5, 0);    // 真ん中
  expect(t.starts[1]).toBeCloseTo(43, 0);      // 最後
  expect(await diag(page)).toMatch(/試し圧縮 1920x1080@60 21\.\d-23\.\ds 指定 4\.0Mbps → [\d.]+[kM]bps・指定 50\.0Mbps → [\d.]+[kM]bps（/);

  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.done; });
  const u = await ui(page);
  expect(u.planInfo).toMatch(/（予圧縮済み）$/);
  expect(await diag(page)).toMatch(/予圧縮を開始 720 1280x720 mode=quality .* fps=60→30/);
  expect(await diag(page)).toMatch(/予圧縮が完了 /);
  // 予圧縮が済んだら、予想は書き出した量とほぼ同じ
  const r = await pc(page, () => ({ bytes: window.__compressor.precomp().pre.bytes, est: window.__compressor.state.plan.estBytes }));
  expect(Math.abs(r.est - r.bytes) / r.bytes).toBeLessThan(0.05);
});

test('「なるべく圧縮」で、予圧縮が済んでいれば、押したら範囲を切り出してすぐ結果にする', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.done; });
  await setTrim(page, 10, 30);   // 範囲を変えても予圧縮はやり直さない
  expect((await ui(page)).planInfo).toMatch(/（予圧縮済み）$/);
  const est = await pc(page, () => window.__compressor.state.plan.estBytes);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を使う（完了済み）/);
  expect(d).toMatch(/予圧縮から切り出す準備/);
  expect(d).not.toMatch(/変換を開始/);   // 普通の圧縮はしていない
  const u = await ui(page);
  expect(u.hasOut).toBe(true);
  expect(u.outWarn).toBe('');
  const dur = await outDuration(page);
  expect(dur).toBeGreaterThanOrEqual(19.9);
  expect(dur).toBeLessThanOrEqual(22.1);   // 始まりはキーフレームに合わせて最大2秒早まる
  const size = await pc(page, () => window.__compressor.state.out.blob.size);
  expect(Math.abs(size - est) / size).toBeLessThan(0.15);
  // 結果の欄のビットレートは、書き出した大きさと動画の長さから求めた実際の値（切り出しで少し長くなった分も反映する）
  const actual = await pc(page, () => ({ audio: window.__compressor.state.plan.audioBitrate }));
  const bps = size * 8 / dur - actual.audio;
  const label = bps >= 1000000 ? (bps / 1000000).toFixed(1) + 'Mbps' : Math.round(bps / 1000) + 'kbps';
  await page.waitForFunction(l => document.getElementById('outInfo').textContent.includes('・' + l), label, { timeout: 10000 });
});

test('予圧縮の途中で押しても、範囲の始まりを越えていれば、範囲の終わりまで続けて使う', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 2, 20);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && !p.done && p.time >= 3; });
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を使う（[\d.]+秒まで済み）/);
  expect(d).toMatch(/予圧縮を範囲の終わりで止める/);
  expect(d).not.toMatch(/変換を開始/);
  const dur = await outDuration(page);
  expect(dur).toBeGreaterThanOrEqual(17.9);
  expect(dur).toBeLessThanOrEqual(20.1);
});

test('予圧縮が範囲の始まりまで届いていなければ、使わずに範囲だけを圧縮する', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 50, 58);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.job && p.time < 40; });
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮は使わない（範囲の始まりまで届いていない/);
  expect(d).toMatch(/予圧縮を中断（圧縮を開始/);
  expect(d).toMatch(/変換を開始/);
  expect((await ui(page)).hasOut).toBe(true);
});

test('設定を変えたら予圧縮をやり直す。「◯MB以内に圧縮」では予想だけに使い、普通に圧縮する', async ({ page }) => {
  await open(page, '?probe=on&mode=size');
  await pick(page, '1080p60-45s.mp4');
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.job && p.time > 1; });
  await page.click('details.settings:not(#diagBox) > summary');
  await page.uncheck('#halfFps');   // 60fps のまま
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.done && /@60\//.test(p.key); });
  const d0 = await diag(page);
  expect(d0).toMatch(/予圧縮を中断（設定を変えた/);
  expect(d0).toMatch(/予圧縮を開始 .* fps=60→60/);
  expect((await ui(page)).planInfo).toMatch(/（予圧縮済み）$/);
  await compress(page);
  const d = await diag(page);
  expect(d).not.toMatch(/予圧縮を使う/);
  expect(d).toMatch(/変換を開始/);
});

test('「動画を選んだらすぐ圧縮」がオンのとき・probe=off のときは、試し圧縮も予圧縮もしない', async ({ page }) => {
  await open(page, '?probe=on&auto=on');
  await pick(page, 'small-5mb.mp4');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
  await page.waitForTimeout(2000);
  expect(await diag(page)).not.toMatch(/試し圧縮|予圧縮/);

  await open(page);   // probe=off
  await pick(page, '720p-60s.mp4');
  await page.waitForTimeout(2000);
  expect(await diag(page)).not.toMatch(/試し圧縮|予圧縮/);
});

test('見込みの計算：場面ごとに「指定」と「実測」の大きい方を長さで重み付けして平均し、「◯MB以内に圧縮」では収まるように下げる', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const st = { res: '1080', mode: 'quality', targetMB: 20, targetBytes: 20000000, halfFps: false, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const meta = { width: 1920, height: 1080, duration: 60, fps: 60 };
    const plan = s => c.makePlan(meta, { start: 0, end: 60 }, Object.assign({}, st, s), none, 500000000);
    const heavy = [1400000, 5900000, 11600000].map(bps => ({ w: 1, bps }));   // iPhone の実機で測った値
    const light = [300000, 400000, 500000].map(bps => ({ w: 1, bps }));       // 指定を守るエンコーダー
    return {
      mid: c.probedBps(4050000, heavy),
      weighted: c.probedBps(4000000, [{ w: 3, bps: 1000000 }, { w: 1, bps: 8000000 }]),
      q: c.applyProbe(plan({}), heavy),
      size70: c.applyProbe(plan({ mode: 'size', targetMB: 70, targetBytes: 70000000 }), heavy),
      plain70: plan({ mode: 'size', targetMB: 70, targetBytes: 70000000 }),
      sizeOver: c.applyProbe(plan({ mode: 'size', targetMB: 40, targetBytes: 40000000 }), heavy),
      easy: c.applyProbe(plan({ mode: 'size' }), light)
    };
  });
  expect(r.mid).toBe(Math.round((4050000 + 5900000 + 11600000) / 3));
  expect(r.weighted).toBe(Math.round((3 * 4000000 + 8000000) / 4));
  // なるべく圧縮：指定はそのまま、予想だけ直す
  expect(r.q.videoBitrate).toBe(4050000);
  expect(r.q.estBytes).toBe(Math.round(r.mid * 60 / 8));
  // 70MB以内：計画のまま（約9Mbps）だと超える見込みなので、見込みが予算に収まるいちばん高い値（約7.8Mbps）に下げる
  expect(r.plain70.videoBitrate).toBeGreaterThan(8500000);
  expect(r.size70.videoBitrate).toBeLessThan(r.plain70.videoBitrate);
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
});

test('見込みの材料：予圧縮が済んだ所は書き出した量、まだの所は試し圧縮を今の解像度・fps に換算した値', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    const plan = { trimStart: 0, trimEnd: 60, width: 1280, height: 720, outFps: 30 };
    // 試し圧縮：1920x1080@60 で 30秒と 58秒の所が 8Mbps
    const trial = { plan: { width: 1920, height: 1080, outFps: 60 }, samples: [{ start: 29, end: 31, bps: 8000000 }, { start: 58, end: 60, bps: 8000000 }] };
    const k = Math.pow(1280 * 720 / (1920 * 1080), 0.75) * Math.pow(30 / 60, 0.6);
    // 予圧縮：0〜20秒まで、2秒ごとに 250000バイト（= 1Mbps）。音声 0
    const marks = [{ t: 0, bytes: 0 }];
    for (let t = 2; t <= 20; t += 2) marks.push({ t, bytes: t / 2 * 250000 });
    const pre = { plan: { audioBitrate: 0 }, marks };
    return {
      k,
      trialOnly: c.estimateParts(plan, trial, null),
      both: c.estimateParts(plan, trial, pre),
      trimmed: c.estimateParts(Object.assign({}, plan, { trimStart: 4, trimEnd: 14 }), trial, pre),
      preOnly: c.estimateParts(Object.assign({}, plan, { trimEnd: 40 }), null, pre),
      nothing: c.estimateParts(plan, null, null)
    };
  });
  // 試し圧縮だけ：2か所を換算して、全体に半分ずつ
  expect(r.trialOnly.from).toBe('trial');
  expect(r.trialOnly.parts.map(x => [x.w, Math.round(x.bps)])).toEqual([[30, Math.round(8000000 * r.k)], [30, Math.round(8000000 * r.k)]]);
  // 予圧縮が 0〜20秒：そこは実測（1Mbps×10区切り）、残りの40秒は試し圧縮（まだの所にある2か所）
  expect(r.both.from).toBe('pre');
  expect(r.both.parts).toHaveLength(12);
  expect(r.both.parts.slice(0, 10).every(x => x.w === 2 && x.bps === 1000000)).toBe(true);
  expect(r.both.parts.slice(10).map(x => x.w)).toEqual([20, 20]);
  // 範囲が予圧縮の済んだ所に収まるなら、実測だけ
  expect(r.trimmed.parts.reduce((a, x) => a + x.w, 0)).toBeCloseTo(10, 5);
  expect(r.trimmed.parts.every(x => x.bps === 1000000)).toBe(true);
  // 試し圧縮がなければ、まだの所は予圧縮の平均
  expect(r.preOnly.parts.slice(10).map(x => [x.w, x.bps])).toEqual([[20, 1000000]]);
  expect(r.nothing).toBe(null);
});

test('「◯MB以内に圧縮」で収まらない見込みなら、押す前に知らせる（押すことはできる）', async ({ page }) => {
  await open(page, '?probe=trial&res=1080&fps=source&mode=size&target=30');
  await pick(page, '1080p60-45s.mp4');
  await waitPc(page, () => window.__compressor.precomp().trial && window.__compressor.precomp().trial.done);
  // テストの動画では収まる見込みになるので、試し圧縮の実測を重い映像のものに差し替えて出し直す
  await page.evaluate(() => {
    window.__compressor.precomp().trial.samples.forEach(x => { x.bps = 30000000; });
    document.getElementById('targetSize').dispatchEvent(new Event('input', { bubbles: true }));
  });
  const u = await ui(page);
  expect(u.planWarn).toMatch(/試し圧縮の結果、この設定では30MBに収まらない見込みです（予想.*）。30fpsにするか、720pにするか、範囲を短くしてください。/);
  expect(u.planInfo).toMatch(/（目安）$/);
  expect(u.runDisabled).toBe(false);
  expect(await diag(page)).not.toMatch(/予圧縮/);   // probe=trial では予圧縮しない
});

test('上限：指定が高すぎるときは、場面ごとの上限までしか使わない見込みにする', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const parts = [{ w: 1, bps: 5400000, hi: 6500000 }];   // iPhone：下限 5.4Mbps・上限 6.5Mbps の場面
    const st = { res: '1080', mode: 'size', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const plan = c.makePlan({ width: 1920, height: 1080, duration: 15.4, fps: 30 }, { start: 0, end: 15.4 }, st, none, 500000000);
    const trial = { plan: { width: 1920, height: 1080, outFps: 30 }, samples: [{ start: 6.7, end: 8.7, bps: 4000000, hi: 8000000 }] };
    const marks = [{ t: 0, bytes: 0 }, { t: 2, bytes: 250000 }];   // 予圧縮：0〜2秒が 1Mbps
    return {
      low: c.probedBps(2700000, parts),     // 指定が低い → 下限
      mid: c.probedBps(6000000, parts),     // 間 → 指定どおり
      high: c.probedBps(9400000, parts),    // 指定が高い → 上限
      noHi: c.probedBps(9400000, [{ w: 1, bps: 5400000 }]),
      plan: c.applyProbe(plan, parts),
      est: c.estimateParts(Object.assign({}, plan, { width: 1920, height: 1080, outFps: 30, trimStart: 0, trimEnd: 4 }), trial, { plan: { audioBitrate: 0 }, marks })
    };
  });
  expect(r.low).toBe(5400000);
  expect(r.mid).toBe(6000000);
  expect(r.high).toBe(6500000);
  expect(r.noHi).toBe(9400000);   // 上限を測っていなければ、今までどおり指定どおり
  // 20MB以内・15.4秒：指定は約9.9Mbps のままだが、予想は上限の 6.5Mbps で出す（実機では 12.9MB になった）
  expect(r.plan.videoBitrate).toBeGreaterThan(9000000);
  expect(r.plan.expectedBps).toBe(6500000);
  expect(r.plan.estBytes).toBe(Math.round(6500000 * 15.4 / 8));
  // 予圧縮の区切りの上限は、試し圧縮の「上限÷下限」の比（2倍）で見込む
  expect(r.est.parts[0]).toEqual({ w: 2, bps: 1000000, hi: 2000000 });
});
