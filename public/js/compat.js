// 互換モード：<video> を再生しながらコマを取り出し、WebCodecs でエンコードする（高速モードで扱えない動画向け）

import { AUDIO_BITRATE, CANCELLED, COMPAT_AUDIO_CODEC, COMPAT_VIDEO_CODECS, DEFAULT_FPS, KEYFRAME_INTERVAL, M } from './constants.js';
import { els } from './dom.js';
import { state } from './state.js';
import { errText, isCancel, log, sleep, throwIfCancelled } from './util.js';
import { MSG_CANVAS_FAIL, MSG_NO_H264, MSG_PLAY_FAILED, MSG_PLAY_LOW_POWER, borrowVideo, isIOS } from './media.js';
import { ENCODER_ORDER, newMp4Output, outputBlob } from './fast.js';

// ---------------------------------------------------------------- 互換モード（再生しながら取り込み）
function findCompatVideoConfig(plan, job) {
  var cands = [];
  ENCODER_ORDER.forEach(function (o) {
    COMPAT_VIDEO_CODECS.forEach(function (c) {
      var cfg = {
        codec: c.codec, width: plan.width, height: plan.height, bitrate: plan.videoBitrate,
        framerate: Math.round(plan.outFps) || DEFAULT_FPS, hardwareAcceleration: o.hw, latencyMode: 'quality',
        bitrateMode: o.bitrateMode
      };
      Object.keys(c.extra).forEach(function (k) { cfg[k] = c.extra[k]; });
      cands.push({ config: cfg, mb: c.mb });
    });
  });
  return (function next(i) {
    if (i >= cands.length) return Promise.resolve(null);
    if (job && job.cancelled) return Promise.reject(new Error(CANCELLED));   // キャンセルされたら残りの候補は試さない
    var c = cands[i];
    return Promise.resolve()
      .then(function () { return VideoEncoder.isConfigSupported(c.config); })
      .then(function (res) {
        log('互換エンコード設定 ' + c.config.codec + '/' + c.config.hardwareAcceleration + '/' + (c.config.bitrateMode || '既定') +
          ' → ' + ((res && res.supported) ? '使える' : '使えない'));
        return (res && res.supported) ? { config: res.config || c.config, mb: c.mb } : next(i + 1);
      })
      .catch(function (e) {
        if (isCancel(job, e)) throw e;   // キャンセルはそのまま伝える
        log('互換エンコード設定の確認に失敗 ' + errText(e));
        return next(i + 1);
      });
  })(0);
}

function drain(encoder, max, job) {
  return new Promise(function (resolve, reject) {
    (function check() {
      if (job && job.cancelled) return reject(new Error(CANCELLED));
      if (encoder.state !== 'configured' || encoder.encodeQueueSize <= max) return resolve();
      setTimeout(check, 15);
    })();
  });
}

// 音声: ファイル全体をWeb Audioでデコードし、トリミング範囲だけAACへ再エンコードする
function encodeCompatAudio(plan, onProgress, job) {
  var key = plan.trimStart + '-' + plan.trimEnd;
  if (state.compatAudio && state.compatAudio.key === key) return Promise.resolve(state.compatAudio.data);
  var decoded = null;
  return state.file.arrayBuffer().then(function (buf) {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new Ctx(2, 1024, 48000);
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }).then(function (audioBuffer) {
    decoded = audioBuffer;
    throwIfCancelled(job);
    if (!decoded || decoded.length === 0) return null;
    var channels = Math.min(2, decoded.numberOfChannels);
    var sampleRate = decoded.sampleRate;
    var cfg = { codec: COMPAT_AUDIO_CODEC.codec, sampleRate: sampleRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE };
    return AudioEncoder.isConfigSupported(cfg).then(function (res) {
      if (!res || !res.supported) return null;
      var from = Math.max(0, Math.floor(plan.trimStart * sampleRate));
      var to = Math.min(decoded.length, Math.ceil(plan.trimEnd * sampleRate));
      return runAudioEncoder(decoded, from, to, channels, sampleRate, res.config || cfg, onProgress, job);
    });
  }).then(function (data) {
    decoded = null;
    state.compatAudio = { key: key, data: data };
    return data;
  }).catch(function (err) {
    decoded = null;
    if (isCancel(job, err)) throw new Error(CANCELLED);
    console.warn('音声のエンコードに失敗したため、音声なしで続行します:', err);
    return null;
  });
}

