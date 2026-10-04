// 動画の読み込み（選んだ動画の解析と、画面への反映）

import { SNAPSHOT_MAX_BYTES } from './constants.js';
import { fmtBytes, fmtDuration, fmtFps } from './calc.js';
import { els } from './dom.js';
import { state } from './state.js';
import { errText, log, secondsSince, setAlert, setProgress, show, showDiag, sleep } from './util.js';
import { randDigits } from './naming.js';
import { MSG_READ_FAIL, errorLines, loadFailMessage, loadMetaCompat, loadMetaFast } from './media.js';
import { clearOutput, refresh } from './view.js';
import { renderPlayhead, setupTrim } from './trim.js';
import { forgetPre } from './precompress.js';
import { run } from './run.js';
import { resetAdjust, resetEasyName } from './adjust.js';

// ---------------------------------------------------------------- 動画の読み込み
// Android では、ファイル選択で渡された動画が時間が経つと読めなくなることがある（TypeError: network error）。
// 読めるうちに中身をブラウザ内に写し取り、以降はその写しを使う（大きすぎる動画は写さない）
// 選んだ直後に、端末が動画を一時的に読ませてくれないことがある（NotReadableError）。少し待って1回だけ読み直す
var READ_RETRY_MS = 800;
function snapshotFile(file) {
  if (!/Android/i.test(navigator.userAgent || '') || file.size > SNAPSHOT_MAX_BYTES) return Promise.resolve(file);
  var t0 = Date.now();
  function read(retry) {
    return file.arrayBuffer().then(function (buf) {
      log('動画をブラウザ内に写した（Android・' + secondsSince(t0) + (retry ? '・読み直しで成功' : '') + '）');
      return new File([buf], file.name || 'video.mp4', { type: file.type || 'video/mp4', lastModified: file.lastModified });
    }, function (err) {
      log('動画をブラウザ内に写せなかった' + (retry ? '（読み直しも失敗）' : '') + ' ' + errText(err));
      if (!retry && isReadError(err)) return sleep(READ_RETRY_MS).then(function () { return read(true); });
      return file;
    });
  }
  return read(false);
}
// 動画の中身ではなく、端末から受け取るところで失敗したか（Android で選んだ直後などに一時的に起きる）
function isReadError(err) {
  if (!err) return false;
  return err.name === 'NotReadableError' || err.name === 'NotFoundError' ||
    (err.name === 'TypeError' && /network error/i.test(err.message || ''));
}

export function onFileChosen(picked) {
  if (!picked || state.running) return;
  state.picking = picked;
  state.busy = true;
  els.srcInfo.textContent = '読み込み中…';
  refresh();
  snapshotFile(picked).then(function (file) {
    if (state.picking !== picked || state.running) return;   // 写している間に別の動画が選ばれた
    loadChosenFile(file);
  });
}

