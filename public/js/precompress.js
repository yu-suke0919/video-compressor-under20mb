// 先行圧縮：動画を読み込んだら裏で全体を圧縮し、サイズを予想する。押したら範囲を切り出してすぐ結果にする

import { CANCELLED, DISCORD_FREE_BYTES, INPUT_FORMATS, M, MIN_SHRINK } from './constants.js';
import { describePlan, exactCutBytes, fitSecOf, fmtBytes, fmtDuration, fmtFps, fmtRate, isOverTarget, makePlan, planSettings, preEstimate, preKey, preUseRatioOf } from './calc.js';
import { els } from './dom.js';
import { state } from './state.js';
import { errText, isCancel, log, newJob, secondsSince, show, stopJob, throwIfCancelled } from './util.js';
import { MSG_NO_H264, outputTags } from './media.js';
import { currentPlan } from './plan.js';
import { isCompressed, refresh } from './view.js';
import { convertFast, copyLabel, fastOptions, pickFastEncoding, runConversion, trimOnlyEstimate } from './fast.js';

// ---------------------------------------------------------------- 先行圧縮（サイズの予想と、先に済ませておく圧縮）
// 端末のエンコーダーは、映像によって指定のビットレートを守らない（重い映像では下げきれず多く使い、軽い映像では使い切らない。
// iPhone の 1080p60 のゲーム映像で、2.7Mbps・4.05Mbps のどちらを指定しても約7.5Mbps になった）。そこで、実際に圧縮して測る。
// 動画を読み込んだら（設定を変えたときも）、範囲に関係なく動画の最初から最後までを裏で圧縮し（先行圧縮）、
// 書き出したデータの量から、ビットレートとサイズの予想を出す。先行圧縮は、モードにかかわらず決めた下限ビットレートで行う
// （範囲の長さでビットレートを変えると、範囲を変えるたびにやり直しになるため）。
// 設定を変えずに「圧縮する」を押したら、範囲の始まりまで届いていれば、範囲の終わりまで続けて、範囲を切り出して使う。
// 「◯MB以内」では、切り出した大きさが目標の80%以上・目標未満のときだけ使い、それ以外は予想と注意にだけ使って普通に圧縮する
export var FIT_MARGIN = 0.95;             // 「約◯秒まで◯MBに収まるよ」は、実測の平均で収まる秒数のこの割合を出す
export var PRE_DELAY_MS = 1500;           // 設定を変えてから先行圧縮をやり直すまで待つ（続けて変えたときに何度もやり直さない）
export var PRE_FRAGMENT_SEC = 1;          // 先行圧縮の書き出しの区切りの最短の長さ（実際はキーフレームごと＝約2秒ごとに書き出される）
export var PRE_TAIL_SEC = 1;              // 範囲の終わりからこれだけ先まで書き出せたら、範囲の終わりまで書き出せたとみる
// URL に probe=off があれば先行圧縮しない（自動テスト・自己テストで、本番の圧縮だけを確かめるため）
export var PROBE_OFF = /[?&]probe=off\b/.test(location.search);
// pre … { file, key, plan, enc, job, chunks, bytes, marks: [{ t: 書き出したときの進み（秒）, bytes: そこまでの量 }],
//         time: 進み（秒）, done, failed, audioLost, t0 }
export var pre = null, preTimer = null;

// 先行圧縮から範囲を切り出したときの大きさ（exactCutBytes。数えられなければ null。表が壊れていても例外にしない）
export function cutBytes(plan, rec) {
  try { return exactCutBytes(plan, rec); } catch (e) { return null; }
}

