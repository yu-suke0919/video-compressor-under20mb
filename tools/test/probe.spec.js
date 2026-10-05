// 先行圧縮（動画を読み込んだら全体を裏で圧縮し、書き出した量でサイズを予想する。押したら先行圧縮をそのまま使う）
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

test('読み込んだら全体を先行圧縮し、実測の平均ビットレート・予想・目標サイズに収まる秒数を出す', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '1080p60-10s.mp4');   // 初期設定は 720p・30fps
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.marks.length > 2; });
  // 途中なら進み具合を出す（短い動画なので、見た時にはもう済んでいることもある）
  const mid = await pc(page, () => ({ info: document.getElementById('planInfo').textContent, done: window.__compressor.precomp().pre.done }));
  expect(mid.info).toMatch(mid.done ? /^現在の設定：720p\/30fps\/10秒\/.+\n→ [\d.]+MB（確定・先行圧縮済み）$/
    : /^現在の設定：720p\/30fps\/10秒\/.+\n→ [\d.]+MB（予想・先行圧縮 \d+%）$/);   // 20MBに収まるので3行目は出さない
  await preDone(page);
  const u = await ui(page);
  expect(u.planInfo).toMatch(/（確定・先行圧縮済み）$/);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮を開始 720 1280x720 mode=quality 1200kbps fps=60→30/);   // なるべく圧縮は下限ビットレート
  expect(d).toMatch(/先行圧縮が完了 /);
  expect(d).not.toMatch(/試し圧縮/);
  // 先行圧縮が済んだら、予想は書き出した量とほぼ同じ。表示のビットレートは実測の平均、秒数は収まる秒数の95%
  const r = await pc(page, () => { const p = window.__compressor.state.plan; return { bytes: window.__compressor.precomp().pre.bytes, est: p.estBytes, bps: p.expectedBps, audio: p.audioBitrate, fit: p.fitSec }; });
  expect(Math.abs(r.est - r.bytes) / r.bytes).toBeLessThan(0.02);
  // （表示のビットレートは予想の大きさから逆算した値で、目安の秒数は実測そのものから出すので、切り捨ての境目で1秒ずれることがある）
  expect(Math.abs(r.fit - Math.floor(20000000 * 8 / (r.bps + r.audio) * 0.95))).toBeLessThanOrEqual(1);
  const label = r.bps >= 1000000 ? (r.bps / 1000000).toFixed(1) + 'Mbps' : Math.round(r.bps / 1000) + 'kbps';
  expect(u.planInfo).toContain('/' + label + '\n→ ');
});

test('「なるべく圧縮」で、先行圧縮が済んでいれば、押したら範囲を切り出してすぐ結果にする', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  await setTrim(page, 10.7, 30.7);   // 「なるべく圧縮」では、範囲を変えても先行圧縮はやり直さない（始まりはキーフレームの間）
  expect((await ui(page)).planInfo).toMatch(/・先行圧縮済み）/);
  const est = await pc(page, () => window.__compressor.state.plan.estBytes);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮を使う（完了済み）/);
  expect(d).toMatch(/先行圧縮から切り出す準備/);
  expect(d).not.toMatch(/変換を開始/);   // 普通の圧縮はしていない
  expect(d).not.toMatch(/先行圧縮を中断（設定を変えた/);
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
  await page.waitForFunction(l => document.getElementById('outInfo').textContent.includes('/' + l), label, { timeout: 10000 });
});

test('先行圧縮の途中で押しても、範囲の始まりを越えていれば、範囲の終わりまで続けて使う', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 2.5, 20.5);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && !p.done && p.time >= 3; });
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮を使う（[\d.]+秒まで済み）/);
  expect(d).toMatch(/先行圧縮を範囲の終わりで止める/);
  expect(d).not.toMatch(/変換を開始/);
  const dur = await outDuration(page);
  expect(dur).toBeGreaterThanOrEqual(17.8);
  expect(dur).toBeLessThanOrEqual(18.2);
});

