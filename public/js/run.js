// 圧縮の実行：方式の選択、圧縮し直し、互換モードへの切り替え、別のアプリに切り替えたときのやり直し、画面スリープ防止

import { BG_STALL_MS, CANCELLED, CLEANUP_WAIT_MS, DECODER_CHECK_MS, FAIL_SETTLE_MS, FROZEN_GAP_MS, MB, MSG_BG_RETRY, STALLED, STALL_MS } from './constants.js';
import { aacAudio, describePlan, fmtBytes, fmtRate, makePlan, noAudio, planSettings, recoveryAfterFailure, retryAfterSize } from './calc.js';
import { els } from './dom.js';
import { state } from './state.js';
import { errText, isCancel, log, newJob, secondsSince, setAlert, setPhase, setProgress, show, showDiag, sleep, stopJob, throwIfCancelled, waitVisible } from './util.js';
import { MSG_AUDIO_COPY_FAILED, MSG_REPORT, MSG_STALLED, audioStrategy, codecStuckError, errorLines, withinDecoderCheck } from './media.js';
import { currentPlan } from './plan.js';
import { notifyUpdate, refresh, showResult } from './view.js';
import { convertCopy, convertFast, trimOnlyEstimate } from './fast.js';
import { finishFromPrecompress, logEstimate, pre, precompressUsable, precompressWhyNot, stopPre } from './precompress.js';
import { convertCompat } from './compat.js';

// ---------------------------------------------------------------- 実行
// 音声のことで失敗したか（Mediabunny の音声の形式の検査など）
export function isAudioError(err) { return /audio|aac|mp4a/i.test(errText(err)); }

// 1回ぶんの処理の見張り。別のアプリに切り替えたかと、進捗が止まったままかを見る。
// iPhone は裏に回ると動画の読み込み・書き出しを止めたり壊したりする。
// iPhone でブラウザを閉じた（ホーム画面に戻った）ときは、画面が隠れた知らせが届かないか、戻ってから遅れて届くことがあるので、
// ページが止められていたこと（1秒ごとの見回りの間が空いた）でも見分ける
//   onStall(limit, done) … 止まったとみなしたとき（limit: 待った時間（ミリ秒）、done: そこまでの進捗 0〜1）。見回りはそこで止まる
//   quick … 最初から早めに見切る（別のアプリから戻ってやり直すとき）
//   onReturn() … 別のアプリから画面に戻ったとき
export function watchAttempt(onStall, quick, onReturn) {
  var lastVal = -1, idleMs = 0, lastTick = Date.now(), hidden = false;
  function markHidden(why) {
    if (!hidden) log('画面から離れた（' + why + '）');
    hidden = true;
  }
  // ページが止められていたか（見回りは1秒ごとなので、それより大きく間が空いたら止められていた）
  function checkFrozen() {
    var gap = Date.now() - lastTick;
    if (gap > FROZEN_GAP_MS) markHidden('ページが' + (gap / 1000).toFixed(1) + '秒止まっていた');
  }
  function onVisibility() {
    if (document.visibilityState !== 'visible') { markHidden('visibilitychange'); return; }
    idleMs = 0;   // 戻ってからの時間で、止まっているかを判断する
    if (hidden) {
      log('画面に戻った');
      if (onReturn) onReturn();
    }
  }
  function onLeave(e) { markHidden(e.type); }

  if (document.visibilityState !== 'visible') markHidden('開始時に非表示');
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onLeave);
  document.addEventListener('freeze', onLeave);
  // 画面を表示しているのに進捗が止まったままなら、止まったとみなす（裏に回っていた時間は数えない）
  var timer = setInterval(function () {
    checkFrozen();
    var now = Date.now(), dt = now - lastTick;
    lastTick = now;
    if (document.visibilityState !== 'visible' || dt > 5000) return;
    idleMs += dt;
    // 別のアプリから戻ったあとは、止まっていたら早めに見切る（裏に回って処理が止まったままのことがある）
    var limit = (hidden || quick) ? BG_STALL_MS : STALL_MS;
    if (idleMs >= limit) {
      clearInterval(timer);
      onStall(limit, Math.max(0, lastVal));
    }
  }, 1000);

  return {
    progress: function (p) { if (p > lastVal + 0.0005) { lastVal = p; idleMs = 0; } },   // 進捗が届いたとき
    lastProgress: function () { return lastVal; },
    wentHidden: function () { return hidden; },   // この処理の途中で別のアプリに切り替えたか
    checkFrozen: checkFrozen,
    stopTimer: function () { clearInterval(timer); },   // 見回りだけ止める
    end: function () {   // 見張りをすべてやめる
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('freeze', onLeave);
    }
  };
}

