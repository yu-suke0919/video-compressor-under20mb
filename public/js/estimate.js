// 先行圧縮の予想：計画に先行圧縮の実測を当てはめ（withEstimate）、予想の行・即出力の大きさ・トリミングの帯・診断情報に出す

import { DISCORD_FREE_BYTES } from './constants.js';
import { fitSecOf, fmtBytes, fmtDuration, fmtFps, fmtRate, isOverTarget, preEstimate, preKey, preUseRatioOf } from './calc.js';
import { els } from './dom.js';
import { state } from './state.js';
import { log, show } from './util.js';
import { currentPlan } from './plan.js';
import { isCompressed } from './view.js';
import { copyLabel, trimOnlyEstimate } from './fast.js';
import { cutBytes, pre, prePlan, preReady, preTimer, precompressWhyNot } from './precompress.js';

var FIT_MARGIN = 0.95;             // 「約◯秒まで◯MBに収まるよ」は、実測の平均で収まる秒数のこの割合を出す
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
  var sure = !trimEst && !!(plan.probed && pre && preReady(plan) && plan.exactEst && !precompressWhyNot(plan));
  // ビットレートは、指定するビットレート（エンコーダーが実際に使う量は、予想の大きさに入っている）。
  // 先行圧縮をそのまま使う（確定）ときは、切り出した大きさから求めた実際の値（3 の結果と同じ計算。
  // 「◯MB以内」の指定は範囲の長さで変わるが、先行圧縮を切り出すときは使わないため）
  var line1 = '現在の設定：' + Math.min(plan.width, plan.height) + 'p/' + fmtFps(plan.outFps) + '/' + fmtDuration(plan.duration) + '/' +
    (trimEst ? '再圧縮なし' : fmtRate(sure ? plan.expectedBps : plan.videoBitrate));
  var est = trimEst || plan.estBytes;
  var tag;
  if (trimEst) tag = '予想・' + copyLabel(plan);
  else {
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
function probeLabel(plan) {
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
