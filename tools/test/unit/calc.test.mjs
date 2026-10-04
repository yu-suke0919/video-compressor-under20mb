// 計算だけの関数（public/js/calc.js）の単体テスト。ブラウザなしで数秒で終わる（npm run test:unit）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePlan, resolutionCap, nextBitrate, audioBytesOf, preEstimate, exactCutBytes, fitSecOf, isOverTarget, preUseRatioOf, preKey,
  planSettings, describePlan, snapFps, estimateFps, fmtBytes, fmtDuration, fmtRate, fmtFps, even, resValue, isStandardRes, isSmallSource,
  noAudio, aacAudio, onOffWord, CUT_OVERHEAD_BASE, CUT_OVERHEAD_PER_SAMPLE, retryAfterSize, recoveryAfterFailure
} from '../../../public/js/calc.js';
import { SIZE_SAFETY, MB, DEFAULT_MIN_KBPS, MIN_KBPS_LIMITS, HIGH_FPS_FLOOR_FACTOR, MAX_ATTEMPTS, MAX_BG_RETRIES } from '../../../public/js/constants.js';

const MIN = { '480': Math.round(DEFAULT_MIN_KBPS['720'] * 1000 * 4 / 9), '720': DEFAULT_MIN_KBPS['720'] * 1000, '1080': DEFAULT_MIN_KBPS['1080'] * 1000 };
// 画面の設定（readSettings の結果）の代わり
function settings(over) {
  return Object.assign({ res: '720', mode: 'size', targetMB: 20, targetBytes: 20 * MB, halfFps: true, audio: true, minBitrate: MIN, preUseRatio: 0.8 }, over);
}
const meta = (w, h, fps, duration, extra) => Object.assign({ width: w, height: h, fps, duration, videoCodec: 'avc' }, extra);
const AAC = { mode: 'copy', bps: 128000 };
// 元のファイルの大きさ（元のビットレートの上限に当たらないよう、十分大きくする）
const BIG = 1e12;

test('makePlan：「◯MB以内」は目標の97%に収まるビットレート（音声の分を引く）', () => {
  const p = makePlan(meta(1920, 1080, 30, 60), { start: 0, end: 30 }, settings(), AAC, BIG);
  assert.equal(p.duration, 30);
  assert.equal(p.videoBitrate, Math.floor(20 * MB * 8 * SIZE_SAFETY / 30 - 128000));
  assert.equal(p.unreachable, false);
  assert.deepEqual([p.width, p.height], [1280, 720]);
  assert.equal(p.estBytes, Math.round((p.videoBitrate + 128000) * 30 / 8));
});

test('makePlan：下限を下回るなら下限で、目標に収められない（unreachable）', () => {
  const p = makePlan(meta(1920, 1080, 30, 600), { start: 0, end: 600 }, settings(), AAC, BIG);
  assert.equal(p.videoBitrate, MIN['720']);
  assert.equal(p.unreachable, true);
});

test('makePlan：なるべく圧縮は下限ビットレート。60fps のままなら下限を1.5倍にする', () => {
  const q = makePlan(meta(1920, 1080, 30, 60), { start: 0, end: 60 }, settings({ mode: 'quality' }), AAC, BIG);
  assert.equal(q.videoBitrate, MIN['720']);
  const q60 = makePlan(meta(1920, 1080, 60, 60), { start: 0, end: 60 }, settings({ mode: 'quality', halfFps: false }), AAC, BIG);
  assert.equal(q60.videoBitrate, Math.round(MIN['720'] * HIGH_FPS_FLOOR_FACTOR));
});

test('makePlan：元の動画のビットレートを超えない（HEVC は1.5倍まで）。元が下限より低ければ下限は当てはめない', () => {
  // 60秒・6MB（0.8Mbps）の動画
  const low = makePlan(meta(1280, 720, 30, 60), { start: 0, end: 60 }, settings({ mode: 'quality' }), noAudio(), 6 * MB);
  assert.equal(low.videoBitrate, Math.floor(6 * MB * 8 / 60));
  assert.equal(low.floorBitrate, MIN_KBPS_LIMITS[0] * 1000);
  const hevc = makePlan(meta(1280, 720, 30, 60, { videoCodec: 'hevc' }), { start: 0, end: 60 }, settings({ mode: 'quality' }), noAudio(), 6 * MB);
  assert.equal(hevc.videoBitrate, Math.min(MIN['720'], Math.floor(6 * MB * 8 / 60 * 1.5)));
});

