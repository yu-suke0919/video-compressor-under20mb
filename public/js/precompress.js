// 先行圧縮：動画を読み込んだら裏で全体を圧縮し、サイズを予想する。押したら範囲を切り出してすぐ結果にする

import { CANCELLED, M, MIN_SHRINK } from './constants.js';
import { describePlan, exactCutBytes, fmtBytes, fmtRate, makePlan, planSettings, preKey, preUseRatioOf } from './calc.js';
import { fragmentsBlob, parseFragments } from './fmp4.js';
import { els } from './dom.js';
import { state } from './state.js';
import { errText, isCancel, log, newJob, secondsSince, stopJob, throwIfCancelled } from './util.js';
import { MSG_NO_H264, closeInput, openInput, outputTags, withInput } from './media.js';
import { isCompressed, refresh } from './view.js';
import { convertFast, fastOptions, pickFastEncoding, runConversion } from './fast.js';

// ---------------------------------------------------------------- 先行圧縮（サイズの予想と、先に済ませておく圧縮）
// 端末のエンコーダーは、映像によって指定のビットレートを守らない（重い映像では下げきれず多く使い、軽い映像では使い切らない。
// iPhone の 1080p60 のゲーム映像で、2.7Mbps・4.05Mbps のどちらを指定しても約7.5Mbps になった）。そこで、実際に圧縮して測る。
// 動画を読み込んだら（設定を変えたときも）、範囲に関係なく動画の最初から最後までを裏で圧縮し（先行圧縮）、
// 書き出したデータの量から、ビットレートとサイズの予想を出す。先行圧縮は、モードにかかわらず決めた下限ビットレートで行う
// （範囲の長さでビットレートを変えると、範囲を変えるたびにやり直しになるため）。
// 設定を変えずに「圧縮する」を押したら、範囲の始まりまで届いていれば、範囲の終わりまで続けて、範囲を切り出して使う。
// 「◯MB以内」では、切り出した大きさが許容する最小サイズ（既定は目標の80%）以上・目標未満のときだけ使い、それ以外は予想と注意にだけ使って普通に圧縮する
// 予想の当てはめと表示は estimate.js、書き出しの読み取りは fmp4.js
var PRE_DELAY_MS = 1500;           // 設定を変えてから先行圧縮をやり直すまで待つ（続けて変えたときに何度もやり直さない）
var PRE_FRAGMENT_SEC = 1;          // 先行圧縮の書き出しの区切りの最短の長さ（実際はキーフレームごと＝約2秒ごとに書き出される）
var PRE_TAIL_SEC = 1;              // 範囲の終わりからこれだけ先まで書き出せたら、範囲の終わりまで書き出せたとみる
// URL に probe=off があれば先行圧縮しない（自動テスト・自己テストで、本番の圧縮だけを確かめるため）
var PROBE_OFF = /[?&]probe=off\b/.test(location.search);
// pre … { file, key, plan, enc, job, chunks, bytes, marks: [{ t: 書き出したときの進み（秒）, bytes: そこまでの量 }],
//         time: 進み（秒）, done, failed, audioLost, t0 }
export var pre = null, preTimer = null;

// 先行圧縮から範囲を切り出したときの大きさ（exactCutBytes。数えられなければ null。表が壊れていても例外にしない）
export function cutBytes(plan, rec) {
  try { return exactCutBytes(plan, rec); } catch (e) { return null; }
}

function canProbe() {
  return !PROBE_OFF && !!(state.file && state.meta) && state.engine === 'fast' && !state.running && !state.busy && !isCompressed() &&
    !els.autoRun.checked && document.visibilityState === 'visible';
}
// 先行圧縮の計画（動画全体・今の解像度とfpsと音声・下限ビットレート）
export function prePlan(plan) {
  return makePlan(state.meta, { start: 0, end: state.meta.duration }, Object.assign(planSettings(plan), { mode: 'quality' }),
    plan.audio, state.file.size);
}