// 選んだ動画のデコーダーが応答するか（応答しなければ codecStuckError。対応していないなどの失敗はここでは問わない）
// job がキャンセルされていたら、結果は書かない
export function decoderResponds(job) {
  var codec = state.meta && state.meta.codecString;
  if (!codec || typeof VideoDecoder === 'undefined') return Promise.resolve();
  var p;
  try { p = VideoDecoder.isConfigSupported({ codec: codec, codedWidth: state.meta.width, codedHeight: state.meta.height }); } catch (e) { return Promise.resolve(); }
  return withinDecoderCheck(p).then(function () { /* noop */ }, function (e) {
    if (e && e.stuck) {
      if (!job.cancelled) log('デコーダーが応答しない（' + DECODER_CHECK_MS / 1000 + '秒）');
      throw e;
    }
  });
}

// 別のアプリから戻ったあと、動画の読み込みとデコーダーが応答するかを確かめ、診断情報に書く。
// デコーダーが応答しなければ codecStuckError で失敗する（やり直しても互換モードでも進まないので、開き直してもらう）。
// 裏に回っている間はデコーダーが応答しないのが普通なので、確かめている間ずっと画面を表示していたときだけ判断する
export function checkAfterBackground(job) {
  return waitVisible(job).then(function () {
    var leftDuring = false, lastTick = Date.now();
    function onVisibility() { if (document.visibilityState !== 'visible') leftDuring = true; }
    // 知らせがないままページが止められていたことも見分ける（1秒ごとの見回りの間が空いた）
    var ticker = setInterval(function () {
      if (Date.now() - lastTick > FROZEN_GAP_MS) leftDuring = true;
      lastTick = Date.now();
    }, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    return checkResponses().then(function (r) {
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', onVisibility);
      if (Date.now() - lastTick > FROZEN_GAP_MS) leftDuring = true;
      if (leftDuring || document.visibilityState !== 'visible') {
        log('確かめている間に画面から離れたため、戻ってから確かめ直す');
        return checkAfterBackground(job);
      }
      if (r[1] === '応答なし') throw codecStuckError();
    });
  });
}
export function checkResponses() {
  var t = Date.now();
  function check(what, start) {
    var p;
    try { p = Promise.resolve(start()); } catch (e) { p = Promise.reject(e); }
    return Promise.race([
      p.then(function () { return 'OK'; }, function (e) { return '失敗 ' + errText(e); }),
      sleep(DECODER_CHECK_MS).then(function () { return '応答なし'; })
    ]).then(function (r) {
      log('確認: ' + what + ' ' + r + '（' + secondsSince(t) + '）');
      return r;
    });
  }
  var codec = state.meta && state.meta.codecString;
  return Promise.all([
    check('動画の読み込み', function () { return state.file.slice(0, 65536).arrayBuffer(); }),
    codec && typeof VideoDecoder !== 'undefined' ? check('デコーダー', function () {
      return VideoDecoder.isConfigSupported({ codec: codec, codedWidth: state.meta.width, codedHeight: state.meta.height });
    }) : null
  ]);
}

// 圧縮の流れ：準備（先行圧縮を使うか・デコーダーが応答するか）→ 1回ぶんの圧縮（attempt）→ 結果かエラー。
// 1回ぶんが終わったあとの判断は、計算だけの関数にまとめてある（calc.js。単体テストあり）
//   retryAfterSize        … 書き出せたあと、「◯MB以内」で目標を超えていたら圧縮し直すか
//   recoveryAfterFailure  … 失敗・停止したあと、どうやり直すか
// 圧縮1回の流れで共有するもの（ctx）
//   job          … この圧縮全体（キャンセルはこれを止める）
//   plan, engine … 今の計画と方式（'copy'＝トリミングのみ・'fast'＝高速モード・'compat'＝互換モード）。やり直しで変わり、結果の欄はこれで出す
//   usePre       … そのまま使う先行圧縮（使わなければ null）。preTried … 先行圧縮を使ったか（使えるのは最初の1回だけ）
//   bgRetries    … 別のアプリに切り替えたためにやり直した回数
//   lastGood     … 圧縮し直す前にできた結果と、その計画（{ res, plan }。圧縮し直しに失敗したら、こちらを使う）
//   audioRetried … 元の音声をそのまま使えず、音声を作り直す（外す）やり直しをした
export function run() {
  if (!state.file || state.running) return;
  var ctx = {
    job: null, plan: currentPlan(), engine: state.engine, usePre: null, preTried: false,
    bgRetries: 0, lastGood: null, audioRetried: false, started: Date.now()
  };
  if (ctx.engine === 'fast' && trimOnlyEstimate(ctx.plan)) ctx.engine = 'copy';   // トリミングのみ（再エンコードしない）
  var job = ctx.job = state.job = newJob();
  state.running = true;
  setRunningUi(true);
  requestWakeLock();
  showDiag(false);
  log('圧縮開始 ' + describePlan(ctx.plan) + ' engine=' + ctx.engine);
  logEstimate(ctx.plan);
  var probeStopped = choosePrecompress(ctx);
  // デコーダーが固まったまま（iPhone で、前の圧縮中に別のアプリに切り替えたときなど）なら、始める前に開き直すよう案内する
  var ready = Promise.race([probeStopped, sleep(CLEANUP_WAIT_MS), job.aborted]).then(function () {
    throwIfCancelled(job);
    return ctx.engine === 'copy' ? null : Promise.race([decoderResponds(job), job.aborted]);
  });
  return ready.then(function () {
    throwIfCancelled(job);
    return attempt(ctx, 0);
  }).then(function (res) {
    finishWithResult(ctx, res);
  }, function (err) {
    finishWithError(ctx, err);
  });
}

// 設定を変えておらず、先行圧縮が範囲の始まりまで届いていれば（「◯MB以内」では、切り出した大きさが許容する最小サイズ以上・目標未満なら）、
// 先行圧縮をそのまま使う。使わない先行圧縮の途中なら止める（エンコーダーなどを片付け終わるのを待つ Promise を返す）
function choosePrecompress(ctx) {
  var usePre = ctx.engine === 'fast' && precompressUsable(ctx.plan);
  ctx.usePre = usePre || null;
  if (usePre) {
    log('先行圧縮を使う（' + (usePre.done ? '完了済み' : usePre.time.toFixed(1) + '秒まで済み') + '）');
    // 「◯MB以内」は先行圧縮のビットレート（下限）で圧縮したことになるので、結果の欄と圧縮し直しの判断もその値で行う
    if (ctx.plan.mode === 'size') ctx.plan = replan(ctx.plan, { bitrate: usePre.plan.videoBitrate });
  } else if (pre && pre.file === state.file && ctx.engine === 'fast') log('先行圧縮は使わない（' + precompressWhyNot(ctx.plan) + '）');
  return usePre ? Promise.resolve() : stopPre('圧縮を開始', true);
}

// 1回ぶんの圧縮。進まなくなったら、この1回（a.aj）だけ止めて、別の方式でやり直す
//   index    … 何回目か（0から。圧縮し直すと増える。方式を変えたら0に戻す）
//   prevSize … 前回の圧縮結果のサイズ（圧縮し直すときに表示する）
//   note     … 進捗の欄に出す補足（なければ方式と回数から決める）
//   afterBg  … 別のアプリから戻ってのやり直し（iPhone は戻ったあとも動画の読み込み・書き出しが固まったままのことがあるので、
//              進まなければ早めに見切って互換モードに切り替える）
function attempt(ctx, index, prevSize, note, afterBg) {
  var label = note || attemptLabel(ctx.engine, index, prevSize);
  setProgress(0, label);
  var a = { index: index, prevSize: prevSize, aj: null, t0: 0, watch: null, stuckErr: null };
  a.aj = state.attemptJob = newJob();
  a.t0 = Date.now();
  a.watch = watchCurrentAttempt(ctx, a, afterBg);
  var task = startTask(ctx, a, progressReporter(ctx, a, label));
  task.catch(function () { /* 競争に負けた側の失敗は無視する */ });
  // キャンセルしたら、ライブラリ側が止まりきるのを待たずにすぐ抜ける
  return Promise.race([task, ctx.job.aborted, a.aj.aborted]).then(function (res) {
    a.watch.end();
    throwIfCancelled(ctx.job);
    log('完了 ' + fmtBytes(res.blob.size) + '（' + secondsSince(a.t0) + '）');
    return afterSuccess(ctx, a, res);
  }, function (err) {
    return afterError(ctx, a, err);
  });
}

function attemptLabel(engine, index, prevSize) {
  if (index > 0) return '圧縮結果が' + (prevSize / MB).toFixed(2) + 'MBで目標超過→再圧縮中（' + (index + 1) + '回目）';
  return engine === 'copy' ? 'トリミング中（再圧縮なし）' : engine === 'fast' ? '圧縮中' : '圧縮中（互換モード：再生しながら処理）';
}

// この1回の見張り：進捗が止まったら止める。別のアプリから戻ったら、すぐデコーダーを確かめ、固まっていれば、
// 止まったと判断するのを待たずに、開き直すよう案内する（a.stuckErr）
function watchCurrentAttempt(ctx, a, afterBg) {
  var watch = watchAttempt(function (limit, done) {
    log('進捗が' + Math.round(limit / 1000) + '秒止まったため中断（' + Math.round(done * 100) + '%）');
    if (!watch.wentHidden()) showDiag(true);   // 別のアプリに切り替えたせいなら、やり直すだけなので開かない
    stopJob(a.aj, STALLED);
  }, afterBg, function () {
    if (ctx.engine === 'copy') return;   // トリミングのみはデコーダーを使わない
    var progressAtReturn = watch.lastProgress();
    checkAfterBackground(a.aj).then(null, function (e) {
      if (!e || !e.stuck || a.aj.cancelled || ctx.job.cancelled) return;
      if (watch.lastProgress() > progressAtReturn) return;   // 進み始めていれば、固まっていない
      log('画面に戻ったあと、デコーダーが応答しない');
      a.stuckErr = e;
      stopJob(a.aj, STALLED);
    });
  });
  return watch;
}

// 進捗を見張りと画面に伝える（10%ごとに診断情報にも書く）。キャンセル後に古い処理から届く進捗は無視する
function progressReporter(ctx, a, label) {
  var nextLog = 0;
  return function (p) {
    if (ctx.job.cancelled || a.aj.cancelled) return;
    a.watch.progress(p);
    if (p >= nextLog) {
      log('進捗 ' + Math.round(p * 100) + '%（' + secondsSince(a.t0) + '）');
      nextLog = Math.floor(p * 10 + 1) / 10;
    }
    setProgress(p, label);
  };
}

// 方式ごとの変換を始める（先行圧縮を使えるのは最初の1回だけ。やり直すときは普通に圧縮する）
function startTask(ctx, a, onProgress) {
  var fromPre = ctx.engine === 'fast' && a.index === 0 && ctx.usePre && !ctx.preTried;
  if (fromPre) ctx.preTried = true;
  if (ctx.engine === 'copy') return convertCopy(ctx.plan, onProgress, a.aj);
  if (fromPre) return finishFromPrecompress(ctx.usePre, ctx.plan, onProgress, a.aj);
  return ctx.engine === 'fast' ? convertFast(ctx.plan, onProgress, a.aj) : convertCompat(ctx.plan, onProgress, a.aj);
}

// ---- 書き出せたあと：圧縮し直すかを決める（し直さなければ結果を返す）
function afterSuccess(ctx, a, res) {
  if (ctx.engine === 'copy') {
    if (res.blob.size >= ctx.plan.targetBytes) return retryCopyAsCompress(ctx, res);
    res.attempts = 1;
    return res;
  }
  if (res.audioDropped && ctx.plan.audio.mode !== 'none') {
    ctx.plan.audio = noAudio();
    ctx.plan.audioBitrate = 0;
  }
  var next = retryAfterSize(ctx.plan, res.blob.size, a.index, a.prevSize, ctx.lastGood ? ctx.lastGood.res.blob.size : null);
  if (next.kind === 'floor') {
    // 圧縮し直しても小さくならなかったら、ビットレートを下げても減らない見込みなので、それ以上は圧縮し直さない
    log('圧縮し直しても小さくならないため、圧縮し直しをやめる');
    res.deviceFloor = true;
    if (next.usePrevious) return usePrevious(ctx, a, '前回の結果の方が小さいため、前回の結果を使う', true);
  } else if (next.kind === 'retry') {
    // 「◯MB以内に圧縮」で目標を超えたら、実際のサイズから求め直したビットレートで、圧縮し直す
    ctx.lastGood = { res: res, plan: ctx.plan };
    ctx.plan = replan(ctx.plan, { bitrate: next.bitrate });
    log('再圧縮 映像 ' + fmtRate(ctx.plan.videoBitrate));
    return attempt(ctx, a.index + 1, res.blob.size);
  }
  res.attempts = a.index + 1;
  return res;
}

// 圧縮し直す前にできた結果を使う
function usePrevious(ctx, a, message, deviceFloor) {
  log(message);
  ctx.plan = ctx.lastGood.plan;
  ctx.lastGood.res.attempts = a.index;
  if (deviceFloor) ctx.lastGood.res.deviceFloor = true;
  return ctx.lastGood.res;
}

// トリミングのみで目標を超えたら、通常の圧縮に切り替える
function retryCopyAsCompress(ctx, res) {
  log('トリミングのみでは目標を超えたため、通常の圧縮に切り替え');
  ctx.engine = 'fast';
  // 予想を超えたのは、切り出した部分がファイル全体の平均より重いから。
  // 全体の平均で頭打ちにすると必要以上に小さくなるので、切り出した部分の実測値を上限にして計画し直す
  var copyVideoBps = Math.floor(res.blob.size * 8 / ctx.plan.duration) - Math.round(ctx.plan.audio.bps || 0);
  ctx.plan = replan(ctx.plan, { cap: copyVideoBps });
  log('計画し直し ' + describePlan(ctx.plan));
  return attempt(ctx, 0, 0, 'トリミングのみでは' + (res.blob.size / MB).toFixed(2) + 'MBで目標超過→圧縮中');
}

// ---- 失敗・停止したあと
function afterError(ctx, a, err) {
  var watch = a.watch;
  watch.checkFrozen();   // 止められていたページが再開した直後に失敗が届くことがある（見回りより先に）
  // 見回りは止めるが、画面が隠れた知らせは下で少し待つあいだも受け取る
  watch.stopTimer();
  if (ctx.job.cancelled || (!a.aj.cancelled && isCancel(null, err))) { watch.end(); throw new Error(CANCELLED); }
  // デコーダーが固まっていたら、やり直しても互換モードでも進まないので、開き直すよう案内する
  if (a.stuckErr) { watch.end(); throw a.stuckErr; }
  var stalled = a.aj.cancelled;
  if (!stalled) log('失敗（' + ctx.engine + '）' + errText(err));
  // iPhone では、別のアプリに切り替え始めた瞬間に読み込みが壊れて失敗し、画面が隠れた知らせはその直後に届く。
  // すぐには決めず、少し待ってから別のアプリに切り替えたかを見る（切り替えていなければ、少し遅れて互換モードにするだけ）
  var settle = watch.wentHidden() ? Promise.resolve() : sleep(FAIL_SETTLE_MS);
  return Promise.race([settle, ctx.job.aborted]).then(function () {   // 待っている間のキャンセルはすぐ効かせる
    watch.checkFrozen();
    watch.end();
    throwIfCancelled(ctx.job);
    return afterFailure(ctx, a, err, stalled);
  });
}

// どうやり直すかを決めて（recoveryAfterFailure）、やり直す
function afterFailure(ctx, a, err, stalled) {
  var step = recoveryAfterFailure({
    wentHidden: a.watch.wentHidden(), bgRetries: ctx.bgRetries, index: a.index, hasPrevious: !!ctx.lastGood,
    engine: ctx.engine, audioMode: ctx.plan.audio.mode, stalled: stalled, audioRetried: ctx.audioRetried,
    audioError: isAudioError(err), compatAvailable: !!state.caps.compat
  });
  switch (step) {
    case 'background': return retryAfterBackground(ctx, a);
    // （目標を超えていれば、結果の欄でそのことを知らせる）
    case 'previous': return usePrevious(ctx, a, '圧縮し直しに失敗したため、前の結果を使う', false);
    case 'audio': return retryWithoutAudioCopy(ctx);
    case 'fast':
      ctx.engine = 'fast';
      return attempt(ctx, 0);
    case 'compat':
      console.warn('高速モードに失敗したため互換モードに切り替えます:', err);
      log('互換モードに切り替え');
      ctx.engine = 'compat';
      ctx.plan = replan(ctx.plan, { audio: audioStrategy(state.meta, ctx.plan.wantAudio, 'compat') });
      return attempt(ctx, 0, 0, stalled ? '処理が進まないため、互換モードでやり直し中' : null);
    case 'stalled': throw new Error(MSG_STALLED);
    default: throw err;
  }
}

// 画面に戻るのを待ち、止めた処理の後片付けとデコーダーを確かめてから、同じ方式で最初からやり直す
function retryAfterBackground(ctx, a) {
  var job = ctx.job;
  ctx.bgRetries++;
  log('別のアプリに切り替えていたため、画面に戻ってから最初からやり直し（' + ctx.engine + '・' + ctx.bgRetries + '回目）');
  setProgress(0, MSG_BG_RETRY);
  var waited = document.visibilityState !== 'visible';
  return waitVisible(job).then(function () {
    if (waited) log('画面に戻った');
    // 止めた処理が動画の読み込み・書き出しを使ったままだと、やり直しが進まないことがあるので、後片付けを少し待つ
    if (!a.aj.stopped) return;
    var t = Date.now();
    return Promise.race([
      a.aj.stopped.then(function () { return '完了'; }),
      sleep(CLEANUP_WAIT_MS).then(function () { return '時間切れ'; }),
      job.aborted
    ]).then(function (r) { log('止めた処理の後片付け ' + r + '（' + secondsSince(t) + '）'); });
  }).then(function () {
    throwIfCancelled(job);
    if (ctx.engine === 'copy') return null;   // トリミングのみはデコーダーを使わない
    return Promise.race([checkAfterBackground(job), job.aborted]);
  }).then(function () {
    throwIfCancelled(job);
    return attempt(ctx, a.index, a.prevSize, MSG_BG_RETRY, true);
  });
}

// 元の音声をそのままコピーして音声のことで失敗したら（音声の設定データが壊れた動画など）、互換モードにせず、
// 音声を AAC に作り直して（読めて、AAC で書き出せるとき）、または音声を外して、高速モードのままやり直す
function retryWithoutAudioCopy(ctx) {
  ctx.audioRetried = true;
  var src = state.meta.audio || {};
  var audio = state.caps.aac && src.canDecode !== false ? aacAudio()
    : Object.assign(noAudio(MSG_AUDIO_COPY_FAILED), { afterFailure: true });
  log('元の音声をそのまま使えないため、' + (audio.mode === 'aac' ? '音声を AAC に作り直して' : '音声を外して') + '高速モードでやり直し');
  ctx.plan = replan(ctx.plan, { audio: audio });
  return attempt(ctx, 0);
}

// ---- 終わったあと
function finishWithResult(ctx, res) {
  setProgress(1, '完了');
  finishRun();
  showResult(res, ctx.plan, ctx.engine, (Date.now() - ctx.started) / 1000);
  refresh();   // 結果が入ってから、ボタンを「やり直す」にして設定を無効にする
}
function finishWithError(ctx, err) {
  finishRun();
  if (isCancel(ctx.job, err)) { log('キャンセル'); return; }
  console.error(err);
  log('エラーで終了 ' + errText(err));
  // エラーを出したら、3ステップの画面にも知らせる（見出しを「うまく圧縮できませんでした」にする）
  if (err && err.stuck) { setAlert(els.outWarn, errorLines(err.message), true); notifyUpdate(); return; }   // 直し方は決まっているので、診断情報は開かない
  setAlert(els.outWarn, ['エラー: ' + ((err && err.message) || String(err)),
    MSG_REPORT], true);
  showDiag(true);
  notifyUpdate();
}
// 同じ範囲・同じ設定のまま、一部だけ変えて計画し直す（再圧縮・互換モードへの切り替え・トリミングのみからの切り替え）
//   changes.audio   … 音声の扱い（省略時は今のまま）
//   changes.bitrate … 映像ビットレートを直接決める（再圧縮のとき）
//   changes.cap     … 映像ビットレートの上限（省略時は今のまま）
export function replan(plan, changes) {
  return makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
    changes.audio || plan.audio, state.file.size, changes.bitrate || null,
    changes.cap !== undefined ? changes.cap : plan.videoCapBps);
}

