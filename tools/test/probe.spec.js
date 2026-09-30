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
// 書き出した動画の映像の最初のコマの時刻（秒。負なら、その分は再生されない）
const videoStart = page => page.evaluate(async () => {
  const M = window.Mediabunny, out = window.__compressor.state.out;
  const input = new M.Input({ source: new M.BlobSource(out.blob), formats: [M.MP4] });
  return (await input.getPrimaryVideoTrack()).getFirstTimestamp();
});

test('読み込んだら全体を予圧縮し、実測の平均ビットレート・予想・目標サイズに収まる秒数を出す', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '1080p60-45s.mp4');   // 初期設定は 720p・30fps
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.marks.length > 2; });
  expect((await ui(page)).planInfo).toMatch(/・予想[\d.]+ MB（予圧縮 \d+%）\n約.+まで20MBに収まるよ$/);
  await preDone(page);
  const u = await ui(page);
  expect(u.planInfo).toMatch(/（予圧縮済み）\n約.+まで20MBに収まるよ$/);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を開始 720 1280x720 mode=quality 1200kbps fps=60→30/);   // なるべく圧縮は下限ビットレート
  expect(d).toMatch(/予圧縮が完了 /);
  expect(d).not.toMatch(/試し圧縮/);
  // 予圧縮が済んだら、予想は書き出した量とほぼ同じ。表示のビットレートは実測の平均、秒数は収まる秒数の95%
  const r = await pc(page, () => { const p = window.__compressor.state.plan; return { bytes: window.__compressor.precomp().pre.bytes, est: p.estBytes, bps: p.expectedBps, audio: p.audioBitrate, fit: p.fitSec }; });
  expect(Math.abs(r.est - r.bytes) / r.bytes).toBeLessThan(0.02);
  expect(r.fit).toBe(Math.floor(20000000 * 8 / (r.bps + r.audio) * 0.95));
  const label = r.bps >= 1000000 ? (r.bps / 1000000).toFixed(1) + 'Mbps' : Math.round(r.bps / 1000) + 'kbps';
  expect(u.planInfo).toContain('・' + label + '・予想');
});

test('「なるべく圧縮」で、予圧縮が済んでいれば、押したら範囲を切り出してすぐ結果にする', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  await setTrim(page, 10.7, 30.7);   // 「なるべく圧縮」では、範囲を変えても予圧縮はやり直さない（始まりはキーフレームの間）
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
  // ファイルにはキーフレーム（10秒）から入るが、範囲の始まりより前は再生されないので、長さは範囲どおり
  expect(dur).toBeGreaterThanOrEqual(19.8);
  expect(dur).toBeLessThanOrEqual(20.2);
  expect(await videoStart(page)).toBeLessThan(-0.5);   // 再生しない部分（キーフレームから範囲の始まりまで）
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
  await setTrim(page, 2.5, 20.5);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && !p.done && p.time >= 3; });
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を使う（[\d.]+秒まで済み）/);
  expect(d).toMatch(/予圧縮を範囲の終わりで止める/);
  expect(d).not.toMatch(/変換を開始/);
  const dur = await outDuration(page);
  expect(dur).toBeGreaterThanOrEqual(17.8);
  expect(dur).toBeLessThanOrEqual(18.2);
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
  // 範囲が「約◯秒まで」以内なら、収まらない注意は出さず、予想は狙うサイズ（目標の97%）までにする
  const r = await pc(page, () => { const p = window.__compressor.state.plan; return { est: p.estBytes, over: p.probeOver, fit: p.fitSec, dur: p.duration, probed: p.probed }; });
  expect(r.probed).toBe(true);
  expect(r.dur).toBeLessThanOrEqual(r.fit);
  expect(r.over).toBe(false);
  expect(r.est).toBeLessThanOrEqual(10000000 * 0.97);
  expect((await ui(page)).planWarn).not.toMatch(/収まらない/);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮は使わない（「◯MB以内」で、予圧縮の大きさ（.*）が目標の95%未満）/);   // 10MB の目標に対して小さい
  expect(d).toMatch(/変換を開始/);
});