test('makePlan：圧縮し直し（forcedVideoBitrate）は下限を下回らない', () => {
  const p = makePlan(meta(1920, 1080, 30, 60), { start: 0, end: 30 }, settings(), AAC, BIG, 100000);
  assert.equal(p.videoBitrate, MIN['720']);
  const q = makePlan(meta(1920, 1080, 30, 60), { start: 0, end: 30 }, settings(), AAC, BIG, 3000000.7);
  assert.equal(q.videoBitrate, 3000000);
});

test('makePlan：「30fps」は 30fps 以下になるまで元の fps を割る', () => {
  const fps = [24, 30, 50, 59.94, 60, 90, 120, 144].map(f =>
    Math.round(makePlan(meta(1280, 720, f, 10), { start: 0, end: 10 }, settings({ mode: 'quality' }), noAudio(), BIG).outFps * 100) / 100);
  assert.deepEqual(fps, [24, 30, 25, 29.97, 30, 30, 30, 28.8]);
  const keep = makePlan(meta(1280, 720, 120, 10), { start: 0, end: 10 }, settings({ mode: 'quality', halfFps: false }), noAudio(), BIG);
  assert.equal(keep.outFps, 60);   // 60fps より上は 60fps まで
});

test('resolutionCap と大きさ：短い辺を選んだ解像度に合わせ、拡大はせず、偶数にする', () => {
  assert.equal(resolutionCap(meta(3840, 2160), '720'), 720 / 2160);
  assert.equal(resolutionCap(meta(1280, 720), '1080'), 1);
  assert.equal(resolutionCap(meta(3840, 2160), 'source'), 1);
  assert.equal(resolutionCap(meta(1080, 1920), '480'), 480 / 1080);
  const odd = makePlan(meta(1279, 719, 30, 10), { start: 0, end: 10 }, settings({ res: 'source' }), noAudio(), BIG);
  assert.deepEqual([odd.width % 2, odd.height % 2], [0, 0]);
  assert.equal(even(1), 2);
});

test('nextBitrate：実際の大きさとの比で下げる（最低5%・最大70%）。10万bps未満なら null', () => {
  const plan = { targetBytes: 20 * MB, videoBitrate: 8000000, audioBitrate: 0, duration: 20 };
  assert.equal(nextBitrate(plan, 40 * MB, 0), Math.floor(8000000 * 0.485));
  assert.equal(nextBitrate(plan, 19.5 * MB, 0), Math.floor(8000000 * 0.95));   // ほぼ同じでも5%は下げる
  assert.equal(nextBitrate(plan, 200 * MB, 0), Math.floor(8000000 * 0.3));     // 下げすぎない
  assert.equal(nextBitrate({ targetBytes: 20 * MB, videoBitrate: 200000 }, 200 * MB, 0), null);
  assert.equal(audioBytesOf({ audioBitrate: 128000, duration: 10 }), 160000);
});

test('preEstimate：済んだ所は区切りごとの実測、まだの所は済んだ所の平均。指定が高いときは区切りごとに大きい方', () => {
  // 0〜20秒まで、2秒ごとに 250000バイト（= 1Mbps）。10〜14秒だけ 2倍（2Mbps）。音声 0
  const marks = [{ t: 0, bytes: 0 }];
  let total = 0;
  for (let t = 2; t <= 20; t += 2) { total += (t === 12 || t === 14) ? 500000 : 250000; marks.push({ t, bytes: total }); }
  const rec = { marks, plan: { audioBitrate: 0 } };
  assert.deepEqual(preEstimate({ trimStart: 10, trimEnd: 14 }, rec, 0), { videoBps: 2000000, covered: 1 });
  const half = preEstimate({ trimStart: 10, trimEnd: 30 }, rec, 0);
  assert.ok(Math.abs(half.covered - 0.5) < 1e-9);
  assert.equal(half.videoBps, Math.round((2000000 * 4 + 1000000 * 6 + 1200000 * 10) / 20));
  assert.equal(preEstimate({ trimStart: 0, trimEnd: 20 }, rec, 1500000).videoBps, Math.round((1500000 * 16 + 2000000 * 4) / 20));
  assert.equal(preEstimate({ trimStart: 0, trimEnd: 10 }, { marks: [{ t: 0, bytes: 0 }], plan: { audioBitrate: 0 } }, 0), null);
});