export function finishRun() {
  state.running = false;
  state.job = null;
  state.attemptJob = null;
  releaseWakeLock();
  setRunningUi(false);   // 画面の更新（refresh）もここで行う
}

export function setRunningUi(running) {
  els.app.classList.toggle('is-running', running);
  show(els.progressWrap, running);
  els.runBtn.classList.toggle('is-cancel', running);
  els.runBtn.disabled = false;
  if (running) {
    els.shareBtn.disabled = true;
    els.saveBtn.disabled = true;
  } else {
    els.shareBtn.disabled = !state.out;
    els.saveBtn.disabled = !state.out;
  }
  refresh();
}

export function cancelRun() {
  var job = state.job;
  if (!job || job.cancelled) return;
  setPhase('キャンセルしています…');
  // 後片付けを始め（止まりきるのは待たない）、実行はすぐに終わらせる。
  // Android などでエンコーダが止まりきらなくても、画面が固まらないようにするため
  stopJob(state.attemptJob, CANCELLED);
  stopJob(job, CANCELLED);
}

// ---------------------------------------------------------------- 画面スリープ防止
export function requestWakeLock() {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  if (state.wakeLock) return;   // すでに取れている
  navigator.wakeLock.request('screen').then(function (lock) {
    // 取れる前に圧縮が終わっていたら、すぐ外す（残ると画面が暗くならないままになる）
    if (!state.running) { try { lock.release(); } catch (e) { /* noop */ } return; }
    if (state.wakeLock && state.wakeLock !== lock) { try { state.wakeLock.release(); } catch (e) { /* noop */ } }
    state.wakeLock = lock;
    // 別のアプリに切り替えたときなど、自動で外れたら忘れる（戻ったときに取り直せるように）
    lock.addEventListener('release', function () { if (state.wakeLock === lock) state.wakeLock = null; });
  }).catch(function () { /* noop */ });
}
export function releaseWakeLock() {
  if (state.wakeLock) {
    try { state.wakeLock.release(); } catch (e) { /* noop */ }
    state.wakeLock = null;
  }
}