test('「◯MB以内」で収まらない見込みなら、押す前に知らせる（押すことはできる）', async ({ page }) => {
  // 下限を 100kbps まで下げ、目標を小さくする。エンコーダーは下限ほど小さくできないので、予圧縮の結果は目標を超える
  await open(page, '?probe=on&res=1080&fps=source&mode=size&target=3&min1080=100');
  await pick(page, '1080p60-45s.mp4');
  await preDone(page);
  const u = await ui(page);
  expect(u.planWarn).toMatch(/^この設定では3MBに収まらない可能性があります（目安は約.+まで）。720pにするか、トリミングするか、「なるべく圧縮」を選択してください。/);
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

test('範囲が目標サイズに収まる長さの目安を超えていればトリミングの帯を黄色にし、予圧縮が済んだら「なるべく圧縮」の下に即出力の大きさを出す', async ({ page }) => {
  await open(page, '?probe=on&mode=size&target=3');   // 3MB なら、この動画は20秒ほどしか入らない
  await pick(page, '720p-60s.mp4');
  expect(await page.isVisible('#quickNote')).toBe(false);
  await preDone(page);
  const over = () => page.evaluate(() => document.getElementById('trimBox').classList.contains('is-over'));
  const fit = await pc(page, () => window.__compressor.state.plan.fitSec);
  expect(fit).toBeLessThan(60);
  expect(await over()).toBe(true);
  expect(await page.textContent('#planInfo')).toMatch(new RegExp('\n3MBに収めるなら約' + fit + '秒以内にトリミングしてね$'));
  // 即出力の大きさは「なるべく圧縮」での予想（範囲全体）
  const q = await pc(page, () => {
    const m = document.getElementById('modeQuality');
    m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true }));
    const est = window.__compressor.state.plan.estBytes;
    const s = document.getElementById('modeSize');
    s.checked = true; s.dispatchEvent(new Event('change', { bubbles: true }));
    return est;
  });
  const label = (q / 1000000).toFixed(1) + 'MB';
  expect(await page.textContent('#quickNote')).toBe(label + 'で即出力するよ');
  expect(await page.isVisible('#quickNote')).toBe(true);
  // 目安の長さより短くすれば、黄色をやめる
  await setTrim(page, 0, Math.max(1, fit - 2));
  expect(await over()).toBe(false);
  expect(await page.textContent('#planInfo')).toMatch(new RegExp('\n約' + fit + '秒まで3MBに収まるよ$'));
  // 圧縮中・圧縮後は出さない
  await compress(page);
  expect(await over()).toBe(false);
  expect(await page.isVisible('#quickNote')).toBe(false);
});

test('「◯MB以内」の予想は、範囲が目安の長さを超えるかどうかで計算を変えない（長くしたのに小さくならない）', async ({ page }) => {
  await open(page, '?probe=on&mode=size&target=3');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  const fit = await pc(page, () => window.__compressor.state.plan.fitSec);
  const at = async end => { await setTrim(page, 0, end); return pc(page, () => { const p = window.__compressor.state.plan; return { est: p.estBytes, over: p.probeOver }; }); };
  const inside = await at(fit), outside = await at(fit + 0.1);
  expect(inside.over).toBe(false);
  expect(outside.over).toBe(true);
  expect(outside.est).toBeGreaterThanOrEqual(inside.est);
  expect(await page.textContent('#planWarn')).toContain('（目安は約' + fit + '秒まで）');
});