export function canProbe() {
  return !PROBE_OFF && !!(state.file && state.meta) && state.engine === 'fast' && !state.running && !state.busy && !isCompressed() &&
    !els.autoRun.checked && document.visibilityState === 'visible';
}
// 先行圧縮の計画（動画全体・今の解像度とfpsと音声・下限ビットレート）
export function prePlan(plan) {
  return makePlan(state.meta, { start: 0, end: state.meta.duration }, Object.assign(planSettings(plan), { mode: 'quality' }),
    plan.audio, state.file.size);
}
// 計画に先行圧縮の予想を当てはめる（今の設定の先行圧縮がまだ何も書き出していなければ、そのまま）
//   probed      … 先行圧縮の予想を使った
//   expectedBps … 映像のビットレートの予想（予想のサイズから求める）
//   fitSec      … 目標サイズに収まる秒数の目安（下限ビットレートでの実測の平均で収まる秒数の95%）
//   probeOver   … 「◯MB以内」で、範囲が fitSec より長い（目標サイズに収まらない可能性がある。押せなくはしない）
//   preFits     … 先行圧縮を切り出した大きさ（正確な値）が目標サイズ未満（「◯MB以内」では、押せば先行圧縮をそのまま使えるとき）。
//                 目安（fitSec）より長くても収まるので、収まらない注意・トリミングの促し・黄色の帯は出さない
export function withEstimate(plan) {
  if (state.engine !== 'fast' || !pre || pre.file !== state.file || pre.key !== preKey(prePlan(plan))) return plan;
  var floorEst = preEstimate(plan, pre, 0);
  if (!floorEst) return plan;
  var p = Object.assign({}, plan, { probed: true });
  var floorTotal = floorEst.videoBps + p.audioBitrate;
  var floorBytes = Math.round(floorTotal * p.duration / 8);
  p.fitSec = floorTotal > 0 ? Math.floor(p.targetBytes * 8 / floorTotal * FIT_MARGIN) : 0;
  if (plan.mode === 'size') {
    // 「◯MB以内」：収まるかどうかは、画面に出す目安（「約◯秒まで」）で決める（トリミングの帯の黄色と同じ）。
    // 予想は、区切りごとの「指定」と「下限での実測」の大きい方（下限での実測より小さくはしない）。
    // 狙うサイズ（目標の97%）で頭打ちにはしない（超える見込みなら、そのまま出す。押せば、圧縮し直しで目標に寄せる）
    p.probeOver = !p.unreachable && p.duration > p.fitSec;
    var setBytes = Math.round((preEstimate(plan, pre, plan.videoBitrate).videoBps + p.audioBitrate) * p.duration / 8);
    p.estBytes = Math.max(floorBytes, setBytes);
    // 押したら先行圧縮をそのまま使う大きさ（目標の80%以上・目標未満）なら、切り出したときの大きさを予想にする
    var cut = cutBytes(plan, pre);
    if (cut && cut >= p.targetBytes * preUseRatioOf(p) && cut < p.targetBytes) { p.estBytes = cut; p.exactEst = true; }
  } else {
    // なるべく圧縮：先行圧縮が範囲の終わりまで済んでいれば、切り出したときの大きさ（1コマごとの表から数える）
    p.probeOver = false;
    var exact = cutBytes(plan, pre);
    p.estBytes = exact || floorBytes;
    p.exactEst = !!exact;
  }
  p.preFits = !!p.exactEst && p.estBytes < p.targetBytes && (plan.mode !== 'size' || !precompressWhyNot(p));
  // 「◯MB以内」で先行圧縮をそのまま使えるなら、下限ビットレートの計算では収まらなくても（エンコーダーが下限ちょうどに
  // 収めた軽い映像では、目標の97%を下限の大きさが超えることがある）押せるようにする
  if (p.preFits && plan.mode === 'size') { p.unreachable = false; p.probeOver = false; }
  p.deviceFloor = !!pre.floorHit;
  p.expectedBps = Math.max(0, Math.round(p.estBytes * 8 / p.duration - p.audioBitrate));
  p.overDiscord = p.estBytes > DISCORD_FREE_BYTES;
  return p;
}
export function planParts(plan, trimEst) {
  // ビットレートは、指定するビットレート（エンコーダーが実際に使う量は、予想の大きさに入っている）
  var line1 = '現在の設定：' + Math.min(plan.width, plan.height) + 'p/' + fmtFps(plan.outFps) + '/' + fmtDuration(plan.duration) + '/' +
    (trimEst ? '再圧縮なし' : fmtRate(plan.videoBitrate));
  var est = trimEst || plan.estBytes;
  var tag;
  if (trimEst) tag = '予想・' + copyLabel(plan);
  else {
    var sure = !!(plan.probed && pre && preReady(plan) && plan.exactEst && !precompressWhyNot(plan));
    var probe = plan.probed ? (preReady(plan) ? '先行圧縮済み' : '先行圧縮 ' + Math.floor(pre.time / pre.plan.duration * 100) + '%')
      : pre && pre.file === state.file && (pre.job || preTimer) ? '先行圧縮中' : '';
    tag = (sure ? '確定' : '予想') + (probe ? '・' + probe : '');
  }
  var parts = { line1: line1, size: fmtBytes(est).replace(' ', ''), tag: '（' + tag + '）', over: false, line3: '' };
  // 目標サイズに収まらない見込みのとき（目安は 2 の注意と同じ計算）
  if (isOverTarget(plan, trimEst)) {
    parts.over = true;
    parts.line3 = fmtDuration(fitSecOf(plan)) + '以内で' + plan.targetMB + 'MBに収まります。';
  }
  return parts;
}
// 予想の行を出す。予想の大きさは、目標サイズに収まるなら緑、超えるならオレンジにする
export function showPlanText(parts) {
  var el = els.planInfo;
  el.textContent = parts.line1 + '\n→ ';
  var size = document.createElement('span');
  size.className = 'plan-size ' + (parts.over ? 'is-over' : 'is-fit');
  size.textContent = parts.size;
  el.appendChild(size);
  el.appendChild(document.createTextNode(parts.tag + (parts.line3 ? '\n' + parts.line3 : '')));
}
export function probeLabel(plan) {
  if (plan.probed) return preReady(plan) ? '（先行圧縮済み）' : '（先行圧縮 ' + Math.floor(pre.time / pre.plan.duration * 100) + '%）';
  return pre && pre.file === state.file && (pre.job || preTimer) ? '（先行圧縮中）' : '';
}
// 先行圧縮の結果を画面に出す。範囲が目標サイズに収まる長さの目安を超えていれば、トリミングの帯を黄色にする。
// 先行圧縮が済んでいれば、押せばすぐ出せる選択肢（なるべく圧縮・条件を満たせば◯MB以内）の下に、その大きさを出す
export function showPrecompressHints(plan) {
  var idle = !!plan && !state.running && !isCompressed();
  // トリミングの帯の黄色は、2 の注意・予想の行と同じ判断（目標サイズに収まらない見込み）
  els.trimBox.classList.toggle('is-over', idle && isOverTarget(plan, trimOnlyEstimate(plan)));
  // 「なるべく圧縮」「◯MB以内」それぞれ、押せば先行圧縮をそのまま使えるなら、その大きさを選択肢の下に出す
  var note = '', noteSize = '';
  if (idle && pre && preReady(plan)) {
    var qp = plan.mode === 'quality' ? plan : currentPlan('quality');
    var sp = plan.mode === 'size' ? plan : currentPlan('size');
    var quick = qp.probed ? fmtBytes(qp.estBytes).replace(' ', '') + 'で即出力するよ' : '';
    if (quick && !precompressWhyNot(qp)) note = quick;
    if (quick && !precompressWhyNot(sp)) noteSize = quick;
  }
  els.quickNote.textContent = note;
  show(els.quickNote, !!note);
  els.quickNoteSize.textContent = noteSize;
  show(els.quickNoteSize, !!noteSize);
}
export function logEstimate(plan) {
  if (!plan || !plan.probed) return;
  log('予想' + probeLabel(plan) + ' 映像 ' + fmtRate(plan.expectedBps) + '・' + fmtBytes(plan.estBytes) +
    '・' + plan.targetMB + 'MBに収めるなら約' + plan.fitSec + '秒まで' + (plan.probeOver ? '（目標サイズに収まらない見込み）' : ''));
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

export function boxType(buf, o) { return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]); }
// buf の [start, end) にある箱を順に fn(type, 中身の始まり, 終わり) で渡す
export function eachBox(buf, dv, start, end, fn) {
  var o = start;
  while (o + 8 <= end) {
    var size = dv.getUint32(o), head = 8;
    if (size === 1) { size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12); head = 16; }
    else if (size === 0) size = end - o;
    if (size < head || o + size > end) return;
    fn(boxType(buf, o + 4), o + head, o + size);
    o += size;
  }
}
// 受け取ったデータの [off, off + len) を写し取る（区切りの書き出しは先頭から順に届く）
export function readChunks(rec, off, len) {
  var out = new Uint8Array(len), got = 0;
  for (var i = rec.parseChunk || 0; i < rec.chunks.length && got < len; i++) {
    var c = rec.chunks[i], cEnd = c.position + c.data.byteLength;
    if (cEnd <= off + got) { rec.parseChunk = i + 1; continue; }
    var from = off + got - c.position, n = Math.min(len - got, c.data.byteLength - from);
    out.set(c.data.subarray(from, from + n), got);
    got += n;
  }
  return got === len ? out : null;
}
// 届いた分の箱を読み進める（moov でトラックの情報を、moof で1コマごとの表を読む）
export function parseFragments(rec) {
  if (!rec.tracks) { rec.tracks = {}; rec.samples = { video: [], audio: [] }; rec.parseOff = 0; }
  while (rec.parseOff + 16 <= rec.bytes) {
    var head = readChunks(rec, rec.parseOff, 16);
    if (!head) return;
    var hv = new DataView(head.buffer), size = hv.getUint32(0), type = boxType(head, 4);
    if (size === 1) size = hv.getUint32(8) * 4294967296 + hv.getUint32(12);
    if (size < 8 || rec.parseOff + size > rec.bytes) return;   // まだ全部届いていない
    if (type === 'moov' || type === 'moof') {
      var buf = readChunks(rec, rec.parseOff, size);
      if (!buf) return;
      var dv = new DataView(buf.buffer);
      if (type === 'moov') parseMoov(rec, buf, dv, size);
      else parseMoof(rec, buf, dv, size);
    }
    rec.parseOff += size;
  }
}
export function parseMoov(rec, buf, dv, size) {
  eachBox(buf, dv, 8, size, function (type, s, e) {
    if (type === 'trak') {
      var t = { timescale: 1000, kind: null, id: 0 };
      eachBox(buf, dv, s, e, function (type2, s2, e2) {
        if (type2 === 'tkhd') t.id = dv.getUint32(s2 + (buf[s2] === 1 ? 20 : 12));
        if (type2 !== 'mdia') return;
        eachBox(buf, dv, s2, e2, function (type3, s3) {
          if (type3 === 'mdhd') t.timescale = dv.getUint32(s3 + (buf[s3] === 1 ? 20 : 12));
          if (type3 === 'hdlr') { var h = boxType(buf, s3 + 8); t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : null; }
        });
      });
      rec.tracks[t.id] = Object.assign(rec.tracks[t.id] || {}, t);
    }
    if (type === 'mvex') {
      eachBox(buf, dv, s, e, function (type2, s2) {
        if (type2 !== 'trex') return;
        var id = dv.getUint32(s2 + 4);
        rec.tracks[id] = Object.assign(rec.tracks[id] || {}, {
          defDur: dv.getUint32(s2 + 12), defSize: dv.getUint32(s2 + 16), defFlags: dv.getUint32(s2 + 20)
        });
      });
    }
  });
}
export function parseMoof(rec, buf, dv, size) {
  eachBox(buf, dv, 8, size, function (type, s, e) {
    if (type !== 'traf') return;
    var tr = null, dur = 0, sz = 0, flags = 0, dts = 0;
    eachBox(buf, dv, s, e, function (type2, s2) {
      var f = dv.getUint32(s2) & 0xffffff;
      if (type2 === 'tfhd') {
        tr = rec.tracks[dv.getUint32(s2 + 4)];
        if (!tr) return;
        var o = s2 + 8;
        if (f & 0x1) o += 8;
        if (f & 0x2) o += 4;
        dur = (f & 0x8) ? dv.getUint32(o) : tr.defDur || 0; if (f & 0x8) o += 4;
        sz = (f & 0x10) ? dv.getUint32(o) : tr.defSize || 0; if (f & 0x10) o += 4;
        flags = (f & 0x20) ? dv.getUint32(o) : tr.defFlags || 0;
      } else if (type2 === 'tfdt') {
        dts = buf[s2] === 1 ? dv.getUint32(s2 + 4) * 4294967296 + dv.getUint32(s2 + 8) : dv.getUint32(s2 + 4);
      } else if (type2 === 'trun' && tr && tr.kind) {
        var v1 = buf[s2] === 1, n = dv.getUint32(s2 + 4), o2 = s2 + 8, first = null;
        if (f & 0x1) o2 += 4;
        if (f & 0x4) { first = dv.getUint32(o2); o2 += 4; }
        var list = rec.samples[tr.kind];
        for (var i = 0; i < n; i++) {
          var d = dur, z = sz, fl = i === 0 && first !== null ? first : flags, cts = 0;
          if (f & 0x100) { d = dv.getUint32(o2); o2 += 4; }
          if (f & 0x200) { z = dv.getUint32(o2); o2 += 4; }
          if (f & 0x400) { fl = dv.getUint32(o2); o2 += 4; }
          if (f & 0x800) { cts = v1 ? dv.getInt32(o2) : dv.getUint32(o2); o2 += 4; }
          list.push({ t: (dts + cts) / tr.timescale, d: d / tr.timescale, s: z, k: !(fl & 0x10000) });
          dts += d;
        }
      }
    });
  });
}