test('exactCutBytes：範囲の始まりより前のキーフレームから、範囲の終わりまでのコマを足す（音声は範囲だけ）', () => {
  // 映像：1秒ごとに1コマ、0・2・4秒がキーフレーム。音声：0.5秒ごと
  const video = [0, 1, 2, 3, 4, 5].map(t => ({ t, d: 1, s: t % 2 === 0 ? 1000 : 100, k: t % 2 === 0 }));
  const audio = Array.from({ length: 12 }, (_, i) => ({ t: i / 2, d: 0.5, s: 10 }));
  const rec = { done: true, samples: { video, audio } };
  // 3〜5秒：映像は 2秒のキーフレームから（2・3・4秒）、音声は 3〜5秒（4つ）
  assert.equal(exactCutBytes({ trimStart: 3, trimEnd: 5 }, rec), 1000 + 100 + 1000 + 40 + CUT_OVERHEAD_BASE + CUT_OVERHEAD_PER_SAMPLE * 7);
  // 範囲の終わりまで書き出せていなければ null
  assert.equal(exactCutBytes({ trimStart: 3, trimEnd: 8 }, { done: false, samples: { video, audio } }), null);
  assert.equal(exactCutBytes({ trimStart: 0, trimEnd: 1 }, { samples: null }), null);
});

test('収まる長さの目安と、収まらない見込みの判断', () => {
  const plan = { probed: false, targetBytes: 20 * MB, floorBitrate: 1200000, audioBitrate: 128000, mode: 'size', unreachable: false, estBytes: 10 * MB };
  assert.equal(fitSecOf(plan), Math.floor(20 * MB * 8 * SIZE_SAFETY / 1328000));
  assert.equal(fitSecOf(Object.assign({}, plan, { probed: true, fitSec: 42 })), 42);   // 先行圧縮で測れていれば、その値
  assert.equal(isOverTarget(plan, 0), false);
  assert.equal(isOverTarget(Object.assign({}, plan, { estBytes: 20 * MB }), 0), true);
  assert.equal(isOverTarget(Object.assign({}, plan, { unreachable: true }), 0), true);
  assert.equal(isOverTarget(Object.assign({}, plan, { probeOver: true }), 0), true);
  assert.equal(isOverTarget(Object.assign({}, plan, { unreachable: true }), 5 * MB), false);   // トリミングのみで収まる
  assert.equal(isOverTarget(Object.assign({}, plan, { estBytes: 25 * MB, preFits: true }), 0), false);   // 先行圧縮をそのまま使える
});

test('先行圧縮：許容する最小サイズの割合と、やり直すかを決める鍵', () => {
  assert.equal(preUseRatioOf({ preUseRatio: 0.9 }), 0.9);
  assert.equal(preUseRatioOf({}), 0.8);
  const pp = { width: 1280, height: 720, outFps: 29.97, videoBitrate: 1200000, audio: { mode: 'aac' }, audioBitrate: 128000 };
  assert.equal(preKey(pp), '1280x720@30/1200000/aac/128000');
});

test('計画を作り直すときの設定・診断情報の書き方', () => {
  const p = makePlan(meta(1920, 1080, 60, 60), { start: 1, end: 11 }, settings({ preUseRatio: 0.7 }), AAC, BIG);
  const again = makePlan(meta(1920, 1080, 60, 60), { start: 1, end: 11 }, planSettings(p), AAC, BIG);
  assert.deepEqual(again, p);
  assert.match(describePlan(p), /^720 1280x720 mode=size \d+kbps fps=60→30 audio=copy trim=1\.0-11\.0s$/);
});

test('fps の推定：よくある fps に寄せ、コマの間隔の中央値から求める', () => {
  assert.equal(snapFps(59.6), 60);
  assert.equal(snapFps(29.97), 30);
  assert.equal(snapFps(33.3), 33.3);
  assert.equal(snapFps(0), null);
  assert.equal(estimateFps([0, 1 / 30, 2 / 30, 3 / 30, 4 / 30, 5 / 30, 6 / 30]), 30);
  assert.equal(estimateFps([0, 1]), null);
});

test('表示の書式', () => {
  assert.equal(fmtBytes(999), '999 B');
  assert.equal(fmtBytes(19400000), '19.4 MB');
  assert.equal(fmtDuration(0.3), '0.3秒');
  assert.equal(fmtDuration(75), '1分15秒');
  assert.equal(fmtDuration(605), '10分05秒');
  assert.equal(fmtRate(1234567), '1.2Mbps');
  assert.equal(fmtRate(800000), '800kbps');
  assert.equal(fmtFps(29.97), '30fps');
});

