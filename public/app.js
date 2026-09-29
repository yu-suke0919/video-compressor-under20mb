/*
 * 20MB圧縮 — 動画をDiscordに投稿できるサイズに圧縮するWebアプリ
 *
 * 処理方式は2つ:
 *   高速モード … Mediabunny の Conversion で、動画ファイルを直接デコード→再エンコードする（実時間より速い）
 *   互換モード … 高速モードで扱えない動画向け。<video> を再生しながら requestVideoFrameCallback で
 *                フレームを取り出し、WebCodecs でエンコードして Mediabunny で mp4 にまとめる
 *
 * 圧縮の方針（解像度は選んだもの（720p / 1080p / 元の解像度）で固定し、ビットレートだけで容量を調整する）:
 *   元の解像度 … 720p・1080p より大きい動画（スマホの画面録画など）のときだけ選べる。解像度を変えずに圧縮する
 *   なるべく圧縮 … 解像度ごとの「下限ビットレート」で圧縮する
 *   ◯MB以内に圧縮 … 下限を下回らない範囲で、目標サイズに収まるなるべく高いビットレートにする。
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
  var SIZE_SAFETY = 0.97;
  // 「◯MB以内に圧縮」で、目標のこの割合以下に仕上がったら、小さく済んだ理由を出す（エンコーダーが、画質が十分な所で使う量を抑えた）
  var SMALL_RESULT_RATIO = 0.8;                // 目標サイズの97%を狙う（20MB→19.4MB）。エンコーダの誤差（数%）を吸収して再圧縮を避ける
  var AUDIO_BITRATE = 128000;            // 音声を再エンコードするときのビットレート
  var AUDIO_COPY_MAX_BITRATE = 192000;   // これ以下のAACは再エンコードせずそのまま使う
  var DISCORD_FREE_BYTES = 20 * MB;     // Discord無料アカウントの上限（注意文の基準）
  // 下限ビットレートの既定値（kbps）。720p30で1.2Mbps、1080pは画素数に比例させて同等の画質
  var DEFAULT_MIN_KBPS = { '720': 1200, '1080': 2700 };
  var MIN_KBPS_LIMITS = [100, 50000];
  // 60fps のまま書き出すときは、下限ビットレートをこの倍率にする（下限は30fpsを前提にした値。
  // 60fps のままだと1コマあたりのデータが半分になる。60fps はとなりのコマが似ていて圧縮しやすいので2倍までは要らない）
  var HIGH_FPS_FLOOR_FACTOR = 1.5;
  // 映像ビットレートの上限（元の動画のビットレートに対する倍率）。元より高いビットレートで焼き直しても、画質は上がらず容量が増えるだけ。
  // 元が HEVC のときは、書き出す H.264 で同じ画質にするのに約1.5倍のビットレートが要るので、1.5倍まで許す
  var SRC_CAP_RATIO = 1, SRC_CAP_RATIO_HEVC = 1.5;
  var MSG_UNREACHABLE = '目標サイズに圧縮できません。解像度を下げるか、詳細設定にて下限ビットレートを引き下げてください。';
  var MSG_OVER_DISCORD = '20MBを超えるため、Discordの無料アカウントでは送信できません。';
  var MSG_HALF_FPS_HINT = '詳細設定の「60fpsの動画は30fpsにする」をオンにすると収まりやすくなります。';
  var MSG_LOCATION = '位置情報が含まれている動画です。この情報はアップロードされず、圧縮後の動画には位置情報を含めません。';
  var SETTINGS_KEY = 'video-compressor-under20mb:settings';   // 画面で変えた設定を覚えておく場所（この端末のブラウザ内だけ）
  var DEFAULT_FPS = 30;
  var MAX_FPS = 60;
  var MAX_ATTEMPTS = 3;                  // 初回 + 最大2回の再圧縮
  // 可変ビットレート（VBR）で書き出した結果が、指定のビットレートよりこれ以上大きい、
  // または圧縮し直しても MIN_SHRINK 以上小さくならないなら、エンコーダーが指定を守っていない（Android の実機であった）。
  // 次の再圧縮から固定ビットレート（CBR）にする
  var CBR_OVERSHOOT = 1.2;
  var MIN_SHRINK = 0.05;
  // 「なるべく圧縮」（目標サイズなし）では、VBR の結果が指定の約2倍以上になったときだけ、CBR でもう一度圧縮して小さい方を使う。
  // CBR はソフトウェアのエンコーダーになることがあり、時間が2〜3倍かかるので、短い動画（この秒数以内）だけにする
  var QUALITY_CBR_OVERSHOOT = 1.8;
  var QUALITY_CBR_MAX_SECONDS = 20;
  var KEYFRAME_INTERVAL = 2;             // 秒
  var MIN_TRIM_LENGTH = 0.5;             // 秒
  var AUDIO_DECODE_MAX_BYTES = 400 * MB;   // 互換モードで音声を扱うファイルサイズの上限
  var APP_VERSION = '2026-09-29t';        // 診断情報に出す（どの版で起きたかを見分ける）
  var CANCELLED = 'cancelled';
  var SNAPSHOT_MAX_BYTES = 600 * MB;     // Android で動画をブラウザ内に写し取る上限（これより大きい動画は写さない）
  var STALLED = 'stalled';
  var STALL_MS = 20000;                  // 画面を表示しているのに進捗がこれだけ止まったら、互換モードに切り替える
  var BG_STALL_MS = 3000;                // 別のアプリから戻ったあと、進捗がこれだけ止まっていたら、最初からやり直す（動いていれば戻って1秒以内に進む）
  var CLEANUP_WAIT_MS = 3000;            // やり直す前に、止めた処理の後片付けを待つ上限
  var DECODER_CHECK_MS = 2000;           // デコーダーがこれだけ応答しなければ、固まっているとみなす（普段はすぐ応答し、固まると全く応答しない）
  var FAIL_SETTLE_MS = 1500;             // 失敗してから、別のアプリに切り替えたかを見極めるまで待つ時間
  var FROZEN_GAP_MS = 3000;              // 1秒ごとの見回りの間がこれより空いたら、ページが止められていた（裏に回っていた）とみなす
  var MAX_BG_RETRIES = 3;                // 別のアプリに切り替えたために失敗したとき、やり直す回数の上限
  var MSG_BG_RETRY = '別のアプリに切り替えたため、最初からやり直し中';

  // 出力に使うコーデック（優先順）。高速モードは Mediabunny の名前、互換モードは WebCodecs のコーデック文字列
  var FAST_VIDEO_CODECS = ['avc', 'hevc'];
  var FAST_AUDIO_CODEC = 'aac';
  var COMPAT_VIDEO_CODECS = [
    { codec: 'avc1.4D0028', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.42E028', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.640028', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.42E01F', mb: 'avc', extra: { avc: { format: 'avc' } } },
    { codec: 'avc1.640033', mb: 'avc', extra: { avc: { format: 'avc' } } },   // 1080pより大きい「元の解像度」用（レベル5.1）
    { codec: 'hvc1.1.6.L123.B0', mb: 'hevc', extra: { hevc: { format: 'hevc' } } }
  ];
  var COMPAT_AUDIO_CODEC = { codec: 'mp4a.40.2', mb: 'aac' };
  // 高速モードで読める入力形式。iPhoneの撮影動画(mov)とSwitchの動画(mp4)が対象。それ以外は互換モードで処理する
  var INPUT_FORMATS = M ? [M.MP4, M.QTFF] : [];

  // ---------------------------------------------------------------- 要素
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    unsupported: $('unsupported'), file: $('file'), pickBtn: $('pickBtn'), repickBtn: $('repickBtn'),
    app: document.querySelector('.app'),
    srcVideo: $('srcVideo'), srcInfo: $('srcInfo'), srcBox: $('srcBox'), outBox: $('outBox'),
    trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimFill: $('trimFill'), trimBox: $('trimBox'), quickNote: $('quickNote'), quickNoteSize: $('quickNoteSize'), trimLabel: $('trimLabel'),
    trimTicks: $('trimTicks'), trimSeek: $('trimSeek'),
    res720: $('res720'), res1080: $('res1080'), resSource: $('resSource'), resSeg: $('resSeg'), modeQuality: $('modeQuality'), modeSize: $('modeSize'),
    sizeLabel: $('sizeLabel'), planInfo: $('planInfo'), planWarn: $('planWarn'),
    targetSize: $('targetSize'), halfFps: $('halfFps'), audioOn: $('audioOn'), audioLabel: $('audioLabel'),
    minRate720: $('minRate720'), minRate1080: $('minRate1080'), autoRun: $('autoRun'), capLabel: $('capLabel'),
    urlCopy: $('urlCopy'), urlStatus: $('urlStatus'),
    resetSettings: $('resetSettings'), runBtn: $('runBtn'), progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressNote: $('progressNote'),
    phase: $('phase'), pct: $('pct'),
    outVideo: $('outVideo'), outEmpty: $('outEmpty'), outInfo: $('outInfo'), outNote: $('outNote'), outWarn: $('outWarn'),
    shareBtn: $('shareBtn'), saveBtn: $('saveBtn'),
    nameOn: $('nameOn'), nameBox: $('nameBox'), nameList: $('nameList'), namePreview: $('namePreview'),
    diagBox: $('diagBox'), diagOut: $('diagOut'), diagCopy: $('diagCopy'), diagStatus: $('diagStatus')
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
    picking: null,       // 選んだ動画（Android でブラウザ内に写している間に、別の動画が選ばれたかを見分ける）
    job: null,           // 実行中の圧縮1回ぶん（キャンセルは実行ごとに管理する）
    attemptJob: null,    // その中の1回の処理（進まなくなったらこれだけ止める）
    loadError: null,     // 動画を読み込めなかった理由（次の動画を選ぶまで表示する）
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
    if (sec > 0 && sec < 0.95) return sec.toFixed(1) + '秒';   // 1秒未満（0.3秒など）が「0秒」にならないようにする
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
  // t からの経過時間（例: 1.2秒）
  function secondsSince(t) { return ((Date.now() - t) / 1000).toFixed(1) + '秒'; }
  function fmtRate(bps) {
    return bps >= 1000000 ? (bps / 1000000).toFixed(1) + 'Mbps' : Math.round(bps / 1000) + 'kbps';
  }
  function fmtFps(fps) { return (Math.round(fps * 10) / 10) + 'fps'; }
  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // 圧縮1回ぶんの情報。キャンセルは実行ごとに管理し、止まりきらない古い処理が次の実行に影響しないようにする
  //   cancelled … キャンセルされたか
  //   hooks     … キャンセル時にすぐ実行する後片付け（エンコーダを閉じる、再生を止める など）
  //   aborted   … キャンセルした瞬間に失敗する Promise（処理の完了と競わせて、画面をすぐ戻すために使う）
  function newJob() {
    var job = { cancelled: false, hooks: [] };
    job.aborted = new Promise(function (resolve, reject) { job.abort = reject; });
    job.aborted.catch(function () { /* noop */ });
    return job;
  }
  // 実行を止める。後片付けを始め（止まりきるのは待たない）、aborted をすぐ失敗させる。
  // 後片付けが終わるのを待ちたいときは job.stopped を使う
  function stopJob(job, reason) {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    job.stopped = Promise.all(job.hooks.map(function (hook) {
      try { return Promise.resolve(hook()).catch(function () { /* noop */ }); } catch (e) { return null; }
    }));
    job.abort(new Error(reason));
  }
  // 画面が表示されるまで待つ（キャンセルされたら失敗する）
  function waitVisible(job) {
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
  function throwIfCancelled(job) { if (job && job.cancelled) throw new Error(CANCELLED); }
  function isCancel(job, err) { return !!(job && job.cancelled) || !!(err && err.message === CANCELLED); }
  // lines の各行は文字、または太字にする行 { bold: 文字 }
  function setAlert(el, lines, danger) {
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
  function log(msg) {
    var line = ((Date.now() - diag.t0) / 1000).toFixed(1) + 's ' + msg;
    diag.lines.push(line);
    if (diag.lines.length > 400) diag.lines.splice(2, 1);   // 先頭（端末情報）は残す
    if (els.diagOut) els.diagOut.value = diag.lines.join('\n');
    try { console.log('[診断] ' + msg); } catch (e) { /* noop */ }
  }
  function errText(err) { return err ? ((err.name ? err.name + ': ' : '') + (err.message || String(err))) : String(err); }
  // 診断情報を普段から表示するか。本番ではエラーや停止のときだけ表示する（記録は常に続ける）
  //   プレビュー（<ブランチ名>.<プロジェクト名>.pages.dev）・手元の確認環境・URLに debug=1 のときは、圧縮を始めたら表示
  var DIAG_ALWAYS = (function () {
    var h = location.hostname;
    var debug = false;
    try { debug = /^(1|on|true)$/i.test(new URLSearchParams(location.search).get('debug') || ''); } catch (e) { /* noop */ }
    return debug || (/\.pages\.dev$/.test(h) && h.split('.').length > 3) || h === 'localhost' || h === '127.0.0.1';
  })();
  // open: 開いて表示する（エラーや停止のとき）。false なら普段から表示する環境だけで表示する
  function showDiag(open) {
    if (!open && !DIAG_ALWAYS) return;
    show(els.diagBox, true);
    if (open) els.diagBox.open = true;
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
  function resValue(v) { return v === '1080' || v === 'source' ? v : '720'; }

  // 「元の解像度」は、720p・1080p 以外で720pより大きい動画（スマホの画面録画など）のときだけ出す
  // （720p以下の動画は、どれを選んでも元の大きさのままなので出さない）。
  // 選んだことは覚えておき、出せない動画のあいだは 720p・1080p のどちらか（選択中なら 1080p）にしておく（次に出せる動画を選んだら戻す）
  var wantSource = false;
  function isStandardRes(meta) {
    var shortSide = Math.min(meta.width, meta.height);
    return Math.abs(shortSide - 720) <= 8 || Math.abs(shortSide - 1080) <= 8;
  }
  // 720p以下の動画（短い辺が720付近以下）は、1080p を選んでも拡大はしないので、720p にして 1080p を選べなくする
  // （1080p の下限ビットレートで 720p の動画を圧縮してしまうのを防ぐ）。
  // 選んでいた 1080p は want1080 で覚えておき、大きい動画を選んだら戻す（保存する設定も 1080p のまま）
  var want1080 = false;
  function isSmallSource(meta) { return !!meta && Math.min(meta.width, meta.height) <= 720 + 8; }
  function syncResOption() {
    var show = !!(state.meta && !isStandardRes(state.meta) && Math.min(state.meta.width, state.meta.height) > 720 + 8);
    els.resSeg.classList.toggle('is-three', show);
    if (show && wantSource) els.resSource.checked = true;
    else if (!show && els.resSource.checked) els.res1080.checked = true;
    var small = isSmallSource(state.meta);
    els.res1080.classList.toggle('is-locked', small);
    if (small && els.res1080.checked) {
      if (!wantSource) want1080 = true;
      els.res720.checked = true;
    } else if (!small && want1080) {
      els.res1080.checked = true;
      want1080 = false;
    }
  }
  // 目標サイズ（MB）。入力がおかしければ初期値、上限を超えたら上限にする
  function readTargetMB() {
    var mb = parseFloat(els.targetSize.value);
    if (!isFinite(mb) || mb < MIN_TARGET_MB) mb = DEFAULT_TARGET_MB;
    return Math.min(mb, MAX_TARGET_MB);
  }
  function readSettings() {
    var mb = readTargetMB();
    return {
      res: resValue(radioValue('res', '720')),
      mode: radioValue('mode', 'size') === 'quality' ? 'quality' : 'size',
      targetMB: mb,
      // 上限（この値「未満」に収める）。見積もりはこの97%を狙う
      targetBytes: Math.floor(mb * MB),
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

  // ---------------------------------------------------------------- 書き出す動画のファイル名
  // 詳細設定でオンにすると、選んだ項目を選んだ順に「_」でつないだ名前にする（全部オフなら今までの名前）
  var NAME_PARTS = [
    { key: 'date', label: '日付' },
    { key: 'datetime', label: '日付+時間' },
    { key: 'text1', label: '自由入力' },
    { key: 'text2', label: '自由入力2' },
    { key: 'rand', label: 'ランダム英数字4桁' },
    { key: 'opt', label: '圧縮オプション' },
    { key: 'orig', label: '元のファイル名' }
  ];
  var NAME_KEYS = NAME_PARTS.map(function (p) { return p.key; });
  var NAME_TEXT_MAX = 10;    // 自由入力の文字数
  var NAME_ORIG_MAX = 30;    // 元のファイル名の文字数
  function defaultNaming() {
    return { on: false, order: NAME_KEYS.slice(), enabled: ['date', 'text1', 'opt'], text: { text1: '', text2: '' } };
  }
  var naming = defaultNaming();
  // ファイル名に使えない記号・制御文字を外し、長さをそろえる
  function cleanName(v, max) {
    var t = String(v || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
    return Array.from(t).slice(0, max || NAME_ORIG_MAX).join('').trim();   // 文字単位で数える
  }
  // 自由入力は文字（ひらがな・カタカナ・漢字・英字）と数字、「-」「_」だけにする（絵文字・記号・空白は外す）
  function cleanText(v) {
    return Array.from(String(v || '').replace(/[^\p{L}\p{N}_-]/gu, '')).slice(0, NAME_TEXT_MAX).join('');
  }
  // ファイル名は多くの端末で 255 バイトまでなので、拡張子のぶんを残して 200 バイトに収める
  var NAME_MAX_BYTES = 200;
  function limitBytes(t) {
    var chars = Array.from(t);
    var enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    var size = function (x) { return enc ? enc.encode(x).length : unescape(encodeURIComponent(x)).length; };
    while (chars.length && size(chars.join('')) > NAME_MAX_BYTES) chars.pop();
    return chars.join('');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // ランダムな英数字4文字（数字だけだと意味があるように見えるため。見間違えやすい 0 o 1 l i は使わない）
  var RAND_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  function randDigits() {
    var v = new Uint32Array(4), out = '';
    try { crypto.getRandomValues(v); } catch (e) { for (var j = 0; j < 4; j++) v[j] = Math.floor(Math.random() * 1e9); }
    for (var i = 0; i < 4; i++) out += RAND_CHARS.charAt(v[i] % RAND_CHARS.length);
    return out;
  }
  // 並び順と使う項目を整える（知らない項目は捨て、日付と日付+時間はどちらか1つ）
  function setNaming(on, enabledKeys, orderKeys) {
    var enabled = [];
    enabledKeys.forEach(function (k) {
      if (NAME_KEYS.indexOf(k) < 0 || enabled.indexOf(k) >= 0) return;
      if ((k === 'date' && enabled.indexOf('datetime') >= 0) || (k === 'datetime' && enabled.indexOf('date') >= 0)) return;
      enabled.push(k);
    });
    var order = [];
    (orderKeys || []).concat(enabled, NAME_KEYS).forEach(function (k) {
      if (NAME_KEYS.indexOf(k) >= 0 && order.indexOf(k) < 0) order.push(k);
    });
    naming.on = !!on;
    naming.enabled = enabled;
    naming.order = order;
  }
  // kind: compressed（圧縮した）/ trimmed（トリミングのみ）/ copy（位置情報だけ除いた）/ original（元の動画のまま）
  function namePart(key, ctx) {
    var d = ctx.now;
    var ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    if (key === 'date') return ymd;
    if (key === 'datetime') return ymd + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    if (key === 'text1' || key === 'text2') return cleanText(naming.text[key]);
    if (key === 'rand') return ctx.rand;
    if (key === 'opt') {
      if (ctx.kind === 'original' || ctx.kind === 'copy') return '元のまま';
      if (ctx.kind === 'trimmed') return 'トリミング';
      var s = ctx.settings;
      return (s.res === 'source' ? '元解像度' : s.res + 'p') + '-' + (s.mode === 'quality' ? 'なるべく' : s.targetMB + 'MB');
    }
    if (key === 'orig') return cleanName(ctx.base);
    return '';
  }
  // 指定した名前（拡張子なし）。オフのとき・使う項目がないときは null（今までの名前にする）
  function customName(ctx) {
    if (!naming.on) return null;
    var parts = naming.order.filter(function (k) { return naming.enabled.indexOf(k) >= 0; })
      .map(function (k) { return namePart(k, ctx); })
      .filter(function (v) { return v; });
    return parts.length ? limitBytes(parts.join('_')) : null;
  }
  function fileBase() { return String((state.file && state.file.name) || 'video').replace(/\.[^.]+$/, '') || 'video'; }
  // 元の動画のまま渡すときの名前（拡張子は元のまま）
  function passthroughName() {
    var m = /\.[^.]+$/.exec((state.file && state.file.name) || '');
    var name = customName({ kind: 'original', now: new Date(), rand: state.nameRand || randDigits(), base: fileBase(), settings: readSettings() });
    return name ? name + (m ? m[0] : '.mp4') : ((state.file && state.file.name) || 'video.mp4');
  }
  // 詳細設定の項目の行を作り直す
  function renderNameList() {
    els.nameOn.checked = naming.on;
    show(els.nameBox, naming.on);
    els.nameList.textContent = '';
    naming.order.forEach(function (key, i) {
      var part = NAME_PARTS[NAME_KEYS.indexOf(key)];
      var on = naming.enabled.indexOf(key) >= 0;
      var li = document.createElement('li');
      li.dataset.key = key;
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.className = 'name-use';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(part.label));
      li.appendChild(label);
      [['up', '↑', i === 0], ['down', '↓', i === naming.order.length - 1]].forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm name-move';
        btn.dataset.move = b[0];
        btn.textContent = b[1];
        btn.disabled = b[2];
        btn.setAttribute('aria-label', part.label + 'を' + (b[0] === 'up' ? '上へ' : '下へ'));
        li.appendChild(btn);
      });
      if ((key === 'text1' || key === 'text2') && on) {
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'name-text';
        input.maxLength = NAME_TEXT_MAX;
        input.value = naming.text[key];
        input.placeholder = key === 'text1' ? '例：クリップ' : '例：ゲーム名';
        input.setAttribute('aria-label', part.label);
        li.appendChild(input);
      }
      els.nameList.appendChild(li);
    });
    // ファイル名の例は refresh() で更新する（呼ぶ側は、このあと必ず refresh() する）
  }
  var previewRand = randDigits();
  function updateNamePreview() {
    var name = customName({ kind: 'compressed', now: new Date(), rand: previewRand, base: state.file ? fileBase() : 'IMG_1234', settings: readSettings() });
    els.namePreview.textContent = name ? name + '.mp4' : '（項目がないので今までの名前）' + (state.file ? fileBase() : 'IMG_1234') + '_compressed.mp4';
  }

  // ---------------------------------------------------------------- 設定の一覧
  // 画面で変えられる設定。保存・読み込み・初期値に戻す・URL の読み取りと作成は、すべてこの一覧から行う
  // （設定を足すときは、ここに1つ足せばよい。ファイル名の設定は naming で別に扱う）
  //   key … 保存するときの名前   url … URL での名前   def … 初期値   ids … 画面の入力欄（変えたら保存する）
  //   read() … 画面から今の値を読む        write(v) … 画面に値を入れる（おかしな値は無視する）
  //   fromUrl(文字) … URL の値を読む（読めなければ undefined）   toUrl(v) … URL に書く文字
  function onOffWord(v) {
    v = v.toLowerCase();
    if (v === 'on' || v === '1' || v === 'true') return true;
    if (v === 'off' || v === '0' || v === 'false') return false;
    return undefined;
  }
  // チェックボックスの設定
  function checkSetting(key, url, id, def, fromUrl, toUrl) {
    return {
      key: key, url: url, def: def, ids: [id],
      read: function () { return !!els[id].checked; },
      write: function (v) { if (typeof v === 'boolean') els[id].checked = v; },
      fromUrl: fromUrl || onOffWord,
      toUrl: toUrl || function (v) { return v ? 'on' : 'off'; }
    };
  }
  // 数値の設定（範囲外は無視する）
  function numberSetting(key, id, def, min, max, round, read) {
    return {
      key: key, url: key, def: def, ids: [id], read: read,
      write: function (v) {
        var n = typeof v === 'string' ? parseFloat(v) : v;
        if (typeof n === 'number' && isFinite(n) && n >= min && n <= max) els[id].value = String(round ? Math.round(n) : n);
      },
      fromUrl: function (v) { var n = parseFloat(v); return isFinite(n) ? n : undefined; },
      toUrl: String
    };
  }
  var SETTING_DEFS = [
    // 解像度（「元の解像度」を選んだことは wantSource で覚える。出せない動画のあいだは画面の選択は 720p・1080p のまま）
    {
      key: 'res', url: 'res', def: '720', ids: ['res720', 'res1080', 'resSource'],
      read: function () { return wantSource ? 'source' : want1080 ? '1080' : resValue(radioValue('res', '720')); },
      write: function (v) {
        want1080 = false;
        if (v === '1080') { els.res1080.checked = true; wantSource = false; }
        else if (v === '720') { els.res720.checked = true; wantSource = false; }
        // 元の解像度：選択肢が出ない動画（720p・1080p など）のあいだは 1080p にしておく。
        // 選択肢が出る動画を選ぶと syncResOption で「元の解像度」に切り替わる
        else if (v === 'source') { els.res1080.checked = true; wantSource = true; }
      },
      fromUrl: function (v) { v = v.toLowerCase().replace('p', ''); return v === 'original' ? 'source' : v; },
      toUrl: String
    },
    // 圧縮方法（size＝◯MB以内に圧縮、quality＝なるべく圧縮）
    {
      key: 'mode', url: 'mode', def: 'size', ids: ['modeQuality', 'modeSize'],
      read: function () { return radioValue('mode', 'size') === 'quality' ? 'quality' : 'size'; },
      write: function (v) { if (v === 'quality') els.modeQuality.checked = true; else if (v === 'size') els.modeSize.checked = true; },
      fromUrl: function (v) {
        v = v.toLowerCase();
        return (v === 'max' || v === 'best') ? 'quality' : v === 'target' ? 'size' : v;
      },
      toUrl: String
    },
    numberSetting('target', 'targetSize', DEFAULT_TARGET_MB, MIN_TARGET_MB, MAX_TARGET_MB, false, readTargetMB),
    numberSetting('min720', 'minRate720', DEFAULT_MIN_KBPS['720'], MIN_KBPS_LIMITS[0], MIN_KBPS_LIMITS[1], true,
      function () { return readKbps(els.minRate720, DEFAULT_MIN_KBPS['720']); }),
    numberSetting('min1080', 'minRate1080', DEFAULT_MIN_KBPS['1080'], MIN_KBPS_LIMITS[0], MIN_KBPS_LIMITS[1], true,
      function () { return readKbps(els.minRate1080, DEFAULT_MIN_KBPS['1080']); }),
    // 60fpsの動画は30fpsにする（URL は fps=30|source）
    checkSetting('halfFps', 'fps', 'halfFps', true, function (v) {
      v = v.toLowerCase();
      if (v === '30' || v === 'half') return true;
      if (v === 'source' || v === 'keep' || v === '60') return false;
      return undefined;
    }, function (v) { return v ? '30' : 'source'; }),
    checkSetting('auto', 'auto', 'autoRun', false),     // 動画を選んだらすぐ圧縮
    checkSetting('audio', 'audio', 'audioOn', true)     // 音声を残す
  ];

  // ---------------------------------------------------------------- 設定を覚える
  // 画面で設定を変えたらこの端末のブラウザ内に保存し、次に開いたときに戻す。
  // URL パラメータで開いたときの値は保存しない（画面で変えたときだけ保存する）
  var SAVED_FIELDS = SETTING_DEFS.reduce(function (ids, d) { return ids.concat(d.ids); }, []);
  function saveSettings() {
    var data = {};
    SETTING_DEFS.forEach(function (d) { data[d.key] = d.read(); });
    data.name = { on: naming.on, order: naming.order, enabled: naming.enabled, text1: naming.text.text1, text2: naming.text.text2 };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境では覚えない */ }
  }
  function loadSavedSettings() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') return;
    SETTING_DEFS.forEach(function (def) { if (def.key in d) def.write(d[def.key]); });
    var n = d.name;
    if (n && typeof n === 'object' && Array.isArray(n.enabled) && Array.isArray(n.order)) {
      setNaming(n.on === true, n.enabled, n.order);
      naming.text.text1 = cleanText(n.text1);
      naming.text.text2 = cleanText(n.text2);
    }
  }
  function resetSettings() {
    // 圧縮中・圧縮後は、ほかの設定と同じく変えさせない（圧縮中の計画と画面の設定がずれないように）
    if (state.running || isCompressed()) return;
    try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* noop */ }
    SETTING_DEFS.forEach(function (d) { d.write(d.def); });
    naming = defaultNaming();
    renderNameList();
    refresh();
  }

  // ファイル名の設定の URL での名前（name=date,text1,opt と、自由入力の text1=… text2=…）
  var SETTING_PARAMS = SETTING_DEFS.map(function (d) { return d.url; }).concat(['name', 'text1', 'text2']);
  function hasSettingParams() {
    try {
      var params = new URLSearchParams(window.location.search);
      return SETTING_PARAMS.some(function (k) { return params.has(k); });
    } catch (e) { return false; }
  }
  // ショートカットなどから URL で初期値を渡せる（詳細設定の項目も含む）
  //   res=720|1080|source  mode=size|quality  target=MB  min720=kbps  min1080=kbps  fps=30|source  auto=on|off  audio=on|off
  function applyUrlParams() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    SETTING_DEFS.forEach(function (d) {
      var raw = params.get(d.url);
      if (raw === null) return;
      var v = d.fromUrl(raw);
      if (v !== undefined) d.write(v);
    });
    // ファイル名: name=date,text1,opt（使う項目を並べる順に。off で指定しない）、text1=… text2=…（自由入力）
    if (params.has('name')) {
      var nv = (params.get('name') || '').toLowerCase();
      if (nv === 'off') naming.on = false;
      else {
        var keys = nv.split(',').map(function (k) { return k.trim(); });
        setNaming(true, keys, keys);
      }
    }
    ['text1', 'text2'].forEach(function (k) { if (params.has(k)) naming.text[k] = cleanText(params.get(k)); });
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

  // 撮影場所（GPS）の情報が入っているか。Android は ©xyz、iPhone は com.apple.quicktime.location.ISO6709 などに入る。
  // メタデータを読めなかったときは null（不明）を返す。不明なときは「なし」と同じに扱わない（元の動画をそのまま渡さない）
  function hasLocationTag(tags) {
    if (!tags) return null;
    var raw = tags.raw;
    if (!raw) return false;
    return Object.keys(raw).some(function (k) { return /xyz|location|gps/i.test(k); });
  }
  // 書き出す動画のメタデータ。位置情報などが入る生のデータ（raw）はすべて除き、題名や日付などだけ残す
  function outputTags(tags) {
    var out = {};
    Object.keys(tags || {}).forEach(function (k) { if (k !== 'raw') out[k] = tags[k]; });
    return out;
  }

  // 高速モード: Mediabunny でコンテナを読んで情報を得る
  function loadMetaFast(file) {
    var input = new M.Input({ source: new M.BlobSource(file), formats: INPUT_FORMATS });
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
    }).then(function (m) {
      try { input.dispose(); } catch (e) { /* noop */ }
      return m;
    }, function (err) {
      try { input.dispose(); } catch (e) { /* noop */ }
      throw err;
    });
  }

  // 読み込めなかったときの文言。codec は高速モードで分かった映像の形式（分からなければ undefined）
  var CODEC_NAMES = { hevc: 'HEVC/H.265', avc: 'H.264', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' };
  // 端末によっては一時的に読み込めず、もう一度選ぶと読み込めることがあるので、まず選び直してもらう
  var MSG_READ_FAIL = '動画をうまく受け取れませんでした（端末側で一時的に読み込めないことがあります）。「動画を選択」からもう一度同じ動画を選んでください。';
  var MSG_PICK_AGAIN = '一時的に読み込めないこともあるので、まずは「動画を選択」からもう一度選び直してください。';
  // iPhone は、動画の処理中に別のアプリに切り替えると、動画のデコーダーが固まることがある。
  // 固まるとこのページからは直せず、Safari（ホーム画面のアプリ）を開き直すまで動画を読み込めない
  var MSG_CODEC_STUCK = 'この端末の動画の処理が止まったままになっています。ブラウザ（ホーム画面に追加した場合はそのアプリ）をいったん完全に閉じて開き直してから、もう一度お試しください（iPhone は、アプリの切り替え画面で上にスワイプすると閉じられます）。';
  var MSG_KILL_BROWSER = 'ブラウザをタスクキルしてください！';
  var MSG_NO_H264 = 'この端末では動画のエンコード（H.264）に対応していません。';
  var MSG_NO_VIDEO_TRACK = '映像トラックが見つかりませんでした。';
  var MSG_CANVAS_FAIL = 'canvasを初期化できませんでした。';
  var MSG_STALLED = '圧縮が進まなくなりました。画面を表示したまま、もう一度お試しください。';
  var MSG_PLAY_FAILED = '動画を再生できませんでした。画面を表示したまま、もう一度お試しください。';
  var MSG_REPORT = 'うまくいかないときは、画面のいちばん下の「診断情報」をコピーして、X（@inkaroma0431）あるいはDiscordに送ってください。';
  var MSG_AUDIO_COPY_FAILED = '元の動画の音声をそのまま使えなかったため、音声なしで圧縮しました。';
  var MSG_PLAY_LOW_POWER = '動画を再生できませんでした。低電力モードがオンのときは再生できないことがあるので、オフにしてからもう一度お試しください。';
  // 読み込み・圧縮のエラーの赤枠に出す行（デコーダーが固まったときは、先に太字でタスクキルを促す）
  function errorLines(message) {
    return message === MSG_CODEC_STUCK ? [{ bold: MSG_KILL_BROWSER }, message] : [message];
  }
  function codecStuckError() { var e = new Error(MSG_CODEC_STUCK); e.stuck = true; return e; }
  // デコーダーへの問い合わせに時間制限を付ける（応答がなければ codecStuckError）
  function withinDecoderCheck(promise) {
    return Promise.race([promise, sleep(DECODER_CHECK_MS).then(function () { throw codecStuckError(); })]);
  }
  function loadFailMessage(codec) {
    if (!codec) return '動画を読み込めませんでした。' + MSG_PICK_AGAIN + '何度選んでも読み込めないときは、ファイルが壊れているか、対応していない形式です（MP4・MOVに対応しています）。';
    return 'この端末は、この動画の映像形式（' + (CODEC_NAMES[codec] || codec) + '）の読み込みに対応していない可能性があります。' + MSG_PICK_AGAIN +
      (codec === 'hevc' ? '何度選んでも読み込めないときは、別の端末で試すか、iPhoneで撮影するときは「設定」→「カメラ」→「フォーマット」を「互換性優先」にしてください。' : '何度選んでも読み込めないときは、別の端末でお試しください。');
  }

  // 互換モード: <video> で長さと解像度を読み、冒頭を少し再生してフレームレートを測る
  function loadMetaCompat(videoEl, codec) {
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
  function borrowVideo(videoEl, hideControls) {
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
  // 音声の扱い（mode: aac＝AAC に変換・copy＝そのまま・none＝なし。note は圧縮する前に知らせる文）
  function aacAudio() { return { mode: 'aac', bps: AUDIO_BITRATE, label: 'AAC ' + fmtRate(AUDIO_BITRATE), note: null }; }
  function noAudio(note, label) { return { mode: 'none', bps: 0, label: label || 'なし', note: note || null }; }

  function audioStrategy(meta, wanted, engine) {
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

  // ---------------------------------------------------------------- 圧縮プラン
  function resolutionCap(meta, res) {
    if (res === 'source') return 1;   // 元の解像度のまま
    var limit = res === '1080' ? 1080 : 720;
    var shortSide = Math.min(meta.width, meta.height);
    return shortSide > limit ? limit / shortSide : 1;   // 拡大はしない
  }

  // videoCapBps: 映像ビットレートの上限を直接指定する（トリミングのみで目標を超えたとき、切り出した部分の実測値を使う）。
  //   省略時は、ファイル全体の平均ビットレート（元が HEVC なら1.5倍）を上限にする
  function makePlan(meta, trim, settings, audio, fileSize, forcedVideoBitrate, videoCapBps) {
    var duration = Math.max(0.1, trim.end - trim.start);
    var srcFps = meta.fps || DEFAULT_FPS;
    var outFps = (settings.halfFps && srcFps > 40) ? srcFps / 2 : srcFps;
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
      trimStart: trim.start, trimEnd: trim.end, duration: duration,
      srcFps: srcFps, outFps: outFps, fpsChanged: Math.abs(outFps - srcFps) > 0.05,
      width: width, height: height, videoBitrate: videoBps, floorBitrate: minBps, videoCapBps: videoCapBps || null,
      audio: audio, audioBitrate: audioBps,
      estBytes: estBytes,
      unreachable: unreachable,                        // 目標サイズに収められない（◯MB以内に圧縮のとき）
      overDiscord: estBytes > DISCORD_FREE_BYTES       // Discord無料アカウントの上限を超える見込み
    };
  }

  // 計画の音声のバイト数と、書き出した動画の映像ビットレートの実測値（音声のぶんを引く）
  function audioBytesOf(plan) { return plan.audioBitrate * plan.duration / 8; }
  function videoBpsOf(res, plan) { return Math.round((res.blob.size - audioBytesOf(plan)) * 8 / plan.duration); }

  // 書き出した実サイズから、目標に収まる映像ビットレートを計算し直す（無理なら null）
  function nextBitrate(plan, videoBytes, audioBytes) {
    var allowed = plan.targetBytes * SIZE_SAFETY - (audioBytes || 0);
    if (!(allowed > 0) || !(videoBytes > 0)) return null;
    var ratio = Math.max(0.3, Math.min(0.95, allowed / videoBytes));   // 最低5%は下げ、下げすぎない
    var next = Math.floor(plan.videoBitrate * ratio);
    return next >= 100000 ? next : null;
  }

  // 範囲が動画の全体か（ほんの少し（0.05秒以内）ずれているだけなら全体とみなす）
  var FULL_RANGE_MARGIN = 0.05;
  function isFullRange(start, end) {
    if (!state.meta) return true;
    return start <= FULL_RANGE_MARGIN && end >= state.meta.duration - FULL_RANGE_MARGIN;
  }
  function isFullTrim() { return isFullRange(state.trim.start, state.trim.end); }

  // mode … 画面で選んだモードの代わりに使うモード（省略時は画面のとおり）
  function currentPlan(mode) {
    var settings = readSettings();
    if (mode) settings.mode = mode;
    var audio = audioStrategy(state.meta, settings.audio, state.engine);
    // 予圧縮の予想があれば当てはめる
    return withEstimate(makePlan(state.meta, state.trim, settings, audio, state.file.size));
  }

  // ---------------------------------------------------------------- 表示の更新
  // 圧縮前は元動画を大きく、圧縮が終わったら圧縮後の動画を大きく表示する。
  // 元のまま共有できる（圧縮不要）ときや、圧縮し直している間は、元動画を大きくする
  function updateMediaLayout() {
    var done = isCompressed();
    els.srcBox.classList.toggle('is-large', !done);
    els.srcBox.classList.toggle('is-small', done);
    els.outBox.classList.toggle('is-large', done);
    els.outBox.classList.toggle('is-small', !done);
  }

  function refresh() {
    updateMediaLayout();
    syncResOption();
    var s = readSettings();
    els.sizeLabel.textContent = String(s.targetMB);
    // 狙うサイズは丸めずに見せる（例: 50MB → 48.5 MB、33MB → 32.01 MB）
    els.capLabel.textContent = String(Math.round(s.targetBytes * SIZE_SAFETY / MB * 100) / 100) + ' MB';
    var hasFile = !!(state.file && state.meta);
    var locked = state.running || state.busy;
    // 圧縮が終わったら「やり直す」を押すまで、トリミングと設定を変えられないようにする
    var done = isCompressed();

    [els.trimStart, els.trimEnd].forEach(function (el) { el.disabled = !hasFile || locked || done; });
    // シークバーは圧縮後も元動画の確認に使えるようにする（圧縮中だけ止める）
    els.trimSeek.disabled = !hasFile || locked;
    [els.res720, els.res1080, els.resSource, els.modeQuality, els.modeSize, els.targetSize, els.halfFps, els.audioOn,
      els.minRate720, els.minRate1080, els.autoRun, els.nameOn, els.resetSettings].forEach(function (el) { el.disabled = state.running || done; });
    if (isSmallSource(state.meta)) els.res1080.disabled = true;   // 720p以下の動画は 1080p を選べない
    Array.prototype.forEach.call(els.nameList.querySelectorAll('input, button'), function (el) {
      el.disabled = state.running || done || (el.dataset.move === 'up' && !el.parentNode.previousSibling) ||
        (el.dataset.move === 'down' && !el.parentNode.nextSibling);
    });
    updateNamePreview();
    els.repickBtn.disabled = locked;
    els.runBtn.textContent = state.running ? 'キャンセル' : done ? 'やり直す' : '圧縮する';

    if (!hasFile) {
      showPrecompressHints(null);
      els.runBtn.disabled = !state.running;
      els.planInfo.textContent = '';
      // 読み込みに失敗したときは、その理由を出したままにする
      setAlert(els.planWarn, state.loadError ? errorLines(state.loadError) : [], true);
      return;
    }

    var plan = state.plan = currentPlan();
    scheduleProbe();
    showPrecompressHints(plan);
    els.audioLabel.textContent = '音声を残す（' + plan.audio.label + '）';
    var trimEst = trimOnlyEstimate(plan);
    els.planInfo.textContent = trimEst
      ? '→ ' + copyLabel(plan) + '（再圧縮なし）・' +
        plan.width + '×' + plan.height + '・予想' + fmtBytes(trimEst)
      : '→ ' + plan.width + '×' + plan.height + '・' + fmtFps(plan.outFps) + '・' +
        // 予圧縮で測れたら、ビットレートは実測の平均。目標サイズに収まる秒数の目安も出す
        // （範囲が目安を超えていればトリミングを促し、収まっていれば収まる長さを伝える）
        fmtRate(plan.probed ? plan.expectedBps : plan.videoBitrate) + '・予想' + fmtBytes(plan.estBytes) + probeLabel(plan) +
        (plan.probed && plan.fitSec ? '・' + (plan.duration > plan.fitSec
          ? plan.targetMB + 'MBに収めるなら約' + fmtDuration(plan.fitSec) + '以内にトリミングしてね'
          : '約' + fmtDuration(plan.fitSec) + 'まで' + plan.targetMB + 'MBに収まるよ') : '');

    var warns = [];
    if (plan.mode === 'size' && plan.unreachable && !trimEst) {
      warns.push(MSG_UNREACHABLE);
      // 今の解像度と下限ビットレートで、目標サイズに収まる長さの目安
      var fitSec = Math.floor(plan.targetBytes * 8 * SIZE_SAFETY / (plan.floorBitrate + plan.audioBitrate));
      warns.push(resLabel(plan) + 'なら' + fmtDuration(fitSec) + 'まで' + plan.targetMB + 'MBに収められます。');
    }
    var probeOver = plan.probeOver && !trimEst;
    if (probeOver) warns.push(probeOverMessage(plan));
    if (plan.audio.note) warns.push(plan.audio.note);   // 音声を残せないとき（圧縮する前に知らせる）
    if (state.meta.hasLocation === true) warns.push(MSG_LOCATION);
    // 目標サイズに収まらないと出しているときは、同じ内容になる20MB超えの注意は重ねない
    if (!(plan.mode === 'size' && plan.unreachable && !trimEst) && !probeOver && (trimEst ? trimEst > DISCORD_FREE_BYTES : plan.overDiscord)) {
      warns.push(MSG_OVER_DISCORD);
    }
    setAlert(els.planWarn, warns);

    // 目標サイズを超えるのが分かっているときは実行させない（処理中はキャンセル、圧縮後はやり直すボタンなので有効のまま）
    // （再圧縮では収まらなくても、トリミングのみ（再圧縮なし）で収まる見込みなら実行できる）
    els.runBtn.disabled = !state.running && !done && (state.busy || (plan.mode === 'size' && plan.unreachable && !trimEst));

    updatePassthrough(s);
  }

  // 元の動画から取り除く必要があるもの（元の動画をそのまま渡してはいけない理由）
  //   location … 位置情報が入っている、または入っているか分からない
  //   audio    … 「音声を残す」がオフなのに、元の動画に音声が入っている（または入っているか分からない）
  function stripNeeds(settings) {
    var meta = state.meta || {};
    return { location: meta.hasLocation !== false, audio: !settings.audio && meta.audio !== null };
  }
  // すでに目標サイズ以下なら、圧縮せずそのまま共有・保存できるようにする
  function updatePassthrough(settings) {
    if (state.running) return;
    // 位置情報や音声を取り除く必要がある動画は、元の動画をそのまま渡さない（「圧縮する」で取り除いて書き出す）
    var need = stripNeeds(settings);
    var canPass = settings.mode === 'size' && isFullTrim() && state.file.size < settings.targetBytes &&
      !need.location && !need.audio;
    if (canPass && (!state.out || state.out.original)) {
      if (!state.out) {
        setOutput({ blob: state.file, name: passthroughName(), type: state.file.type || 'video/mp4', original: true });
      }
      state.out.name = passthroughName();   // ファイル名の設定を変えたら、渡す名前も合わせる
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
  function renderPlayhead() {
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
  function onSeeked() {
    if (seekQueue.pending === null) return;
    var t = seekQueue.pending;
    seekQueue.pending = null;
    seekVideo(t);
  }

  function onSeekInput() {
    seekDragging = true;
    seekVideo(parseFloat(els.trimSeek.value) || 0);
  }
  function endSeekDrag() { seekDragging = false; }

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
  function followPlayhead() {
    headRaf = 0;
    renderPlayhead();
    if (!els.srcVideo.paused && !els.srcVideo.ended) headRaf = requestAnimationFrame(followPlayhead);
  }

  function onTrimInput(which) {
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

  // ---------------------------------------------------------------- 高速モード（Mediabunny Conversion）
  function encKey(c) { return c.codec + '/' + c.hw + '/' + c.bitrateMode; }
  function pickFastEncoding(plan) {
    // 可変ビットレート（VBR）を優先し、使えなければ固定ビットレート（CBR）にする。
    // plan.preferCbr（VBR では指定のサイズに収まらなかった）なら CBR を優先する
    // （CBR を優先するときは、ハードウェアの CBR が使えなければ、ハードウェアの VBR より先にソフトウェアの CBR を試す。
    //   Android の実機で、ハードウェアは VBR しか使えず、VBR ではビットレートを下げても小さくならなかった）
    var hws = ['prefer-hardware', 'no-preference'];
    var cands = [];
    FAST_VIDEO_CODECS.forEach(function (codec) {
      if (plan.preferCbr) {
        ['constant', 'variable'].forEach(function (bm) {
          hws.forEach(function (hw) { cands.push({ codec: codec, hw: hw, bitrateMode: bm }); });
        });
      } else {
        hws.forEach(function (hw) {
          ['variable', 'constant'].forEach(function (bm) { cands.push({ codec: codec, hw: hw, bitrateMode: bm }); });
        });
      }
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
  function newMp4Output() {
    return new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
  }
  function outputBlob(output) { return new Blob([output.target.buffer], { type: 'video/mp4' }); }

  // Mediabunny の Conversion で1回書き出す（高速モードとトリミングのみで共通）。結果は { blob, audioDropped }
  //   spec.options(input, output) … Conversion.init に渡す設定（Promise でもよい）
  //   spec.prepareLog()           … 準備ができたときに診断情報へ書く見出し（なければ書かない）
  //   spec.invalidMessage         … 扱えない動画だったときの文言
  //   spec.startLog               … 変換を始めるときに診断情報へ書く文（なければ書かない）
  //   spec.input                  … 使う読み込み（予圧縮からの切り出し）。渡したときは閉じない（なければ開いて、終わったら閉じる）
  //   spec.output                 … 書き出し先（予圧縮）。渡したときは結果の blob を作らない
  //   spec.onReady(conv, audioLost) … 変換の準備ができたとき（予圧縮で、音声が外れたかを早めに知る）
  function runConversion(spec, plan, onProgress, job) {
    var input = spec.input || new M.Input({ source: new M.BlobSource(state.file), formats: INPUT_FORMATS });
    var output = spec.output || newMp4Output();
    function dispose() {
      if (spec.input) return;
      try { input.dispose(); } catch (e) { /* noop */ }
    }
    job.hooks.push(dispose);   // 準備中に止めた場合も、ファイルの読み込みを閉じる

    return Promise.resolve().then(function () {
      return spec.options(input, output);
    }).then(function (options) {
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

  // 高速モードの映像の設定（本番の圧縮と試し圧縮で共通）
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

  // 高速モードの変換の設定（本番の圧縮と予圧縮で共通）
  function fastOptions(plan, enc, input, output) {
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
  function convertFast(plan, onProgress, job) {
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
  function copyLabel(plan) {
    if (!isFullTrimOf(plan)) return 'トリミングのみ';
    var need = stripNeeds({ audio: plan.wantAudio });
    if (need.audio && need.location) return '位置情報と音声を除いて元のまま';
    return need.audio ? '音声を除いて元のまま' : '位置情報を除いて元のまま';
  }

  function isFullTrimOf(plan) { return isFullRange(plan.trimStart, plan.trimEnd); }

  // ---------------------------------------------------------------- 予圧縮（サイズの予想と、先に済ませておく圧縮）
  // 端末のエンコーダーは、映像によって指定のビットレートを守らない（重い映像では下げきれず多く使い、軽い映像では使い切らない。
  // iPhone の 1080p60 のゲーム映像で、2.7Mbps・4.05Mbps のどちらを指定しても約7.5Mbps になった）。そこで、実際に圧縮して測る。
  // 動画を読み込んだら（設定を変えたときも）、範囲に関係なく動画の最初から最後までを裏で圧縮し（予圧縮）、
  // 書き出したデータの量から、ビットレートとサイズの予想を出す。予圧縮は、モードにかかわらず決めた下限ビットレートで行う
  // （範囲の長さでビットレートを変えると、範囲を変えるたびにやり直しになるため）。
  // 「なるべく圧縮」で設定を変えずに「圧縮する」を押したら、範囲の始まりまで届いていれば、
  // 範囲の終わりまで続けて、範囲を切り出して使う。「◯MB以内」では予想と注意にだけ使い、押したら普通に圧縮する
  var FIT_MARGIN = 0.95;
  // 「◯MB以内」でも、予圧縮を切り出した大きさが目標のこの割合以上（かつ目標未満）なら、予圧縮をそのまま使う
  // （目標いっぱいまで使って圧縮し直しても、大きさ・画質はほとんど変わらないので、すぐ出せる方を選ぶ）
  var PRE_SIZE_USE_RATIO = 0.95;             // 「◯MBに収めるなら約◯秒まで」は、実測の平均で収まる秒数のこの割合を出す
  var PRE_DELAY_MS = 1500;           // 設定を変えてから予圧縮をやり直すまで待つ（続けて変えたときに何度もやり直さない）
  var PRE_FRAGMENT_SEC = 1;          // 予圧縮の書き出しの区切りの最短の長さ（実際はキーフレームごと＝約2秒ごとに書き出される）
  var PRE_TAIL_SEC = 1;              // 範囲の終わりからこれだけ先まで書き出せたら、範囲の終わりまで書き出せたとみる
  // URL に probe=off があれば予圧縮しない（自動テスト・自己テストで、本番の圧縮だけを確かめるため）
  var PROBE_OFF = /[?&]probe=off\b/.test(location.search);
  // pre … { file, key, plan, enc, job, chunks, bytes, marks: [{ t: 書き出したときの進み（秒）, bytes: そこまでの量 }],
  //         time: 進み（秒）, done, failed, audioLost, t0 }
  var pre = null, preTimer = null;

  function canProbe() {
    return !PROBE_OFF && !!(state.file && state.meta) && state.engine === 'fast' && !state.running && !state.busy && !isCompressed() &&
      !els.autoRun.checked && document.visibilityState === 'visible';
  }
  // 予圧縮の計画（動画全体・今の解像度とfpsと音声・下限ビットレート）
  function prePlan(plan) {
    return makePlan(state.meta, { start: 0, end: state.meta.duration }, Object.assign(planSettings(plan), { mode: 'quality' }),
      plan.audio, state.file.size);
  }
  // 予圧縮の中身を決めるもの（これが変わったら予圧縮をやり直す）
  function preKey(pp) {
    return pp.width + 'x' + pp.height + '@' + Math.round(pp.outFps) + '/' + pp.videoBitrate + '/' + pp.audio.mode + '/' + pp.audioBitrate;
  }
  // 予圧縮で書き出した量から、範囲の映像のビットレートの予想を出す（まだどこも書き出していなければ null）
  //   済んだ所 … 書き出した区切りごとの実測（音声の分を引く）。まだの所 … 済んだ所（動画全体のうち）の平均
  //   bps      … 本番で指定するビットレート（下限より高いとき）。区切りごとに「指定」と「実測」の大きい方になるとみる
  //              （下限の実測がそれより高い場面は、エンコーダーがそこまでしか下げられない）
  function preEstimate(plan, rec, bps) {
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
  // 計画に予圧縮の予想を当てはめる（今の設定の予圧縮がまだ何も書き出していなければ、そのまま）
  //   probed      … 予圧縮の予想を使った
  //   expectedBps … 映像のビットレートの予想（予想のサイズから求める）
  //   fitSec      … 目標サイズに収まる秒数の目安（下限ビットレートでの実測の平均で収まる秒数の95%）
  //   probeOver   … 「◯MB以内」で、範囲が fitSec より長い（目標サイズに収まらない可能性がある。押せなくはしない）
  function withEstimate(plan) {
    if (state.engine !== 'fast' || !pre || pre.file !== state.file || pre.key !== preKey(prePlan(plan))) return plan;
    var floorEst = preEstimate(plan, pre, 0);
    if (!floorEst) return plan;
    var p = Object.assign({}, plan, { probed: true });
    var floorTotal = floorEst.videoBps + p.audioBitrate;
    var floorBytes = Math.round(floorTotal * p.duration / 8);
    p.fitSec = floorTotal > 0 ? Math.floor(p.targetBytes * 8 / floorTotal * FIT_MARGIN) : 0;
    if (plan.mode === 'size') {
      // 「◯MB以内」：収まるかどうかは、画面に出す目安（「約◯秒まで」）で決める（トリミングの帯の黄色と同じ）。
      // 予想は、区切りごとの「指定」と「下限での実測」の大きい方を、狙うサイズ（目標の97%）で頭打ちにし、
      // 下限での実測より小さくはしない（大きい方をとる見込みは多めに出る。エンコーダーは平均を指定に寄せるため。
      // iPhone：29.8秒・指定 5.0Mbps で、見込み 21.1MB に対し実際 18.8MB。超えても圧縮し直しで下限まで下げられる）
      p.probeOver = !p.unreachable && p.duration > p.fitSec;
      var setBytes = Math.round((preEstimate(plan, pre, plan.videoBitrate).videoBps + p.audioBitrate) * p.duration / 8);
      p.estBytes = Math.max(floorBytes, Math.min(setBytes, Math.floor(p.targetBytes * SIZE_SAFETY)));
    } else {
      // なるべく圧縮：予圧縮が範囲の終わりまで済んでいれば、切り出したときの大きさ（1コマごとの表から数える）
      p.probeOver = false;
      var exact = null;
      try { exact = exactCutBytes(plan, pre); } catch (e) { exact = null; }
      p.estBytes = exact || floorBytes;
      p.exactEst = !!exact;
    }
    p.expectedBps = Math.max(0, Math.round(p.estBytes * 8 / p.duration - p.audioBitrate));
    p.overDiscord = p.estBytes > DISCORD_FREE_BYTES;
    return p;
  }
  // 画面の予想の後ろに付ける、予圧縮の状況
  function probeLabel(plan) {
    if (plan.probed) return pre.done ? '（予圧縮済み）' : '（予圧縮 ' + Math.floor(pre.time / pre.plan.duration * 100) + '%）';
    return pre && pre.file === state.file && (pre.job || preTimer) ? '（予圧縮中）' : '';
  }
  // 予圧縮の結果を画面に出す。範囲が目標サイズに収まる長さの目安を超えていれば、トリミングの帯を黄色にする。
  // 予圧縮が済んでいれば、「なるべく圧縮」の下に、押せばすぐ出せる大きさを出す
  function showPrecompressHints(plan) {
    var idle = !!plan && !state.running && !isCompressed();
    els.trimBox.classList.toggle('is-over', idle && !!plan.probed && plan.fitSec > 0 && plan.duration > plan.fitSec);
    // 「なるべく圧縮」「◯MB以内」それぞれ、押せば予圧縮をそのまま使えるなら、その大きさを選択肢の下に出す
    var note = '', noteSize = '';
    if (idle && pre && pre.done) {
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
  function probeOverMessage(plan) {
    // すでに 720p のときは、720p にする案は出さない
    return 'この設定では' + plan.targetMB + 'MBに収まらない可能性があります（目安は約' + fmtDuration(plan.fitSec) + 'まで）。' +
      (plan.res !== '720' ? '720pにするか、' : '') + 'トリミングするか、「なるべく圧縮」を選択してください。';
  }
  function logEstimate(plan) {
    if (!plan || !plan.probed) return;
    log('予想' + probeLabel(plan) + ' 映像 ' + fmtRate(plan.expectedBps) + '・' + fmtBytes(plan.estBytes) +
      '・' + plan.targetMB + 'MBに収めるなら約' + plan.fitSec + '秒まで' + (plan.probeOver ? '（目標サイズに収まらない見込み）' : ''));
  }

  // 今の設定の予圧縮がまだなら始める。設定が変わったら止めて、少し待ってからやり直す
  function scheduleProbe() {
    if (!canProbe() || !state.plan) return;
    var file = state.file;
    var key = preKey(prePlan(state.plan));
    if (pre && pre.file === file && pre.key === key && (pre.job || pre.done || pre.failed)) return;
    if (pre && pre.job) stopPre('設定を変えた');
    if (preTimer && preTimer.key === key) return;
    if (preTimer) clearTimeout(preTimer.id);
    var delay = pre && pre.file === file ? PRE_DELAY_MS : 0;
    preTimer = { key: key, id: setTimeout(function () {
      preTimer = null;
      if (!canProbe() || !state.plan) return;
      var pp = prePlan(state.plan);
      if (preKey(pp) === key) startPre(pp, key); else scheduleProbe();
    }, delay) };
  }

  // ---- 予圧縮の区切り（fragmented MP4）の表を読む。1コマごとの大きさ・時刻・キーフレームかどうかが分かるので、
  // 範囲を切り出したときの大きさを正確に予想できる（区切りの途中で切ると、割合で数えるより正確。
  // 区切りの頭はキーフレームで大きいので、割合で数えると小さめに出ていた）
  // 切り出した mp4 の見出し（目次など）の大きさの目安（バイト）。実測では 1000＋1コマ（音声の1区切り）あたり約4.5バイト。
  // 少し多めに見込む（予想は小さく外れるより、大きく外れる方がよい）
  var CUT_OVERHEAD_BASE = 1000;
  var CUT_OVERHEAD_PER_SAMPLE = 5;

  function boxType(buf, o) { return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]); }
  // buf の [start, end) にある箱を順に fn(type, 中身の始まり, 終わり) で渡す
  function eachBox(buf, dv, start, end, fn) {
    var o = start;
    while (o + 8 <= end) {
      var size = dv.getUint32(o), head = 8;
      if (size === 1) { size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12); head = 16; }
      else if (size === 0) size = end - o;
      if (size < head || o + size > end) return;
      fn(boxType(buf, o + 4), o + head, o + size);
      o += size;
    }
  }
  // 受け取ったデータの [off, off + len) を写し取る（区切りの書き出しは先頭から順に届く）
  function readChunks(rec, off, len) {
    var out = new Uint8Array(len), got = 0;
    for (var i = rec.parseChunk || 0; i < rec.chunks.length && got < len; i++) {
      var c = rec.chunks[i], cEnd = c.position + c.data.byteLength;
      if (cEnd <= off + got) { rec.parseChunk = i + 1; continue; }
      var from = off + got - c.position, n = Math.min(len - got, c.data.byteLength - from);
      out.set(c.data.subarray(from, from + n), got);
      got += n;
    }
    return got === len ? out : null;
  }
  // 届いた分の箱を読み進める（moov でトラックの情報を、moof で1コマごとの表を読む）
  function parseFragments(rec) {
    if (!rec.tracks) { rec.tracks = {}; rec.samples = { video: [], audio: [] }; rec.parseOff = 0; }
    while (rec.parseOff + 16 <= rec.bytes) {
      var head = readChunks(rec, rec.parseOff, 16);
      if (!head) return;
      var hv = new DataView(head.buffer), size = hv.getUint32(0), type = boxType(head, 4);
      if (size === 1) size = hv.getUint32(8) * 4294967296 + hv.getUint32(12);
      if (size < 8 || rec.parseOff + size > rec.bytes) return;   // まだ全部届いていない
      if (type === 'moov' || type === 'moof') {
        var buf = readChunks(rec, rec.parseOff, size);
        if (!buf) return;
        var dv = new DataView(buf.buffer);
        if (type === 'moov') parseMoov(rec, buf, dv, size);
        else parseMoof(rec, buf, dv, size);
      }
      rec.parseOff += size;
    }
  }
  function parseMoov(rec, buf, dv, size) {
    eachBox(buf, dv, 8, size, function (type, s, e) {
      if (type === 'trak') {
        var t = { timescale: 1000, kind: null, id: 0 };
        eachBox(buf, dv, s, e, function (type2, s2, e2) {
          if (type2 === 'tkhd') t.id = dv.getUint32(s2 + (buf[s2] === 1 ? 20 : 12));
          if (type2 !== 'mdia') return;
          eachBox(buf, dv, s2, e2, function (type3, s3) {
            if (type3 === 'mdhd') t.timescale = dv.getUint32(s3 + (buf[s3] === 1 ? 20 : 12));
            if (type3 === 'hdlr') { var h = boxType(buf, s3 + 8); t.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : null; }
          });
        });
        rec.tracks[t.id] = Object.assign(rec.tracks[t.id] || {}, t);
      }
      if (type === 'mvex') {
        eachBox(buf, dv, s, e, function (type2, s2) {
          if (type2 !== 'trex') return;
          var id = dv.getUint32(s2 + 4);
          rec.tracks[id] = Object.assign(rec.tracks[id] || {}, {
            defDur: dv.getUint32(s2 + 12), defSize: dv.getUint32(s2 + 16), defFlags: dv.getUint32(s2 + 20)
          });
        });
      }
    });
  }
  function parseMoof(rec, buf, dv, size) {
    eachBox(buf, dv, 8, size, function (type, s, e) {
      if (type !== 'traf') return;
      var tr = null, dur = 0, sz = 0, flags = 0, dts = 0;
      eachBox(buf, dv, s, e, function (type2, s2) {
        var f = dv.getUint32(s2) & 0xffffff;
        if (type2 === 'tfhd') {
          tr = rec.tracks[dv.getUint32(s2 + 4)];
          if (!tr) return;
          var o = s2 + 8;
          if (f & 0x1) o += 8;
          if (f & 0x2) o += 4;
          dur = (f & 0x8) ? dv.getUint32(o) : tr.defDur || 0; if (f & 0x8) o += 4;
          sz = (f & 0x10) ? dv.getUint32(o) : tr.defSize || 0; if (f & 0x10) o += 4;
          flags = (f & 0x20) ? dv.getUint32(o) : tr.defFlags || 0;
        } else if (type2 === 'tfdt') {
          dts = buf[s2] === 1 ? dv.getUint32(s2 + 4) * 4294967296 + dv.getUint32(s2 + 8) : dv.getUint32(s2 + 4);
        } else if (type2 === 'trun' && tr && tr.kind) {
          var v1 = buf[s2] === 1, n = dv.getUint32(s2 + 4), o2 = s2 + 8, first = null;
          if (f & 0x1) o2 += 4;
          if (f & 0x4) { first = dv.getUint32(o2); o2 += 4; }
          var list = rec.samples[tr.kind];
          for (var i = 0; i < n; i++) {
            var d = dur, z = sz, fl = i === 0 && first !== null ? first : flags, cts = 0;
            if (f & 0x100) { d = dv.getUint32(o2); o2 += 4; }
            if (f & 0x200) { z = dv.getUint32(o2); o2 += 4; }
            if (f & 0x400) { fl = dv.getUint32(o2); o2 += 4; }
            if (f & 0x800) { cts = v1 ? dv.getInt32(o2) : dv.getUint32(o2); o2 += 4; }
            list.push({ t: (dts + cts) / tr.timescale, d: d / tr.timescale, s: z, k: !(fl & 0x10000) });
            dts += d;
          }
        }
      });
    });
  }
  // 範囲を切り出したときの大きさ（バイト）。予圧縮がまだ範囲の終わりまで届いていなければ null
  //   映像の始まりは、切り出すときと同じく、範囲の始まり以前でいちばん近いキーフレームまで早める（音声は範囲の始まりから）
  function exactCutBytes(plan, rec) {
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

  // 予圧縮。書き出しは区切りごと（fragmented MP4）に受け取って持っておく（途中で止めても、区切りまでは読める）
  function startPre(pp, key) {
    var file = state.file;
    var rec = pre = { file: file, key: key, plan: pp, job: newJob(), chunks: [], bytes: 0, marks: [{ t: 0, bytes: 0 }],
      time: 0, done: false, failed: false, audioLost: false, t0: Date.now() };
    var job = rec.job;
    var writable = new WritableStream({
      write: function (chunk) {
        rec.chunks.push(chunk);
        var end = chunk.position + chunk.data.byteLength;
        if (end <= rec.bytes) return;
        rec.bytes = end;
        // 同じ進みのうちに続けて書き出された分（1つの区切りが何回かに分けて届いたとき）は、まとめる
        var last = rec.marks[rec.marks.length - 1];
        if (last.t === rec.time && rec.marks.length > 1) last.bytes = end;
        else rec.marks.push({ t: rec.time, bytes: end });
        try { parseFragments(rec); } catch (e) { rec.samples = null; }   // 読めなければ、割合で数える予想のまま
        if (pre === rec && state.file === file && !state.running) refresh();   // 予想を出し直す
      }
    });
    var output = new M.Output({
      format: new M.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: PRE_FRAGMENT_SEC }),
      target: new M.StreamTarget(writable)
    });
    log('予圧縮を開始 ' + describePlan(pp));
    pickFastEncoding(pp).then(function (enc) {
      if (!enc) throw new Error(MSG_NO_H264);
      rec.enc = enc;
      throwIfCancelled(job);
      return runConversion({
        output: output,
        options: function (input, out) { return fastOptions(pp, enc, input, out); },
        onReady: function (conv, audioLost) { rec.audioLost = audioLost; },
        invalidMessage: '予圧縮できない動画です'
      }, pp, function (p) { rec.time = p * pp.duration; }, job);
    }).then(function () {
      rec.time = pp.duration;
      rec.marks[rec.marks.length - 1].t = pp.duration;   // 最後の書き出しは、動画の終わりまでの分
      rec.done = true;
      log('予圧縮が完了 ' + fmtBytes(rec.bytes) + '（' + secondsSince(rec.t0) + '）');
    }, function (err) {
      if (isCancel(job, err)) return;
      rec.failed = true;   // 同じ設定では何度もやり直さない
      log('予圧縮に失敗 ' + errText(err));
    }).then(function () {
      if (rec.job === job) rec.job = null;
      if (pre === rec && state.file === file && !state.running) refresh();
    });
  }
  function stopPre(why) {
    if (preTimer) { clearTimeout(preTimer.id); preTimer = null; }
    var job = pre && pre.job;
    if (!job) return Promise.resolve();
    pre.job = null;
    if (why) log('予圧縮を中断（' + why + '・' + pre.time.toFixed(1) + '秒まで）');
    stopJob(job, CANCELLED);
    return job.stopped || Promise.resolve();
  }

  // 「なるべく圧縮」で、予圧縮が今の設定と同じで、範囲の始まりまで届いていれば、その予圧縮（使えなければ null）
  function precompressUsable(plan) {
    return precompressWhyNot(plan) ? null : pre;
  }
  function precompressWhyNot(plan) {
    if (!pre || pre.file !== state.file) return '予圧縮していない';
    if (pre.failed) return '予圧縮に失敗した';
    if (pre.key !== preKey(prePlan(plan))) return '設定が変わった';
    if (!pre.done && !pre.job) return '予圧縮を途中で止めた';
    if (!pre.done && pre.time < plan.trimStart) return '範囲の始まりまで届いていない（' + pre.time.toFixed(1) + '秒）';
    if (plan.mode === 'size') {
      // 「◯MB以内」は、予圧縮が範囲の終わりまで済んでいて、切り出した大きさが目標の95%以上・目標未満のときだけ
      var cut = null;
      try { cut = exactCutBytes(plan, pre); } catch (e) { cut = null; }
      if (!cut) return '「◯MB以内」で、予圧縮が範囲の終わりまで済んでいない';
      if (cut >= plan.targetBytes) return '「◯MB以内」で、予圧縮の大きさ（' + fmtBytes(cut) + '）が目標以上';
      if (cut < plan.targetBytes * PRE_SIZE_USE_RATIO) return '「◯MB以内」で、予圧縮の大きさ（' + fmtBytes(cut) + '）が目標の95%未満';
    }
    return '';
  }
  // 予圧縮を範囲の終わりまで続け、範囲を切り出して結果にする（予圧縮に失敗したら、普通に圧縮する）
  function finishFromPrecompress(rec, plan, onProgress, job) {
    var span = Math.max(0.1, plan.trimEnd - plan.trimStart);
    var need = Math.min(rec.plan.duration, plan.trimEnd + PRE_TAIL_SEC);
    job.hooks.push(function () { return stopPre(); });   // キャンセル・停止したら予圧縮も止める
    return new Promise(function (resolve, reject) {
      (function wait() {
        if (job.cancelled) return reject(new Error(CANCELLED));
        if (rec.failed) return reject(new Error('予圧縮に失敗'));
        if (rec.done || rec.marks[rec.marks.length - 1].t >= need) return resolve();
        if (!rec.job) return reject(new Error('予圧縮が止まった'));
        onProgress(Math.max(0, Math.min(0.95, (rec.time - plan.trimStart) / span)));
        setTimeout(wait, 200);
      })();
    }).then(function () {
      throwIfCancelled(job);
      var stopping = rec.done ? null : stopPre();   // 範囲の終わりまで書き出せたので、残りは要らない
      if (!rec.done) log('予圧縮を範囲の終わりで止める（' + rec.time.toFixed(1) + '秒）');
      return Promise.resolve(stopping);
    }).then(function () {
      throwIfCancelled(job);
      var input = new M.Input({ source: new M.BlobSource(fragmentsBlob(rec)), formats: INPUT_FORMATS });
      job.hooks.push(function () { try { input.dispose(); } catch (e) { /* noop */ } });
      return runConversion({
        input: input,
        options: function (inp, output) {
          return {
            input: inp, output: output, video: {},
            audio: plan.audio.mode === 'none' ? { discard: true } : {},
            trim: { start: plan.trimStart, end: plan.trimEnd },
            // 区切りはキーフレームに合わせて広げる（開始が最大2秒早まることがある）
            copy: { mode: 'forced', boundaryPolicy: 'expand', shiftTolerance: Infinity },
            tags: outputTags, showWarnings: false
          };
        },
        prepareLog: function () { return '予圧縮から切り出す準備'; },
        invalidMessage: '予圧縮から切り出せませんでした'
      }, plan, function (p) { onProgress(0.95 + 0.05 * p); }, job).then(function (res) {
        try { input.dispose(); } catch (e) { /* noop */ }
        return checkCutDuration(res, span).then(function () {
          res.rateMode = rec.enc.bitrateMode;
          res.audioDropped = rec.audioLost;
          return res;
        });
      });
    }).catch(function (err) {
      if (isCancel(job, err)) throw err;
      log('予圧縮を使えないため、普通に圧縮する（' + errText(err) + '）');
      return convertFast(plan, onProgress, job);
    });
  }
  // 切り出した動画が範囲より短ければ失敗にする（予圧縮の書き出しが範囲の終わりまで届いていなかった）
  function checkCutDuration(res, span) {
    return blobDuration(res.blob).then(function (d) {
      if (d < span - 0.25) throw new Error('切り出した動画が短い（' + d.toFixed(2) + '秒／' + span.toFixed(2) + '秒）');
    });
  }
  // 書き出した動画の長さ（秒）
  function blobDuration(blob) {
    var input = new M.Input({ source: new M.BlobSource(blob), formats: INPUT_FORMATS });
    return input.computeDuration().then(function (d) {
      try { input.dispose(); } catch (e) { /* noop */ }
      return d;
    }, function (e) {
      try { input.dispose(); } catch (e2) { /* noop */ }
      throw e;
    });
  }
  // 受け取った書き出しを1つにまとめ、最後の区切りまでで切る（途中で止めたとき、最後の区切りは書きかけのことがある）。
  // 区切りごとの書き出しは先頭から順に届くので、受け取ったデータをそのままつなげる（長い動画でも大きな写しを作らない）
  function fragmentsBlob(rec) {
    var chunks = rec.chunks, pos = 0;
    var inOrder = chunks.every(function (c) { var ok = c.position === pos; pos += c.data.byteLength; return ok; });
    if (!inOrder) {
      // 念のため：順に届いていなければ、位置どおりに1つにまとめ直す
      var buf = new Uint8Array(rec.bytes);
      chunks.forEach(function (c) { buf.set(c.data, c.position); });
      chunks = [{ position: 0, data: buf }];
    }
    // 箱（size 4バイト＋種類 4バイト）を先頭から順にたどる
    var ci = 0, total = chunks.reduce(function (n, c) { return n + c.data.byteLength; }, 0);
    function byteAt(off) {
      while (off >= chunks[ci].position + chunks[ci].data.byteLength) ci++;
      while (off < chunks[ci].position) ci--;
      return chunks[ci].data[off - chunks[ci].position];
    }
    var off = 0, keep = 0;
    while (off + 8 <= total) {
      var size = ((byteAt(off) << 24) >>> 0) + (byteAt(off + 1) << 16) + (byteAt(off + 2) << 8) + byteAt(off + 3);
      var type = String.fromCharCode(byteAt(off + 4), byteAt(off + 5), byteAt(off + 6), byteAt(off + 7));
      if (size < 8 || off + size > total) break;
      off += size;
      if (type === 'mdat' || type === 'moov' || type === 'mfra') keep = off;
    }
    return new Blob(chunks.map(function (c) { return c.data; }), { type: 'video/mp4' }).slice(0, keep, 'video/mp4');
  }

  // ---------------------------------------------------------------- トリミングのみ（再エンコードしない）
  // 「◯MB以内に圧縮」で、解像度もfpsも元のまま、トリミングした元動画が目標サイズに収まる見込みなら、
  // 再エンコードせずに切り出すだけにする（画質は元のまま）。見込みのサイズを返し、対象外なら 0
  function trimOnlyEstimate(plan) {
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
  function convertCopy(plan, onProgress, job) {
    return runConversion({
      options: function (input, output) {
        return {
          input: input, output: output,
          video: {},
          audio: plan.audio.mode === 'none' ? { discard: true } : {},
          trim: { start: plan.trimStart, end: plan.trimEnd },
          // 区切りはキーフレームに合わせて広げる（開始が少し早まることがある）
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

  // ---------------------------------------------------------------- 互換モード（再生しながら取り込み）
  function findCompatVideoConfig(plan, job) {
    var cands = [];
    ['prefer-hardware', 'no-preference'].forEach(function (accel) {
      ['variable', 'constant'].forEach(function (mode) {
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

  function convertCompat(plan, onProgress, job) {
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

  // ---------------------------------------------------------------- 実行
  // 音声のことで失敗したか（Mediabunny の音声の形式の検査など）
  function isAudioError(err) { return /audio|aac|mp4a/i.test(errText(err)); }

  // 1回ぶんの処理の見張り。別のアプリに切り替えたかと、進捗が止まったままかを見る。
  // iPhone は裏に回ると動画の読み込み・書き出しを止めたり壊したりする。
  // iPhone でブラウザを閉じた（ホーム画面に戻った）ときは、画面が隠れた知らせが届かないか、戻ってから遅れて届くことがあるので、
  // ページが止められていたこと（1秒ごとの見回りの間が空いた）でも見分ける
  //   onStall(limit, done) … 止まったとみなしたとき（limit: 待った時間（ミリ秒）、done: そこまでの進捗 0〜1）。見回りはそこで止まる
  //   quick … 最初から早めに見切る（別のアプリから戻ってやり直すとき）
  //   onReturn() … 別のアプリから画面に戻ったとき
  function watchAttempt(onStall, quick, onReturn) {
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
  function decoderResponds(job) {
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
  function checkAfterBackground(job) {
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
  function checkResponses() {
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

  function run() {
    if (!state.file || state.running) return;
    var plan = currentPlan();
    var engine = state.engine;
    if (engine === 'fast' && trimOnlyEstimate(plan)) engine = 'copy';   // トリミングのみ（再エンコードしない）
    var started = Date.now();

    var job = state.job = newJob();
    state.running = true;
    setRunningUi(true);
    requestWakeLock();
    showDiag(false);
    log('圧縮開始 ' + describePlan(plan) + ' engine=' + engine);
    logEstimate(plan);
    // 設定を変えておらず、予圧縮が範囲の始まりまで届いていれば（「◯MB以内」では、切り出した大きさが目標の95%以上・目標未満なら）、
    // 予圧縮をそのまま使う
    var usePre = engine === 'fast' && precompressUsable(plan);
    var preTried = false;
    if (usePre) {
      log('予圧縮を使う（' + (usePre.done ? '完了済み' : usePre.time.toFixed(1) + '秒まで済み') + '）');
      // 「◯MB以内」は予圧縮のビットレート（下限）で圧縮したことになるので、結果の欄と圧縮し直しの判断もその値で行う
      if (plan.mode === 'size') plan = replan(plan, { bitrate: usePre.plan.videoBitrate });
    } else if (pre && pre.file === state.file && engine === 'fast') log('予圧縮は使わない（' + precompressWhyNot(plan) + '）');
    // （使わない）予圧縮の途中なら止め、エンコーダーなどを片付け終わるのを少し待ってから始める
    var probeStopped = usePre ? Promise.resolve() : stopPre('圧縮を開始');
    var bgRetries = 0;   // 別のアプリに切り替えたためにやり直した回数
    var preferCbr = false;   // VBR では指定のサイズに収まらなかったので、CBR を優先する
    var vbrResult = null;    // 「なるべく圧縮」で CBR を試す前の VBR の結果（CBR の方が大きければ、こちらを使う）
    var lastGood = null;     // 圧縮し直す前にできた結果と、その計画（圧縮し直しに失敗したら、こちらを使う）
    var audioRetried = false;   // 元の音声をそのまま使えず、音声を作り直す（外す）やり直しをした

    // CBR に切り替えて意味があるか（高速モードで、VBR で書き出したとき。
    // iPhone の Safari は CBR/VBR の指定をエンコーダーに渡さないので、切り替えても変わらない）
    function canSwitchToCbr(res) { return engine === 'fast' && !preferCbr && res.rateMode === 'variable' && !isIOS(); }

    // prevSize: 前回の圧縮結果のサイズ（再圧縮のときに表示する）。note: 進捗の欄に出す補足
    // afterBg: 別のアプリから戻ってのやり直し（iPhone は戻ったあとも動画の読み込み・書き出しが固まったままのことがあるので、
    //   進まなければ早めに見切って互換モードに切り替える）
    function attempt(index, prevSize, note, afterBg) {
      var label = note || (index === 0 ? (engine === 'copy' ? 'トリミング中（再圧縮なし）'
        : engine === 'fast' ? '圧縮中' : '圧縮中（互換モード：再生しながら処理）')
        : '圧縮結果が' + (prevSize / MB).toFixed(2) + 'MBで目標超過→再圧縮中（' + (index + 1) + '回目）');
      setProgress(0, label);
      // 1回ぶんの処理（進まなくなったらこれだけ止めて、別の方式でやり直す）
      var aj = state.attemptJob = newJob();
      var t0 = Date.now(), nextLog = 0;
      var stuckErr = null;   // 戻ったときにデコーダーが固まっていた
      var watch = watchAttempt(function (limit, done) {
        log('進捗が' + Math.round(limit / 1000) + '秒止まったため中断（' + Math.round(done * 100) + '%）');
        if (!watch.wentHidden()) showDiag(true);   // 別のアプリに切り替えたせいなら、やり直すだけなので開かない
        stopJob(aj, STALLED);
      }, afterBg, function () {
        // 戻ったらすぐデコーダーを確かめる。固まっていれば、止まったと判断するのを待たずに、開き直すよう案内する
        if (engine === 'copy') return;   // トリミングのみはデコーダーを使わない
        var progressAtReturn = watch.lastProgress();
        checkAfterBackground(aj).then(null, function (e) {
          if (!e || !e.stuck || aj.cancelled || job.cancelled) return;
          if (watch.lastProgress() > progressAtReturn) return;   // 進み始めていれば、固まっていない
          log('画面に戻ったあと、デコーダーが応答しない');
          stuckErr = e;
          stopJob(aj, STALLED);
        });
      });
      // キャンセル後に古い処理から届く進捗は無視する
      var onProgress = function (p) {
        if (job.cancelled || aj.cancelled) return;
        watch.progress(p);
        if (p >= nextLog) {
          log('進捗 ' + Math.round(p * 100) + '%（' + secondsSince(t0) + '）');
          nextLog = Math.floor(p * 10 + 1) / 10;
        }
        setProgress(p, label);
      };
      var fromPre = engine === 'fast' && index === 0 && usePre && !preTried;
      if (fromPre) preTried = true;   // 使えるのは最初の1回だけ（やり直すときは普通に圧縮する）
      var task = engine === 'copy' ? convertCopy(plan, onProgress, aj)
        : fromPre ? finishFromPrecompress(usePre, plan, onProgress, aj)
        : engine === 'fast' ? convertFast(plan, onProgress, aj) : convertCompat(plan, onProgress, aj);
      task.catch(function () { /* 競争に負けた側の失敗は無視する */ });

      // キャンセルしたら、ライブラリ側が止まりきるのを待たずにすぐ抜ける
      return Promise.race([task, job.aborted, aj.aborted]).then(function (res) {
        watch.end();
        throwIfCancelled(job);
        log('完了 ' + fmtBytes(res.blob.size) + '（' + secondsSince(t0) + '）');
        return afterSuccess(res);
      }, function (err) {
        watch.checkFrozen();   // 止められていたページが再開した直後に失敗が届くことがある（見回りより先に）
        // 見回りは止めるが、画面が隠れた知らせは下で少し待つあいだも受け取る
        watch.stopTimer();
        if (job.cancelled || (!aj.cancelled && isCancel(null, err))) { watch.end(); throw new Error(CANCELLED); }
        // デコーダーが固まっていたら、やり直しても互換モードでも進まないので、開き直すよう案内する
        if (stuckErr) { watch.end(); throw stuckErr; }
        var stalled = aj.cancelled;
        if (!stalled) log('失敗（' + engine + '）' + errText(err));
        // iPhone では、別のアプリに切り替え始めた瞬間に読み込みが壊れて失敗し、画面が隠れた知らせはその直後に届く。
        // すぐには決めず、少し待ってから別のアプリに切り替えたかを見る（切り替えていなければ、少し遅れて互換モードにするだけ）
        var settle = watch.wentHidden() ? Promise.resolve() : sleep(FAIL_SETTLE_MS);
        return Promise.race([settle, job.aborted]).then(function () {   // 待っている間のキャンセルはすぐ効かせる
          watch.checkFrozen();
          watch.end();
          throwIfCancelled(job);
          return afterFailure(err, stalled);
        });
      });

      // ---- 書き出せたあと：圧縮し直すかを決める（し直さなければ結果を返す）
      function afterSuccess(res) {
        if (engine === 'copy') {
          if (res.blob.size >= plan.targetBytes) return retryCopyAsCompress(res);
          res.attempts = 1;
          return res;
        }
        if (res.audioDropped && plan.audio.mode !== 'none') {
          plan.audio = noAudio();
          plan.audioBitrate = 0;
        }
        var retry = retryQualityWithCbr(res) || retrySmaller(res);
        if (retry) return retry;
        if (vbrResult && vbrResult.blob.size <= res.blob.size) {
          log('CBR の方が小さくならなかったため、最初の結果を使う');
          res = vbrResult;
        }
        res.attempts = index + 1;
        return res;
      }

      // トリミングのみで目標を超えたら、通常の圧縮に切り替える
      function retryCopyAsCompress(res) {
        log('トリミングのみでは目標を超えたため、通常の圧縮に切り替え');
        engine = 'fast';
        // 予想を超えたのは、切り出した部分がファイル全体の平均より重いから。
        // 全体の平均で頭打ちにすると必要以上に小さくなるので、切り出した部分の実測値を上限にして計画し直す
        var copyVideoBps = Math.floor(res.blob.size * 8 / plan.duration) - Math.round(plan.audio.bps || 0);
        plan = replan(plan, { cap: copyVideoBps });
        log('計画し直し ' + describePlan(plan));
        return attempt(0, 0, 'トリミングのみでは' + (res.blob.size / MB).toFixed(2) + 'MBで目標超過→圧縮中');
      }

      // 「なるべく圧縮」で、VBR なのに指定の約2倍以上の大きさになったら、CBR でもう一度圧縮する（小さい方を使う）。
      // CBR は時間がかかることがあるので、短い動画だけ
      function retryQualityWithCbr(res) {
        if (plan.mode !== 'quality' || !canSwitchToCbr(res) || plan.duration > QUALITY_CBR_MAX_SECONDS || index + 1 >= MAX_ATTEMPTS) return null;
        var bps = videoBpsOf(res, plan);
        if (bps < plan.videoBitrate * QUALITY_CBR_OVERSHOOT) return null;
        preferCbr = plan.preferCbr = true;
        vbrResult = res;
        lastGood = { res: res, plan: plan };
        log('指定より大きく書き出した（映像 ' + fmtRate(bps) + '／指定 ' + fmtRate(plan.videoBitrate) + '）→ 固定ビットレート（CBR）で圧縮し直し');
        return attempt(index + 1, res.blob.size, '指定より大きくなったため、固定ビットレートで圧縮し直し中');
      }

      // 「◯MB以内に圧縮」で目標を超えたら、実際のサイズからビットレートを計算し直して、圧縮し直す
      function retrySmaller(res) {
        if (plan.mode !== 'size' || res.blob.size < plan.targetBytes || index + 1 >= MAX_ATTEMPTS) return null;
        var audioBytes = audioBytesOf(plan);
        var next = nextBitrate(plan, res.blob.size - audioBytes, audioBytes);
        // 下限を下回る値は下限に揃え、それ以上下げられないならやめる
        if (next) next = Math.max(next, plan.floorBitrate);
        // VBR で、指定より大きく書き出した・圧縮し直しても小さくならないなら、ビットレートを下げても減らない見込みなので CBR にする
        // （CBR にするときは、同じビットレート（下限）でもやり直す）
        var switchCbr = false;
        if (canSwitchToCbr(res)) {
          var actualBps = videoBpsOf(res, plan);
          var overshoot = actualBps > plan.videoBitrate * CBR_OVERSHOOT;
          var noShrink = index > 0 && prevSize > 0 && res.blob.size > prevSize * (1 - MIN_SHRINK);
          if (overshoot || noShrink) {
            switchCbr = preferCbr = true;
            log((overshoot ? '指定より大きく書き出した（映像 ' + fmtRate(actualBps) + '／指定 ' + fmtRate(plan.videoBitrate) + '）'
              : '圧縮し直しても小さくならない') + '→ 固定ビットレート（CBR）に切り替え');
          }
        }
        if (!next || (next >= plan.videoBitrate && !switchCbr)) return null;
        lastGood = { res: res, plan: plan };
        plan = replan(plan, { bitrate: next });
        plan.preferCbr = preferCbr;
        log('再圧縮 映像 ' + fmtRate(plan.videoBitrate) + (preferCbr ? '（CBR）' : ''));
        return attempt(index + 1, res.blob.size);
      }

      // ---- 失敗・停止したあと：どうやり直すかを決める
      function afterFailure(err, stalled) {
        // 途中で別のアプリに切り替えていたら、失敗・停止は動画のせいではない（iPhone は裏に回ると読み込み・書き出しを壊す）。
        // 別の方式に切り替えず、画面に戻るのを待ってから同じ方式で最初からやり直す
        if (watch.wentHidden() && bgRetries < MAX_BG_RETRIES) return retryAfterBackground();
        // 圧縮し直している途中で失敗したら、その前にできた結果を使う（目標を超えていれば、結果の欄でそのことを知らせる）
        if (index > 0 && lastGood) {
          log('圧縮し直しに失敗したため、前の結果を使う');
          plan = lastGood.plan;
          lastGood.res.attempts = index;
          return lastGood.res;
        }
        // 元の音声をそのままコピーして、音声のことで失敗したときは（音声の設定データが壊れた動画など）、互換モードにせず、
        // 音声を作り直すか外して、高速モードのままやり直す。
        // 映像の失敗（Decoder failure など）では音声を外さない（一時的な失敗で音声を失わないため）
        if (engine === 'fast' && plan.audio.mode === 'copy' && !stalled && !audioRetried && isAudioError(err)) return retryWithoutAudioCopy();
        // トリミングのみがうまくいかなければ、通常の圧縮でやり直す
        if (engine === 'copy') {
          engine = 'fast';
          return attempt(0);
        }
        // 高速モードで扱えなかったら、互換モードでやり直す
        if (engine === 'fast' && (index === 0 || stalled) && state.caps.compat) {
          console.warn('高速モードに失敗したため互換モードに切り替えます:', err);
          log('互換モードに切り替え');
          engine = 'compat';
          plan = replan(plan, { audio: audioStrategy(state.meta, plan.wantAudio, 'compat') });
          return attempt(0, 0, stalled ? '処理が進まないため、互換モードでやり直し中' : null);
        }
        if (stalled) throw new Error(MSG_STALLED);
        throw err;
      }

      // 画面に戻るのを待ち、止めた処理の後片付けとデコーダーを確かめてから、同じ方式で最初からやり直す
      function retryAfterBackground() {
        bgRetries++;
        log('別のアプリに切り替えていたため、画面に戻ってから最初からやり直し（' + engine + '・' + bgRetries + '回目）');
        setProgress(0, MSG_BG_RETRY);
        var waited = document.visibilityState !== 'visible';
        return waitVisible(job).then(function () {
          if (waited) log('画面に戻った');
          // 止めた処理が動画の読み込み・書き出しを使ったままだと、やり直しが進まないことがあるので、後片付けを少し待つ
          if (!aj.stopped) return;
          var t = Date.now();
          return Promise.race([
            aj.stopped.then(function () { return '完了'; }),
            sleep(CLEANUP_WAIT_MS).then(function () { return '時間切れ'; }),
            job.aborted
          ]).then(function (r) { log('止めた処理の後片付け ' + r + '（' + secondsSince(t) + '）'); });
        }).then(function () {
          throwIfCancelled(job);
          if (engine === 'copy') return null;   // トリミングのみはデコーダーを使わない
          return Promise.race([checkAfterBackground(job), job.aborted]);
        }).then(function () {
          throwIfCancelled(job);
          return attempt(index, prevSize, MSG_BG_RETRY, true);
        });
      }

      // 音声を AAC に作り直して（読めて、AAC で書き出せるとき）、または音声を外して、高速モードのままやり直す
      function retryWithoutAudioCopy() {
        audioRetried = true;
        var src = state.meta.audio || {};
        var audio = state.caps.aac && src.canDecode !== false ? aacAudio()
          : Object.assign(noAudio(MSG_AUDIO_COPY_FAILED), { afterFailure: true });
        log('元の音声をそのまま使えないため、' + (audio.mode === 'aac' ? '音声を AAC に作り直して' : '音声を外して') + '高速モードでやり直し');
        plan = replan(plan, { audio: audio });
        plan.preferCbr = preferCbr;
        return attempt(0);
      }
    }

    // デコーダーが固まったまま（iPhone で、前の圧縮中に別のアプリに切り替えたときなど）なら、始める前に開き直すよう案内する
    var ready = Promise.race([probeStopped, sleep(CLEANUP_WAIT_MS), job.aborted]).then(function () {
      throwIfCancelled(job);
      return engine === 'copy' ? null : Promise.race([decoderResponds(job), job.aborted]);
    });
    return ready.then(function () {
      throwIfCancelled(job);
      return attempt(0);
    }).then(function (res) {
      setProgress(1, '完了');
      finishRun();
      showResult(res, plan, engine, (Date.now() - started) / 1000);
      refresh();   // 結果が入ってから、ボタンを「やり直す」にして設定を無効にする
    }, function (err) {
      finishRun();
      if (isCancel(job, err)) { log('キャンセル'); return; }
      console.error(err);
      log('エラーで終了 ' + errText(err));
      if (err && err.stuck) { setAlert(els.outWarn, errorLines(err.message), true); return; }   // 直し方は決まっているので、診断情報は開かない
      setAlert(els.outWarn, ['エラー: ' + ((err && err.message) || String(err)),
        MSG_REPORT], true);
      showDiag(true);
    });
  }

  // 画面に出す解像度の名前（例: 720p、元の解像度）
  function resLabel(plan) { return plan.res === 'source' ? '元の解像度' : plan.res + 'p'; }

  function describePlan(plan) {
    return plan.res + ' ' + plan.width + 'x' + plan.height + ' mode=' + plan.mode + ' ' + Math.round(plan.videoBitrate / 1000) + 'kbps' +
      ' fps=' + plan.srcFps + '→' + plan.outFps + ' audio=' + plan.audio.mode +
      ' trim=' + plan.trimStart.toFixed(1) + '-' + plan.trimEnd.toFixed(1) + 's';
  }

  // 計画を作り直すときに、元の計画と同じ設定を渡す
  function planSettings(plan) {
    return {
      mode: plan.mode, res: plan.res, halfFps: plan.halfFps, audio: plan.wantAudio,
      targetMB: plan.targetMB, targetBytes: plan.targetBytes, minBitrate: plan.minBitrate
    };
  }
  // 同じ範囲・同じ設定のまま、一部だけ変えて計画し直す（再圧縮・互換モードへの切り替え・トリミングのみからの切り替え）
  //   changes.audio   … 音声の扱い（省略時は今のまま）
  //   changes.bitrate … 映像ビットレートを直接決める（再圧縮のとき）
  //   changes.cap     … 映像ビットレートの上限（省略時は今のまま）
  function replan(plan, changes) {
    return makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
      changes.audio || plan.audio, state.file.size, changes.bitrate || null,
      changes.cap !== undefined ? changes.cap : plan.videoCapBps);
  }

  function finishRun() {
    state.running = false;
    state.job = null;
    state.attemptJob = null;
    releaseWakeLock();
    setRunningUi(false);   // 画面の更新（refresh）もここで行う
  }

  function setRunningUi(running) {
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

  function cancelRun() {
    var job = state.job;
    if (!job || job.cancelled) return;
    setPhase('キャンセルしています…');
    // 後片付けを始め（止まりきるのは待たない）、実行はすぐに終わらせる。
    // Android などでエンコーダが止まりきらなくても、画面が固まらないようにするため
    stopJob(state.attemptJob, CANCELLED);
    stopJob(job, CANCELLED);
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
    updateMediaLayout();
  }

  // 圧縮した動画ができている（「元の動画のまま」は含めない）
  function isCompressed() {
    return !!(state.out && !state.out.original) && !state.running;
  }
  // やり直す: 圧縮した動画を消して、トリミングと設定を変えられる状態に戻す
  function redo() {
    log('やり直す');
    clearOutput();
    refresh();
  }

  function clearOutput() {
    if (state.out && state.out.url) URL.revokeObjectURL(state.out.url);
    state.out = null;
    els.outVideo.removeAttribute('src');
    try { els.outVideo.load(); } catch (e) { /* noop */ }
    show(els.outVideo, false);
    show(els.outEmpty, true);
    els.outInfo.textContent = '';
    show(els.outNote, false);
    setAlert(els.outWarn, []);
    els.shareBtn.disabled = true;
    els.saveBtn.disabled = true;
    updateMediaLayout();
  }

  function showResult(res, plan, engine, elapsed) {
    var base = fileBase();
    var kind = !res.trimOnly ? 'compressed' : isFullTrimOf(plan) ? 'copy' : 'trimmed';
    var suffix = kind === 'compressed' ? '_compressed' : kind === 'trimmed' ? '_trimmed' : '';
    var name = customName({ kind: kind, now: new Date(), rand: randDigits(), base: base, settings: plan }) || base + suffix;
    setOutput({ blob: res.blob, name: name + '.mp4', type: 'video/mp4', original: false });

    var size = res.blob.size;
    var ratio = state.file.size > 0 ? Math.round((1 - size / state.file.size) * 100) : 0;
    if (res.trimOnly) {
      els.outInfo.textContent = fmtBytes(state.file.size) + ' → ' + fmtBytes(size) + '（-' + Math.max(0, ratio) + '%）・' +
        plan.width + '×' + plan.height + '・' + copyLabel(plan) +
        '（再圧縮なし）・' + fmtDuration(elapsed) +
        (res.audioDropped ? '・音声なし' : '');
      setAlert(els.outWarn, size > DISCORD_FREE_BYTES ? [MSG_OVER_DISCORD] : []);
      return;
    }
    // ビットレートは、書き出した大きさと長さから求めた実際の値（音声の分を引く）。指定と1割以上違えば、指定も出す
    // （エンコーダーは映像によって、指定より多く使ったり、少なく済ませたりする）
    function info(duration) {
      var actual = Math.max(0, size * 8 / duration - plan.audioBitrate);
      var rate = fmtRate(actual) + (Math.abs(actual - plan.videoBitrate) > plan.videoBitrate * 0.1 ? '（指定' + fmtRate(plan.videoBitrate) + '）' : '');
      return fmtBytes(state.file.size) + ' → ' + fmtBytes(size) + '（' + (ratio >= 0 ? '-' : '+') +
        Math.abs(ratio) + '%）・' + plan.width + '×' + plan.height + '・' + rate + '・' +
        fmtDuration(elapsed) + (res.attempts > 1 ? '・' + res.attempts + '回で調整' : '') +
        // Safari（WebKit）は CBR/VBR の指定をエンコーダに渡さないので、表示しない
        (res.rateMode && !isWebKit() ? (res.rateMode === 'variable' ? '・VBR' : '・CBR') : '') +
        (plan.audio.mode === 'none' && plan.wantAudio ? '・音声なし' : '') + (engine === 'compat' ? '・互換モード' : '');
    }
    // まず範囲の長さで出し、書き出した動画の長さが分かったら出し直す（予圧縮から切り出すと、始まりが少し早まることがある）
    els.outInfo.textContent = info(plan.duration);
    var out = state.out;
    blobDuration(res.blob).then(function (d) {
      if (state.out === out && d > 0) els.outInfo.textContent = info(d);
    }, function () { /* 範囲の長さのまま */ });

    // 目標よりかなり小さく仕上がったときは、そのわけを出す（悪いことではないので、注意ではなく補足として）
    var small = plan.mode === 'size' && size <= plan.targetBytes * SMALL_RESULT_RATIO;
    els.outNote.textContent = small ? 'これ以上大きくしても画質はほぼ上がらないため、' + fmtBytes(size).replace(' ', '') + 'に抑えました。' : '';
    show(els.outNote, small);

    var warns = [];
    if (plan.mode === 'size' && size >= plan.targetBytes) {
      warns.push(MSG_UNREACHABLE);
      // 60fpsのままだと、エンコーダが下限ビットレートまで下げきれず目標を超えることがある
      if (plan.outFps > 40 && !plan.halfFps) warns.push(MSG_HALF_FPS_HINT);
    }
    if (plan.audio.afterFailure && plan.audio.note) warns.push(plan.audio.note);
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
    // 共有の仕組みがない環境（PCなど）は、そのままダウンロードする
    if (!navigator.share || !navigator.canShare) return download();
    // 共有の仕組みはあるのに断られた場合は、ダウンロードに切り替えたうえで理由を表示する
    // （Android の Chrome は .mov など共有できない形式があるため、元のまま共有するときに起きうる）
    if (!navigator.canShare({ files: [file] })) {
      download();
      return showShareProblem('この端末では「' + file.name + '」（' + (file.type || '形式不明') + '）を共有できないため、保存（ダウンロード）しました。');
    }
    navigator.share({ files: [file] }).catch(function (err) {
      if (err && err.name === 'AbortError') return;   // 共有シートを閉じただけ
      download();
      showShareProblem('共有できなかったため、保存（ダウンロード）しました（' + ((err && (err.name + ': ' + err.message)) || err) + '）。');
    });
  }

  function showShareProblem(message) {
    console.warn(message);
    setAlert(els.outWarn, [message], true);
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
  // 別のアプリに切り替えると、画面を暗くしない設定は自動で外れる。戻ったときに圧縮中（やり直し中を含む）なら取り直す
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.running) requestWakeLock();
    // 予圧縮は、画面を離れたら止める（iPhone は裏に回ると読み込み・書き出しを壊す）。戻ったら最初からやり直す
    // （圧縮中に予圧縮を使っているときは、圧縮の見回りに任せる）
    if (state.running) return;
    if (document.visibilityState !== 'visible') stopPre('画面を離れた');
    else if (state.meta) refresh();
  });
  function releaseWakeLock() {
    if (state.wakeLock) {
      try { state.wakeLock.release(); } catch (e) { /* noop */ }
      state.wakeLock = null;
    }
  }

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

  function onFileChosen(picked) {
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
    stopPre();
    pre = null;
    state.busy = true;
    state.loadError = null;
    state.file = file;
    state.meta = null;
    state.nameRand = randDigits();   // 元の動画のまま渡すときの乱数（同じ動画のあいだは変えない）
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

    log('動画を選択 ' + ((file.name || '').split('.').pop() || '?') + ' ' + (file.type || '種類不明') + ' ' + fmtBytes(file.size));
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

  // ---------------------------------------------------------------- 配線
  els.pickBtn.addEventListener('click', function () { els.file.click(); });
  els.repickBtn.addEventListener('click', function () { els.file.click(); });

  // 説明書: 開く・閉じる（外側をタップしても閉じる）
  var helpDlg = $('helpDlg'), helpSlides = $('helpSlides'), helpHint = $('helpHint');
  var helpDots = Array.prototype.slice.call($('helpDots').children);
  var helpOpened = false;
  $('helpBtn').addEventListener('click', function () {
    if (!helpOpened) {
      helpOpened = true;
      // 画像は初めて開いたときに読み込む（アプリの起動を軽くするため）
      helpSlides.querySelectorAll('img[data-src]').forEach(function (img) { img.src = img.getAttribute('data-src'); });
      helpSlides.classList.add('is-nudge');   // 少し横に揺らして、スワイプできることを知らせる
    }
    if (helpDlg.showModal) helpDlg.showModal(); else helpDlg.setAttribute('open', '');
  });
  // 今見ている画像に合わせて下の点を切り替える。一度スワイプしたら案内を消す
  function helpSlideStep() {
    var imgs = helpSlides.children;
    return imgs.length > 1 ? imgs[1].offsetLeft - imgs[0].offsetLeft : 1;
  }
  helpSlides.addEventListener('scroll', function () {
    var maxLeft = helpSlides.scrollWidth - helpSlides.clientWidth;
    // 最後の画像は左端まで寄せられないので、いちばん右まで来たら最後とみなす
    var i = helpSlides.scrollLeft >= maxLeft - 4 ? helpDots.length - 1 : Math.round(helpSlides.scrollLeft / helpSlideStep());
    helpDots.forEach(function (d, k) { d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    if (helpSlides.scrollLeft > 20) {
      helpHint.classList.add('is-done');
      helpSlides.classList.remove('is-nudge');
    }
  }, { passive: true });
  helpDots.forEach(function (d, k) {
    d.addEventListener('click', function () { helpSlides.scrollTo({ left: k * helpSlideStep(), behavior: 'smooth' }); });
  });
  $('helpClose').addEventListener('click', function () {
    if (helpDlg.close) helpDlg.close(); else helpDlg.removeAttribute('open');
  });
  helpDlg.addEventListener('click', function (e) {
    if (e.target === helpDlg && helpDlg.close) helpDlg.close();   // 枠の外（背景）をタップ
  });
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
  els.trimSeek.addEventListener('input', onSeekInput);
  els.srcVideo.addEventListener('seeked', onSeeked);
  els.trimSeek.addEventListener('change', endSeekDrag);
  ['pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(function (type) {
    window.addEventListener(type, endSeekDrag, { passive: true });
  });
  els.srcVideo.addEventListener('playing', function () {
    if (!headRaf) headRaf = requestAnimationFrame(followPlayhead);
  });
  // seeking: シークの完了を待たずに（大きな動画は時間がかかる）、移動先を表示する
  ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'pause', 'ended', 'emptied'].forEach(function (type) {
    els.srcVideo.addEventListener(type, renderPlayhead);
  });
  els.srcVideo.addEventListener('timeupdate', function () {
    if (state.running || state.busy || !state.meta || els.srcVideo.paused) return;
    if (els.srcVideo.currentTime >= state.trim.end) els.srcVideo.pause();
  });

  // 画面で解像度を選んだら、「元の解像度」を選んだかどうかを覚えておく
  ['res720', 'res1080', 'resSource'].forEach(function (k) {
    els[k].addEventListener('change', function () { wantSource = k === 'resSource'; want1080 = false; });
  });
  ['res720', 'res1080', 'resSource', 'modeQuality', 'modeSize', 'halfFps', 'audioOn'].forEach(function (k) {
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
  SAVED_FIELDS.forEach(function (id) { $(id).addEventListener('change', function () { setTimeout(saveSettings, 0); }); });
  $('resetSettings').addEventListener('click', resetSettings);
  // ファイル名の設定（変えたらすぐ保存する）
  function nameChanged(rerender) {
    if (rerender) renderNameList();
    saveSettings();
    refresh();   // ファイル名の例もここで更新する
  }
  els.nameOn.addEventListener('change', function () { naming.on = els.nameOn.checked; nameChanged(true); });
  els.nameList.addEventListener('change', function (e) {
    if (!e.target.classList.contains('name-use')) return;
    var key = e.target.closest('li').dataset.key;
    var keys = naming.enabled.filter(function (k) { return k !== key; });
    if (e.target.checked) {
      // 日付と日付+時間は、どちらか1つだけ
      keys = keys.filter(function (k) { return !((key === 'date' && k === 'datetime') || (key === 'datetime' && k === 'date')); });
      keys.push(key);
    }
    setNaming(naming.on, keys, naming.order);
    nameChanged(true);
  });
  els.nameList.addEventListener('input', function (e) {
    if (!e.target.classList.contains('name-text')) return;
    naming.text[e.target.closest('li').dataset.key] = e.target.value;
    nameChanged(false);
  });
  els.nameList.addEventListener('change', function (e) {
    // 入力が終わったら、使えない文字を外した形に直す（入力中に直すと、日本語の変換が途切れるため）
    if (e.target.classList.contains('name-text')) { e.target.value = naming.text[e.target.closest('li').dataset.key] = cleanText(e.target.value); nameChanged(false); }
  });
  els.nameList.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-move]');
    if (!btn) return;
    var key = btn.closest('li').dataset.key;
    var i = naming.order.indexOf(key), j = btn.dataset.move === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= naming.order.length) return;
    naming.order[i] = naming.order[j];
    naming.order[j] = key;
    nameChanged(true);
  });
  els.runBtn.addEventListener('click', function () {
    if (state.running) cancelRun(); else if (isCompressed()) redo(); else run();
  });
  els.shareBtn.addEventListener('click', share);
  els.saveBtn.addEventListener('click', download);

  window.addEventListener('beforeunload', function (e) {
    if (state.running) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- iOS向けの表示
  // iPhone / iPad（iPadOS はMacとして名乗るので、タッチ対応かどうかで見分ける）
  // Safari（WebKit）。iPhone・iPad はどのブラウザも中身は Safari
  function isWebKit() {
    var ua = navigator.userAgent || '';
    return isIOS() || (/AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua));
  }
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 0);
  }
  // iOSは共有シートの「ビデオを保存」で写真アプリに保存できるので、ボタンを1つにまとめる
  function setupIOSButtons() {
    if (!isIOS()) return;
    // 圧縮中に別のアプリに切り替えると、動画の処理が止まって Safari を開き直すまで使えなくなることがあるので、先に伝える
    show(els.progressNote, true);
    els.app.classList.add('is-ios');
    els.shareBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>' +
      '<path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2"/></svg>' +
      '<span>Discord等に共有・動画保存</span>';
  }

  // ---------------------------------------------------------------- URLを作る
  // 今の設定を URL パラメータにする（既定値と同じ項目は省く）。ショートカットやブックマーク用
  function buildUrl() {
    var q = [];
    SETTING_DEFS.forEach(function (d) {
      var v = d.read();
      if (v !== d.def) q.push(d.url + '=' + d.toUrl(v));
    });
    if (naming.on) {
      var keys = naming.order.filter(function (k) { return naming.enabled.indexOf(k) >= 0; });
      if (keys.length) {
        q.push('name=' + keys.join(','));
        ['text1', 'text2'].forEach(function (k) {
          var t = cleanText(naming.text[k]);
          if (keys.indexOf(k) >= 0 && t) q.push(k + '=' + encodeURIComponent(t));
        });
      }
    }
    // すべて初期値でも1つは付ける（URL に設定の項目がないと、開いたときに前回の設定が使われるため）
    if (!q.length) q.push('res=' + SETTING_DEFS[0].read());
    return location.origin + location.pathname + '?' + q.join('&');
  }
  // 文字をコピーする（クリップボードAPIが使えなければ、隠した欄を選択してコピー）
  function copyText(text, status, failMsg) {
    var done = function () { status.textContent = 'コピーしました'; };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position: fixed; top: 0; left: 0; opacity: 0';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) done(); else status.textContent = failMsg;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  els.urlCopy.addEventListener('click', function () {
    var url = buildUrl();
    copyText(url, els.urlStatus, 'コピーできませんでした。次のURLを長押ししてコピーしてください: ' + url);
  });
  els.diagCopy.addEventListener('click', function () {
    copyText(els.diagOut.value, els.diagStatus, 'コピーできませんでした。上の欄を長押ししてコピーしてください。');
  });

  // ---------------------------------------------------------------- 起動
  setupIOSButtons();
  // URL に設定の項目が1つでもあれば、前回の設定は使わず、初期値に URL の設定だけを重ねて始める
  // （保存してある前回の設定は消さない。URL なしで開いたときは前回の設定で始まる）
  if (!hasSettingParams()) loadSavedSettings();
  applyUrlParams();
  renderNameList();
  var missing = checkSupport();
  if (missing.length) {
    setAlert(els.unsupported, ['この環境では利用できません。次の機能に対応していません: ' + missing.join('、'),
      'iPhoneはiOS 16.4以降、AndroidはAndroid 10以降の最新のChromeでお試しください。'], true);
    els.pickBtn.disabled = true;
  }
  log('端末 ' + navigator.userAgent);
  detectCaps().then(function () {
    log('対応 VideoEncoder=' + (typeof window.VideoEncoder !== 'undefined') + ' AudioEncoder=' + (typeof window.AudioEncoder !== 'undefined') +
      ' AAC=' + state.caps.aac + ' 互換モード=' + state.caps.compat + ' iOS=' + isIOS() + ' Brave=' + !!navigator.brave + ' ver=' + APP_VERSION);
    refresh();
  });
  if (/[?&]debug=(1|on|true)\b/i.test(location.search)) showDiag(false);   // debug=1 なら最初から表示
  refresh();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* オフライン対応なしでも動く */ });
    });
  }

  // 動作確認用（ブラウザのコンソールから計算結果を確認できるようにしておく）
  window.__compressor = {
    makePlan: makePlan, nextBitrate: nextBitrate, preEstimate: preEstimate, exactCutBytes: exactCutBytes, readSettings: readSettings,
    estimateFps: estimateFps, snapFps: snapFps, audioStrategy: audioStrategy,
    state: state, precomp: function () { return { pre: pre }; },
    pickFile: function (file) { onFileChosen(file); },   // 自己テスト（selftest.html）から動画を渡す
    constants: {
      SIZE_SAFETY: SIZE_SAFETY, AUDIO_BITRATE: AUDIO_BITRATE, DEFAULT_MIN_KBPS: DEFAULT_MIN_KBPS,
      DISCORD_FREE_BYTES: DISCORD_FREE_BYTES, MAX_ATTEMPTS: MAX_ATTEMPTS, MB: MB
    }
  };
})();
