// トリミングの部品（範囲のつまみ・目盛り・再生位置・シーク）

import { MIN_TRIM_LENGTH } from './constants.js';
import { fmtClock } from './calc.js';
import { els } from './dom.js';
import { state } from './state.js';
import { show } from './util.js';
import { refresh } from './view.js';

// ---------------------------------------------------------------- トリミングUI
export function setupTrim(duration) {
  var step = duration > 600 ? 0.5 : 0.1;
  [els.trimStart, els.trimEnd].forEach(function (el) { el.max = String(duration); el.step = String(step); });
  els.trimStart.value = '0';
  els.trimEnd.value = String(duration);
  state.trim = { start: 0, end: duration };
  renderTicks(duration);
  renderTrim();
}

// 目盛りの間隔: 5秒 → 10秒 → 30秒 … のうち、線が24本以下に収まる最小のもの
var TICK_INTERVALS = [5, 10, 30, 60, 120, 300, 600];
function tickInterval(duration) {
  for (var i = 0; i < TICK_INTERVALS.length; i++) {
    if (duration / TICK_INTERVALS[i] <= 24) return TICK_INTERVALS[i];
  }
  return TICK_INTERVALS[TICK_INTERVALS.length - 1];
}

function renderTicks(duration) {
  els.trimTicks.innerHTML = '';
  state.tickInterval = tickInterval(duration);
  for (var t = state.tickInterval; t < duration - 0.05; t += state.tickInterval) {
    var tick = document.createElement('i');
    tick.style.left = (t / duration * 100) + '%';
    els.trimTicks.appendChild(tick);
  }
}

function renderTrim() {
  var dur = state.meta ? state.meta.duration : 1;
  var a = state.trim.start / dur, b = state.trim.end / dur;
  // つまみの幅（--thumb-w）の半分だけ内側を実際の可動域とする
  els.trimFill.style.left = 'calc(var(--thumb-w) / 2 + (100% - var(--thumb-w)) * ' + a + ')';
  els.trimFill.style.width = 'calc((100% - var(--thumb-w)) * ' + Math.max(0, b - a) + ')';
  // 両方のつまみが右端に寄ったときに開始側を掴めるようにする
  els.trimStart.style.zIndex = a > 0.9 ? 3 : 2;
  els.trimEnd.style.zIndex = a > 0.9 ? 2 : 3;
  if (!state.meta) { els.trimLabel.textContent = 'トリミング'; return; }
  els.trimLabel.textContent = fmtClock(state.trim.start) + '–' + fmtClock(state.trim.end) +
    '（' + (state.trim.end - state.trim.start).toFixed(1) + '秒・目盛' + state.tickInterval + '秒）';
}

// 元動画の再生位置をトリミングのバー（シークバー）に表示する（再生中は画面の書き換えに合わせてなめらかに動かす）
var headRaf = 0, seekDragging = false;
export function renderPlayhead() {
  var dur = state.meta ? state.meta.duration : 0;
  if (!(dur > 0) || !state.file) { show(els.trimSeek, false); return; }
  if (els.trimSeek.max !== String(dur)) els.trimSeek.max = String(dur);
  // 指で動かしている間は、指の位置を優先する
  if (!seekDragging) els.trimSeek.value = String(Math.min(dur, Math.max(0, els.srcVideo.currentTime || 0)));
  show(els.trimSeek, true);
}
// 指の操作に合わせて動画を移動する。移動が終わるまで次の移動は出さず、最新の位置だけ覚えておく
// （Android の Chrome は、移動の途中で次の移動が来ると取りやめるため、動かしている間は映像が変わらなかった）
var seekQueue = { pending: null, at: 0 };
function seekVideo(t) {
  var v = els.srcVideo;
  if (v.seeking && Date.now() - seekQueue.at < 1000) { seekQueue.pending = t; return; }
  seekQueue.pending = null;
  seekQueue.at = Date.now();
  try { v.currentTime = t; } catch (e) { /* noop */ }
}
export function onSeeked() {
  if (seekQueue.pending === null) return;
  var t = seekQueue.pending;
  seekQueue.pending = null;
  seekVideo(t);
}

export function onSeekInput() {
  seekDragging = true;
  seekVideo(parseFloat(els.trimSeek.value) || 0);
}
export function endSeekDrag() { seekDragging = false; }

// バーの何もない所を触ったら、その位置へシークする（そのまま指を動かすとシークし続ける）。
// つまみや再生位置の線を触ったときは、それぞれの操作を優先する（触った要素が input のとき）
var trimBar = document.querySelector('.trim');
var barPointer = null;
function seekFromX(clientX) {
  var rect = trimBar.getBoundingClientRect();
  var thumbW = parseFloat(getComputedStyle(trimBar).getPropertyValue('--thumb-w')) || 44;
  var a = Math.min(1, Math.max(0, (clientX - rect.left - thumbW / 2) / Math.max(1, rect.width - thumbW)));
  var t = a * state.meta.duration;
  seekDragging = true;
  els.trimSeek.value = String(t);
  seekVideo(t);
}
export function setupTrimBar() {
trimBar.addEventListener('pointerdown', function (e) {
  if (e.target.tagName === 'INPUT' || els.trimSeek.disabled || !state.meta || e.button > 0) return;
  barPointer = e.pointerId;
  try { trimBar.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  seekFromX(e.clientX);
  e.preventDefault();
});
trimBar.addEventListener('pointermove', function (e) {
  if (barPointer === e.pointerId) seekFromX(e.clientX);
});
['pointerup', 'pointercancel'].forEach(function (type) {
  trimBar.addEventListener(type, function (e) {
    if (barPointer !== e.pointerId) return;
    barPointer = null;
    endSeekDrag();
  });
});
}
export function followPlayheadSoon() { if (!headRaf) headRaf = requestAnimationFrame(followPlayhead); }
function followPlayhead() {
  headRaf = 0;
  renderPlayhead();
  if (!els.srcVideo.paused && !els.srcVideo.ended) headRaf = requestAnimationFrame(followPlayhead);
}

export function onTrimInput(which) {
  var dur = state.meta.duration;
  var minLen = Math.min(MIN_TRIM_LENGTH, dur);
  var s = parseFloat(els.trimStart.value), e = parseFloat(els.trimEnd.value);
  if (which === 'start' && s > e - minLen) { s = Math.max(0, e - minLen); els.trimStart.value = String(s); }
  if (which === 'end' && e < s + minLen) { e = Math.min(dur, s + minLen); els.trimEnd.value = String(e); }
  state.trim = { start: s, end: e };
  seekVideo(which === 'start' ? s : e);
  renderTrim();
  refresh();
}
