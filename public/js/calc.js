// 計算だけの関数（画面・状態に触らない。定数のほかは何も読み込まないので、Node の単体テスト（npm run test:unit）でそのまま試せる）

import { AUDIO_BITRATE, DEFAULT_FPS, DISCORD_FREE_BYTES, HIGH_FPS_FLOOR_FACTOR, MAX_ATTEMPTS, MAX_BG_RETRIES, MAX_FPS, MB, MIN_KBPS_LIMITS, MIN_SHRINK, PRE_USE_PCT_DEFAULT, SIZE_SAFETY, SRC_CAP_RATIO, SRC_CAP_RATIO_HEVC } from './constants.js';

export function fmtBytes(n) {
  if (n < 1000) return n + ' B';
  if (n < MB) return (n / 1000).toFixed(0) + ' KB';
  return (n / MB).toFixed(1) + ' MB';
}
export function fmtDuration(sec) {
  if (sec > 0 && sec < 0.95) return sec.toFixed(1) + '秒';   // 1秒未満（0.3秒など）が「0秒」にならないようにする
  sec = Math.round(sec);
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m === 0) return s + '秒';
  return m + '分' + (s < 10 ? '0' : '') + s + '秒';
}
export function fmtClock(sec) {
  sec = Math.max(0, sec);
  var m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
export function fmtRate(bps) {
  return bps >= 1000000 ? (bps / 1000000).toFixed(1) + 'Mbps' : Math.round(bps / 1000) + 'kbps';
}
export function fmtFps(fps) { return (Math.round(fps * 10) / 10) + 'fps'; }
export function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
export function resValue(v) { return v === '1080' || v === 'source' || v === '480' ? v : '720'; }

export function isStandardRes(meta) {
  var shortSide = Math.min(meta.width, meta.height);
  return Math.abs(shortSide - 720) <= 8 || Math.abs(shortSide - 1080) <= 8;
}
// 720p以下の動画（短い辺が720付近以下）は、1080p を選んでも拡大はしないので、1080p を選べなくする
// （1080p を選んでいても 720p として計画する。1080p の下限ビットレートで 720p の動画を圧縮してしまうのを防ぐ）
export function isSmallSource(meta) { return !!meta && Math.min(meta.width, meta.height) <= 720 + 8; }

// 画面で変えられる設定。保存・読み込み・初期値に戻す・URL の読み取りと作成は、すべてこの一覧から行う
// （設定を足すときは、ここに1つ足せばよい。ファイル名の設定は naming で別に扱う）
//   key … 保存するときの名前   url … URL での名前   def … 初期値   ids … 画面の入力欄（変えたら保存する）
//   read() … 画面から今の値を読む        write(v) … 画面に値を入れる（おかしな値は無視する）
//   fromUrl(文字) … URL の値を読む（読めなければ undefined）   toUrl(v) … URL に書く文字
export function onOffWord(v) {
  v = v.toLowerCase();
  if (v === 'on' || v === '1' || v === 'true') return true;
  if (v === 'off' || v === '0' || v === 'false') return false;
  return undefined;
}

// フレームレートを一般的な値（29.97→30 など）に寄せる
export function snapFps(fps) {
  if (!(fps > 0) || !isFinite(fps)) return null;
  var common = [10, 12, 15, 20, 24, 25, 30, 48, 50, 60, 90, 120];
  var best = null, bestErr = Infinity;
  for (var i = 0; i < common.length; i++) {
    var err = Math.abs(fps - common[i]) / common[i];
    if (err < bestErr) { bestErr = err; best = common[i]; }
  }
  return bestErr < 0.08 ? best : Math.round(fps * 10) / 10;
}

export function estimateFps(times) {
  if (!times || times.length < 6) return null;
  var deltas = [];
  for (var i = 1; i < times.length; i++) {
    var dt = times[i] - times[i - 1];
    if (dt > 0.0005 && dt < 1) deltas.push(dt);
  }
  if (deltas.length < 4) return null;
  deltas.sort(function (a, b) { return a - b; });
  return snapFps(1 / deltas[Math.floor(deltas.length / 2)]);
}

// 音声の扱い（mode: aac＝AAC に変換・copy＝そのまま・none＝なし。note は圧縮する前に知らせる文）
export function aacAudio() { return { mode: 'aac', bps: AUDIO_BITRATE, label: 'AAC ' + fmtRate(AUDIO_BITRATE), note: null }; }
export function noAudio(note, label) { return { mode: 'none', bps: 0, label: label || 'なし', note: note || null }; }

export function resolutionCap(meta, res) {
  if (res === 'source') return 1;   // 元の解像度のまま
  var limit = res === '1080' ? 1080 : res === '480' ? 480 : 720;
  var shortSide = Math.min(meta.width, meta.height);
  return shortSide > limit ? limit / shortSide : 1;   // 拡大はしない
}

// videoCapBps: 映像ビットレートの上限を直接指定する（トリミングのみで目標を超えたとき、切り出した部分の実測値を使う）。
//   省略時は、ファイル全体の平均ビットレート（元が HEVC なら1.5倍）を上限にする
export function makePlan(meta, trim, settings, audio, fileSize, forcedVideoBitrate, videoCapBps) {
  var duration = Math.max(0.1, trim.end - trim.start);
  var srcFps = meta.fps || DEFAULT_FPS;
  // 「30fps」（halfFps）：40fps を超える動画は、30fps 以下になるまで元の fps を 2・3・4…で割る
  // （コマを等間隔に間引く。60→30、59.94→29.97、90→30、120→30、50→25）
  var outFps = (settings.halfFps && srcFps > 40) ? srcFps / Math.ceil(srcFps / 30.5) : srcFps;
  outFps = Math.min(Math.max(outFps, 1), MAX_FPS);
  // 音声をそのまま使うときは実測値（小数）なので、整数にしてから使う
  var audioBps = Math.round(audio.bps || 0);
  // 解像度は選んだもので固定（元より大きくはしない）。容量はビットレートだけで調整する
  var scale = resolutionCap(meta, settings.res);
  var width = even(meta.width * scale);
  var height = even(meta.height * scale);
  // 元の解像度の下限は、720p の下限を画素数に比例させる（1080p の既定値 2700kbps も同じ考え方）
  var floorBps = settings.res === 'source'
    ? Math.max(MIN_KBPS_LIMITS[0] * 1000, Math.round(settings.minBitrate['720'] * width * height / (1280 * 720)))
    : settings.minBitrate[settings.res];
  if (outFps > 40) floorBps = Math.round(floorBps * HIGH_FPS_FLOOR_FACTOR);
  // 元動画より高いビットレートで焼き直しても容量が増えるだけなので上限を設ける（元の実効ビットレート。HEVC なら1.5倍）
  var srcBps = meta.duration > 0 ? fileSize * 8 / meta.duration : Infinity;
  var capRatio = meta.videoCodec === 'hevc' ? SRC_CAP_RATIO_HEVC : SRC_CAP_RATIO;
  var srcCap = videoCapBps ? Math.floor(videoCapBps * capRatio) : Math.floor(srcBps * capRatio) - audioBps;
  var capOk = isFinite(srcCap) && srcCap > 100000;
  // この計画の下限。元動画のビットレートがもともと下限より低い動画には、下限（画質をこれ以上落とさないための値）は
  // 当てはまらないので、設定で選べる最小値にする。初回の計画・圧縮し直し・「◯分まで収まる」の目安で同じ値を使う
  var minBps = capOk && srcCap < floorBps ? MIN_KBPS_LIMITS[0] * 1000 : floorBps;
  var videoBps, unreachable = false, budgetBps = Infinity;

  if (settings.mode === 'quality') {
    // なるべく圧縮: 設定の下限ビットレートで圧縮する（元動画が低ければ、下の上限で元に合わせる）
    videoBps = floorBps;
  } else if (forcedVideoBitrate) {
    // 再圧縮: 実サイズから求め直した値（この計画の下限は下回らない）
    videoBps = Math.max(minBps, Math.floor(forcedVideoBitrate));
  } else {
    // ◯MB以内に圧縮: 目標サイズに収まるなるべく高いビットレート。この計画の下限を下回るなら圧縮できない
    budgetBps = Math.floor(settings.targetBytes * 8 * SIZE_SAFETY / duration - audioBps);
    videoBps = budgetBps;
    if (videoBps < minBps) { unreachable = true; videoBps = minBps; }
  }

  if (capOk && videoBps > srcCap) videoBps = srcCap;
  // ビットレートは必ず整数にする（小数だと Mediabunny が例外を出し、0%のまま止まっていた）
  videoBps = Math.floor(videoBps);
  // 元動画のビットレートがもともと低く、上限（元のビットレート）で目標に収まるなら、下限を割っても収められる
  // （下限は画質をこれ以上落とさないための値で、元がそれより低い動画には当てはまらない）
  if (unreachable && videoBps <= budgetBps) unreachable = false;

  var estBytes = Math.round((videoBps + audioBps) * duration / 8);
  return {
    mode: settings.mode, res: settings.res, halfFps: settings.halfFps,
    wantAudio: !!settings.audio,                     // 「音声を残す」（圧縮を始めたときの設定。やり直しでもこれを使う）
    targetMB: settings.targetMB, targetBytes: settings.targetBytes, minBitrate: settings.minBitrate,
    preUseRatio: settings.preUseRatio,
    trimStart: trim.start, trimEnd: trim.end, duration: duration,
    srcFps: srcFps, outFps: outFps, fpsChanged: Math.abs(outFps - srcFps) > 0.05,
    width: width, height: height, videoBitrate: videoBps, floorBitrate: minBps, videoCapBps: videoCapBps || null,
    audio: audio, audioBitrate: audioBps,
    estBytes: estBytes,
    unreachable: unreachable,                        // 目標サイズに収められない（◯MB以内に圧縮のとき）
    overDiscord: estBytes > DISCORD_FREE_BYTES       // Discord無料アカウントの上限を超える見込み
  };
}

// 計画の音声のバイト数
export function audioBytesOf(plan) { return plan.audioBitrate * plan.duration / 8; }

// 書き出した実サイズから、目標に収まる映像ビットレートを計算し直す（無理なら null）
export function nextBitrate(plan, videoBytes, audioBytes) {
  var allowed = plan.targetBytes * SIZE_SAFETY - (audioBytes || 0);
  if (!(allowed > 0) || !(videoBytes > 0)) return null;
  var ratio = Math.max(0.3, Math.min(0.95, allowed / videoBytes));   // 最低5%は下げ、下げすぎない
  var next = Math.floor(plan.videoBitrate * ratio);
  return next >= 100000 ? next : null;
}
// 「◯MB以内」でも、先行圧縮を切り出した大きさが目標のこの割合以上（かつ目標未満）なら、先行圧縮をそのまま使う
// （目標いっぱいまで使って圧縮し直しても、大きさ・画質はほとんど変わらないので、すぐ出せる方を選ぶ。
// 指定の約2倍で書き出す端末（Android・Windows）では、圧縮し直すと1回目が目標を超え、何回も圧縮し直したうえで
// 先行圧縮とほぼ同じ大きさになることがある（Android：先行圧縮 18.6MB を使わず、3回圧縮して 19.4MB）。余裕をもって80%にする）
// 詳細設定の「許容する最小サイズ」（％。PRE_USE_PCT_DEFAULT）で変えられる。100% にすると、「◯MB以内」では先行圧縮を使わない
export function preUseRatioOf(plan) { return plan.preUseRatio > 0 ? plan.preUseRatio : PRE_USE_PCT_DEFAULT / 100; }
// 先行圧縮の中身を決めるもの（これが変わったら先行圧縮をやり直す）
export function preKey(pp) {
  return pp.width + 'x' + pp.height + '@' + Math.round(pp.outFps) + '/' + pp.videoBitrate + '/' + pp.audio.mode + '/' + pp.audioBitrate;
}
// 先行圧縮で書き出した量から、範囲の映像のビットレートの予想を出す（まだどこも書き出していなければ null）
//   済んだ所 … 書き出した区切りごとの実測（音声の分を引く）。まだの所 … 済んだ所（動画全体のうち）の平均
//   bps      … 本番で指定するビットレート（下限より高いとき）。区切りごとに「指定」と「実測」の大きい方になるとみる
//              （下限の実測がそれより高い場面は、エンコーダーがそこまでしか下げられない）
export function preEstimate(plan, rec, bps) {
  var a = plan.trimStart, b = plan.trimEnd, marks = rec.marks, audio = rec.plan ? rec.plan.audioBitrate : 0;
  var inBits = 0, inSec = 0, allBits = 0, allSec = 0;
  for (var i = 1; i < marks.length; i++) {
    var s0 = marks[i - 1].t, s1 = marks[i].t;
    if (!(s1 > s0)) continue;
    var v = Math.max(bps || 0, (marks[i].bytes - marks[i - 1].bytes) * 8 / (s1 - s0) - audio, 0);
    allBits += v * (s1 - s0);
    allSec += s1 - s0;
    var ov = Math.min(s1, b) - Math.max(s0, a);
    if (ov > 0) { inBits += v * ov; inSec += ov; }
  }
  if (!allSec) return null;
  var rest = Math.max(0, (b - a) - inSec);
  return { videoBps: Math.round((inBits + rest * allBits / allSec) / (b - a)), covered: Math.min(1, inSec / (b - a)) };
}
// 画面の予想の後ろに付ける、先行圧縮の状況
// 予想の行
//   現在の設定：720p/30fps/1分00秒/1.2Mbps
//   → 7.5MB（予想・先行圧縮 60%）… 先行圧縮が使えて、切り出す大きさが分かっていれば「確定・先行圧縮済み」
//   目標サイズに収まらなければ、次の行に「◯分◯秒以内で20MBに収まります。」（先行圧縮で測れたビットレートか、指定のビットレートから）
// 目標サイズに収まる長さの目安（秒）。先行圧縮で測れていれば、その実際のビットレートから（plan.fitSec）、
// なければ、この計画の下限ビットレートから。予想の行・2 の注意・トリミングの帯で同じ値を使う
export function fitSecOf(plan) {
  if (plan.probed && plan.fitSec) return plan.fitSec;
  return Math.floor(plan.targetBytes * 8 * SIZE_SAFETY / (plan.floorBitrate + plan.audioBitrate));
}
// 目標サイズに収まらない見込みか（「◯MB以内」で下限でも収まらない・先行圧縮の目安を超える・予想が目標以上）
export function isOverTarget(plan, trimEst) {
  if (trimEst || plan.preFits) return false;
  return (plan.mode === 'size' && plan.unreachable) || !!plan.probeOver || plan.estBytes >= plan.targetBytes;
}

// ---- 先行圧縮の区切り（fragmented MP4）の表を読む。1コマごとの大きさ・時刻・キーフレームかどうかが分かるので、
// 範囲を切り出したときの大きさを正確に予想できる（区切りの途中で切ると、割合で数えるより正確。
// 区切りの頭はキーフレームで大きいので、割合で数えると小さめに出ていた）
// 切り出した mp4 の見出し（目次など）の大きさの目安（バイト）。実測では 1000＋1コマ（音声の1区切り）あたり約4.5バイト。
// 少し多めに見込む（予想は小さく外れるより、大きく外れる方がよい）
export var CUT_OVERHEAD_BASE = 1000;
export var CUT_OVERHEAD_PER_SAMPLE = 5;
// 範囲を切り出したときの大きさ（バイト）。先行圧縮がまだ範囲の終わりまで届いていなければ null
//   映像は、切り出すときと同じく、範囲の始まり以前でいちばん近いキーフレームから数える（音声は範囲の始まりから）。
//   キーフレームから範囲の始まりまでは再生されないが、ファイルには入る
export function exactCutBytes(plan, rec) {
  var v = rec.samples && rec.samples.video;
  if (!v || !v.length) return null;
  var a = plan.trimStart, b = plan.trimEnd, eps = 1e-4, last = v[v.length - 1];
  if (!rec.done && last.t + last.d < b - eps) return null;
  var start = v[0].t;
  for (var i = 0; i < v.length && v[i].t <= a + eps; i++) if (v[i].k) start = v[i].t;
  var bytes = 0, n = 0;
  [[v, start], [rec.samples.audio, a]].forEach(function (pair) {
    pair[0].forEach(function (x) {
      if (x.t >= pair[1] - eps && x.t < b - eps) { bytes += x.s; n++; }
    });
  });
  return bytes + CUT_OVERHEAD_BASE + CUT_OVERHEAD_PER_SAMPLE * n;
}

export function describePlan(plan) {
  return plan.res + ' ' + plan.width + 'x' + plan.height + ' mode=' + plan.mode + ' ' + Math.round(plan.videoBitrate / 1000) + 'kbps' +
    ' fps=' + plan.srcFps + '→' + plan.outFps + ' audio=' + plan.audio.mode +
    ' trim=' + plan.trimStart.toFixed(1) + '-' + plan.trimEnd.toFixed(1) + 's';
}

// 計画を作り直すときに、元の計画と同じ設定を渡す
export function planSettings(plan) {
  return {
    mode: plan.mode, res: plan.res, halfFps: plan.halfFps, audio: plan.wantAudio,
    targetMB: plan.targetMB, targetBytes: plan.targetBytes, minBitrate: plan.minBitrate, preUseRatio: plan.preUseRatio
  };
}

// ---------------------------------------------------------------- 圧縮1回ぶんが終わったあとの判断（run.js）
// 書き出せたあと、圧縮し直すか（「◯MB以内」で目標以上のときだけ。回数は MAX_ATTEMPTS まで）
//   size         … 書き出した大きさ。index … 何回目か（0から）
//   prevSize     … 前回の大きさ（圧縮し直したとき）。previousSize … 圧縮し直す前の結果の大きさ（なければ null）
// 返す値
//   { kind: 'done' }                … 圧縮し直さない（目標未満・なるべく圧縮・回数の上限・これ以上下げられない）
//   { kind: 'retry', bitrate }      … 実際の大きさから求め直したビットレート（下限は下回らない）で圧縮し直す
//   { kind: 'floor', usePrevious }  … 圧縮し直しても MIN_SHRINK 以上小さくならなかった（下げても減らない端末）。
//                                     usePrevious なら、前の結果の方が小さい（か同じ）ので、前の結果を使う
export function retryAfterSize(plan, size, index, prevSize, previousSize) {
  if (plan.mode !== 'size' || size < plan.targetBytes || index + 1 >= MAX_ATTEMPTS) return { kind: 'done' };
  if (index > 0 && prevSize > 0 && size > prevSize * (1 - MIN_SHRINK)) {
    return { kind: 'floor', usePrevious: previousSize !== null && previousSize !== undefined && previousSize <= size };
  }
  var audioBytes = audioBytesOf(plan);
  var next = nextBitrate(plan, size - audioBytes, audioBytes);
  if (next) next = Math.max(next, plan.floorBitrate);
  if (!next || next >= plan.videoBitrate) return { kind: 'done' };
  return { kind: 'retry', bitrate: next };
}

// 失敗・停止したあと、どうやり直すか（上から順に、最初に当てはまるもの）
//   'background' … 途中で別のアプリに切り替えていた（MAX_BG_RETRIES 回まで）。失敗は動画のせいではない（iPhone は裏に回ると
//                  読み込み・書き出しを壊す）ので、方式を変えずに、画面に戻るのを待ってから最初からやり直す
//   'previous'   … 圧縮し直している途中で失敗した。その前にできた結果を使う
//   'audio'      … 高速モードで元の音声をそのまま使い、音声のことで失敗した（停止ではない・まだ試していない）。
//                  音声を作り直すか外して、高速モードのままやり直す（映像の失敗では音声を外さない）
//   'fast'       … トリミングのみで失敗した。高速モードでやり直す
//   'compat'     … 高速モードで扱えなかった（1回目か、停止した）。互換モードが使えればやり直す
//   'stalled'    … 停止したまま。あきらめる（止まった旨のエラー）
//   'error'      … あきらめる（そのエラー）
// f … { wentHidden, bgRetries, index, hasPrevious, engine, audioMode, stalled, audioRetried, audioError, compatAvailable }
export function recoveryAfterFailure(f) {
  if (f.wentHidden && f.bgRetries < MAX_BG_RETRIES) return 'background';
  if (f.index > 0 && f.hasPrevious) return 'previous';
  if (f.engine === 'fast' && f.audioMode === 'copy' && !f.stalled && !f.audioRetried && f.audioError) return 'audio';
  if (f.engine === 'copy') return 'fast';
  if (f.engine === 'fast' && (f.index === 0 || f.stalled) && f.compatAvailable) return 'compat';
  return f.stalled ? 'stalled' : 'error';
}
