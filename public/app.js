/*
 * 20MB圧縮 — 動画をDiscordに投稿できるサイズに圧縮するWebアプリ
 *
 * 処理方式は2つ:
 *   高速モード … Mediabunny の Conversion で、動画ファイルを直接デコード→再エンコードする（実時間より速い）
 *   互換モード … 高速モードで扱えない動画向け。<video> を再生しながら requestVideoFrameCallback で
 *                フレームを取り出し、WebCodecs でエンコードして Mediabunny で mp4 にまとめる
 *
 * 圧縮の方針（解像度は選んだ720p/1080pで固定し、ビットレートだけで容量を調整する）:
 *   なるべく圧縮 … 解像度ごとの「下限ビットレート」で圧縮する
 *   ◯MB以下で圧縮 … 下限を下回らない範囲で、目標サイズに収まるなるべく高いビットレートにする。
 *                   超えたら実サイズからビットレートを直し、最大2回まで再圧縮
 *
 * すべて端末内で完結し、外部にデータは送信しない。
 */
'use strict';

(function () {
  var M = window.Mediabunny;

  // ---------------------------------------------------------------- 定数
  var DEFAULT_TARGET_MB = 20;            // Discord無料アカウントの上限（2026年8月に10MBから引き上げ）
  var MIN_TARGET_MB = 1;
  var MAX_TARGET_MB = 500;
  var MB = 1000 * 1000;                  // 1MB = 100万バイト（iPhoneのファイル表示と同じ数え方）
  var TARGET_MARGIN = 0.005;             // 確実にDiscordに送れるよう、目標サイズから0.5%引いた値を上限にする（20MB→19.9MB）
  var SIZE_SAFETY = 0.95;                // 上限に対する安全係数（超えたら再圧縮するので攻める）
  var AUDIO_BITRATE = 128000;            // 音声を再エンコードするときのビットレート
  var AUDIO_COPY_MAX_BITRATE = 192000;   // これ以下のAACは再エンコードせずそのまま使う
  var DISCORD_FREE_BYTES = 20 * MB;     // Discord無料アカウントの上限（注意文の基準）
  // 下限ビットレートの既定値（kbps）。720p30で1.2Mbps、1080pは画素数に比例させて同等の画質
  var DEFAULT_MIN_KBPS = { '720': 1200, '1080': 2700 };
  var MIN_KBPS_LIMITS = [100, 50000];
  var MSG_UNREACHABLE = '目標サイズに圧縮できません。解像度を下げるか、詳細設定にて下限ビットレートを引き下げてください。';
  var MSG_OVER_DISCORD = '20MBを超える為、Discord(無料垢)では送信できません。';
  var DEFAULT_FPS = 30;
  var MAX_FPS = 60;
  var MAX_ATTEMPTS = 3;                  // 初回 + 最大2回の再圧縮
  var KEYFRAME_INTERVAL = 2;             // 秒
  var MIN_TRIM_LENGTH = 0.5;             // 秒
  var AUDIO_DECODE_MAX_BYTES = 400 * MB;   // 互換モードで音声を扱うファイルサイズの上限
  var CANCELLED = 'cancelled';

  // 出力に使うコーデック（優先順）。高速モードは Mediabunny の名前、互換モードは WebCodecs のコーデック文字列
  var FAST_VIDEO_CODECS = ['avc', 'hevc'];
  var FAST_AUDIO_CODEC = 'aac';
  var COMPAT_VIDEO_CODECS = [
    { codec: 'avc1.4D0028', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.42E028', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.640028', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.42E01F', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'hvc1.1.6.L123.B0', mb: 'hevc', extra: { hevc: { format: 'hevc' } } }
  ];
  var COMPAT_AUDIO_CODEC = { codec: 'mp4a.40.2', mb: 'aac' };
  // 高速モードで読める入力形式。iPhoneの撮影動画(mov)とSwitchの動画(mp4)が対象。それ以外は互換モードで処理する
  var INPUT_FORMATS = M ? [M.MP4, M.QTFF] : [];

  // ---------------------------------------------------------------- 要素
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    unsupported: $('unsupported'), file: $('file'), pickBtn: $('pickBtn'), repickBtn: $('repickBtn'),
    srcVideo: $('srcVideo'), srcInfo: $('srcInfo'),
    trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimFill: $('trimFill'), trimLabel: $('trimLabel'),
    res720: $('res720'), res1080: $('res1080'), modeQuality: $('modeQuality'), modeSize: $('modeSize'),
    sizeLabel: $('sizeLabel'), planInfo: $('planInfo'), planWarn: $('planWarn'),
    targetSize: $('targetSize'), halfFps: $('halfFps'), audioOn: $('audioOn'), audioLabel: $('audioLabel'),
    minRate720: $('minRate720'), minRate1080: $('minRate1080'), autoRun: $('autoRun'), capLabel: $('capLabel'),
    runBtn: $('runBtn'), progressWrap: $('progressWrap'), progressBar: $('progressBar'),
    phase: $('phase'), pct: $('pct'),
    outVideo: $('outVideo'), outEmpty: $('outEmpty'), outInfo: $('outInfo'), outWarn: $('outWarn'),
    shareBtn: $('shareBtn'), saveBtn: $('saveBtn')
  };

  // ---------------------------------------------------------------- 状態
  var state = {
    file: null,
    meta: null,          // { duration, width, height, fps, fpsMeasured, audio: {codec, bitrate}|null|undefined }
    engine: null,        // 'fast' | 'compat'
    trim: { start: 0, end: 0 },
    plan: null,
    caps: { aac: false, compat: false },
    running: false,
    busy: false,         // 読み込み・解析中
    cancel: false,
    cancelHook: null,
    srcUrl: null,
    out: null,           // { blob, name, type, original, url }
    compatAudio: null,   // 互換モードで再圧縮するときに音声を使い回す
    wakeLock: null
  };

  // ---------------------------------------------------------------- 小道具
  function show(el, visible) { el.classList.toggle('hidden', !visible); }
  function fmtBytes(n) {
    if (n < 1000) return n + ' B';
    if (n < MB) return (n / 1000).toFixed(0) + ' KB';
    return (n / MB).toFixed(1) + ' MB';
  }
  function fmtDuration(sec) {
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m === 0) return s + '秒';
    return m + '分' + (s < 10 ? '0' : '') + s + '秒';
  }
  function fmtClock(sec) {
    sec = Math.max(0, sec);
    var m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function fmtRate(bps) {
    return bps >= 1000000 ? (bps / 1000000).toFixed(1) + 'Mbps' : Math.round(bps / 1000) + 'kbps';
  }
  function fmtFps(fps) { return (Math.round(fps * 10) / 10) + 'fps'; }
  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function throwIfCancelled() { if (state.cancel) throw new Error(CANCELLED); }
  function isCancel(err) { return state.cancel || (err && err.message === CANCELLED); }
  function setAlert(el, lines, danger) {
    el.classList.toggle('danger', !!danger);
    el.innerHTML = '';
    lines = (lines || []).filter(Boolean);
    lines.forEach(function (t) {
      var p = document.createElement('p'); p.textContent = t; el.appendChild(p);
    });
    show(el, lines.length > 0);
  }
  // 進捗は1フレームに1回だけ描く。数字とゲージを同じタイミングで更新し、
  // 処理中に頻繁に呼ばれてもゲージが遅れないよう、CSSのアニメーションは使わない
  var progress = { value: 0, label: null, raf: 0 };
  function setProgress(ratio, label) {
    progress.value = Math.max(0, Math.min(1, ratio || 0));
    if (label) progress.label = label;
    if (!progress.raf) progress.raf = requestAnimationFrame(drawProgress);
  }
  function setPhase(label) {
    progress.label = label;
    if (!progress.raf) progress.raf = requestAnimationFrame(drawProgress);
  }
  function drawProgress() {
    progress.raf = 0;
    els.progressBar.style.transform = 'scaleX(' + progress.value.toFixed(4) + ')';
    els.pct.textContent = Math.round(progress.value * 100) + '%';
    if (progress.label !== null) els.phase.textContent = progress.label;
  }

  // ---------------------------------------------------------------- 設定
  function radioValue(name, fallback) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : fallback;
  }
  function readKbps(input, fallback) {
    var v = parseFloat(input.value);
    if (!isFinite(v)) v = fallback;
    return Math.min(MIN_KBPS_LIMITS[1], Math.max(MIN_KBPS_LIMITS[0], Math.round(v)));
  }
  function readSettings() {
    var mb = parseFloat(els.targetSize.value);
    if (!isFinite(mb) || mb < MIN_TARGET_MB) mb = DEFAULT_TARGET_MB;
    if (mb > MAX_TARGET_MB) mb = MAX_TARGET_MB;
    return {
      res: radioValue('res', '720') === '1080' ? '1080' : '720',
      mode: radioValue('mode', 'size') === 'quality' ? 'quality' : 'size',
      targetMB: mb,
      // 実際に守る上限（目標サイズから0.5%引いた値）。見積もり・再圧縮・判定はすべてこれを使う
      targetBytes: Math.floor(mb * MB * (1 - TARGET_MARGIN)),
      halfFps: !!els.halfFps.checked,
      audio: !!els.audioOn.checked,
      autoRun: !!els.autoRun.checked,
      // 解像度ごとの下限ビットレート（bps）
      minBitrate: {
        '720': readKbps(els.minRate720, DEFAULT_MIN_KBPS['720']) * 1000,
        '1080': readKbps(els.minRate1080, DEFAULT_MIN_KBPS['1080']) * 1000
      }
    };
  }

  // ショートカットなどから URL で初期値を渡せる（詳細設定の項目も含む）
  //   res=720|1080  mode=size|quality  target=MB  fps=30|source  audio=on|off  min720=kbps  min1080=kbps  auto=on|off
  function applyUrlParams() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var t = parseFloat(params.get('target'));
    if (isFinite(t) && t >= MIN_TARGET_MB && t <= MAX_TARGET_MB) els.targetSize.value = String(t);
    var r = (params.get('res') || '').toLowerCase().replace('p', '');
    if (r === '1080') els.res1080.checked = true;
    else if (r === '720') els.res720.checked = true;
    var m = (params.get('mode') || '').toLowerCase();
    if (m === 'quality' || m === 'max' || m === 'best') els.modeQuality.checked = true;
    else if (m === 'size' || m === 'target') els.modeSize.checked = true;
    var f = (params.get('fps') || '').toLowerCase();
    if (f === '30' || f === 'half') els.halfFps.checked = true;
    else if (f === 'source' || f === 'keep' || f === '60') els.halfFps.checked = false;
    var a = (params.get('audio') || '').toLowerCase();
    if (a === 'on' || a === '1' || a === 'true') els.audioOn.checked = true;
    else if (a === 'off' || a === '0' || a === 'false') els.audioOn.checked = false;
    var au = (params.get('auto') || '').toLowerCase();
    if (au === 'on' || au === '1' || au === 'true') els.autoRun.checked = true;
    else if (au === 'off' || au === '0' || au === 'false') els.autoRun.checked = false;
    [['min720', els.minRate720], ['min1080', els.minRate1080]].forEach(function (pair) {
      var v = parseFloat(params.get(pair[0]));
      if (isFinite(v) && v >= MIN_KBPS_LIMITS[0] && v <= MIN_KBPS_LIMITS[1]) pair[1].value = String(Math.round(v));
    });
  }

  // ---------------------------------------------------------------- 対応判定
  function checkSupport() {
    var missing = [];
    if (typeof window.VideoEncoder === 'undefined' || typeof window.VideoFrame === 'undefined') {
      missing.push('WebCodecs（VideoEncoder）');
    }
    if (!M) missing.push('Mediabunny（同梱ライブラリの読み込みに失敗）');
    return missing;
  }

  function detectCaps() {
    state.caps.compat = typeof HTMLVideoElement !== 'undefined' &&
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
    if (!M || typeof window.AudioEncoder === 'undefined') return Promise.resolve();
    return M.canEncodeAudio(FAST_AUDIO_CODEC, { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE })
      .then(function (ok) { state.caps.aac = !!ok; }, function () { state.caps.aac = false; });
  }

  // ---------------------------------------------------------------- メタ情報
  // フレームレートを一般的な値（29.97→30 など）に寄せる
  function snapFps(fps) {
    if (!(fps > 0) || !isFinite(fps)) return null;
    var common = [10, 12, 15, 20, 24, 25, 30, 48, 50, 60, 90, 120];
    var best = null, bestErr = Infinity;
    for (var i = 0; i < common.length; i++) {
      var err = Math.abs(fps - common[i]) / common[i];
      if (err < bestErr) { bestErr = err; best = common[i]; }
    }
    return bestErr < 0.08 ? best : Math.round(fps * 10) / 10;
  }

  // 高速モード: Mediabunny でコンテナを読んで情報を得る
  function loadMetaFast(file) {
    var input = new M.Input({ source: new M.BlobSource(file), formats: INPUT_FORMATS });
    var meta = {};
    return input.getPrimaryVideoTrack().then(function (vt) {
      if (!vt) throw new Error('映像トラックが見つかりませんでした。');
      meta.width = vt.displayWidth;
      meta.height = vt.displayHeight;
      return Promise.all([input.computeDuration(), vt.computePacketStats(120), vt.canDecode(), input.getPrimaryAudioTrack()]);
    }).then(function (r) {
      meta.duration = r[0];
      meta.fps = snapFps(r[1].averagePacketRate);
      meta.fpsMeasured = !!meta.fps;
      meta.canDecode = !!r[2];
      var at = r[3];
      if (!at) { meta.audio = null; return meta; }
      return at.computePacketStats(200).then(function (st) {
        meta.audio = { codec: at.codec, bitrate: st.averageBitrate || 0 };
        return meta;
      });
    }).then(function (m) {
      try { input.dispose(); } catch (e) { /* noop */ }
      return m;
    }, function (err) {
      try { input.dispose(); } catch (e) { /* noop */ }
      throw err;
    });
  }

  // 互換モード: <video> で長さと解像度を読み、冒頭を少し再生してフレームレートを測る
  function loadMetaCompat(videoEl) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function ready() {
        if (done) return;
        if (!(isFinite(videoEl.duration) && videoEl.duration > 0) || !videoEl.videoWidth) return;
        done = true;
        clearTimeout(timer);
        resolve({ duration: videoEl.duration, width: videoEl.videoWidth, height: videoEl.videoHeight });
      }
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('この動画を読み込めませんでした。mp4またはmovをお試しください。')); }
      }, 20000);
      videoEl.addEventListener('loadedmetadata', ready);
      videoEl.addEventListener('durationchange', ready);
      videoEl.addEventListener('error', function () {
        if (!done) { done = true; clearTimeout(timer); reject(new Error('この動画を読み込めませんでした。mp4またはmovをお試しください。')); }
      }, { once: true });
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

  function probeFps(videoEl) {
    var wasMuted = videoEl.muted;
    videoEl.muted = true;
    return new Promise(function (resolve) {
      var times = [], done = false;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { videoEl.pause(); } catch (e) { /* noop */ }
        try { videoEl.currentTime = 0; } catch (e) { /* noop */ }
        videoEl.muted = wasMuted;
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

  function estimateFps(times) {
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

  // ---------------------------------------------------------------- 音声の扱い
  function audioStrategy(meta, wanted, engine) {
    if (!wanted) return { mode: 'none', bps: 0, label: 'なし', note: null };
    if (meta.audio === null) return { mode: 'none', bps: 0, label: 'なし（元動画に音声なし）', note: null };
    if (engine === 'compat') {
      var compatOk = state.caps.aac && typeof window.AudioData !== 'undefined' &&
        (typeof window.OfflineAudioContext !== 'undefined' || typeof window.webkitOfflineAudioContext !== 'undefined');
      if (compatOk && state.file && state.file.size <= AUDIO_DECODE_MAX_BYTES) {
        return { mode: 'aac', bps: AUDIO_BITRATE, label: 'AAC ' + fmtRate(AUDIO_BITRATE), note: null };
      }
      return { mode: 'none', bps: 0, label: 'なし', note: 'この端末・動画では音声を変換できないため、音声なしで圧縮します。' };
    }
    var src = meta.audio || {};
    var isAac = src.codec === 'aac';
    if (isAac && src.bitrate > 0 && src.bitrate <= AUDIO_COPY_MAX_BITRATE) {
      return { mode: 'copy', bps: src.bitrate, label: 'AAC ' + fmtRate(src.bitrate) + '（そのまま）', note: null };
    }
    if (state.caps.aac) return { mode: 'aac', bps: AUDIO_BITRATE, label: 'AAC ' + fmtRate(AUDIO_BITRATE), note: null };
    if (isAac) {
      return { mode: 'copy', bps: src.bitrate || AUDIO_BITRATE, label: 'AAC ' + fmtRate(src.bitrate || AUDIO_BITRATE) + '（そのまま）', note: null };
    }
    return { mode: 'none', bps: 0, label: 'なし', note: 'この端末では音声をAACに変換できないため、音声なしで圧縮します。' };
  }

  // ---------------------------------------------------------------- 圧縮プラン
  function resolutionCap(meta, res) {
    var limit = res === '1080' ? 1080 : 720;
    var shortSide = Math.min(meta.width, meta.height);
    return shortSide > limit ? limit / shortSide : 1;   // 拡大はしない
  }

  function makePlan(meta, trim, settings, audio, fileSize, forcedVideoBitrate) {
    var duration = Math.max(0.1, trim.end - trim.start);
    var srcFps = meta.fps || DEFAULT_FPS;
    var outFps = (settings.halfFps && srcFps > 40) ? srcFps / 2 : srcFps;
    outFps = Math.min(Math.max(outFps, 1), MAX_FPS);
    var audioBps = audio.bps;
    // 解像度は選んだもので固定（元より大きくはしない）。容量はビットレートだけで調整する
    var scale = resolutionCap(meta, settings.res);
    var width = even(meta.width * scale);
    var height = even(meta.height * scale);
    var floorBps = settings.minBitrate[settings.res];
    var videoBps, unreachable = false;

    if (settings.mode === 'quality') {
      // なるべく圧縮: 下限ビットレートで圧縮する
      videoBps = floorBps;
    } else if (forcedVideoBitrate) {
      // 再圧縮: 実サイズから求め直した値（下限は下回らない）
      videoBps = Math.max(floorBps, Math.floor(forcedVideoBitrate));
    } else {
      // ◯MB以下で圧縮: 目標サイズに収まるなるべく高いビットレート。下限を下回るなら圧縮できない
      videoBps = Math.floor(settings.targetBytes * 8 * SIZE_SAFETY / duration - audioBps);
      if (videoBps < floorBps) { unreachable = true; videoBps = floorBps; }
    }

    // 元動画より高いビットレートで焼き直しても容量が増えるだけなので上限を設ける
    var srcBps = meta.duration > 0 ? fileSize * 8 / meta.duration : Infinity;
    var srcCap = Math.floor(srcBps * 0.8) - audioBps;
    if (isFinite(srcCap) && srcCap > 100000 && videoBps > srcCap) videoBps = srcCap;

    var estBytes = Math.round((videoBps + audioBps) * duration / 8);
    return {
      mode: settings.mode, res: settings.res, halfFps: settings.halfFps,
      targetMB: settings.targetMB, targetBytes: settings.targetBytes, minBitrate: settings.minBitrate,
      trimStart: trim.start, trimEnd: trim.end, duration: duration,
      srcFps: srcFps, outFps: outFps, fpsChanged: Math.abs(outFps - srcFps) > 0.05,
      width: width, height: height, videoBitrate: videoBps, floorBitrate: floorBps,
      audio: audio, audioBitrate: audioBps,
      estBytes: estBytes,
      unreachable: unreachable,                        // 目標サイズに収められない（◯MB以下で圧縮のとき）
      overDiscord: estBytes > DISCORD_FREE_BYTES       // Discord無料アカウントの上限を超える見込み
    };
  }

  // 書き出した実サイズから、目標に収まる映像ビットレートを計算し直す（無理なら null）
  function nextBitrate(plan, videoBytes, audioBytes) {
    var allowed = plan.targetBytes * 0.97 - (audioBytes || 0);
    if (!(allowed > 0) || !(videoBytes > 0)) return null;
    var ratio = Math.max(0.3, Math.min(0.95, allowed / videoBytes));   // 最低5%は下げ、下げすぎない
    var next = Math.floor(plan.videoBitrate * ratio);
    return next >= 100000 ? next : null;
  }

  function isFullTrim() {
    if (!state.meta) return true;
    return state.trim.start <= 0.05 && state.trim.end >= state.meta.duration - 0.05;
  }

  function currentPlan() {
    var settings = readSettings();
    var audio = audioStrategy(state.meta, settings.audio, state.engine);
    return makePlan(state.meta, state.trim, settings, audio, state.file.size);
  }

  // ---------------------------------------------------------------- 表示の更新
  function refresh() {
    var s = readSettings();
    els.sizeLabel.textContent = String(s.targetMB);
    // 上限は丸めずに見せる（例: 50MB → 49.75 MB）
    els.capLabel.textContent = String(Math.round(s.targetBytes / MB * 100) / 100) + ' MB';
    var hasFile = !!(state.file && state.meta);
    var locked = state.running || state.busy;

    [els.trimStart, els.trimEnd].forEach(function (el) { el.disabled = !hasFile || locked; });
    [els.res720, els.res1080, els.modeQuality, els.modeSize, els.targetSize, els.halfFps, els.audioOn,
      els.minRate720, els.minRate1080, els.autoRun].forEach(function (el) { el.disabled = state.running; });
    els.repickBtn.disabled = locked;

    if (!hasFile) {
      els.runBtn.disabled = !state.running;
      els.planInfo.textContent = '';
      setAlert(els.planWarn, []);
      return;
    }

    var plan = state.plan = currentPlan();
    els.audioLabel.textContent = '音声を残す（' + plan.audio.label + '）';
    els.planInfo.textContent = '→ ' + plan.width + '×' + plan.height + '・' + fmtFps(plan.outFps) + '・' +
      fmtRate(plan.videoBitrate) + '・予想' + fmtBytes(plan.estBytes);

    // 注意文は2種類だけ
    var warns = [];
    if (plan.mode === 'size' && plan.unreachable) warns.push(MSG_UNREACHABLE);
    if (plan.overDiscord) warns.push(MSG_OVER_DISCORD);
    setAlert(els.planWarn, warns);

    // 目標サイズを超えるのが分かっているときは実行させない（処理中はキャンセルボタンなので有効のまま）
    els.runBtn.disabled = !state.running && (state.busy || (plan.mode === 'size' && plan.unreachable));

    updatePassthrough(s);
  }

  // すでに目標サイズ以下なら、圧縮せずそのまま共有・保存できるようにする
  function updatePassthrough(settings) {
    if (state.running) return;
    var canPass = settings.mode === 'size' && isFullTrim() && state.file.size <= settings.targetBytes;
    if (canPass && (!state.out || state.out.original)) {
      if (!state.out) {
        setOutput({ blob: state.file, name: state.file.name || 'video.mp4', type: state.file.type || 'video/mp4', original: true });
      }
      els.outInfo.textContent = '元の動画のまま・' + fmtBytes(state.file.size) + '（' + settings.targetMB + 'MB以下なので圧縮不要）';
      setAlert(els.outWarn, state.file.size > DISCORD_FREE_BYTES ? [MSG_OVER_DISCORD] : []);
    } else if (!canPass && state.out && state.out.original) {
      clearOutput();
    }
  }

  // ---------------------------------------------------------------- トリミングUI
  function setupTrim(duration) {
    var step = duration > 600 ? 0.5 : 0.1;
    [els.trimStart, els.trimEnd].forEach(function (el) { el.max = String(duration); el.step = String(step); });
    els.trimStart.value = '0';
    els.trimEnd.value = String(duration);
    state.trim = { start: 0, end: duration };
    renderTrim();
  }

  function renderTrim() {
    var dur = state.meta ? state.meta.duration : 1;
    var a = state.trim.start / dur, b = state.trim.end / dur;
    // つまみの幅（22px）の半分だけ内側を実際の可動域とする
    els.trimFill.style.left = 'calc(11px + (100% - 22px) * ' + a + ')';
    els.trimFill.style.width = 'calc((100% - 22px) * ' + Math.max(0, b - a) + ')';
    // 両方のつまみが右端に寄ったときに開始側を掴めるようにする
    els.trimStart.style.zIndex = a > 0.9 ? 3 : 2;
    els.trimEnd.style.zIndex = a > 0.9 ? 2 : 3;
    if (!state.meta) { els.trimLabel.textContent = 'トリミング'; return; }
    els.trimLabel.textContent = fmtClock(state.trim.start) + '–' + fmtClock(state.trim.end) +
      '（' + (state.trim.end - state.trim.start).toFixed(1) + '秒）';
  }

  function onTrimInput(which) {
    var dur = state.meta.duration;
    var minLen = Math.min(MIN_TRIM_LENGTH, dur);
    var s = parseFloat(els.trimStart.value), e = parseFloat(els.trimEnd.value);
    if (which === 'start' && s > e - minLen) { s = Math.max(0, e - minLen); els.trimStart.value = String(s); }
    if (which === 'end' && e < s + minLen) { e = Math.min(dur, s + minLen); els.trimEnd.value = String(e); }
    state.trim = { start: s, end: e };
    try { els.srcVideo.currentTime = which === 'start' ? s : e; } catch (err) { /* noop */ }
    renderTrim();
    refresh();
  }

  // ---------------------------------------------------------------- 高速モード（Mediabunny Conversion）
  function pickFastEncoding(plan) {
    // 指定したビットレートに素直に従わせるため、どちらのモードも固定ビットレートを優先する
    var modes = ['constant', 'variable'];
    var cands = [];
    FAST_VIDEO_CODECS.forEach(function (codec) {
      ['prefer-hardware', 'no-preference'].forEach(function (hw) {
        modes.forEach(function (bm) { cands.push({ codec: codec, hw: hw, bitrateMode: bm }); });
      });
    });
    return (function next(i) {
      if (i >= cands.length) return Promise.resolve(null);
      var c = cands[i];
      return M.canEncodeVideo(c.codec, {
        width: plan.width, height: plan.height, frameRate: plan.outFps,
        quality: new M.Quality({ bitrate: plan.videoBitrate, bitrateMode: c.bitrateMode }),
        hardwareAcceleration: c.hw
      }).then(function (ok) { return ok ? c : next(i + 1); }, function () { return next(i + 1); });
    })(0);
  }

  function convertFast(plan, onProgress) {
    var input = new M.Input({ source: new M.BlobSource(state.file), formats: INPUT_FORMATS });
    var output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
    var conversion = null;
    function dispose() { try { input.dispose(); } catch (e) { /* noop */ } }

    return pickFastEncoding(plan).then(function (enc) {
      if (!enc) throw new Error('この端末では動画のエンコード（H.264）に対応していません。');
      var video = {
        codec: enc.codec, width: plan.width, height: plan.height, fit: 'fill',
        quality: new M.Quality({ bitrate: plan.videoBitrate, bitrateMode: enc.bitrateMode }),
        hardwareAcceleration: enc.hw, keyFrameInterval: KEYFRAME_INTERVAL,
        forceTranscode: true, allowTransformationMetadata: false
      };
      if (plan.fpsChanged) video.frameRate = plan.outFps;
      var audio;
      if (plan.audio.mode === 'aac') {
        audio = { codec: FAST_AUDIO_CODEC, quality: new M.Quality({ bitrate: AUDIO_BITRATE }), forceTranscode: true };
      } else if (plan.audio.mode === 'copy') {
        audio = { codec: FAST_AUDIO_CODEC };   // AACのままコピーする
      } else {
        audio = { discard: true };
      }
      var options = { input: input, output: output, video: video, audio: audio, showWarnings: false };
      if (!isFullTrimOf(plan)) options.trim = { start: plan.trimStart, end: plan.trimEnd };
      return M.Conversion.init(options);
    }).then(function (conv) {
      conversion = conv;
      var discarded = conv.discardedTracks || [];
      var videoLost = discarded.filter(function (d) { return d.track && d.track.type === 'video'; })[0];
      if (!conv.isValid || videoLost) {
        throw new Error('高速モードで扱えない動画です（' + (videoLost ? videoLost.reason : 'invalid') + '）');
      }
      var audioLost = plan.audio.mode !== 'none' &&
        discarded.some(function (d) { return d.track && d.track.type === 'audio' && d.reason !== 'discarded_by_user'; });
      state.cancelHook = function () { return conv.cancel(); };
      conv.onProgress = function (p) { onProgress(p); };
      throwIfCancelled();
      return conv.execute().then(function () {
        return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), audioDropped: audioLost, frames: null };
      });
    }).then(function (res) {
      state.cancelHook = null;
      dispose();
      return res;
    }, function (err) {
      state.cancelHook = null;
      dispose();
      if (conversion && conversion.state === 'canceled') throw new Error(CANCELLED);
      throw err;
    });
  }

  function isFullTrimOf(plan) {
    return plan.trimStart <= 0.05 && plan.trimEnd >= state.meta.duration - 0.05;
  }

  // ---------------------------------------------------------------- 互換モード（再生しながら取り込み）
  function findCompatVideoConfig(plan) {
    var cands = [];
    ['prefer-hardware', 'no-preference'].forEach(function (accel) {
      ['constant', null].forEach(function (mode) {
        COMPAT_VIDEO_CODECS.forEach(function (c) {
          var cfg = {
            codec: c.codec, width: plan.width, height: plan.height, bitrate: plan.videoBitrate,
            framerate: Math.round(plan.outFps) || DEFAULT_FPS, hardwareAcceleration: accel, latencyMode: 'quality'
          };
          Object.keys(c.extra).forEach(function (k) { cfg[k] = c.extra[k]; });
          if (mode) cfg.bitrateMode = mode;
          cands.push({ config: cfg, mb: c.mb });
        });
      });
    });
    return (function next(i) {
      if (i >= cands.length) return Promise.resolve(null);
      var c = cands[i];
      return Promise.resolve()
        .then(function () { return VideoEncoder.isConfigSupported(c.config); })
        .then(function (res) {
          return (res && res.supported) ? { config: res.config || c.config, mb: c.mb } : next(i + 1);
        })
        .catch(function () { return next(i + 1); });
    })(0);
  }

  function drain(encoder, max) {
    return new Promise(function (resolve, reject) {
      (function check() {
        if (state.cancel) return reject(new Error(CANCELLED));
        if (encoder.state !== 'configured' || encoder.encodeQueueSize <= max) return resolve();
        setTimeout(check, 15);
      })();
    });
  }

  // 音声: ファイル全体をWeb Audioでデコードし、トリミング範囲だけAACへ再エンコードする
  function encodeCompatAudio(plan, onProgress) {
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
      throwIfCancelled();
      if (!decoded || decoded.length === 0) return null;
      var channels = Math.min(2, decoded.numberOfChannels);
      var sampleRate = decoded.sampleRate;
      var cfg = { codec: COMPAT_AUDIO_CODEC.codec, sampleRate: sampleRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE };
      return AudioEncoder.isConfigSupported(cfg).then(function (res) {
        if (!res || !res.supported) return null;
        var from = Math.max(0, Math.floor(plan.trimStart * sampleRate));
        var to = Math.min(decoded.length, Math.ceil(plan.trimEnd * sampleRate));
        return runAudioEncoder(decoded, from, to, channels, sampleRate, res.config || cfg, onProgress);
      });
    }).then(function (data) {
      decoded = null;
      state.compatAudio = { key: key, data: data };
      return data;
    }).catch(function (err) {
      decoded = null;
      if (isCancel(err)) throw err;
      console.warn('音声のエンコードに失敗したため、音声なしで続行します:', err);
      return null;
    });
  }

  function runAudioEncoder(audioBuffer, from, to, channels, sampleRate, config, onProgress) {
    return new Promise(function (resolve, reject) {
      var packets = [];
      var encoder = new AudioEncoder({
        output: function (chunk, meta) { packets.push({ packet: M.EncodedPacket.fromEncodedChunk(chunk), meta: meta }); },
        error: function (e) { reject(e); }
      });
      encoder.configure(config);
      var CHUNK = 1024, pos = from, total = Math.max(1, to - from), n = 0;
      (function pump() {
        try {
          throwIfCancelled();
          while (pos < to) {
            if (encoder.encodeQueueSize > 24) return drain(encoder, 8).then(pump, reject);
            var len = Math.min(CHUNK, to - pos);
            var data = new Float32Array(len * channels);
            for (var c = 0; c < channels; c++) {
              audioBuffer.copyFromChannel(data.subarray(c * len, (c + 1) * len), c, pos);
            }
            encoder.encode(new AudioData({
              format: 'f32-planar', sampleRate: sampleRate, numberOfFrames: len, numberOfChannels: channels,
              timestamp: Math.round((pos - from) / sampleRate * 1e6), data: data
            }));
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
          }, reject);
        } catch (e) {
          try { encoder.close(); } catch (e2) { /* noop */ }
          reject(e);
        }
      })();
    });
  }

  // 映像: <video> をトリミング範囲だけ再生し、フレームを取り出してエンコードする
  function encodeCompatVideo(videoEl, plan, config, onPacket, onProgress) {
    var width = plan.width, height = plan.height;
    function makeCanvas(offscreen) {
      var c;
      if (offscreen && typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(width, height);
      else { c = document.createElement('canvas'); c.width = width; c.height = height; }
      return { canvas: c, ctx: c.getContext('2d', { alpha: false }) };
    }
    var surface = makeCanvas(true);
    if (!surface.ctx) surface = makeCanvas(false);
    if (!surface.ctx) return Promise.reject(new Error('canvasを初期化できませんでした。'));
    var canvasFallbackUsed = false;
    var start = plan.trimStart, end = plan.trimEnd, span = Math.max(0.1, end - start);
    var wasMuted = videoEl.muted;
    videoEl.muted = true;
    videoEl.controls = false;

    return new Promise(function (resolve, reject) {
      var frames = 0, lastKeyTs = -Infinity, lastTs = -1, finished = false;
      var minDeltaUs = 1e6 / plan.outFps * 0.75;   // 取り込むフレームレートの上限（多少の揺らぎは許容）
      var encoder = new VideoEncoder({
        output: function (chunk, meta) { onPacket(M.EncodedPacket.fromEncodedChunk(chunk), meta); },
        error: function (e) { fail(e); }
      });
      encoder.configure(config);

      function cleanup() {
        videoEl.onended = null;
        clearInterval(watchdog);
        try { videoEl.pause(); } catch (e) { /* noop */ }
        videoEl.muted = wasMuted;
        videoEl.controls = true;
      }
      function fail(err) {
        if (finished) return;
        finished = true;
        cleanup();
        try { if (encoder.state !== 'closed') encoder.close(); } catch (e) { /* noop */ }
        reject(err);
      }
      function finish() {
        if (finished) return;
        finished = true;
        cleanup();
        // 取りこぼした末尾を最後の1枚で埋めて、長さをトリミング範囲に合わせる
        try {
          var endTs = Math.round(span * 1e6);
          if (frames > 0 && endTs > lastTs + minDeltaUs) {
            var tail = new VideoFrame(surface.canvas, { timestamp: endTs });
            try { encoder.encode(tail, { keyFrame: false }); } finally { tail.close(); }
          }
        } catch (e) { /* 末尾の補完は失敗しても無視する */ }
        encoder.flush().then(function () {
          encoder.close();
          resolve({ frames: frames });
        }, fail);
      }
      function onFrame(now, frameMeta) {
        if (finished) return;
        if (state.cancel) return fail(new Error(CANCELLED));
        try {
          var t = (frameMeta && typeof frameMeta.mediaTime === 'number') ? frameMeta.mediaTime : videoEl.currentTime;
          if (t >= end) return finish();
          var ts = Math.round((t - start) * 1e6);
          if (ts >= 0 && ts > lastTs + minDeltaUs) {
            surface.ctx.drawImage(videoEl, 0, 0, width, height);
            var keyFrame = (ts - lastKeyTs) >= KEYFRAME_INTERVAL * 1e6;
            var frame;
            try {
              frame = new VideoFrame(surface.canvas, { timestamp: ts });
            } catch (ve) {
              // OffscreenCanvas から VideoFrame を作れない環境では通常の canvas で作り直す
              if (canvasFallbackUsed) throw ve;
              canvasFallbackUsed = true;
              surface = makeCanvas(false);
              surface.ctx.drawImage(videoEl, 0, 0, width, height);
              frame = new VideoFrame(surface.canvas, { timestamp: ts });
            }
            try { encoder.encode(frame, { keyFrame: keyFrame }); } finally { frame.close(); }   // VideoFrameは必ず解放する
            if (keyFrame) lastKeyTs = ts;
            lastTs = ts;
            frames++;
            onProgress(Math.min(1, (t - start) / span));
          }
          if (encoder.encodeQueueSize > 6) {
            // エンコードが追いつかないときは再生を止めて待つ
            videoEl.pause();
            drain(encoder, 2).then(function () {
              if (finished) return;
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
        if (finished) return;
        if (state.cancel) return fail(new Error(CANCELLED));
        if (videoEl.ended || videoEl.currentTime >= end) finish();
      }, 400);
      videoEl.onended = finish;

      // 開始位置へシークしてから再生する
      var seeked = false;
      function begin() {
        if (seeked) return;
        seeked = true;
        Promise.resolve(videoEl.play()).then(function () {
          videoEl.requestVideoFrameCallback(onFrame);
        }, function () {
          fail(new Error('動画を再生できませんでした。画面を表示したまま、もう一度お試しください。'));
        });
      }
      videoEl.addEventListener('seeked', begin, { once: true });
      videoEl.currentTime = start;
      setTimeout(begin, 1500);   // seeked が来ない場合の保険
    });
  }

  function convertCompat(plan, onProgress) {
    var audioSpan = plan.audio.mode === 'aac' ? 0.15 : 0;
    var audioPromise = plan.audio.mode === 'aac'
      ? encodeCompatAudio(plan, function (r) { onProgress(r * audioSpan); })
      : Promise.resolve(null);

    return audioPromise.then(function (audio) {
      throwIfCancelled();
      return findCompatVideoConfig(plan).then(function (found) {
        if (!found) throw new Error('この端末では動画のエンコード（H.264）に対応していません。');
        var output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
        var vsrc = new M.EncodedVideoPacketSource(found.mb);
        output.addVideoTrack(vsrc);
        var asrc = null;
        if (audio && audio.packets.length) {
          asrc = new M.EncodedAudioPacketSource(audio.mb);
          output.addAudioTrack(asrc);
        }
        return output.start().then(function () {
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
          }).then(function (vr) {
            pushAudioUntil(Infinity);
            return chain.then(function () {
              vsrc.close();
              if (asrc) asrc.close();
              return output.finalize();
            }).then(function () {
              return {
                blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
                audioDropped: plan.audio.mode === 'aac' && !asrc,
                frames: vr.frames
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

  // ---------------------------------------------------------------- 実行
  function run() {
    if (!state.file || state.running) return;
    var plan = currentPlan();
    var engine = state.engine;
    var started = Date.now();

    state.running = true;
    state.cancel = false;
    setRunningUi(true);
    requestWakeLock();

    function attempt(index) {
      var label = index === 0 ? (engine === 'fast' ? '圧縮中' : '圧縮中（互換モード：再生しながら処理）')
        : '目標を超えたので再圧縮中（' + (index + 1) + '回目 / 最大' + MAX_ATTEMPTS + '回）';
      setProgress(0, label);
      var job = engine === 'fast'
        ? convertFast(plan, function (p) { setProgress(p, label); })
        : convertCompat(plan, function (p) { setProgress(p, label); });

      return job.then(function (res) {
        throwIfCancelled();
        if (res.audioDropped && plan.audio.mode !== 'none') {
          plan.audio = { mode: 'none', bps: 0, label: 'なし', note: null };
          plan.audioBitrate = 0;
        }
        if (plan.mode === 'size' && res.blob.size > plan.targetBytes && index + 1 < MAX_ATTEMPTS) {
          var audioBytes = plan.audioBitrate * plan.duration / 8;
          var next = nextBitrate(plan, res.blob.size - audioBytes, audioBytes);
          // 下限を下回る値は下限に揃え、それ以上下げられないならやめる
          if (next) next = Math.max(next, plan.floorBitrate);
          if (next && next < plan.videoBitrate) {
            plan = makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
              plan.audio, state.file.size, next);
            return attempt(index + 1);
          }
        }
        res.attempts = index + 1;
        return res;
      }, function (err) {
        if (isCancel(err)) throw new Error(CANCELLED);
        // 高速モードで扱えなかったら、互換モードでやり直す
        if (engine === 'fast' && index === 0 && state.caps.compat) {
          console.warn('高速モードに失敗したため互換モードに切り替えます:', err);
          engine = 'compat';
          plan = makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
            audioStrategy(state.meta, readSettings().audio, 'compat'), state.file.size);
          return attempt(0);
        }
        throw err;
      });
    }

    return attempt(0).then(function (res) {
      setProgress(1, '完了');
      finishRun();
      showResult(res, plan, engine, (Date.now() - started) / 1000);
    }, function (err) {
      finishRun();
      if (isCancel(err)) return;
      console.error(err);
      setAlert(els.outWarn, ['エラー: ' + ((err && err.message) || String(err))], true);
    });
  }

  // 計画を作り直すときに、元の計画と同じ設定を渡す
  function planSettings(plan) {
    return {
      mode: plan.mode, res: plan.res, halfFps: plan.halfFps,
      targetMB: plan.targetMB, targetBytes: plan.targetBytes, minBitrate: plan.minBitrate
    };
  }

  function finishRun() {
    state.running = false;
    state.cancelHook = null;
    releaseWakeLock();
    setRunningUi(false);
    refresh();
  }

  function setRunningUi(running) {
    show(els.progressWrap, running);
    els.runBtn.textContent = running ? 'キャンセル' : '圧縮する';
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

  function cancelRun() {
    state.cancel = true;
    setPhase('キャンセルしています…');
    if (state.cancelHook) {
      Promise.resolve(state.cancelHook()).catch(function () { /* noop */ });
    }
  }

  // ---------------------------------------------------------------- 結果
  function setOutput(out) {
    clearOutput();
    out.url = URL.createObjectURL(out.blob);
    state.out = out;
    els.outVideo.src = out.url;
    show(els.outVideo, true);
    show(els.outEmpty, false);
    els.shareBtn.disabled = state.running;
    els.saveBtn.disabled = state.running;
  }

  function clearOutput() {
    if (state.out && state.out.url) URL.revokeObjectURL(state.out.url);
    state.out = null;
    els.outVideo.removeAttribute('src');
    try { els.outVideo.load(); } catch (e) { /* noop */ }
    show(els.outVideo, false);
    show(els.outEmpty, true);
    els.outInfo.textContent = '';
    setAlert(els.outWarn, []);
    els.shareBtn.disabled = true;
    els.saveBtn.disabled = true;
  }

  function showResult(res, plan, engine, elapsed) {
    var base = String(state.file.name || 'video').replace(/\.[^.]+$/, '') || 'video';
    setOutput({ blob: res.blob, name: base + '_compressed.mp4', type: 'video/mp4', original: false });

    var size = res.blob.size;
    var ratio = state.file.size > 0 ? Math.round((1 - size / state.file.size) * 100) : 0;
    els.outInfo.textContent = fmtBytes(state.file.size) + ' → ' + fmtBytes(size) + '（' + (ratio >= 0 ? '-' : '+') +
      Math.abs(ratio) + '%）・' + plan.width + '×' + plan.height + '・' + fmtRate(plan.videoBitrate) + '・' +
      fmtDuration(elapsed) + (res.attempts > 1 ? '・' + res.attempts + '回で調整' : '') +
      (plan.audio.mode === 'none' && readSettings().audio ? '・音声なし' : '') + (engine === 'compat' ? '・互換モード' : '');

    var warns = [];
    if (plan.mode === 'size' && size > plan.targetBytes) warns.push(MSG_UNREACHABLE);
    if (size > DISCORD_FREE_BYTES) warns.push(MSG_OVER_DISCORD);
    setAlert(els.outWarn, warns);
  }

  // ---------------------------------------------------------------- 共有・保存
  function outFile() {
    return new File([state.out.blob], state.out.name, { type: state.out.type || 'video/mp4' });
  }

  function share() {
    if (!state.out) return;
    var file = outFile();
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        download();   // 共有できなければダウンロードにフォールバック
      });
    } else {
      download();
    }
  }

  function download() {
    if (!state.out) return;
    var a = document.createElement('a');
    a.href = state.out.url;
    a.download = state.out.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------------------------------------------------------------- 画面スリープ防止
  function requestWakeLock() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then(function (lock) { state.wakeLock = lock; }).catch(function () { /* noop */ });
  }
  function releaseWakeLock() {
    if (state.wakeLock) {
      try { state.wakeLock.release(); } catch (e) { /* noop */ }
      state.wakeLock = null;
    }
  }

  // ---------------------------------------------------------------- 動画の読み込み
  function onFileChosen(file) {
    if (!file || state.running) return;
    state.busy = true;
    state.file = file;
    state.meta = null;
    state.compatAudio = null;
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

    loadMetaFast(file).then(function (meta) {
      if (!meta.canDecode) throw new Error('decode');
      state.engine = 'fast';
      return meta;
    }).catch(function (err) {
      console.warn('高速モードで読み込めないため互換モードを使います:', err);
      if (!state.caps.compat) {
        throw new Error('この動画は読み込めませんでした（この端末では対応していない形式の可能性があります）。');
      }
      state.engine = 'compat';
      els.srcInfo.textContent = '解析中…';
      return loadMetaCompat(els.srcVideo);
    }).then(function (meta) {
      if (state.file !== file) return;
      state.meta = meta;
      setupTrim(meta.duration);
      els.srcInfo.textContent = meta.width + '×' + meta.height + '・' +
        (meta.fps ? fmtFps(meta.fps) : 'fps不明') + '・' + fmtDuration(meta.duration) + '・' + fmtBytes(file.size);
    }).catch(function (err) {
      state.file = null;
      els.srcInfo.textContent = '';
      setAlert(els.planWarn, [(err && err.message) || String(err)], true);
    }).then(function () {
      state.busy = false;
      refresh();
      autoRunIfEnabled(file);
    });
  }

  // 「動画をアップロードしたら即圧縮」がオンなら、選んだ直後に圧縮を始める。
  // 目標サイズに収まらない（ボタンが無効）ときや、元のままで目標以下（圧縮不要）のときは始めない
  function autoRunIfEnabled(file) {
    if (!els.autoRun.checked || state.file !== file || !state.meta || state.running) return;
    if (els.runBtn.disabled || (state.out && state.out.original)) return;
    run();
  }

  // ---------------------------------------------------------------- 配線
  els.pickBtn.addEventListener('click', function () { els.file.click(); });
  els.repickBtn.addEventListener('click', function () { els.file.click(); });
  els.file.addEventListener('change', function (e) {
    onFileChosen(e.target.files && e.target.files[0]);
    els.file.value = '';
  });
  els.trimStart.addEventListener('input', function () { onTrimInput('start'); });
  els.trimEnd.addEventListener('input', function () { onTrimInput('end'); });

  // プレビュー再生はトリミング範囲の中だけにする
  els.srcVideo.addEventListener('play', function () {
    if (state.running || state.busy || !state.meta) return;
    var t = els.srcVideo.currentTime;
    if (t < state.trim.start - 0.05 || t >= state.trim.end - 0.05) els.srcVideo.currentTime = state.trim.start;
  });
  els.srcVideo.addEventListener('timeupdate', function () {
    if (state.running || state.busy || !state.meta || els.srcVideo.paused) return;
    if (els.srcVideo.currentTime >= state.trim.end) els.srcVideo.pause();
  });

  ['res720', 'res1080', 'modeQuality', 'modeSize', 'halfFps', 'audioOn'].forEach(function (k) {
    els[k].addEventListener('change', refresh);
  });
  [els.minRate720, els.minRate1080].forEach(function (el) {
    el.addEventListener('input', refresh);
    el.addEventListener('change', function () {
      el.value = String(readKbps(el, DEFAULT_MIN_KBPS[el === els.minRate720 ? '720' : '1080']));   // 確定したら正規化
      refresh();
    });
  });
  els.targetSize.addEventListener('input', refresh);
  els.targetSize.addEventListener('change', function () {
    els.targetSize.value = String(readSettings().targetMB);   // 確定したときだけ値を正規化する
    refresh();
  });
  els.runBtn.addEventListener('click', function () {
    if (state.running) cancelRun(); else run();
  });
  els.shareBtn.addEventListener('click', share);
  els.saveBtn.addEventListener('click', download);

  window.addEventListener('beforeunload', function (e) {
    if (state.running) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- 起動
  applyUrlParams();
  var missing = checkSupport();
  if (missing.length) {
    setAlert(els.unsupported, ['この環境では利用できません。次の機能に対応していません: ' + missing.join('、'),
      'iOS 17以降のSafari、または最新のChrome／Edgeでお試しください。'], true);
    els.pickBtn.disabled = true;
  }
  detectCaps().then(refresh);
  refresh();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* オフライン対応なしでも動く */ });
    });
  }

  // 動作確認用（ブラウザのコンソールから計算結果を確認できるようにしておく）
  window.__compressor = {
    makePlan: makePlan, nextBitrate: nextBitrate, readSettings: readSettings,
    estimateFps: estimateFps, snapFps: snapFps, audioStrategy: audioStrategy,
    state: state,
    constants: {
      SIZE_SAFETY: SIZE_SAFETY, AUDIO_BITRATE: AUDIO_BITRATE, DEFAULT_MIN_KBPS: DEFAULT_MIN_KBPS,
      DISCORD_FREE_BYTES: DISCORD_FREE_BYTES, MAX_ATTEMPTS: MAX_ATTEMPTS, MB: MB, TARGET_MARGIN: TARGET_MARGIN
    }
  };
})();
