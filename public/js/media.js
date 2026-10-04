// 端末の対応判定、動画のメタ情報（解像度・fps・音声）、音声の扱い

import { AUDIO_BITRATE, AUDIO_COPY_MAX_BITRATE, AUDIO_DECODE_MAX_BYTES, DECODER_CHECK_MS, FAST_AUDIO_CODEC, INPUT_FORMATS, M } from './constants.js';
import { aacAudio, estimateFps, fmtRate, noAudio, snapFps } from './calc.js';
import { state } from './state.js';
import { sleep } from './util.js';

// ---------------------------------------------------------------- 対応判定
export function checkSupport() {
  var missing = [];
  if (typeof window.VideoEncoder === 'undefined' || typeof window.VideoFrame === 'undefined') {
    missing.push('WebCodecs（VideoEncoder）');
  }
  if (!M) missing.push('Mediabunny（同梱ライブラリの読み込みに失敗）');
  return missing;
}

export function detectCaps() {
  state.caps.compat = typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
  if (!M || typeof window.AudioEncoder === 'undefined') return Promise.resolve();
  return M.canEncodeAudio(FAST_AUDIO_CODEC, { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE })
    .then(function (ok) { state.caps.aac = !!ok; }, function () { state.caps.aac = false; });
}
// ---------------------------------------------------------------- メタ情報

// 撮影場所（GPS）の情報が入っているか。Android は ©xyz、iPhone は com.apple.quicktime.location.ISO6709 などに入る。
// メタデータを読めなかったときは null（不明）を返す。不明なときは「なし」と同じに扱わない（元の動画をそのまま渡さない）
function hasLocationTag(tags) {
  if (!tags) return null;
  var raw = tags.raw;
  if (!raw) return false;
  return Object.keys(raw).some(function (k) { return /xyz|location|gps/i.test(k); });
}
// 書き出す動画のメタデータ。位置情報などが入る生のデータ（raw）はすべて除き、題名や日付などだけ残す
export function outputTags(tags) {
  var out = {};
  Object.keys(tags || {}).forEach(function (k) { if (k !== 'raw') out[k] = tags[k]; });
  return out;
}

// 動画（File・Blob）を Mediabunny で開く（mp4・mov）。閉じるときは closeInput
export function openInput(blob) { return new M.Input({ source: new M.BlobSource(blob), formats: INPUT_FORMATS }); }
// 開いた動画を閉じる（閉じるときの例外は無視する）
export function closeInput(input) { try { input.dispose(); } catch (e) { /* noop */ } }
// 動画を開いて use(input) を行い、成功しても失敗しても閉じる（use は Promise を返す）
export function withInput(blob, use) {
  var input = openInput(blob);
  return Promise.resolve().then(function () { return use(input); }).then(function (r) {
    closeInput(input);
    return r;
  }, function (err) {
    closeInput(input);
    throw err;
  });
}

// 高速モード: Mediabunny でコンテナを読んで情報を得る
export function loadMetaFast(file) {
  return withInput(file, readMetaFast);
}
function readMetaFast(input) {
  var meta = {};
  return input.getPrimaryVideoTrack().then(function (vt) {
    if (!vt) throw new Error(MSG_NO_VIDEO_TRACK);
    meta.width = vt.displayWidth;
    meta.height = vt.displayHeight;
    meta.videoCodec = vt.codec;
    return Promise.all([input.computeDuration(), vt.computePacketStats(120), withinDecoderCheck(vt.canDecode()), input.getPrimaryAudioTrack(),
      vt.getCodecParameterString().catch(function () { return null; }),
      vt.hasHighDynamicRange().catch(function () { return null; }),
      input.getMetadataTags().catch(function () { return null; })]);
  }).then(function (r) {
    meta.codecString = r[4];
    meta.hdr = r[5];
    meta.hasLocation = hasLocationTag(r[6]);
    meta.duration = r[0];
    meta.fps = snapFps(r[1].averagePacketRate);
    meta.fpsMeasured = !!meta.fps;
    meta.canDecode = !!r[2];
    var at = r[3];
    if (!at) { meta.audio = null; return meta; }
    // 音声をこの端末で読み込めるか（読み込めない音声は、変換しようとしても外されて無音になるので、先に知らせる）
    return Promise.all([at.computePacketStats(200), withinDecoderCheck(at.canDecode()).catch(function (e) {
      if (e && e.stuck) throw e;
      return null;
    })]).then(function (r2) {
      meta.audio = { codec: at.codec, bitrate: r2[0].averageBitrate || 0, canDecode: r2[1] };
      return meta;
    });
  });
}