// 先行圧縮。書き出しは区切りごと（fragmented MP4）に受け取って持っておく（途中で止めても、区切りまでは読める）
export function startPre(pp, key) {
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
export function preSummary(rec) {
  var p = rec.plan;
  return {
    fileId: state.fileId, bytes: rec.bytes, width: p.width, height: p.height, outFps: Math.round(p.outFps),
    audioMode: p.audio.mode, audioBitrate: p.audioBitrate, videoBitrate: p.videoBitrate
  };
}
export function checkDeviceFloor(rec) {
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
    var input = new M.Input({ source: new M.BlobSource(fragmentsBlob(rec)), formats: INPUT_FORMATS });
    job.hooks.push(function () { try { input.dispose(); } catch (e) { /* noop */ } });
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
      try { input.dispose(); } catch (e) { /* noop */ }
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
export function checkCutDuration(res, span) {
  return blobDuration(res.blob).then(function (d) {
    if (d < span - 0.25) throw new Error('切り出した動画が短い（' + d.toFixed(2) + '秒／' + span.toFixed(2) + '秒）');
  });
}
// 書き出した動画の長さ（秒）
export function blobDuration(blob) {
  var input = new M.Input({ source: new M.BlobSource(blob), formats: INPUT_FORMATS });
  return input.computeDuration().then(function (d) {
    try { input.dispose(); } catch (e) { /* noop */ }
    return d;
  }, function (e) {
    try { input.dispose(); } catch (e2) { /* noop */ }
    throw e;
  });
}
// 受け取った書き出しを1つにまとめ、最後の区切りまでで切る（途中で止めたとき、最後の区切りは書きかけのことがある）。
// 区切りごとの書き出しは先頭から順に届くので、受け取ったデータをそのままつなげる（長い動画でも大きな写しを作らない）
export function fragmentsBlob(rec) {
  var chunks = rec.chunks, pos = 0;
  var inOrder = chunks.every(function (c) { var ok = c.position === pos; pos += c.data.byteLength; return ok; });
  if (!inOrder) {
    // 念のため：順に届いていなければ、位置どおりに1つにまとめ直す
    var buf = new Uint8Array(rec.bytes);
    chunks.forEach(function (c) { buf.set(c.data, c.position); });
    chunks = [{ position: 0, data: buf }];
  }
  // 箱（size 4バイト＋種類 4バイト）を先頭から順にたどる
  var ci = 0, total = chunks.reduce(function (n, c) { return n + c.data.byteLength; }, 0);
  function byteAt(off) {
    while (off >= chunks[ci].position + chunks[ci].data.byteLength) ci++;
    while (off < chunks[ci].position) ci--;
    return chunks[ci].data[off - chunks[ci].position];
  }
  var off = 0, keep = 0;
  while (off + 8 <= total) {
    var size = ((byteAt(off) << 24) >>> 0) + (byteAt(off + 1) << 16) + (byteAt(off + 2) << 8) + byteAt(off + 3);
    var type = String.fromCharCode(byteAt(off + 4), byteAt(off + 5), byteAt(off + 6), byteAt(off + 7));
    if (size < 8 || off + size > total) break;
    off += size;
    if (type === 'mdat' || type === 'moov' || type === 'mfra') keep = off;
  }
  return new Blob(chunks.map(function (c) { return c.data; }), { type: 'video/mp4' }).slice(0, keep, 'video/mp4');
}