test('予圧縮が範囲の終わりまで済んでいれば、切り出したときの大きさを1コマごとの表から正確に予想する', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  for (const [a, b] of [[0, 21.4], [10.3, 37.7]]) {   // 区切り（約2秒）の途中で始まり・終わる範囲
    await setTrim(page, a, b);
    const est = await pc(page, () => { const p = window.__compressor.state.plan; return p.exactEst ? p.estBytes : null; });
    expect(est).not.toBe(null);
    await compress(page);
    const size = await pc(page, () => window.__compressor.state.out.blob.size);
    expect(Math.abs(est - size) / size).toBeLessThan(0.003);   // 0.3%以内（実測では 0.01〜0.03%）
    await page.click('#runBtn');   // やり直す
  }
});

test('「◯MB以内」でも、予圧縮を切り出した大きさが目標の95%以上・目標未満なら、予圧縮をそのまま使い、選択肢の下に出す', async ({ page }) => {
  await open(page, '?probe=on&mode=size');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  await setTrim(page, 0, 30);
  const cut = await pc(page, () => window.__compressor.exactCutBytes(window.__compressor.state.plan, window.__compressor.precomp().pre));
  // 目標を、切り出した大きさがその 97% になるようにする
  const target = Math.ceil(cut / 0.97 / 100000) / 10;   // MB（小数1桁）
  await page.click('details.settings:not(#diagBox) > summary');
  await page.fill('#targetSize', String(target));
  await page.dispatchEvent('#targetSize', 'change');
  const label = (cut / 1000000).toFixed(1) + 'MBで即出力するよ';
  expect(await page.textContent('#quickNoteSize')).toBe(label);
  expect(await page.isVisible('#quickNoteSize')).toBe(true);
  expect(await page.textContent('#quickNote')).toBe(label);   // 「なるべく圧縮」の下にも同じ大きさ
  expect(await pc(page, () => window.__compressor.state.plan.estBytes)).toBe(cut);   // 予想の行も切り出したときの大きさ
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を使う（完了済み）/);
  expect(d).not.toMatch(/変換を開始/);
  const size = await pc(page, () => window.__compressor.state.out.blob.size);
  expect(size).toBeLessThan(target * 1000000);
  expect(await page.isVisible('#quickNoteSize')).toBe(false);   // 圧縮後は出さない

  // 目標を大きくして 95% 未満になると、使わずに普通に圧縮する（選択肢の下にも出さない）
  await page.click('#runBtn');   // やり直す
  await page.fill('#targetSize', String(Math.ceil(target * 1.2)));
  await page.dispatchEvent('#targetSize', 'change');
  expect(await page.isVisible('#quickNoteSize')).toBe(false);
  expect(await page.isVisible('#quickNote')).toBe(true);
});

test('VBR の指定を守らない端末（Android）でも、予圧縮は VBR のまま。押したら圧縮し直さずに切り出し、予想と合う', async ({ page }) => {
  // VBR のときだけ、指定の3倍のビットレートで書き出すエンコーダー（robustness.spec.js と同じ）
  await page.addInitScript(() => {
    const orig = VideoEncoder.prototype.configure;
    VideoEncoder.prototype.configure = function (c) {
      if (c.bitrateMode !== 'constant' && c.bitrate) c = Object.assign({}, c, { bitrate: c.bitrate * 3 });
      return orig.call(this, c);
    };
  });
  await open(page, '?probe=on&mode=quality&audio=off');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 0, 10);
  await preDone(page);
  expect((await diag(page)).match(/予圧縮を開始/g)).toHaveLength(1);
  expect(await pc(page, () => window.__compressor.precomp().pre.enc.bitrateMode)).toBe('variable');
  const est = await pc(page, () => window.__compressor.state.plan.estBytes);
  expect(est).toBeGreaterThan(1200 * 1000 * 10 / 8 * 2);   // 予想は実際に書き出した量（指定の約3倍）
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/予圧縮を使う（完了済み）/);
  expect(d).not.toMatch(/変換を開始/);
  expect(d).not.toMatch(/CBR/);
  const size = await pc(page, () => window.__compressor.state.out.blob.size);
  expect(Math.abs(size - est) / size).toBeLessThan(0.01);
});
