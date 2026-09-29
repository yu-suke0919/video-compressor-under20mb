// 予圧縮（動画を読み込んだら全体を裏で圧縮し、書き出した量でサイズを予想する。押したら予圧縮をそのまま使う）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui, setTrim } = require('./helpers');

const diag = page => page.inputValue('#diagOut');
const pc = (page, fn) => page.evaluate(fn);
const waitPc = (page, fn, timeout = 120000) => page.waitForFunction(fn, null, { timeout });
const preDone = page => waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.done; });
// 書き出した動画の長さ（秒）
const outDuration = page => page.evaluate(async () => {
  const M = window.Mediabunny, out = window.__compressor.state.out;
  const input = new M.Input({ source: new M.BlobSource(out.blob), formats: [M.MP4] });
  return input.computeDuration();
});

test('読み込んだら全体を予圧縮し、実測の平均ビットレート・予想・目標サイズに収まる秒数を出す', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '1080p60-45s.mp4');   // 初期設定は 720p・30fps
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.marks.length > 2; });
  expect((await ui(page)).planInfo).toMatch(/・予想[\d.]+ MB（予圧縮 \d+%）・20MBなら約.+まで$/);
  await preDone(page);
  const u = await ui(page);
  expect(u.planInfo).toMatch(/（予圧縮済み）・20MBなら約.+まで$/);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を開始 720 1280x720 mode=quality 1200kbps fps=60→30/);   // なるべく圧縮は下限ビットレート
  expect(d).toMatch(/予圧縮が完了 /);
  expect(d).not.toMatch(/試し圧縮/);
  // 予圧縮が済んだら、予想は書き出した量とほぼ同じ。表示のビットレートは実測の平均、秒数は収まる秒数の90%
  const r = await pc(page, () => { const p = window.__compressor.state.plan; return { bytes: window.__compressor.precomp().pre.bytes, est: p.estBytes, bps: p.expectedBps, audio: p.audioBitrate, fit: p.fitSec }; });
  expect(Math.abs(r.est - r.bytes) / r.bytes).toBeLessThan(0.02);
  expect(r.fit).toBe(Math.floor(20000000 * 8 / (r.bps + r.audio) * 0.9));
  const label = r.bps >= 1000000 ? (r.bps / 1000000).toFixed(1) + 'Mbps' : Math.round(r.bps / 1000) + 'kbps';
  expect(u.planInfo).toContain('・' + label + '・予想');
});

test('「なるべく圧縮」で、予圧縮が済んでいれば、押したら範囲を切り出してすぐ結果にする', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  await setTrim(page, 10, 30);   // 「なるべく圧縮」では、範囲を変えても予圧縮はやり直さない
  expect((await ui(page)).planInfo).toMatch(/（予圧縮済み）/);
  const est = await pc(page, () => window.__compressor.state.plan.estBytes);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を使う（完了済み）/);
  expect(d).toMatch(/予圧縮から切り出す準備/);
  expect(d).not.toMatch(/変換を開始/);   // 普通の圧縮はしていない
  expect(d).not.toMatch(/予圧縮を中断（設定を変えた/);
  const u = await ui(page);
  expect(u.hasOut).toBe(true);
  expect(u.outWarn).toBe('');
  const dur = await outDuration(page);
  expect(dur).toBeGreaterThanOrEqual(19.9);
  expect(dur).toBeLessThanOrEqual(22.1);   // 始まりはキーフレームに合わせて最大2秒早まる
  const size = await pc(page, () => window.__compressor.state.out.blob.size);
  expect(Math.abs(size - est) / size).toBeLessThan(0.15);
  // 結果の欄のビットレートは、書き出した大きさと動画の長さから求めた実際の値
  const audio = await pc(page, () => window.__compressor.state.plan.audioBitrate);
  const bps = size * 8 / dur - audio;
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