test('3 から戻って範囲を縮めたときは、範囲の終わりで止めた先行圧縮をそのまま使う。範囲を延ばして届かなければ最初からやり直す', async ({ page }) => {
  const starts = async () => ((await diag(page)).match(/先行圧縮を開始/g) || []).length;
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 2.5, 20.5);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && !p.done && p.time >= 3; });
  await compress(page);
  expect(await diag(page)).toMatch(/先行圧縮を範囲の終わりで止める/);
  await page.click('#runBtn');   // やり直す（3 の「← 戻る」と同じ）
  await setTrim(page, 5, 15);
  await page.waitForTimeout(2000);
  expect(await starts()).toBe(1);   // やり直さない
  expect((await ui(page)).planInfo).toMatch(/確定・先行圧縮済み/);
  await compress(page);
  const d = await diag(page);
  expect(d.match(/先行圧縮を使う/g)).toHaveLength(2);
  expect(d).not.toMatch(/変換を開始/);
  expect(Math.abs(await outDuration(page) - 10)).toBeLessThan(0.3);
  // 範囲を延ばして、止めたところより先が要るなら、最初からやり直す
  await page.click('#runBtn');
  await setTrim(page, 5, 50);
  await waitPc(page, () => (document.getElementById('diagOut').value.match(/先行圧縮を開始/g) || []).length >= 2, 10000);
});

test('「◯MB以内」で先行圧縮を使わずに圧縮しても、止めたところまでの先行圧縮は残し、3 から戻ったときの予想に使う', async ({ page }) => {
  await open(page, '?probe=on&mode=size&target=10');
  await pick(page, '1080p60-45s.mp4');   // 720p に縮小するので、トリミングのみにはならない
  await setTrim(page, 0, 4);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && !p.done && p.time >= 6; });
  await compress(page);
  const d0 = await diag(page);
  expect(d0).toMatch(/先行圧縮を中断（圧縮を開始/);
  await page.click('#runBtn');   // やり直す
  await setTrim(page, 0, 3);
  await page.waitForTimeout(2000);
  expect(((await diag(page)).match(/先行圧縮を開始/g) || []).length).toBe(1);   // やり直さない
  expect((await ui(page)).planInfo).toMatch(/先行圧縮済み/);
});

// Mediabunny の変換の準備（Conversion.init）を、条件に合うときだけ失敗させる
const failConversion = (page, kind) => page.addInitScript(k => {
  window.addEventListener('DOMContentLoaded', () => {
    const M = window.Mediabunny, init = M.Conversion.init;
    M.Conversion.init = function (o) {
      const pre = o && o.output && o.output.target instanceof M.StreamTarget;   // 先行圧縮だけ、書き出しを区切りごとに受け取る
      if ((k === 'pre' && pre) || (k === 'cut' && o && o.copy)) return Promise.reject(new Error(k + ' failed (test)'));
      return init.apply(this, arguments);
    };
  });
}, kind);

test('先行圧縮に失敗したら、同じ設定ではやり直さず、押したら普通に圧縮する', async ({ page }) => {
  await failConversion(page, 'pre');
  await open(page, '?probe=on&mode=quality');
  await pick(page, 'small-5mb.mp4');
  await waitPc(page, () => /先行圧縮に失敗/.test(document.getElementById('diagOut').value), 10000);
  await page.waitForTimeout(2000);
  expect((await diag(page)).match(/先行圧縮を開始/g)).toHaveLength(1);
  await setTrim(page, 0, 3);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮は使わない（先行圧縮に失敗した）/);
  expect(d).toMatch(/変換を開始/);
  expect((await ui(page)).hasOut).toBe(true);
});

test('先行圧縮から切り出せなかったら、普通に圧縮する', async ({ page }) => {
  await failConversion(page, 'cut');
  await open(page, '?probe=on&mode=quality');
  await pick(page, 'small-5mb.mp4');
  await preDone(page);
  await setTrim(page, 0, 3);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮を使う（完了済み）/);
  expect(d).toMatch(/先行圧縮を使えないため、普通に圧縮する（Error: cut failed \(test\)）/);
  expect(d).toMatch(/変換を開始/);
  expect(Math.abs(await outDuration(page) - 3)).toBeLessThan(0.3);
});

test('先行圧縮が範囲の始まりまで届いていなければ、使わずに範囲だけを圧縮する', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 50, 58);
  await waitPc(page, () => { const p = window.__compressor.precomp().pre; return p && p.job && p.time < 40; });
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮は使わない（範囲の始まりまで届いていない/);
  expect(d).toMatch(/先行圧縮を中断（圧縮を開始/);
  expect(d).toMatch(/変換を開始/);
  expect((await ui(page)).hasOut).toBe(true);
});

