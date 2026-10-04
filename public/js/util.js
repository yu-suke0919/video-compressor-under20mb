// 小道具：診断情報への記録、処理の中断（job）、進捗の表示、表示用の書式

import { CANCELLED } from './constants.js';
import { els } from './dom.js';

// ---------------------------------------------------------------- 小道具
export function show(el, visible) { el.classList.toggle('hidden', !visible); }
// t からの経過時間（例: 1.2秒）
export function secondsSince(t) { return ((Date.now() - t) / 1000).toFixed(1) + '秒'; }
export function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// 圧縮1回ぶんの情報。キャンセルは実行ごとに管理し、止まりきらない古い処理が次の実行に影響しないようにする
//   cancelled … キャンセルされたか
//   hooks     … キャンセル時にすぐ実行する後片付け（エンコーダを閉じる、再生を止める など）
//   aborted   … キャンセルした瞬間に失敗する Promise（処理の完了と競わせて、画面をすぐ戻すために使う）
export function newJob() {
  var job = { cancelled: false, hooks: [] };
  job.aborted = new Promise(function (resolve, reject) { job.abort = reject; });
  job.aborted.catch(function () { /* noop */ });
  return job;
}
// 実行を止める。後片付けを始め（止まりきるのは待たない）、aborted をすぐ失敗させる。
// 後片付けが終わるのを待ちたいときは job.stopped を使う
export function stopJob(job, reason) {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  job.stopped = Promise.all(job.hooks.map(function (hook) {
    try { return Promise.resolve(hook()).catch(function () { /* noop */ }); } catch (e) { return null; }
  }));
  job.abort(new Error(reason));
}
// 画面が表示されるまで待つ（キャンセルされたら失敗する）
export function waitVisible(job) {
  if (document.visibilityState === 'visible') return Promise.resolve();
  return new Promise(function (resolve, reject) {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      resolve();
    }
    document.addEventListener('visibilitychange', onVisible);
    job.aborted.catch(function (e) { document.removeEventListener('visibilitychange', onVisible); reject(e); });
  });
}
export function throwIfCancelled(job) { if (job && job.cancelled) throw new Error(CANCELLED); }
export function isCancel(job, err) { return !!(job && job.cancelled) || !!(err && err.message === CANCELLED); }
// lines の各行は文字、または太字にする行 { bold: 文字 }
export function setAlert(el, lines, danger) {
  el.classList.toggle('danger', !!danger);
  el.innerHTML = '';
  lines = (lines || []).filter(Boolean);
  lines.forEach(function (t) {
    var p = document.createElement('p');
    if (typeof t === 'object') { var b = document.createElement('b'); b.textContent = t.bold; p.appendChild(b); }
    else p.textContent = t;
    el.appendChild(p);
  });
  show(el, lines.length > 0);
}
// 診断情報（うまく動かないときに、どこで止まったかを伝えてもらうための記録。動画の中身やファイル名は含めない）
var diag = { t0: Date.now(), lines: [] };
export function log(msg) {
  var line = ((Date.now() - diag.t0) / 1000).toFixed(1) + 's ' + msg;
  diag.lines.push(line);
  if (diag.lines.length > 400) diag.lines.splice(2, 1);   // 先頭（端末情報）は残す
  if (els.diagOut) els.diagOut.value = diag.lines.join('\n');
  try { console.log('[診断] ' + msg); } catch (e) { /* noop */ }
}
export function errText(err) { return err ? ((err.name ? err.name + ': ' : '') + (err.message || String(err))) : String(err); }
// 診断情報を普段から表示するか。本番ではエラーや停止のときだけ表示する（記録は常に続ける）
//   プレビュー（<ブランチ名>.<プロジェクト名>.pages.dev）・手元の確認環境・URLに debug=1 のときは、圧縮を始めたら表示
var DIAG_ALWAYS = (function () {
  var h = location.hostname;
  var debug = false;
  try { debug = /^(1|on|true)$/i.test(new URLSearchParams(location.search).get('debug') || ''); } catch (e) { /* noop */ }
  return debug || (/\.pages\.dev$/.test(h) && h.split('.').length > 3) || h === 'localhost' || h === '127.0.0.1';
})();
// open: 開いて表示する（エラーや停止のとき）。false なら普段から表示する環境だけで表示する
export function showDiag(open) {
  if (!open && !DIAG_ALWAYS) return;
  show(els.diagBox, true);
  if (open) els.diagBox.open = true;
}

// 進捗は1フレームに1回だけ描く。数字とゲージを同じタイミングで更新し、
// 処理中に頻繁に呼ばれてもゲージが遅れないよう、CSSのアニメーションは使わない
var progress = { value: 0, label: null, raf: 0 };
export function setProgress(ratio, label) {
  progress.value = Math.max(0, Math.min(1, ratio || 0));
  if (label) progress.label = label;
  if (!progress.raf) progress.raf = requestAnimationFrame(drawProgress);
}
export function setPhase(label) {
  progress.label = label;
  if (!progress.raf) progress.raf = requestAnimationFrame(drawProgress);
}
function drawProgress() {
  progress.raf = 0;
  els.progressBar.style.transform = 'scaleX(' + progress.value.toFixed(4) + ')';
  els.pct.textContent = Math.round(progress.value * 100) + '%';
  if (progress.label !== null) els.phase.textContent = progress.label;
}