test('設定の値の読み取り', () => {
  assert.equal(resValue('1080'), '1080');
  assert.equal(resValue('4k'), '720');
  assert.equal(isStandardRes(meta(1920, 1080)), true);
  assert.equal(isStandardRes(meta(886, 1920)), false);
  assert.equal(isSmallSource(meta(1280, 720)), true);
  assert.equal(isSmallSource(meta(1920, 1080)), false);
  assert.equal(onOffWord('ON'), true);
  assert.equal(onOffWord('0'), false);
  assert.equal(onOffWord('maybe'), undefined);
  assert.equal(noAudio().mode, 'none');
  assert.equal(aacAudio().mode, 'aac');
});

test('retryAfterSize：「◯MB以内」で目標以上なら、実際の大きさから求め直したビットレートで圧縮し直す', () => {
  const plan = { mode: 'size', targetBytes: 20 * MB, videoBitrate: 8000000, floorBitrate: 1200000, audioBitrate: 0, duration: 20 };
  assert.deepEqual(retryAfterSize(plan, 19 * MB, 0, 0, null), { kind: 'done' });                       // 目標未満
  assert.deepEqual(retryAfterSize(Object.assign({}, plan, { mode: 'quality' }), 30 * MB, 0, 0, null), { kind: 'done' });   // なるべく圧縮
  assert.deepEqual(retryAfterSize(plan, 40 * MB, 0, 0, null), { kind: 'retry', bitrate: Math.floor(8000000 * 0.485) });
  assert.deepEqual(retryAfterSize(plan, 40 * MB, MAX_ATTEMPTS - 1, 50 * MB, 50 * MB), { kind: 'done' });   // 回数の上限
  // 下限より下は下限に揃え、それ以上下げられなければやめる
  assert.deepEqual(retryAfterSize(plan, 200 * MB, 0, 0, null), { kind: 'retry', bitrate: Math.max(Math.floor(8000000 * 0.3), 1200000) });
  assert.deepEqual(retryAfterSize(Object.assign({}, plan, { videoBitrate: 1200000 }), 40 * MB, 0, 0, null), { kind: 'done' });
});

test('retryAfterSize：圧縮し直しても小さくならなければやめ、前の結果の方が小さければそれを使う', () => {
  const plan = { mode: 'size', targetBytes: 20 * MB, videoBitrate: 4000000, floorBitrate: 1200000, audioBitrate: 0, duration: 20 };
  // 前回 25MB → 今回 24.5MB（3%未満しか減っていない）
  assert.deepEqual(retryAfterSize(plan, 24.5 * MB, 1, 25 * MB, 25 * MB), { kind: 'floor', usePrevious: false });
  assert.deepEqual(retryAfterSize(plan, 26 * MB, 1, 25 * MB, 25 * MB), { kind: 'floor', usePrevious: true });
  assert.deepEqual(retryAfterSize(plan, 26 * MB, 1, 25 * MB, null), { kind: 'floor', usePrevious: false });
  // 十分に減っていれば、もう一度下げる
  assert.equal(retryAfterSize(plan, 22 * MB, 1, 25 * MB, 25 * MB).kind, 'retry');
});

test('recoveryAfterFailure：失敗・停止したあとのやり直し方（上から順に当てはまるもの）', () => {
  const base = { wentHidden: false, bgRetries: 0, index: 0, hasPrevious: false, engine: 'fast', audioMode: 'aac', stalled: false,
    audioRetried: false, audioError: false, compatAvailable: true };
  const r = over => recoveryAfterFailure(Object.assign({}, base, over));
  assert.equal(r({ wentHidden: true }), 'background');
  assert.equal(r({ wentHidden: true, bgRetries: MAX_BG_RETRIES }), 'compat');   // やり直しの上限を超えたら、ほかの理由で決める
  assert.equal(r({ index: 1, hasPrevious: true }), 'previous');
  assert.equal(r({ audioMode: 'copy', audioError: true }), 'audio');
  assert.equal(r({ audioMode: 'copy', audioError: true, audioRetried: true }), 'compat');
  assert.equal(r({ audioMode: 'copy', audioError: true, stalled: true }), 'compat');   // 停止は音声のせいとはみない
  assert.equal(r({ audioMode: 'aac', audioError: true }), 'compat');                   // 作り直した音声なら外さない
  assert.equal(r({ engine: 'copy' }), 'fast');
  assert.equal(r({}), 'compat');
  assert.equal(r({ compatAvailable: false }), 'error');
  assert.equal(r({ index: 1 }), 'error');                                             // 圧縮し直しの失敗（前の結果なし）は互換モードにしない
  assert.equal(r({ index: 1, stalled: true }), 'compat');
  assert.equal(r({ engine: 'compat', stalled: true }), 'stalled');
  assert.equal(r({ engine: 'compat' }), 'error');
});