// 今の設定の先行圧縮がまだなら始める。設定が変わったら止めて、少し待ってからやり直す
export function scheduleProbe() {
  if (!canProbe() || !state.plan) return;
  var file = state.file;
  var key = preKey(prePlan(state.plan));
  // 圧縮を始めて途中で止めた先行圧縮も、範囲の終わりまで届いていれば残す（3 から戻って範囲を変えたときに使う）。
  // 範囲を延ばして届かなくなったら、最初からやり直す
  if (pre && pre.file === file && pre.key === key && (pre.job || pre.failed || preReady(state.plan))) return;
  if (pre && pre.job) stopPre('設定を変えた');
  if (preTimer && preTimer.key === key) return;
  if (preTimer) clearTimeout(preTimer.id);
  var delay = pre && pre.file === file ? PRE_DELAY_MS : 0;
  preTimer = { key: key, id: setTimeout(function () {
    preTimer = null;
    if (!canProbe() || !state.plan) return;
    var pp = prePlan(state.plan);
    if (preKey(pp) === key) startPre(pp, key); else scheduleProbe();
  }, delay) };
}

// 先行圧縮。書き出しは区切りごと（fragmented MP4）に受け取って持っておく（途中で止めても、区切りまでは読める）
function startPre(pp, key) {
  var file = state.file;
  var rec = pre = { file: file, key: key, plan: pp, job: newJob(), chunks: [], bytes: 0, marks: [{ t: 0, bytes: 0 }],
    time: 0, done: false, failed: false, audioLost: false, t0: Date.now() };
  var job = rec.job;
  var writable = new WritableStream({
    write: function (chunk) {
      rec.chunks.push(chunk);
      var end = chunk.position + chunk.data.byteLength;
      if (end <= rec.bytes) return;
      rec.bytes = end;
      // 同じ進みのうちに続けて書き出された分（1つの区切りが何回かに分けて届いたとき）は、まとめる
      var last = rec.marks[rec.marks.length - 1];
      if (last.t === rec.time && rec.marks.length > 1) last.bytes = end;
      else rec.marks.push({ t: rec.time, bytes: end });
      // 表を読めなければ、以後は読まず、割合で数える予想のままにする
      if (!rec.parseFailed) { try { parseFragments(rec); } catch (e) { rec.parseFailed = true; rec.samples = null; } }
      if (pre === rec && state.file === file && !state.running) refresh();   // 予想を出し直す
    }
  });
  var output = new M.Output({
    format: new M.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: PRE_FRAGMENT_SEC }),
    target: new M.StreamTarget(writable)
  });
  log('先行圧縮を開始 ' + describePlan(pp));
  pickFastEncoding(pp).then(function (enc) {
    if (!enc) throw new Error(MSG_NO_H264);
    rec.enc = enc;
    throwIfCancelled(job);
    return runConversion({
      output: output,
      options: function (input, out) { return fastOptions(pp, enc, input, out); },
      onReady: function (conv, audioLost) { rec.audioLost = audioLost; },
      invalidMessage: '先行圧縮できない動画です'
    }, pp, function (p) { rec.time = p * pp.duration; }, job);
  }).then(function () {
    rec.time = pp.duration;
    rec.marks[rec.marks.length - 1].t = pp.duration;   // 最後の書き出しは、動画の終わりまでの分
    rec.done = true;
    log('先行圧縮が完了 ' + fmtBytes(rec.bytes) + '（' + secondsSince(rec.t0) + '）');
    checkDeviceFloor(rec);
  }, function (err) {
    if (isCancel(job, err)) return;
    rec.failed = true;   // 同じ設定では何度もやり直さない
    log('先行圧縮に失敗 ' + errText(err));
  }).then(function () {
    if (rec.job === job) rec.job = null;
    if (pre === rec && state.file === file && !state.running) refresh();
  });
}
// 同じ動画・同じ解像度とfpsと音声で、指定ビットレートを下げて先行圧縮をやり直したのに、前回より MIN_SHRINK 以上
// 小さくならなければ、この端末ではそれ以上下げられないとみる（rec.floorHit。予想の注意に出す）
//   lastDonePre … 前回の先行圧縮で比べるのに要る数字だけ（動画や書き出したデータは持たない。新しい動画を選んだら消す）
export var lastDonePre = null;
function preSummary(rec) {
  var p = rec.plan;
  return {
    fileId: state.fileId, bytes: rec.bytes, width: p.width, height: p.height, outFps: Math.round(p.outFps),
    audioMode: p.audio.mode, audioBitrate: p.audioBitrate, videoBitrate: p.videoBitrate
  };
}
function checkDeviceFloor(rec) {
  if (rec.file !== state.file) return;
  var prev = lastDonePre, b = preSummary(rec);
  lastDonePre = b;
  if (!prev || prev.fileId !== b.fileId) return;
  var same = prev.width === b.width && prev.height === b.height && prev.outFps === b.outFps &&
    prev.audioMode === b.audioMode && prev.audioBitrate === b.audioBitrate;
  if (!same || !(b.videoBitrate < prev.videoBitrate)) return;
  if (b.bytes > prev.bytes * (1 - MIN_SHRINK)) {
    rec.floorHit = true;
    log('指定ビットレートを下げても小さくならない（' + fmtRate(prev.videoBitrate) + ' ' + fmtBytes(prev.bytes) + ' → ' +
      fmtRate(b.videoBitrate) + ' ' + fmtBytes(b.bytes) + '）');
  }
}
// 別の動画を選んだら、先行圧縮を止めて、前の動画の先行圧縮と比べるための数字も消す
export function forgetPre() {
  stopPre();
  pre = null;
  lastDonePre = null;
}
// keep … 止めたところまでのデータを残して使う（圧縮を始めたとき・範囲の終わりまで書き出せたとき）。
//         画面を離れたとき（iPhone は裏に回ると書き出しを壊す）・設定を変えたときは残さない（戻ったら最初からやり直す）
export function stopPre(why, keep) {
  if (preTimer) { clearTimeout(preTimer.id); preTimer = null; }
  var job = pre && pre.job;
  if (!job) return Promise.resolve();
  pre.job = null;
  pre.kept = !!keep;
  if (why) log('先行圧縮を中断（' + why + '・' + pre.time.toFixed(1) + '秒まで）');
  stopJob(job, CANCELLED);
  return job.stopped || Promise.resolve();
}