test('「◯MB以内」でも下限ビットレートで先行圧縮し、範囲を変えてもやり直さない。押したら普通に圧縮する', async ({ page }) => {
  await open(page, '?probe=on&mode=size&target=10');
  await pick(page, '720p-60s.mp4');
  await setTrim(page, 0, 30);
  await preDone(page);
  expect(await diag(page)).toMatch(/先行圧縮を開始 720 1280x720 mode=quality 1200kbps/);
  await setTrim(page, 0, 20);
  await page.waitForTimeout(2000);
  const d0 = await diag(page);
  expect(d0).not.toMatch(/先行圧縮を中断/);
  expect(d0.match(/先行圧縮を開始/g)).toHaveLength(1);
  // 範囲が「約◯秒まで」以内なら、収まらない注意は出さず、予想は狙うサイズ（目標の97%）までにする
  const r = await pc(page, () => { const p = window.__compressor.state.plan; return { est: p.estBytes, over: p.probeOver, fit: p.fitSec, dur: p.duration, probed: p.probed }; });
  expect(r.probed).toBe(true);
  expect(r.dur).toBeLessThanOrEqual(r.fit);
  expect(r.over).toBe(false);
  expect(r.est).toBeLessThanOrEqual(10000000 * 0.97);
  expect((await ui(page)).planWarn).not.toMatch(/収まらない/);
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮は使わない（「◯MB以内」で、先行圧縮の大きさ（.*）が許容する最小サイズ（目標の80%）未満）/);   // 10MB の目標に対して小さい
  expect(d).toMatch(/変換を開始/);
});

test('「◯MB以内」で収まらない見込みなら、押す前に知らせる（押すことはできる）', async ({ page }) => {
  // 下限を 100kbps まで下げ、目標を小さくする。エンコーダーは下限ほど小さくできないので、先行圧縮の結果は目標を超える
  await open(page, '?probe=on&res=1080&fps=source&mode=size&target=3&min1080=100');
  await pick(page, '1080p60-45s.mp4');
  await preDone(page);
  const u = await ui(page);
  expect(u.planWarn).toMatch(/^3MBに収まらない可能性があります（目安は約(.+)まで）。トリミングして短くするか、設定変更から低い解像度・fpsを選択してください。/);
  // 予想の行の目安と同じ秒数（先行圧縮で測ったビットレートから）
  const fit = u.planWarn.match(/目安は約(.+?)まで/)[1];
  expect(u.planInfo).toContain(fit + '以内で3MBに収まります。');
  expect(u.runDisabled).toBe(false);
});

test('「動画を選んだらすぐ圧縮」がオンのとき・probe=off のときは、先行圧縮しない', async ({ page }) => {
  await open(page, '?probe=on&auto=on');
  await pick(page, 'small-5mb.mp4');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 120000 });
  await page.waitForTimeout(2000);
  expect(await diag(page)).not.toMatch(/先行圧縮/);

  await open(page);   // probe=off
  await pick(page, '720p-60s.mp4');
  await page.waitForTimeout(2000);
  expect(await diag(page)).not.toMatch(/先行圧縮/);
});

test('範囲が目標サイズに収まる長さの目安を超えていればトリミングの帯を黄色にし、先行圧縮が済んだら「なるべく圧縮」の下に即出力の大きさを出す', async ({ page }) => {
  await open(page, '?probe=on&mode=size&target=3');   // 3MB なら、この動画は20秒ほどしか入らない
  await pick(page, '720p-60s.mp4');
  expect(await page.isVisible('#quickNote')).toBe(false);
  await preDone(page);
  const over = () => page.evaluate(() => document.getElementById('trimBox').classList.contains('is-over'));
  const fit = await pc(page, () => window.__compressor.state.plan.fitSec);
  expect(fit).toBeLessThan(60);
  expect(await over()).toBe(true);
  expect(await page.textContent('#planInfo')).toMatch(new RegExp('\n' + fit + '秒以内で3MBに収まります。$'));
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
  expect(await page.textContent('#planInfo')).not.toMatch(/収まります。/);   // 収まるなら3行目は出さない
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
  const inside = await at(fit), edge = await at(fit + 0.1);
  expect(inside.over).toBe(false);
  expect(edge.est).toBeGreaterThanOrEqual(inside.est);
  // 目安を少し超えただけなら、先行圧縮を切り出した大きさ（正確な値）が目標未満・80%以上で、押せば先行圧縮をそのまま使うので、
  // 収まらない注意は出さない。目標を超える長さなら注意を出す
  const outside = await at(Math.ceil(fit * 1.3));
  expect(outside.est).toBeGreaterThanOrEqual(edge.est);
  expect(outside.est).toBeGreaterThan(3000000);
  expect(await page.textContent('#planWarn')).toContain('（目安は約' + fit + '秒まで）');
});