function loadChosenFile(file) {
  forgetPre();
  state.busy = true;
  state.loadError = null;
  state.file = file;
  state.meta = null;
  state.nameRand = randDigits();   // 元の動画のまま渡すときの乱数（同じ動画のあいだは変えない）
  state.compatAudio = null;
  state.fileId = (state.fileId || 0) + 1;   // 動画ごとの番号（前回の先行圧縮と同じ動画かを見分ける）
  resetAdjust();   // 3ステップの画面の 2 で変えた値は、その動画だけ
  resetEasyName();
  clearOutput();
  setProgress(0, '');
  show(els.progressWrap, false);
  if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);
  state.srcUrl = URL.createObjectURL(file);
  els.srcVideo.src = state.srcUrl;
  show(els.srcVideo, true);
  show(els.pickBtn, false);
  show(els.repickBtn, true);
  els.srcInfo.textContent = '読み込み中…';
  refresh();

  // ファイル名は記録しない（診断情報をそのまま送ってもらうため）。拡張子は決まった形だけ書く
  var ext = /\.(mp4|m4v|mov|qt|webm|mkv|3gp|3g2|avi|ts|mts|m2ts)$/i.exec(file.name || '');
  log('動画を選択 ' + (ext ? ext[1].toLowerCase() : '拡張子不明') + ' ' + (file.type || '種類不明') + ' ' + fmtBytes(file.size));
  loadMetaFast(file).then(function (meta) {
    log('解析（高速） ' + meta.width + 'x' + meta.height + ' ' + meta.fps + 'fps ' + (meta.duration || 0).toFixed(1) + 's codec=' +
      (meta.codecString || meta.videoCodec) + ' hdr=' + meta.hdr + ' decode=' + meta.canDecode +
      ' audio=' + (meta.audio ? meta.audio.codec + '/' + Math.round(meta.audio.bitrate / 1000) + 'kbps' + (meta.audio.canDecode === false ? '（読み込めない）' : '') : 'なし'));
    if (!meta.canDecode) {
      // 互換モードでは位置情報を調べられないので、ここで分かった有無を引き継ぐ
      var e = new Error('decode'); e.codec = meta.videoCodec; e.hasLocation = meta.hasLocation; throw e;
    }
    state.engine = 'fast';
    return meta;
  }).catch(function (err) {
    console.warn('高速モードで読み込めないため互換モードを使います:', err);
    log('高速モードで読み込めない ' + errText(err));
    // デコーダーが固まっているときは、互換モードも動かないので試さない
    if (err && err.stuck) throw err;
    // 端末から受け取れなかったときは、形式の問題ではないので互換モードは試さず、選び直してもらう
    if (isReadError(err)) throw new Error(MSG_READ_FAIL);
    var codec = err && err.codec;   // 中身は読めたが、映像の形式に対応していないとき
    if (!state.caps.compat) throw new Error(loadFailMessage(codec));
    state.engine = 'compat';
    els.srcInfo.textContent = '解析中…';
    // 位置情報は高速モードで分かっていれば引き継ぎ、分からなければ不明（null）にする
    var hasLocation = (err && typeof err.hasLocation === 'boolean') ? err.hasLocation : null;
    return loadMetaCompat(els.srcVideo, codec).then(function (meta) { meta.hasLocation = hasLocation; return meta; });
  }).then(function (meta) {
    if (state.file !== file) return;
    state.meta = meta;
    setupTrim(meta.duration);
    renderPlayhead();
    els.srcInfo.textContent = meta.width + '×' + meta.height + '・' +
      (meta.fps ? fmtFps(meta.fps) : 'fps不明') + '・' + fmtDuration(meta.duration) + '・' + fmtBytes(file.size);
  }).catch(function (err) {
    if (state.file !== file) return;   // 読み込んでいる間に別の動画が選ばれていたら、その動画の表示を崩さない
    log('読み込みに失敗 ' + errText(err));
    showDiag(true);
    state.file = null;
    els.srcInfo.textContent = '';
    // 最初の画面に戻し、「動画を選択」からもう一度選べるようにする（一時的に読み込めないだけのことがある）
    if (state.srcUrl) { URL.revokeObjectURL(state.srcUrl); state.srcUrl = null; }
    els.srcVideo.removeAttribute('src');
    try { els.srcVideo.load(); } catch (e) { /* noop */ }
    show(els.srcVideo, false);
    show(els.pickBtn, true);
    show(els.repickBtn, false);
    state.loadError = (err && err.message) || String(err);
    setAlert(els.planWarn, errorLines(state.loadError), true);
  }).then(function () {
    state.busy = false;
    refresh();
    autoRunIfEnabled(file);
  });
}

// 「動画を選んだらすぐ圧縮」がオンなら、選んだ直後に圧縮を始める。
// 目標サイズに収まらない（ボタンが無効）ときや、元のままで目標以下（圧縮不要）のときは始めない
function autoRunIfEnabled(file) {
  if (!els.autoRun.checked || state.file !== file || !state.meta || state.running) return;
  if (els.runBtn.disabled || (state.out && state.out.original)) return;
  run();
}