test('「◯MB以内」でも下限ビットレートで予圧縮し、範囲を変えてもやり直さない。押したら普通に圧縮する', async ({ page }) => {
  await open(page, '?probe=on&mode=size&target=10');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 0, 30);
  await preDone(page);
  expect(await diag(page)).toMatch(/予圧縮を開始 720 1280x720 mode=quality 1200kbps/);
  await setTrim(page, 0, 20);
  await page.waitForTimeout(2000);
  const d0 = await diag(page);
  expect(d0).not.toMatch(/予圧縮を中断/);
  expect(d0.match(/予圧縮を開始/g)).toHaveLength(1);
  // 予想は、指定（目標から決めたビットレート）と下限での実測の大きい方
  const r = await pc(page, () => { const p = window.__compressor.state.plan; return { bps: p.expectedBps, set: p.videoBitrate, probed: p.probed }; });
  expect(r.probed).toBe(true);
  expect(r.bps).toBeGreaterThanOrEqual(r.set);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮は使わない（「なるべく圧縮」ではない）/);
  expect(d).toMatch(/変換を開始/);
});

test('「◯MB以内」で収まらない見込みなら、押す前に知らせる（押すことはできる）', async ({ page }) => {
  // 下限を 100kbps まで下げ、目標を小さくする。エンコーダーは下限ほど小さくできないので、予圧縮の結果は目標を超える
  await open(page, '?probe=on&res=1080&fps=source&mode=size&target=3&min1080=100');
  await pick(page, '1080p60-45s.mp4');
  await preDone(page);
  const u = await ui(page);
  expect(u.planWarn).toMatch(/予圧縮の結果、この設定では3MBに収まらない見込みです（予想.*）。30fpsにするか、720pにするか、範囲を短くしてください。/);
  expect(u.runDisabled).toBe(false);
});

test('「動画を選んだらすぐ圧縮」がオンのとき・probe=off のときは、予圧縮しない', async ({ page }) => {
  await open(page, '?probe=on&auto=on');
  await pick(page, 'small-5mb.mp4');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
  await page.waitForTimeout(2000);
  expect(await diag(page)).not.toMatch(/予圧縮/);

  await open(page);   // probe=off
  await pick(page, '720p-60s.mp4');
  await page.waitForTimeout(2000);
  expect(await diag(page)).not.toMatch(/予圧縮/);
});

test('予想の計算：済んだ所は区切りごとの実測、まだの所は済んだ所の平均。指定が高いときは区切りごとに大きい方', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    // 0〜20秒まで、2秒ごとに 250000バイト（= 1Mbps）。10〜14秒だけ 2倍（2Mbps）。音声 0
    const marks = [{ t: 0, bytes: 0 }];
    let total = 0;
    for (let t = 2; t <= 20; t += 2) { total += (t === 12 || t === 14) ? 500000 : 250000; marks.push({ t, bytes: total }); }
    const rec = { marks, plan: { audioBitrate: 0 } };
    return {
      inside: c.preEstimate({ trimStart: 10, trimEnd: 14 }, rec, 0),
      half: c.preEstimate({ trimStart: 10, trimEnd: 30 }, rec, 0),
      raised: c.preEstimate({ trimStart: 0, trimEnd: 20 }, rec, 1500000),
      none: c.preEstimate({ trimStart: 0, trimEnd: 10 }, { marks: [{ t: 0, bytes: 0 }], plan: { audioBitrate: 0 } }, 0)
    };
  });
  expect(r.inside).toEqual({ videoBps: 2000000, covered: 1 });   // 10〜14秒は実測（2倍の区間）
  expect(r.half.covered).toBeCloseTo(0.5, 5);
  // 10〜20秒は実測（2Mbps×4秒＋1Mbps×6秒）、20〜30秒は全体の平均（1.2Mbps）
  expect(r.half.videoBps).toBe(Math.round((2000000 * 4 + 1000000 * 6 + 1200000 * 10) / 20));
  // 1.5Mbps を指定：1Mbps の区切りは 1.5Mbps、2Mbps の区切りは 2Mbps のまま
  expect(r.raised.videoBps).toBe(Math.round((1500000 * 16 + 2000000 * 4) / 20));
  expect(r.none).toBe(null);
});