test('先行圧縮が範囲の終わりまで済んでいれば、切り出したときの大きさを1コマごとの表から正確に予想する', async ({ page }) => {
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

test('「◯MB以内」でも、先行圧縮を切り出した大きさが目標の80%以上・目標未満なら、先行圧縮をそのまま使い、選択肢の下に出す', async ({ page }) => {
  await open(page, '?probe=on&mode=size');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  await setTrim(page, 0, 30);
  const cut = await pc(page, () => window.__compressor.exactCutBytes(window.__compressor.state.plan, window.__compressor.precomp().pre));
  // 目標を、切り出した大きさがその約85% になるようにする（以前の95%の条件では使わなかった大きさ）
  const target = Math.ceil(cut / 0.85 / 100000) / 10;   // MB（小数1桁）
  await page.evaluate(() => { document.querySelector('details.settings:not(#diagBox)').open = true; });   // 詳細設定（設定のステップでは開いたまま）
  await page.fill('#targetSize', String(target));
  await page.dispatchEvent('#targetSize', 'change');
  const label = (cut / 1000000).toFixed(1) + 'MBで即出力するよ';
  expect(await page.textContent('#quickNoteSize')).toBe(label);
  expect(await page.isVisible('#quickNoteSize')).toBe(true);
  expect(await page.textContent('#quickNote')).toBe(label);   // 「なるべく圧縮」の下にも同じ大きさ
  expect(await pc(page, () => window.__compressor.state.plan.estBytes)).toBe(cut);   // 予想の行も切り出したときの大きさ
  // 予想の行のビットレートは、「◯MB以内」の指定（範囲の長さで変わる）ではなく、切り出したときの実際の値（3 の結果と同じ）
  const rate = bps => bps >= 1000000 ? (bps / 1000000).toFixed(1) + 'Mbps' : Math.round(bps / 1000) + 'kbps';
  const p = await pc(page, () => { const x = window.__compressor.state.plan; return { spec: x.videoBitrate, real: x.expectedBps }; });
  expect(rate(p.spec)).not.toBe(rate(p.real));
  expect((await ui(page)).planInfo).toMatch(new RegExp('/' + rate(p.real) + '\\n→ [\\d.]+MB（確定・先行圧縮済み）$'));
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮を使う（完了済み）/);
  expect(d).not.toMatch(/変換を開始/);
  const size = await pc(page, () => window.__compressor.state.out.blob.size);
  expect(size).toBeLessThan(target * 1000000);
  expect(await page.isVisible('#quickNoteSize')).toBe(false);   // 圧縮後は出さない

  // 目標を大きくして 80% 未満になると、使わずに普通に圧縮する（選択肢の下にも出さない）
  await page.click('#runBtn');   // やり直す
  await page.fill('#targetSize', String(Math.ceil(target * 1.3)));
  await page.dispatchEvent('#targetSize', 'change');
  expect(await page.isVisible('#quickNoteSize')).toBe(false);
  expect(await page.isVisible('#quickNote')).toBe(true);

  // 詳細設定の「許容する最小サイズ」を 90% にすると、約85% では使わない（70% にすると使う）
  await page.fill('#targetSize', String(target));
  await page.dispatchEvent('#targetSize', 'change');
  expect(await page.isVisible('#quickNoteSize')).toBe(true);
  await page.fill('#preUse', '90');
  await page.dispatchEvent('#preUse', 'change');
  expect(await page.isVisible('#quickNoteSize')).toBe(false);
  expect(await page.textContent('#preUseLabel')).toBe(String(Math.round(target * 0.9 * 100) / 100) + ' MB');
  await page.fill('#preUse', '70');
  await page.dispatchEvent('#preUse', 'change');
  expect(await page.isVisible('#quickNoteSize')).toBe(true);
});

test('VBR の指定を守らない端末（Android）でも、先行圧縮は VBR のまま。押したら圧縮し直さずに切り出し、予想と合う', async ({ page }) => {
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
  expect((await diag(page)).match(/先行圧縮を開始/g)).toHaveLength(1);
  expect(await pc(page, () => window.__compressor.precomp().pre.enc.bitrateMode)).toBe('variable');
  const est = await pc(page, () => window.__compressor.state.plan.estBytes);
  expect(est).toBeGreaterThan(1200 * 1000 * 10 / 8 * 2);   // 予想は実際に書き出した量（指定の約3倍）
  await compress(page);
  const d = await diag(page);
  expect(d).toMatch(/先行圧縮を使う（完了済み）/);
  expect(d).not.toMatch(/変換を開始/);
  expect(d).not.toMatch(/CBR/);
  const size = await pc(page, () => window.__compressor.state.out.blob.size);
  expect(Math.abs(size - est) / size).toBeLessThan(0.01);
});

test('指定ビットレートを下げても先行圧縮の大きさが変わらなければ、「この端末ではこれ以上ビットレートを下げられないみたいです。」と出す', async ({ page }) => {
  // 3Mbps より下げられないエンコーダー（Android の実機では約2.4Mbps より下がらなかった）
  await page.addInitScript(() => {
    const orig = VideoEncoder.prototype.configure;
    VideoEncoder.prototype.configure = function (c) { return orig.call(this, c.bitrate ? Object.assign({}, c, { bitrate: Math.max(c.bitrate, 3000000) }) : c); };
  });
  await open(page, '?probe=on&mode=quality&audio=off');
  await pick(page, '720p-60s.mp4');
  await preDone(page);
  expect((await ui(page)).planWarn).not.toContain('下げられない');
  await page.evaluate(() => { document.querySelector('details.settings:not(#diagBox)').open = true; });   // 詳細設定（設定のステップでは開いたまま）
  await page.fill('#minRate720', '800');   // 1200kbps → 800kbps
  await page.waitForFunction(() => (document.getElementById('diagOut').value.match(/先行圧縮が完了/g) || []).length >= 2, null, { timeout: 120000 });
  expect(await diag(page)).toMatch(/指定ビットレートを下げても小さくならない（1\.2Mbps .+ → 800kbps .+）/);
  expect((await ui(page)).planWarn).toContain('この端末ではこれ以上ビットレートを下げられないみたいです。');

  // 「◯MB以内」で収まらないときは、指定ビットレートを下げる案内の代わりに出す
  await page.evaluate(() => { const s = document.getElementById('modeSize'); s.checked = true; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.fill('#targetSize', '3');
  const w = (await ui(page)).planWarn;
  expect(w).toMatch(/3MBに収まらない可能性があります（目安は約\d+秒まで）。/);
  expect(w).toContain('この端末ではこれ以上ビットレートを下げられないみたいです。');
  expect(w).not.toContain('指定ビットレートを引き下げてください');
});

test('前の動画の先行圧縮は、比べるための数字だけを残し、新しい動画を選んだら消す（動画や書き出したデータを持ち続けない）', async ({ page }) => {
  await open(page, '?probe=on&mode=quality');
  await pick(page, 'small-5mb.mp4');
  await preDone(page);
  const last = await page.evaluate(() => {
    const l = window.__compressor.precomp().last;
    return l && { keys: Object.keys(l).sort(), hasBlob: Object.values(l).some(v => v instanceof Blob || Array.isArray(v)) };
  });
  expect(last.hasBlob).toBe(false);
  expect(last.keys).toEqual(['audioBitrate', 'audioMode', 'bytes', 'fileId', 'height', 'outFps', 'videoBitrate', 'width']);
  // 読み込めない動画を選んでも、前の動画の記録は消す
  await pick(page, 'text.mp4');
  expect(await page.evaluate(() => window.__compressor.precomp().last)).toBe(null);
});

