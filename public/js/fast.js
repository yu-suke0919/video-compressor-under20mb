// 高速モード（Mediabunny の Conversion で直接デコード→再エンコード）と、トリミングのみ（再エンコードしない）

import { AUDIO_BITRATE, CANCELLED, FAST_AUDIO_CODEC, FAST_VIDEO_CODECS, KEYFRAME_INTERVAL, M, SIZE_SAFETY } from './constants.js';
import { state } from './state.js';
import { errText, log, throwIfCancelled } from './util.js';
import { readSettings } from './settings.js';
import { MSG_NO_H264, closeInput, isIOS, openInput, outputTags } from './media.js';
import { isFullRange } from './plan.js';
import { stripNeeds } from './view.js';

// ---------------------------------------------------------------- 高速モード（Mediabunny Conversion）
function encKey(c) { return c.codec + '/' + c.hw + '/' + c.bitrateMode; }
// エンコーダーの候補の順番（高速モード・互換モードで共通）。
// ハードウェアの可変ビットレート（VBR）→ ハードウェアの VBR が使えないときだけハードウェアの固定ビットレート（CBR）→
// ソフトウェア（ブラウザに任せる）の VBR。どのモードでも、指定を守らないエンコーダーでも、CBR で圧縮し直すことはしない
// （サイズは先行圧縮で実際に書き出した量から予想する）
export var ENCODER_ORDER = [
  { hw: 'prefer-hardware', bitrateMode: 'variable' },
  { hw: 'prefer-hardware', bitrateMode: 'constant' },
  { hw: 'no-preference', bitrateMode: 'variable' }
];
export function pickFastEncoding(plan) {
  var cands = [];
  FAST_VIDEO_CODECS.forEach(function (codec) {
    ENCODER_ORDER.forEach(function (o) { cands.push({ codec: codec, hw: o.hw, bitrateMode: o.bitrateMode }); });
  });
  return (function next(i) {
    if (i >= cands.length) return Promise.resolve(null);
    var c = cands[i];
    return M.canEncodeVideo(c.codec, {
      width: plan.width, height: plan.height, frameRate: plan.outFps,
      quality: new M.Quality({ bitrate: plan.videoBitrate, bitrateMode: c.bitrateMode }),
      hardwareAcceleration: c.hw
    }).then(function (ok) {
      log('エンコード設定 ' + encKey(c) + ' → ' + (ok ? '使える' : '使えない'));
      return ok ? c : next(i + 1);
    }, function (e) { log('エンコード設定 ' + encKey(c) + ' → 確認に失敗 ' + errText(e)); return next(i + 1); });
  })(0);
}

// MP4 に書き出す出力と、書き出した結果のファイル（高速モード・トリミングのみ・互換モードで共通）
export function newMp4Output() {
  return new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
}
export function outputBlob(output) { return new Blob([output.target.buffer], { type: 'video/mp4' }); }