// 読み込めなかったときの文言。codec は高速モードで分かった映像の形式（分からなければ undefined）
var CODEC_NAMES = { hevc: 'HEVC/H.265', avc: 'H.264', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' };
// 端末によっては一時的に読み込めず、もう一度選ぶと読み込めることがあるので、まず選び直してもらう
export var MSG_READ_FAIL = '動画をうまく受け取れませんでした（端末側で一時的に読み込めないことがあります）。「動画を選択」からもう一度同じ動画を選んでください。';
var MSG_PICK_AGAIN = '一時的に読み込めないこともあるので、まずは「動画を選択」からもう一度選び直してください。';
// iPhone は、動画の処理中に別のアプリに切り替えると、動画のデコーダーが固まることがある。
// 固まるとこのページからは直せず、Safari（ホーム画面のアプリ）を開き直すまで動画を読み込めない
var MSG_CODEC_STUCK = 'この端末の動画の処理が止まったままになっています。ブラウザ（ホーム画面に追加した場合はそのアプリ）をいったん完全に閉じて開き直してから、もう一度お試しください（iPhone は、アプリの切り替え画面で上にスワイプすると閉じられます）。';
var MSG_KILL_BROWSER = 'ブラウザをタスクキルしてください！';
export var MSG_NO_H264 = 'この端末では動画のエンコード（H.264）に対応していません。';
var MSG_NO_VIDEO_TRACK = '映像トラックが見つかりませんでした。';
export var MSG_CANVAS_FAIL = 'canvasを初期化できませんでした。';
export var MSG_STALLED = '圧縮が進まなくなりました。画面を表示したまま、もう一度お試しください。';
export var MSG_PLAY_FAILED = '動画を再生できませんでした。画面を表示したまま、もう一度お試しください。';
export var MSG_REPORT = 'うまくいかないときは、画面のいちばん下の「診断情報」をコピーして、X（@inkaroma0431）あるいはDiscordに送ってください。';
export var MSG_AUDIO_COPY_FAILED = '元の動画の音声をそのまま使えなかったため、音声なしで圧縮しました。';
export var MSG_PLAY_LOW_POWER = '動画を再生できませんでした。低電力モードがオンのときは再生できないことがあるので、オフにしてからもう一度お試しください。';
// 読み込み・圧縮のエラーの赤枠に出す行（デコーダーが固まったときは、先に太字でタスクキルを促す）
export function errorLines(message) {
  return message === MSG_CODEC_STUCK ? [{ bold: MSG_KILL_BROWSER }, message] : [message];
}
export function codecStuckError() { var e = new Error(MSG_CODEC_STUCK); e.stuck = true; return e; }
// デコーダーへの問い合わせに時間制限を付ける（応答がなければ codecStuckError）
export function withinDecoderCheck(promise) {
  return Promise.race([promise, sleep(DECODER_CHECK_MS).then(function () { throw codecStuckError(); })]);
}
export function loadFailMessage(codec) {
  if (!codec) return '動画を読み込めませんでした。' + MSG_PICK_AGAIN + '何度選んでも読み込めないときは、ファイルが壊れているか、対応していない形式です（MP4・MOVに対応しています）。';
  return 'この端末は、この動画の映像形式（' + (CODEC_NAMES[codec] || codec) + '）の読み込みに対応していない可能性があります。' + MSG_PICK_AGAIN +
    (codec === 'hevc' ? '何度選んでも読み込めないときは、別の端末で試すか、iPhoneで撮影するときは「設定」→「カメラ」→「フォーマット」を「互換性優先」にしてください。' : '何度選んでも読み込めないときは、別の端末でお試しください。');
}

// 互換モード: <video> で長さと解像度を読み、冒頭を少し再生してフレームレートを測る
export function loadMetaCompat(videoEl, codec) {
  return new Promise(function (resolve, reject) {
    var done = false;
    // 同じ <video> を使い回すので、終わったら待ち受けを外す（動画を選ぶたびに溜まらないように）
    function cleanup() {
      clearTimeout(timer);
      videoEl.removeEventListener('loadedmetadata', ready);
      videoEl.removeEventListener('durationchange', ready);
      videoEl.removeEventListener('loadedmetadata', checkNoPicture);
      videoEl.removeEventListener('error', fail);
    }
    function ready() {
      if (done) return;
      if (!(isFinite(videoEl.duration) && videoEl.duration > 0) || !videoEl.videoWidth) return;
      done = true;
      cleanup();
      resolve({ duration: videoEl.duration, width: videoEl.videoWidth, height: videoEl.videoHeight });
    }
    var timer = setTimeout(fail, 20000);
    videoEl.addEventListener('loadedmetadata', ready);
    videoEl.addEventListener('durationchange', ready);
    // 長さは読めたのに映像の大きさが0のまま（映像の形式に対応していない）なら、20秒待たずに諦める
    // （高速モードで調べている間に、プレビューの動画がすでに長さを読み終えていることもある）
    function checkNoPicture() {
      if (!videoEl.videoWidth) setTimeout(function () { if (!done && !videoEl.videoWidth) fail(); }, 3000);
    }
    if (videoEl.readyState >= 1) checkNoPicture();
    else videoEl.addEventListener('loadedmetadata', checkNoPicture, { once: true });
    function fail() {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(loadFailMessage(codec)));
    }
    videoEl.addEventListener('error', fail, { once: true });
    if (videoEl.error) fail();   // 待ち受ける前にすでに失敗していた場合
    ready();
  }).then(function (meta) {
    if (!state.caps.compat) return meta;
    return probeFps(videoEl).then(function (fps) {
      meta.fps = fps;
      meta.fpsMeasured = !!fps;
      meta.audio = undefined;   // 互換モードでは音声の有無を事前に知れない
      return meta;
    });
  });
}