// iPhone の Safari（WebKit）の AudioEncoder は、AAC の設定データ（AudioSpecificConfig）の代わりに、
// MP4 の入れ物（esds）ごと入れてくる（https://bugs.webkit.org/show_bug.cgi?id=302253）。
// そのまま書くと、書き出した動画の音声が正しく読めないので、Mediabunny と同じく、設定データを作り直す
var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function aacSpecificConfig(sampleRate, channels) {
  // 種類（2: AAC-LC）5ビット・サンプリング周波数の番号 4ビット（一覧にないときは 15 と周波数 24ビット）・チャンネル数 4ビット・残り3ビットは0
  var bits = [], idx = AAC_RATES.indexOf(sampleRate);
  function put(v, n) { for (var i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); }
  put(2, 5);
  if (idx >= 0) put(idx, 4); else { put(15, 4); put(sampleRate, 24); }
  put(channels, 4);
  put(0, 3);
  var out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach(function (b, i) { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}
function fixAacMeta(meta) {
  var dc = meta && meta.decoderConfig;
  if (!dc) return meta;
  var d = dc.description, bytes = null;
  if (d) bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (bytes && bytes.length >= 2 && (bytes[0] >> 3) !== 0) return meta;   // 種類が入っている（正しい設定データ）
  log('音声の設定データを作り直した（エンコーダーが出したもの: ' + (bytes ? bytes.length + 'バイト' : 'なし') + '）');
  return { decoderConfig: { codec: dc.codec, sampleRate: dc.sampleRate, numberOfChannels: dc.numberOfChannels,
    description: aacSpecificConfig(dc.sampleRate, dc.numberOfChannels) } };
}

function runAudioEncoder(audioBuffer, from, to, channels, sampleRate, config, onProgress, job) {
  return new Promise(function (resolve, reject) {
    var packets = [];
    var encoder = new AudioEncoder({
      output: function (chunk, meta) { packets.push({ packet: M.EncodedPacket.fromEncodedChunk(chunk), meta: fixAacMeta(meta) }); },
      error: function (e) { reject(e); }
    });
    encoder.configure(config);
    job.hooks.push(function () {
      try { if (encoder.state !== 'closed') encoder.close(); } catch (e) { /* noop */ }
      reject(new Error(CANCELLED));
    });
    var CHUNK = 1024, pos = from, total = Math.max(1, to - from), n = 0;
    (function pump() {
      try {
        throwIfCancelled(job);
        while (pos < to) {
          if (encoder.encodeQueueSize > 24) return drain(encoder, 8, job).then(pump, reject);
          var len = Math.min(CHUNK, to - pos);
          var data = new Float32Array(len * channels);
          for (var c = 0; c < channels; c++) {
            audioBuffer.copyFromChannel(data.subarray(c * len, (c + 1) * len), c, pos);
          }
          var audioData = new AudioData({
            format: 'f32-planar', sampleRate: sampleRate, numberOfFrames: len, numberOfChannels: channels,
            timestamp: Math.round((pos - from) / sampleRate * 1e6), data: data
          });
          // AudioData は渡したらすぐ解放する（長い動画で、使い終わった音声がメモリに溜まらないように）
          try { encoder.encode(audioData); } finally { audioData.close(); }
          pos += len;
          if (++n % 64 === 0) {
            onProgress((pos - from) / total);
            return sleep(0).then(pump, reject);
          }
        }
        onProgress(1);
        encoder.flush().then(function () {
          encoder.close();
          resolve({ packets: packets, mb: COMPAT_AUDIO_CODEC.mb });
        }, function (err) {
          try { if (encoder.state !== 'closed') encoder.close(); } catch (e) { /* noop */ }
          reject(err);
        });
      } catch (e) {
        try { encoder.close(); } catch (e2) { /* noop */ }
        reject(e);
      }
    })();
  });
}

// 映像: <video> をトリミング範囲だけ再生し、フレームを取り出してエンコードする
// 取り込んだコマを描く面。OffscreenCanvas を使い、そこから VideoFrame を作れない環境では、ふつうの canvas に切り替える。
// 作れなければ null
function frameSurface(width, height) {
  function make(offscreen) {
    var c;
    if (offscreen && typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(width, height);
    else { c = document.createElement('canvas'); c.width = width; c.height = height; }
    return { canvas: c, ctx: c.getContext('2d', { alpha: false }) };
  }
  var surface = make(true);
  if (!surface.ctx) surface = make(false);
  if (!surface.ctx) return null;
  var fellBack = false;
  return {
    // source の今のコマを描いて VideoFrame にする（使い終わったら close すること）
    capture: function (source, ts) {
      surface.ctx.drawImage(source, 0, 0, width, height);
      try {
        return new VideoFrame(surface.canvas, { timestamp: ts });
      } catch (e) {
        if (fellBack) throw e;
        fellBack = true;
        surface = make(false);
        surface.ctx.drawImage(source, 0, 0, width, height);
        return new VideoFrame(surface.canvas, { timestamp: ts });
      }
    },
    // 最後に描いたコマを、別の時刻の VideoFrame にする（末尾の補完用）
    repeat: function (ts) { return new VideoFrame(surface.canvas, { timestamp: ts }); }
  };
}

function encodeCompatVideo(videoEl, plan, config, onPacket, onProgress, job) {
  // キャンセル済みなら、プレビューの動画（ミュート・再生位置など）に触れずに終える
  if (job.cancelled) return Promise.reject(new Error(CANCELLED));
  var width = plan.width, height = plan.height;
  var surface = frameSurface(width, height);
  if (!surface) return Promise.reject(new Error(MSG_CANVAS_FAIL));
  var start = plan.trimStart, end = plan.trimEnd, span = Math.max(0.1, end - start);
  var giveBack = borrowVideo(videoEl, true);

  return new Promise(function (resolve, reject) {
    // stopped … フレームの受け付けを終えた（終わりまで来た・失敗・キャンセル）
    // settled … 結果（成功・失敗）を返した。末尾の書き出し（flush）で失敗しても、必ず失敗として返すために分けておく
    var frames = 0, lastKeyTs = -Infinity, lastTs = -1, stopped = false, settled = false;
    var minDeltaUs = 1e6 / plan.outFps * 0.75;   // 取り込むフレームレートの上限（多少の揺らぎは許容）
    var encoder = null;
    // 作る・設定するところで失敗しても、プレビューの動画（操作ボタン・ミュート）を元に戻してから失敗にする
    try {
      encoder = new VideoEncoder({
        output: function (chunk, meta) { onPacket(M.EncodedPacket.fromEncodedChunk(chunk), meta); },
        error: function (e) { fail(e); }
      });
      encoder.configure(config);
    } catch (e) {
      fail(e);
      return;
    }
    // キャンセルしたらその場で止めて、プレビューの動画を元に戻す（次の実行とぶつからないように）
    job.hooks.push(function () { fail(new Error(CANCELLED)); });

    function cleanup() {
      videoEl.onended = null;
      clearInterval(watchdog);
      giveBack();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      stopped = true;
      cleanup();
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) { /* noop */ }
      reject(err);
    }
    function finish() {
      if (stopped) return;
      stopped = true;
      cleanup();
      // 取りこぼした末尾を最後の1枚で埋めて、長さをトリミング範囲に合わせる
      try {
        var endTs = Math.round(span * 1e6);
        if (frames > 0 && endTs > lastTs + minDeltaUs) {
          var tail = surface.repeat(endTs);
          try { encoder.encode(tail, { keyFrame: false }); } finally { tail.close(); }
        }
      } catch (e) { /* 末尾の補完は失敗しても無視する */ }
      encoder.flush().then(function () {
        if (settled) return;   // 書き出しの途中でキャンセル・失敗していた
        settled = true;
        encoder.close();
        resolve();
      }, fail);   // 末尾の書き出しで失敗したら、止まったままにせず失敗として返す
    }
    function onFrame(now, frameMeta) {
      if (stopped) return;
      if (job.cancelled) return fail(new Error(CANCELLED));
      try {
        var t = (frameMeta && typeof frameMeta.mediaTime === 'number') ? frameMeta.mediaTime : videoEl.currentTime;
        if (t >= end) return finish();
        var ts = Math.round((t - start) * 1e6);
        if (ts >= 0 && ts > lastTs + minDeltaUs) {
          var keyFrame = (ts - lastKeyTs) >= KEYFRAME_INTERVAL * 1e6;
          var frame = surface.capture(videoEl, ts);
          try { encoder.encode(frame, { keyFrame: keyFrame }); } finally { frame.close(); }   // VideoFrameは必ず解放する
          if (keyFrame) lastKeyTs = ts;
          lastTs = ts;
          frames++;
          onProgress(Math.min(1, (t - start) / span));
        }
        if (encoder.encodeQueueSize > 6) {
          // エンコードが追いつかないときは再生を止めて待つ
          videoEl.pause();
          drain(encoder, 2, job).then(function () {
            if (stopped) return;
            Promise.resolve(videoEl.play()).catch(function () { /* noop */ });
            videoEl.requestVideoFrameCallback(onFrame);
          }, fail);
          return;
        }
        videoEl.requestVideoFrameCallback(onFrame);
      } catch (e) {
        fail(e);
      }
    }
    var watchdog = setInterval(function () {
      if (stopped) return;
      if (job.cancelled) return fail(new Error(CANCELLED));
      if (videoEl.ended || videoEl.currentTime >= end) finish();
    }, 400);
    videoEl.onended = finish;

    // 開始位置へシークしてから再生する
    var seeked = false;
    function begin() {
      if (seeked || stopped) return;
      seeked = true;
      Promise.resolve(videoEl.play()).then(function () {
        videoEl.requestVideoFrameCallback(onFrame);
      }, function (e) {
        log('再生できない ' + errText(e));
        // iPhone は、低電力モードのとき、音を消した動画でも再生させない（NotAllowedError）
        fail(new Error(isIOS() && e && e.name === 'NotAllowedError' ? MSG_PLAY_LOW_POWER : MSG_PLAY_FAILED));
      });
    }
    videoEl.addEventListener('seeked', begin, { once: true });
    videoEl.currentTime = start;
    setTimeout(begin, 1500);   // seeked が来ない場合の保険
  });
}

export function convertCompat(plan, onProgress, job) {
  var audioSpan = plan.audio.mode === 'aac' ? 0.15 : 0;
  var audioPromise = plan.audio.mode === 'aac'
    ? encodeCompatAudio(plan, function (r) { onProgress(r * audioSpan); }, job)
    : Promise.resolve(null);

  return audioPromise.then(function (audio) {
    throwIfCancelled(job);
    return findCompatVideoConfig(plan, job).then(function (found) {
      throwIfCancelled(job);   // 設定を確かめている間にキャンセルされていたら、先へ進まない
      if (!found) throw new Error(MSG_NO_H264);
      var output = newMp4Output();
      var vsrc = new M.EncodedVideoPacketSource(found.mb);
      output.addVideoTrack(vsrc);
      var asrc = null;
      if (audio && audio.packets.length) {
        asrc = new M.EncodedAudioPacketSource(audio.mb);
        output.addAudioTrack(asrc);
      }
      return output.start().then(function () {
        if (job.cancelled) {   // 出力の準備中にキャンセルされていたら、作りかけの出力を捨てる
          try { output.cancel(); } catch (e) { /* noop */ }
          throw new Error(CANCELLED);
        }
        // 映像と音声をタイムスタンプ順に交互に渡す
        var chain = Promise.resolve(), ai = 0;
        function pushAudioUntil(t) {
          if (!asrc) return;
          while (ai < audio.packets.length && audio.packets[ai].packet.timestamp <= t) {
            (function (p) { chain = chain.then(function () { return asrc.add(p.packet, p.meta); }); })(audio.packets[ai++]);
          }
        }
        function onPacket(packet, meta) {
          pushAudioUntil(packet.timestamp);
          chain = chain.then(function () { return vsrc.add(packet, meta); });
        }
        return encodeCompatVideo(els.srcVideo, plan, found.config, onPacket, function (r) {
          onProgress(audioSpan + r * (1 - audioSpan));
        }, job).then(function () {
          pushAudioUntil(Infinity);
          return chain.then(function () {
            vsrc.close();
            if (asrc) asrc.close();
            return output.finalize();
          }).then(function () {
            return {
              blob: outputBlob(output),
              audioDropped: plan.audio.mode === 'aac' && !asrc,
              rateMode: found.config.bitrateMode || 'variable'   // 指定なしは WebCodecs の既定（可変）
            };
          });
        }, function (err) {
          try { output.cancel(); } catch (e) { /* noop */ }
          throw err;
        });
      });
    });
  });
}