// Mediabunny の Conversion で1回書き出す（高速モードとトリミングのみで共通）。結果は { blob, audioDropped }
//   spec.options(input, output) … Conversion.init に渡す設定（Promise でもよい）
//   spec.prepareLog()           … 準備ができたときに診断情報へ書く見出し（なければ書かない）
//   spec.invalidMessage         … 扱えない動画だったときの文言
//   spec.startLog               … 変換を始めるときに診断情報へ書く文（なければ書かない）
//   spec.input                  … 使う読み込み（先行圧縮からの切り出し）。渡したときは閉じない（なければ開いて、終わったら閉じる）
//   spec.output                 … 書き出し先（先行圧縮）。渡したときは結果の blob を作らない
//   spec.onReady(conv, audioLost) … 変換の準備ができたとき（先行圧縮で、音声が外れたかを早めに知る）
export function runConversion(spec, plan, onProgress, job) {
  var input = spec.input || openInput(state.file);
  var output = spec.output || newMp4Output();
  function dispose() {
    if (spec.input) return;
    closeInput(input);
  }
  job.hooks.push(dispose);   // 準備中に止めた場合も、ファイルの読み込みを閉じる

  return Promise.resolve().then(function () {
    return spec.options(input, output);
  }).then(function (options) {
    // 書き出すのは、メインの映像と音声の1本ずつだけ（大きさの計画も1本ずつで立てている。
    // 指定しないと、副音声などもすべて同じ設定で書き出してしまう）
    options.tracks = 'primary';
    return M.Conversion.init(options);
  }).then(function (conv) {
    var discarded = conv.discardedTracks || [];
    if (spec.prepareLog) {
      log(spec.prepareLog() + ' isValid=' + conv.isValid + (discarded.length ? ' 除外=' + discarded.map(function (d) {
        return (d.track && d.track.type) + ':' + d.reason;
      }).join(',') : ''));
    }
    var videoLost = discarded.filter(function (d) { return d.track && d.track.type === 'video'; })[0];
    if (!conv.isValid || videoLost) {
      throw new Error(spec.invalidMessage + '（' + (videoLost ? videoLost.reason : 'invalid') + '）');
    }
    var audioLost = audioTrackLost(plan, conv);
    if (spec.onReady) spec.onReady(conv, audioLost);
    // キャンセル時: 変換を止め、ファイルの読み込みも閉じる（止まりきるのは待たない）
    job.hooks.push(function () { var stop = conv.cancel(); dispose(); return stop; });
    conv.onProgress = function (p) { onProgress(p); };
    throwIfCancelled(job);
    if (spec.startLog) log(spec.startLog);
    return conv.execute().then(function () {
      return { blob: spec.output ? null : outputBlob(output), audioDropped: audioLost };
    });
  }).then(function (res) {
    dispose();
    return res;
  }, function (err) {
    dispose();
    // こちらで止めたとき（キャンセル・停止の検知）だけキャンセル扱いにする。
    // Mediabunny はエンコーダのエラーでも変換を中止してからエラーを返すので、そのときはエラーとして扱う
    if (job.cancelled) throw new Error(CANCELLED);
    throw err;
  });
}

// 高速モードの映像の設定（本番の圧縮と先行圧縮で共通）
function fastVideoConfig(plan, enc) {
  var video = {
    codec: enc.codec, width: plan.width, height: plan.height, fit: 'fill',
    quality: new M.Quality({ bitrate: plan.videoBitrate, bitrateMode: enc.bitrateMode }),
    hardwareAcceleration: enc.hw, keyFrameInterval: KEYFRAME_INTERVAL,
    forceTranscode: true, allowTransformationMetadata: false
  };
  if (plan.fpsChanged) video.frameRate = plan.outFps;
  // iPhone で解像度を変えないとき、デコーダーが取り出したコマをそのままエンコーダーに渡すと、
  // 圧縮中に別のアプリに切り替えたときにデコーダーが固まり、Safari を開き直すまで直らないことがある
  // （縮小するときは一度描き直すので、エラーになるだけで、戻ってからやり直せる）。
  // 全体を切り抜く指定にして、縮小するときと同じく描き直す（見た目は変わらない）
  if (isIOS() && state.meta && state.meta.width && state.meta.height) {
    video.crop = { left: 0, top: 0, width: Math.round(state.meta.width), height: Math.round(state.meta.height) };
  }
  return video;
}

// 高速モードの変換の設定（本番の圧縮と先行圧縮で共通）
export function fastOptions(plan, enc, input, output) {
  var audio;
  if (plan.audio.mode === 'aac') {
    audio = { codec: FAST_AUDIO_CODEC, quality: new M.Quality({ bitrate: AUDIO_BITRATE }), forceTranscode: true };
  } else if (plan.audio.mode === 'copy') {
    audio = { codec: FAST_AUDIO_CODEC };   // AACのままコピーする
  } else {
    audio = { discard: true };
  }
  var options = { input: input, output: output, video: fastVideoConfig(plan, enc), audio: audio, tags: outputTags, showWarnings: false };
  if (!isFullTrimOf(plan)) options.trim = { start: plan.trimStart, end: plan.trimEnd };
  return options;
}