// プレビューの <video> を処理に借りる（音を消し、hideControls なら操作ボタンも隠す）。
// 返した関数で、止めて元に戻す（どの終わり方でも必ず呼ぶ。何度呼んでもよい）
export function borrowVideo(videoEl, hideControls) {
  var wasMuted = videoEl.muted, hadControls = videoEl.controls, returned = false;
  videoEl.muted = true;
  if (hideControls) videoEl.controls = false;
  return function giveBack() {
    if (returned) return;
    returned = true;
    try { videoEl.pause(); } catch (e) { /* noop */ }
    videoEl.muted = wasMuted;
    videoEl.controls = hadControls;
  };
}

function probeFps(videoEl) {
  var giveBack = borrowVideo(videoEl, false);
  return new Promise(function (resolve) {
    var times = [], done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      giveBack();
      try { videoEl.currentTime = 0; } catch (e) { /* noop */ }
      resolve(estimateFps(times));
    }
    var timer = setTimeout(finish, 2500);
    Promise.resolve(videoEl.play()).then(function () {
      function cb(now, meta) {
        if (done) return;
        times.push((meta && typeof meta.mediaTime === 'number') ? meta.mediaTime : videoEl.currentTime);
        if (times.length >= 24) return finish();
        videoEl.requestVideoFrameCallback(cb);
      }
      videoEl.requestVideoFrameCallback(cb);
    }, finish);
  });
}
// ---------------------------------------------------------------- 音声の扱い

export function audioStrategy(meta, wanted, engine) {
  if (!wanted) return noAudio();
  if (meta.audio === null) return noAudio(null, 'なし（元動画に音声なし）');
  if (engine === 'compat') {
    var compatOk = state.caps.aac && typeof window.AudioData !== 'undefined' &&
      (typeof window.OfflineAudioContext !== 'undefined' || typeof window.webkitOfflineAudioContext !== 'undefined');
    if (compatOk && state.file && state.file.size <= AUDIO_DECODE_MAX_BYTES) {
      return aacAudio();
    }
    return noAudio('この端末・動画では音声を変換できないため、音声なしで圧縮します。');
  }
  var src = meta.audio || {};
  var isAac = src.codec === 'aac';
  if (isAac && src.bitrate > 0 && src.bitrate <= AUDIO_COPY_MAX_BITRATE) {
    return { mode: 'copy', bps: src.bitrate, label: 'AAC ' + fmtRate(src.bitrate) + '（そのまま）', note: null };
  }
  // 変換するには、元の音声を読み込めて、AAC で書き出せる必要がある
  if (state.caps.aac && src.canDecode !== false) return aacAudio();
  if (isAac) {
    return { mode: 'copy', bps: src.bitrate || AUDIO_BITRATE, label: 'AAC ' + fmtRate(src.bitrate || AUDIO_BITRATE) + '（そのまま）', note: null };
  }
  if (state.caps.aac) {
    return noAudio('この端末ではこの動画の音声（' + String(src.codec || '不明').toUpperCase() + '）を読み込めないため、音声なしで圧縮します。');
  }
  return noAudio('この端末では音声をAACに変換できないため、音声なしで圧縮します。');
}

// iPhone / iPad（iPadOS はMacとして名乗るので、タッチ対応かどうかで見分ける）
// Safari（WebKit）。iPhone・iPad はどのブラウザも中身は Safari
export function isWebKit() {
  var ua = navigator.userAgent || '';
  return isIOS() || (/AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua));
}
export function isIOS() {
  var ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 0);
}