// 先行圧縮が、この範囲について済んでいるか（全体が済んだか、圧縮を始めて止めたところまでで範囲の終わりまで届いている）
export function preReady(plan) {
  if (!pre || !plan) return false;
  if (pre.done) return true;
  if (!pre.kept || pre.job) return false;
  var need = Math.min(pre.plan.duration, plan.trimEnd + PRE_TAIL_SEC);   // finishFromPrecompress と同じ
  return pre.marks[pre.marks.length - 1].t >= need;
}
// 「なるべく圧縮」で、先行圧縮が今の設定と同じで、範囲の始まりまで届いていれば、その先行圧縮（使えなければ null）
export function precompressUsable(plan) {
  return precompressWhyNot(plan) ? null : pre;
}
export function precompressWhyNot(plan) {
  if (!pre || pre.file !== state.file) return '先行圧縮していない';
  if (pre.failed) return '先行圧縮に失敗した';
  if (pre.key !== preKey(prePlan(plan))) return '設定が変わった';
  if (!pre.done && !pre.job && !preReady(plan)) return '先行圧縮を途中で止めた（' + pre.time.toFixed(1) + '秒まで）';
  if (!pre.done && pre.time < plan.trimStart) return '範囲の始まりまで届いていない（' + pre.time.toFixed(1) + '秒）';
  if (plan.mode === 'size') {
    // 「◯MB以内」は、先行圧縮が範囲の終わりまで済んでいて、切り出した大きさが目標の80%以上・目標未満のときだけ
    var cut = cutBytes(plan, pre);
    if (!cut) return '「◯MB以内」で、先行圧縮が範囲の終わりまで済んでいない';
    if (cut >= plan.targetBytes) return '「◯MB以内」で、先行圧縮の大きさ（' + fmtBytes(cut) + '）が目標以上';
    if (cut < plan.targetBytes * preUseRatioOf(plan)) {
      return '「◯MB以内」で、先行圧縮の大きさ（' + fmtBytes(cut) + '）が許容する最小サイズ（目標の' + Math.round(preUseRatioOf(plan) * 100) + '%）未満';
    }
  }
  return '';
}
// 先行圧縮を範囲の終わりまで続け、範囲を切り出して結果にする（先行圧縮に失敗したら、普通に圧縮する）
export function finishFromPrecompress(rec, plan, onProgress, job) {
  var span = Math.max(0.1, plan.trimEnd - plan.trimStart);
  var need = Math.min(rec.plan.duration, plan.trimEnd + PRE_TAIL_SEC);
  job.hooks.push(function () { return stopPre(); });   // キャンセル・停止したら先行圧縮も止める
  return new Promise(function (resolve, reject) {
    (function wait() {
      if (job.cancelled) return reject(new Error(CANCELLED));
      if (rec.failed) return reject(new Error('先行圧縮に失敗'));
      if (rec.done || rec.marks[rec.marks.length - 1].t >= need) return resolve();
      if (!rec.job) return reject(new Error('先行圧縮が止まった'));
      onProgress(Math.max(0, Math.min(0.95, (rec.time - plan.trimStart) / span)));
      setTimeout(wait, 200);
    })();
  }).then(function () {
    throwIfCancelled(job);
    var stopping = rec.done ? null : stopPre(null, true);   // 範囲の終わりまで書き出せたので、残りは今は要らない（3 から戻ったときのために残す）
    if (!rec.done) log('先行圧縮を範囲の終わりで止める（' + rec.time.toFixed(1) + '秒）');
    return Promise.resolve(stopping);
  }).then(function () {
    throwIfCancelled(job);
    var input = openInput(fragmentsBlob(rec));
    job.hooks.push(function () { closeInput(input); });
    return runConversion({
      input: input,
      options: function (inp, output) {
        return {
          input: inp, output: output, video: {},
          audio: plan.audio.mode === 'none' ? { discard: true } : {},
          trim: { start: plan.trimStart, end: plan.trimEnd },
          // 始まりはキーフレーム（最大2秒前）から入れる。範囲の始まりより前は、エディットリストで再生しないようにする
          // （Mediabunny が書く。再生される始まりと長さは範囲どおり）
          copy: { mode: 'forced', boundaryPolicy: 'expand', shiftTolerance: Infinity },
          tags: outputTags, showWarnings: false
        };
      },
      prepareLog: function () { return '先行圧縮から切り出す準備'; },
      invalidMessage: '先行圧縮から切り出せませんでした'
    }, plan, function (p) { onProgress(0.95 + 0.05 * p); }, job).then(function (res) {
      closeInput(input);
      return checkCutDuration(res, span).then(function () {
        res.rateMode = rec.enc.bitrateMode;
        res.audioDropped = rec.audioLost;
        return res;
      });
    });
  }).catch(function (err) {
    if (isCancel(job, err)) throw err;
    log('先行圧縮を使えないため、普通に圧縮する（' + errText(err) + '）');
    return convertFast(plan, onProgress, job);
  });
}
// 切り出した動画が範囲より短ければ失敗にする（先行圧縮の書き出しが範囲の終わりまで届いていなかった）
function checkCutDuration(res, span) {
  return blobDuration(res.blob).then(function (d) {
    if (d < span - 0.25) throw new Error('切り出した動画が短い（' + d.toFixed(2) + '秒／' + span.toFixed(2) + '秒）');
  });
}
// 書き出した動画の長さ（秒）
export function blobDuration(blob) {
  return withInput(blob, function (input) { return input.computeDuration(); });
}