// 高速モード: 選んだ解像度・ビットレートで再エンコードする
export function convertFast(plan, onProgress, job) {
  var chosen = null;
  return runConversion({
    options: function (input, output) {
      return pickFastEncoding(plan).then(function (enc) {
        if (!enc) throw new Error(MSG_NO_H264);
        chosen = enc;
        return fastOptions(plan, enc, input, output);
      });
    },
    prepareLog: function () { return '変換の準備（' + encKey(chosen) + '）'; },
    invalidMessage: '高速モードで扱えない動画です',
    startLog: '変換を開始'
  }, plan, onProgress, job).then(function (res) {
    res.rateMode = chosen.bitrateMode;
    return res;
  });
}

// 音声を残すつもりだったのに、書き出す動画に音声が1本も入らないか。
// iPhone の動画には、空間オーディオ（APAC）など読めない音声が AAC と一緒に入っていることがあり、
// それだけが外されたときは AAC が残るので「音声なし」にしない
function audioTrackLost(plan, conv) {
  if (plan.audio.mode === 'none') return false;
  return !(conv.utilizedTracks || []).some(function (t) { return t && t.type === 'audio'; });
}

// 再圧縮せずに書き出すときの説明（全体なら何を除いたか、一部ならトリミングのみ）
export function copyLabel(plan) {
  if (!isFullTrimOf(plan)) return 'トリミングのみ';
  var need = stripNeeds({ audio: plan.wantAudio });
  if (need.audio && need.location) return '位置情報と音声を除いて元のまま';
  return need.audio ? '音声を除いて元のまま' : '位置情報を除いて元のまま';
}

export function isFullTrimOf(plan) { return isFullRange(plan.trimStart, plan.trimEnd); }

// ---------------------------------------------------------------- トリミングのみ（再エンコードしない）
// 「◯MB以内に圧縮」で、解像度もfpsも元のまま、トリミングした元動画が目標サイズに収まる見込みなら、
// 再エンコードせずに切り出すだけにする（画質は元のまま）。見込みのサイズを返し、対象外なら 0
export function trimOnlyEstimate(plan) {
  if (!state.meta || !state.file || state.engine !== 'fast' || plan.mode !== 'size') return 0;
  // 全体のときは「元の動画のまま」で扱う。ただし位置情報や音声を取り除く必要があるときは、それだけ除いてそのまま書き出す
  var need = stripNeeds(readSettings());
  if (isFullTrimOf(plan) && !need.location && !need.audio) return 0;
  if (plan.width !== state.meta.width || plan.height !== state.meta.height || plan.fpsChanged) return 0;
  if (!(state.meta.duration > 0)) return 0;
  var est = Math.round(state.file.size * plan.duration / state.meta.duration);
  // 区切りがキーフレームに合わせて少し広がる分を見込み、狙うサイズ（目標の97%）で判定する
  return est < plan.targetBytes * SIZE_SAFETY ? est : 0;
}

// トリミングのみ: 再エンコードせずにそのまま写す
export function convertCopy(plan, onProgress, job) {
  return runConversion({
    options: function (input, output) {
      return {
        input: input, output: output,
        video: {},
        audio: plan.audio.mode === 'none' ? { discard: true } : {},
        trim: { start: plan.trimStart, end: plan.trimEnd },
        // 始まりはキーフレームから入れる。範囲の始まりより前は、エディットリストで再生しないようにする
        // （Mediabunny が書く。再生される始まりと長さは範囲どおり）
        copy: { mode: 'forced', boundaryPolicy: 'expand', shiftTolerance: Infinity },
        tags: outputTags,
        showWarnings: false
      };
    },
    prepareLog: function () { return 'トリミングのみの準備'; },
    invalidMessage: 'トリミングのみでは扱えない動画です'
  }, plan, onProgress, job).then(function (res) {
    res.trimOnly = true;
    return res;
  });
}
