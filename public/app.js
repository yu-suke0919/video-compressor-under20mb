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
  var SIZE_SAFETY = 0.97;                // 目標サイズの97%を狙う（20MB→19.4MB）。エンコーダの誤差（数%）を吸収して再圧縮を避ける
  var AUDIO_BITRATE = 128000;            // 音声を再エンコードするときのビットレート
  var AUDIO_COPY_MAX_BITRATE = 192000;   // これ以下のAACは再エンコードせずそのまま使う
  var DISCORD_FREE_BYTES = 20 * MB;     // Discord無料アカウントの上限（注意文の基準）
  // 下限ビットレートの既定値（kbps）。720p30で1.2Mbps、1080pは画素数に比例させて同等の画質
  var DEFAULT_MIN_KBPS = { '720': 1200, '1080': 2700 };
  var MIN_KBPS_LIMITS = [100, 50000];
  var MSG_UNREACHABLE = '目標サイズに圧縮できません。解像度を下げるか、詳細設定にて下限ビットレートを引き下げてください。';
  var MSG_OVER_DISCORD = '20MBを超えるため、Discordの無料アカウントでは送信できません。';
  var MSG_HALF_FPS_HINT = '詳細設定の「60fpsの動画は30fpsにする」をオンにすると収まりやすくなります。';
  var MSG_LOCATION = '位置情報が含まれている動画です。この情報はアップロードされず、圧縮後の動画には位置情報を含めません。';
  var SETTINGS_KEY = 'video-compressor-under20mb:settings';   // 画面で変えた設定を覚えておく場所（この端末のブラウザ内だけ）
  var DEFAULT_FPS = 30;
  var MAX_FPS = 60;
  var MAX_ATTEMPTS = 3;                  // 初回 + 最大2回の再圧縮
  var KEYFRAME_INTERVAL = 2;             // 秒
  var MIN_TRIM_LENGTH = 0.5;             // 秒
  var AUDIO_DECODE_MAX_BYTES = 400 * MB;   // 互換モードで音声を扱うファイルサイズの上限
  var APP_VERSION = '2026-09-27a';        // 診断情報に出す（どの版で起きたかを見分ける）
  var CANCELLED = 'cancelled';
  var SNAPSHOT_MAX_BYTES = 600 * MB;     // Android で動画をブラウザ内に写し取る上限（これより大きい動画は写さない）
  var STALLED = 'stalled';
  var STALL_MS = 20000;                  // 画面を表示しているのに進捗がこれだけ止まったら、互換モードに切り替える

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
    trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimFill: $('trimFill'), trimLabel: $('trimLabel'),
    trimTicks: $('trimTicks'), trimSeek: $('trimSeek'),
    res720: $('res720'), res1080: $('res1080'), resSource: $('resSource'), resSeg: $('resSeg'), modeQuality: $('modeQuality'), modeSize: $('modeSize'),
    sizeLabel: $('sizeLabel'), planInfo: $('planInfo'), planWarn: $('planWarn'),
    targetSize: $('targetSize'), halfFps: $('halfFps'), audioOn: $('audioOn'), audioLabel: $('audioLabel'),
    minRate720: $('minRate720'), minRate1080: $('minRate1080'), autoRun: $('autoRun'), capLabel: $('capLabel'),
    urlCopy: $('urlCopy'), urlStatus: $('urlStatus'),
    runBtn: $('runBtn'), progressWrap: $('progressWrap'), progressBar: $('progressBar'),
    phase: $('phase'), pct: $('pct'),
    outVideo: $('outVideo'), outEmpty: $('outEmpty'), outInfo: $('outInfo'), outWarn: $('outWarn'),
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
  // 実行を止める。後片付けを始め（止まりきるのは待たない）、aborted をすぐ失敗させる
  function stopJob(job, reason) {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    job.hooks.forEach(function (hook) {
      try { Promise.resolve(hook()).catch(function () { /* noop */ }); } catch (e) { /* noop */ }
    });
    job.abort(new Error(reason));
  }
  function throwIfCancelled(job) { if (job && job.cancelled) throw new Error(CANCELLED); }
  function isCancel(job, err) { return !!(job && job.cancelled) || !!(err && err.message === CANCELLED); }
  function setAlert(el, lines, danger) {
    el.classList.toggle('danger', !!danger);
    el.innerHTML = '';
    lines = (lines || []).filter(Boolean);
    lines.forEach(function (t) {
      var p = document.createElement('p'); p.textContent = t; el.appendChild(p);
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
  function syncResOption() {
    var show = !!(state.meta && !isStandardRes(state.meta) && Math.min(state.meta.width, state.meta.height) > 720 + 8);
    els.resSeg.classList.toggle('is-three', show);
    if (show && wantSource) els.resSource.checked = true;
    else if (!show && els.resSource.checked) els.res1080.checked = true;
  }
  function readSettings() {
    var mb = parseFloat(els.targetSize.value);
    if (!isFinite(mb) || mb < MIN_TARGET_MB) mb = DEFAULT_TARGET_MB;
    if (mb > MAX_TARGET_MB) mb = MAX_TARGET_MB;
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
    updateNamePreview();
  }
  var previewRand = randDigits();
  function updateNamePreview() {
    var name = customName({ kind: 'compressed', now: new Date(), rand: previewRand, base: state.file ? fileBase() : 'IMG_1234', settings: readSettings() });
    els.namePreview.textContent = name ? name + '.mp4' : '（項目がないので今までの名前）' + (state.file ? fileBase() : 'IMG_1234') + '_compressed.mp4';
  }

  // ---------------------------------------------------------------- 設定を覚える
  // 画面で設定を変えたらこの端末のブラウザ内に保存し、次に開いたときに戻す。
  // URL パラメータで開いたときの値は保存しない（画面で変えたときだけ保存する）
  var SAVED_FIELDS = ['res720', 'res1080', 'resSource', 'modeQuality', 'modeSize', 'targetSize', 'minRate720', 'minRate1080',
    'halfFps', 'autoRun', 'audioOn'];
  function saveSettings() {
    var s = readSettings();
    var data = {
      res: wantSource ? 'source' : s.res, mode: s.mode, target: s.targetMB, min720: s.minBitrate['720'] / 1000, min1080: s.minBitrate['1080'] / 1000,
      halfFps: s.halfFps, auto: s.autoRun, audio: s.audio,
      name: { on: naming.on, order: naming.order, enabled: naming.enabled, text1: naming.text.text1, text2: naming.text.text2 }
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境では覚えない */ }
  }
  function loadSavedSettings() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') return;
    if (d.res === '1080') els.res1080.checked = true; else if (d.res === '720') els.res720.checked = true;
    wantSource = d.res === 'source';
    if (d.mode === 'quality') els.modeQuality.checked = true; else if (d.mode === 'size') els.modeSize.checked = true;
    if (isFinite(d.target) && d.target >= MIN_TARGET_MB && d.target <= MAX_TARGET_MB) els.targetSize.value = String(d.target);
    [['min720', els.minRate720], ['min1080', els.minRate1080]].forEach(function (pair) {
      var v = d[pair[0]];
      if (isFinite(v) && v >= MIN_KBPS_LIMITS[0] && v <= MIN_KBPS_LIMITS[1]) pair[1].value = String(Math.round(v));
    });
    [['halfFps', els.halfFps], ['auto', els.autoRun], ['audio', els.audioOn]].forEach(function (pair) {
      if (typeof d[pair[0]] === 'boolean') pair[1].checked = d[pair[0]];
    });
    var n = d.name;
    if (n && typeof n === 'object' && Array.isArray(n.enabled) && Array.isArray(n.order)) {
      setNaming(n.on === true, n.enabled, n.order);
      naming.text.text1 = cleanText(n.text1);
      naming.text.text2 = cleanText(n.text2);
    }
  }
  function resetSettings() {
    try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* noop */ }
    els.res720.checked = true;
    wantSource = false;
    els.modeSize.checked = true;
    els.targetSize.value = String(DEFAULT_TARGET_MB);
    els.minRate720.value = String(DEFAULT_MIN_KBPS['720']);
    els.minRate1080.value = String(DEFAULT_MIN_KBPS['1080']);
    els.halfFps.checked = true;
    els.autoRun.checked = false;
    els.audioOn.checked = true;
    naming = defaultNaming();
    renderNameList();
    refresh();
  }

  var SETTING_PARAMS = ['res', 'mode', 'target', 'fps', 'audio', 'min720', 'min1080', 'auto', 'name', 'text1', 'text2'];
  function hasSettingParams() {
    try {
      var params = new URLSearchParams(window.location.search);
      return SETTING_PARAMS.some(function (k) { return params.has(k); });
    } catch (e) { return false; }
  }
  // ショートカットなどから URL で初期値を渡せる（詳細設定の項目も含む）
  //   res=720|1080|source  mode=size|quality  target=MB  fps=30|source  audio=on|off  min720=kbps  min1080=kbps  auto=on|off
  function applyUrlParams() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var t = parseFloat(params.get('target'));
    if (isFinite(t) && t >= MIN_TARGET_MB && t <= MAX_TARGET_MB) els.targetSize.value = String(t);
    var r = (params.get('res') || '').toLowerCase().replace('p', '');
    if (r === '1080') { els.res1080.checked = true; wantSource = false; }
    else if (r === '720') { els.res720.checked = true; wantSource = false; }
    else if (r === 'source' || r === 'original') wantSource = true;
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

  // 撮影場所（GPS）の情報が入っているか。Android は ©xyz、iPhone は com.apple.quicktime.location.ISO6709 などに入る
  function hasLocationTag(tags) {
    var raw = tags && tags.raw;
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
      if (!vt) throw new Error('映像トラックが見つかりませんでした。');
      meta.width = vt.displayWidth;
      meta.height = vt.displayHeight;
      meta.videoCodec = vt.codec;
      return Promise.all([input.computeDuration(), vt.computePacketStats(120), vt.canDecode(), input.getPrimaryAudioTrack(),
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

  // 読み込めなかったときの文言。codec は高速モードで分かった映像の形式（分からなければ undefined）
  var CODEC_NAMES = { hevc: 'HEVC/H.265', avc: 'H.264', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' };
  function loadFailMessage(codec) {
    if (!codec) return '動画を読み込めませんでした。ファイルが壊れているか、対応していない形式です（MP4・MOVに対応しています）。';
    return 'この端末は、この動画の映像形式（' + (CODEC_NAMES[codec] || codec) + '）の読み込みに対応していません。' +
      (codec === 'hevc' ? '別の端末で試すか、iPhoneで撮影するときは「設定」→「カメラ」→「フォーマット」を「互換性優先」にしてください。' : '別の端末でお試しください。');
  }

  // 互換モード: <video> で長さと解像度を読み、冒頭を少し再生してフレームレートを測る
  function loadMetaCompat(videoEl, codec) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function ready() {
        if (done) return;
        if (!(isFinite(videoEl.duration) && videoEl.duration > 0) || !videoEl.videoWidth) return;
        done = true;
        clearTimeout(timer);
        resolve({ duration: videoEl.duration, width: videoEl.videoWidth, height: videoEl.videoHeight });
      }
      var timer = setTimeout(fail, 20000);
      videoEl.addEventListener('loadedmetadata', ready);
      videoEl.addEventListener('durationchange', ready);
      // 長さは読めたのに映像の大きさが0のまま（映像の形式に対応していない）なら、20秒待たずに諦める
      videoEl.addEventListener('loadedmetadata', function () {
        if (!videoEl.videoWidth) setTimeout(function () { if (!videoEl.videoWidth) fail(); }, 3000);
      }, { once: true });
      function fail() {
        if (!done) { done = true; clearTimeout(timer); reject(new Error(loadFailMessage(codec))); }
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
    if (res === 'source') return 1;   // 元の解像度のまま
    var limit = res === '1080' ? 1080 : 720;
    var shortSide = Math.min(meta.width, meta.height);
    return shortSide > limit ? limit / shortSide : 1;   // 拡大はしない
  }

  // videoCapBps: 映像ビットレートの上限を直接指定する（トリミングのみで目標を超えたとき、切り出した部分の実測値を使う）。
  //   省略時は、ファイル全体の平均ビットレートの80%を上限にする
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
    var videoBps, unreachable = false;

    if (settings.mode === 'quality') {
      // なるべく圧縮: 下限ビットレートで圧縮する
      videoBps = floorBps;
    } else if (forcedVideoBitrate) {
      // 再圧縮: 実サイズから求め直した値（下限は下回らない）
      videoBps = Math.max(floorBps, Math.floor(forcedVideoBitrate));
    } else {
      // ◯MB以内に圧縮: 目標サイズに収まるなるべく高いビットレート。下限を下回るなら圧縮できない
      videoBps = Math.floor(settings.targetBytes * 8 * SIZE_SAFETY / duration - audioBps);
      if (videoBps < floorBps) { unreachable = true; videoBps = floorBps; }
    }

    // 元動画より高いビットレートで焼き直しても容量が増えるだけなので上限を設ける
    var srcBps = meta.duration > 0 ? fileSize * 8 / meta.duration : Infinity;
    var srcCap = videoCapBps ? Math.floor(videoCapBps) : Math.floor(srcBps * 0.8) - audioBps;
    if (isFinite(srcCap) && srcCap > 100000 && videoBps > srcCap) videoBps = srcCap;
    // ビットレートは必ず整数にする（小数だと Mediabunny が例外を出し、0%のまま止まっていた）
    videoBps = Math.floor(videoBps);

    var estBytes = Math.round((videoBps + audioBps) * duration / 8);
    return {
      mode: settings.mode, res: settings.res, halfFps: settings.halfFps,
      targetMB: settings.targetMB, targetBytes: settings.targetBytes, minBitrate: settings.minBitrate,
      trimStart: trim.start, trimEnd: trim.end, duration: duration,
      srcFps: srcFps, outFps: outFps, fpsChanged: Math.abs(outFps - srcFps) > 0.05,
      width: width, height: height, videoBitrate: videoBps, floorBitrate: floorBps, videoCapBps: videoCapBps || null,
      audio: audio, audioBitrate: audioBps,
      estBytes: estBytes,
      unreachable: unreachable,                        // 目標サイズに収められない（◯MB以内に圧縮のとき）
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
    // 狙うサイズは丸めずに見せる（例: 50MB → 49.75 MB）
    els.capLabel.textContent = String(Math.round(s.targetBytes * SIZE_SAFETY / MB * 100) / 100) + ' MB';
    var hasFile = !!(state.file && state.meta);
    var locked = state.running || state.busy;
    // 圧縮が終わったら「やり直す」を押すまで、トリミングと設定を変えられないようにする
    var done = isCompressed();

    [els.trimStart, els.trimEnd].forEach(function (el) { el.disabled = !hasFile || locked || done; });
    // シークバーは圧縮後も元動画の確認に使えるようにする（圧縮中だけ止める）
    els.trimSeek.disabled = !hasFile || locked;
    [els.res720, els.res1080, els.resSource, els.modeQuality, els.modeSize, els.targetSize, els.halfFps, els.audioOn,
      els.minRate720, els.minRate1080, els.autoRun, els.nameOn].forEach(function (el) { el.disabled = state.running || done; });
    Array.prototype.forEach.call(els.nameList.querySelectorAll('input, button'), function (el) {
      el.disabled = state.running || done || (el.dataset.move === 'up' && !el.parentNode.previousSibling) ||
        (el.dataset.move === 'down' && !el.parentNode.nextSibling);
    });
    updateNamePreview();
    els.repickBtn.disabled = locked;
    els.runBtn.textContent = state.running ? 'キャンセル' : done ? 'やり直す' : '圧縮する';

    if (!hasFile) {
      els.runBtn.disabled = !state.running;
      els.planInfo.textContent = '';
      // 読み込みに失敗したときは、その理由を出したままにする
      setAlert(els.planWarn, state.loadError ? [state.loadError] : [], true);
      return;
    }

    var plan = state.plan = currentPlan();
    els.audioLabel.textContent = '音声を残す（' + plan.audio.label + '）';
    var trimEst = trimOnlyEstimate(plan);
    els.planInfo.textContent = trimEst
      ? '→ ' + (isFullTrimOf(plan) ? '位置情報だけ除いて元のまま' : 'トリミングのみ') + '（再圧縮なし）・' +
        plan.width + '×' + plan.height + '・予想' + fmtBytes(trimEst)
      : '→ ' + plan.width + '×' + plan.height + '・' + fmtFps(plan.outFps) + '・' +
        fmtRate(plan.videoBitrate) + '・予想' + fmtBytes(plan.estBytes);

    var warns = [];
    if (plan.mode === 'size' && plan.unreachable && !trimEst) {
      warns.push(MSG_UNREACHABLE);
      // 今の解像度と下限ビットレートで、目標サイズに収まる長さの目安
      var fitSec = Math.floor(plan.targetBytes * 8 * SIZE_SAFETY / (plan.floorBitrate + plan.audioBitrate));
      warns.push(resLabel(plan) + 'なら' + fmtDuration(fitSec) + 'まで' + plan.targetMB + 'MBに収められます。');
    }
    if (plan.audio.note) warns.push(plan.audio.note);   // 音声を残せないとき（圧縮する前に知らせる）
    if (state.meta.hasLocation) warns.push(MSG_LOCATION);
    // 目標サイズに収まらないと出しているときは、同じ内容になる20MB超えの注意は重ねない
    if (!(plan.mode === 'size' && plan.unreachable && !trimEst) && (trimEst ? trimEst > DISCORD_FREE_BYTES : plan.overDiscord)) {
      warns.push(MSG_OVER_DISCORD);
    }
    setAlert(els.planWarn, warns);

    // 目標サイズを超えるのが分かっているときは実行させない（処理中はキャンセル、圧縮後はやり直すボタンなので有効のまま）
    els.runBtn.disabled = !state.running && !done && (state.busy || (plan.mode === 'size' && plan.unreachable));

    updatePassthrough(s);
  }

  // すでに目標サイズ以下なら、圧縮せずそのまま共有・保存できるようにする
  function updatePassthrough(settings) {
    if (state.running) return;
    // 位置情報が入っている動画は、元の動画をそのまま渡さない（「圧縮する」で位置情報を除いて書き出す）
    var canPass = settings.mode === 'size' && isFullTrim() && state.file.size < settings.targetBytes &&
      !(state.meta && state.meta.hasLocation);
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
    // 可変ビットレート（VBR）を優先し、使えなければ固定ビットレート（CBR）にする
    var cands = [];
    FAST_VIDEO_CODECS.forEach(function (codec) {
      ['prefer-hardware', 'no-preference'].forEach(function (hw) {
        ['variable', 'constant'].forEach(function (bm) {
          cands.push({ codec: codec, hw: hw, bitrateMode: bm });
        });
      });
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

  function convertFast(plan, onProgress, job) {
    var input = new M.Input({ source: new M.BlobSource(state.file), formats: INPUT_FORMATS });
    var output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
    var chosen = null;
    function dispose() { try { input.dispose(); } catch (e) { /* noop */ } }
    job.hooks.push(dispose);   // 準備中に止めた場合も、ファイルの読み込みを閉じる

    return pickFastEncoding(plan).then(function (enc) {
      if (!enc) throw new Error('この端末では動画のエンコード（H.264）に対応していません。');
      chosen = enc;
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
      var options = { input: input, output: output, video: video, audio: audio, tags: outputTags, showWarnings: false };
      if (!isFullTrimOf(plan)) options.trim = { start: plan.trimStart, end: plan.trimEnd };
      return M.Conversion.init(options);
    }).then(function (conv) {
      var discarded = conv.discardedTracks || [];
      log('変換の準備（' + encKey(chosen) + '） isValid=' + conv.isValid + (discarded.length ? ' 除外=' + discarded.map(function (d) {
        return (d.track && d.track.type) + ':' + d.reason;
      }).join(',') : ''));
      var videoLost = discarded.filter(function (d) { return d.track && d.track.type === 'video'; })[0];
      if (!conv.isValid || videoLost) {
        throw new Error('高速モードで扱えない動画です（' + (videoLost ? videoLost.reason : 'invalid') + '）');
      }
      var audioLost = plan.audio.mode !== 'none' &&
        discarded.some(function (d) { return d.track && d.track.type === 'audio' && d.reason !== 'discarded_by_user'; });
      // キャンセル時: 変換を止め、ファイルの読み込みも閉じる（止まりきるのは待たない）
      job.hooks.push(function () { var stop = conv.cancel(); dispose(); return stop; });
      conv.onProgress = function (p) { onProgress(p); };
      throwIfCancelled(job);
      log('変換を開始');
      return conv.execute().then(function () {
        return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), audioDropped: audioLost, rateMode: chosen.bitrateMode };
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

  function isFullTrimOf(plan) {
    return plan.trimStart <= 0.05 && plan.trimEnd >= state.meta.duration - 0.05;
  }

  // ---------------------------------------------------------------- トリミングのみ（再エンコードしない）
  // 「◯MB以内に圧縮」で、解像度もfpsも元のまま、トリミングした元動画が目標サイズに収まる見込みなら、
  // 再エンコードせずに切り出すだけにする（画質は元のまま）。見込みのサイズを返し、対象外なら 0
  function trimOnlyEstimate(plan) {
    if (!state.meta || !state.file || state.engine !== 'fast' || plan.mode !== 'size') return 0;
    // 全体のときは「元の動画のまま」で扱う。ただし位置情報があるときは、位置情報だけ除いてそのまま書き出す
    if (isFullTrimOf(plan) && !state.meta.hasLocation) return 0;
    if (plan.width !== state.meta.width || plan.height !== state.meta.height || plan.fpsChanged) return 0;
    if (!(state.meta.duration > 0)) return 0;
    var est = Math.round(state.file.size * plan.duration / state.meta.duration);
    // 区切りがキーフレームに合わせて少し広がる分を見込み、狙うサイズ（目標の97%）で判定する
    return est < plan.targetBytes * SIZE_SAFETY ? est : 0;
  }

  function convertCopy(plan, onProgress, job) {
    var input = new M.Input({ source: new M.BlobSource(state.file), formats: INPUT_FORMATS });
    var output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
    function dispose() { try { input.dispose(); } catch (e) { /* noop */ } }
    job.hooks.push(dispose);

    return M.Conversion.init({
      input: input, output: output,
      video: {},
      audio: plan.audio.mode === 'none' ? { discard: true } : {},
      trim: { start: plan.trimStart, end: plan.trimEnd },
      // 再エンコードせずにそのまま写す。区切りはキーフレームに合わせて広げる（開始が少し早まることがある）
      copy: { mode: 'forced', boundaryPolicy: 'expand', shiftTolerance: Infinity },
      tags: outputTags,
      showWarnings: false
    }).then(function (conv) {
      var discarded = conv.discardedTracks || [];
      log('トリミングのみの準備 isValid=' + conv.isValid + (discarded.length ? ' 除外=' + discarded.map(function (d) {
        return (d.track && d.track.type) + ':' + d.reason;
      }).join(',') : ''));
      var videoLost = discarded.filter(function (d) { return d.track && d.track.type === 'video'; })[0];
      if (!conv.isValid || videoLost) {
        throw new Error('トリミングのみでは扱えない動画です（' + (videoLost ? videoLost.reason : 'invalid') + '）');
      }
      var audioLost = plan.audio.mode !== 'none' &&
        discarded.some(function (d) { return d.track && d.track.type === 'audio' && d.reason !== 'discarded_by_user'; });
      job.hooks.push(function () { var stop = conv.cancel(); dispose(); return stop; });
      conv.onProgress = function (p) { onProgress(p); };
      throwIfCancelled(job);
      return conv.execute().then(function () {
        return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), audioDropped: audioLost, trimOnly: true };
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

  // ---------------------------------------------------------------- 互換モード（再生しながら取り込み）
  function findCompatVideoConfig(plan) {
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
      var c = cands[i];
      return Promise.resolve()
        .then(function () { return VideoEncoder.isConfigSupported(c.config); })
        .then(function (res) {
          log('互換エンコード設定 ' + c.config.codec + '/' + c.config.hardwareAcceleration + '/' + (c.config.bitrateMode || '既定') +
            ' → ' + ((res && res.supported) ? '使える' : '使えない'));
          return (res && res.supported) ? { config: res.config || c.config, mb: c.mb } : next(i + 1);
        })
        .catch(function (e) { log('互換エンコード設定の確認に失敗 ' + errText(e)); return next(i + 1); });
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

  function runAudioEncoder(audioBuffer, from, to, channels, sampleRate, config, onProgress, job) {
    return new Promise(function (resolve, reject) {
      var packets = [];
      var encoder = new AudioEncoder({
        output: function (chunk, meta) { packets.push({ packet: M.EncodedPacket.fromEncodedChunk(chunk), meta: meta }); },
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
  function encodeCompatVideo(videoEl, plan, config, onPacket, onProgress, job) {
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
      // キャンセルしたらその場で止めて、プレビューの動画を元に戻す（次の実行とぶつからないように）
      job.hooks.push(function () { fail(new Error(CANCELLED)); });

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
          resolve();
        }, fail);
      }
      function onFrame(now, frameMeta) {
        if (finished) return;
        if (job.cancelled) return fail(new Error(CANCELLED));
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
            drain(encoder, 2, job).then(function () {
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
        if (job.cancelled) return fail(new Error(CANCELLED));
        if (videoEl.ended || videoEl.currentTime >= end) finish();
      }, 400);
      videoEl.onended = finish;

      // 開始位置へシークしてから再生する
      var seeked = false;
      function begin() {
        if (seeked || finished) return;
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

  function convertCompat(plan, onProgress, job) {
    var audioSpan = plan.audio.mode === 'aac' ? 0.15 : 0;
    var audioPromise = plan.audio.mode === 'aac'
      ? encodeCompatAudio(plan, function (r) { onProgress(r * audioSpan); }, job)
      : Promise.resolve(null);

    return audioPromise.then(function (audio) {
      throwIfCancelled(job);
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
          }, job).then(function () {
            pushAudioUntil(Infinity);
            return chain.then(function () {
              vsrc.close();
              if (asrc) asrc.close();
              return output.finalize();
            }).then(function () {
              return {
                blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
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

    // prevSize: 前回の圧縮結果のサイズ（再圧縮のときに表示する）。note: 進捗の欄に出す補足
    function attempt(index, prevSize, note) {
      var label = note || (index === 0 ? (engine === 'copy' ? 'トリミング中（再圧縮なし）'
        : engine === 'fast' ? '圧縮中' : '圧縮中（互換モード：再生しながら処理）')
        : '圧縮結果が' + (prevSize / MB).toFixed(2) + 'MBで目標超過→再圧縮中（' + (index + 1) + '回目）');
      setProgress(0, label);
      // 1回ぶんの処理（進まなくなったらこれだけ止めて、別の方式でやり直す）
      var aj = state.attemptJob = newJob();
      var t0 = Date.now(), lastVal = -1, idleMs = 0, lastTick = Date.now(), nextLog = 0;
      // キャンセル後に古い処理から届く進捗は無視する
      var onProgress = function (p) {
        if (job.cancelled || aj.cancelled) return;
        if (p > lastVal + 0.0005) { lastVal = p; idleMs = 0; }
        if (p >= nextLog) {
          log('進捗 ' + Math.round(p * 100) + '%（' + ((Date.now() - t0) / 1000).toFixed(1) + '秒）');
          nextLog = Math.floor(p * 10 + 1) / 10;
        }
        setProgress(p, label);
      };
      // 画面を表示しているのに進捗が止まったままなら、止まったとみなす（裏に回っていた時間は数えない）
      var watchdog = setInterval(function () {
        var now = Date.now(), dt = now - lastTick;
        lastTick = now;
        if (document.visibilityState !== 'visible' || dt > 5000) return;
        idleMs += dt;
        if (idleMs >= STALL_MS) {
          clearInterval(watchdog);
          log('進捗が' + Math.round(STALL_MS / 1000) + '秒止まったため中断（' + Math.round(Math.max(0, lastVal) * 100) + '%）');
          showDiag(true);
          stopJob(aj, STALLED);
        }
      }, 1000);
      var task = engine === 'copy' ? convertCopy(plan, onProgress, aj)
        : engine === 'fast' ? convertFast(plan, onProgress, aj) : convertCompat(plan, onProgress, aj);
      task.catch(function () { /* 競争に負けた側の失敗は無視する */ });

      // キャンセルしたら、ライブラリ側が止まりきるのを待たずにすぐ抜ける
      return Promise.race([task, job.aborted, aj.aborted]).then(function (res) {
        clearInterval(watchdog);
        throwIfCancelled(job);
        log('完了 ' + fmtBytes(res.blob.size) + '（' + ((Date.now() - t0) / 1000).toFixed(1) + '秒）');
        if (engine === 'copy') {
          // トリミングのみで目標を超えたら、通常の圧縮に切り替える
          if (res.blob.size >= plan.targetBytes) {
            log('トリミングのみでは目標を超えたため、通常の圧縮に切り替え');
            engine = 'fast';
            // 予想を超えたのは、切り出した部分がファイル全体の平均より重いから。
            // 全体の平均の80%で頭打ちにすると必要以上に小さくなるので、切り出した部分の実測値を上限にして計画し直す
            var copyVideoBps = Math.floor(res.blob.size * 8 / plan.duration) - Math.round(plan.audio.bps || 0);
            plan = makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
              plan.audio, state.file.size, null, copyVideoBps);
            log('計画し直し ' + describePlan(plan));
            return attempt(0, 0, 'トリミングのみでは' + (res.blob.size / MB).toFixed(2) + 'MBで目標超過→圧縮中');
          }
          res.attempts = 1;
          return res;
        }
        if (res.audioDropped && plan.audio.mode !== 'none') {
          plan.audio = { mode: 'none', bps: 0, label: 'なし', note: null };
          plan.audioBitrate = 0;
        }
        if (plan.mode === 'size' && res.blob.size >= plan.targetBytes && index + 1 < MAX_ATTEMPTS) {
          var audioBytes = plan.audioBitrate * plan.duration / 8;
          var next = nextBitrate(plan, res.blob.size - audioBytes, audioBytes);
          // 下限を下回る値は下限に揃え、それ以上下げられないならやめる
          if (next) next = Math.max(next, plan.floorBitrate);
          if (next && next < plan.videoBitrate) {
            plan = makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
              plan.audio, state.file.size, next, plan.videoCapBps);
            return attempt(index + 1, res.blob.size);
          }
        }
        res.attempts = index + 1;
        return res;
      }, function (err) {
        clearInterval(watchdog);
        if (job.cancelled || (!aj.cancelled && isCancel(null, err))) throw new Error(CANCELLED);
        var stalled = aj.cancelled;
        if (!stalled) log('失敗（' + engine + '）' + errText(err));
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
          plan = makePlan(state.meta, { start: plan.trimStart, end: plan.trimEnd }, planSettings(plan),
            audioStrategy(state.meta, readSettings().audio, 'compat'), state.file.size, null, plan.videoCapBps);
          return attempt(0, 0, stalled ? '処理が進まないため、互換モードでやり直し中' : null);
        }
        if (stalled) throw new Error('圧縮が進まなくなりました。画面を表示したまま、もう一度お試しください。');
        throw err;
      });
    }

    return attempt(0).then(function (res) {
      setProgress(1, '完了');
      finishRun();
      showResult(res, plan, engine, (Date.now() - started) / 1000);
      refresh();   // 結果が入ってから、ボタンを「やり直す」にして設定を無効にする
    }, function (err) {
      finishRun();
      if (isCancel(job, err)) { log('キャンセル'); return; }
      console.error(err);
      log('エラーで終了 ' + errText(err));
      setAlert(els.outWarn, ['エラー: ' + ((err && err.message) || String(err)),
        'うまくいかないときは、画面のいちばん下の「診断情報」をコピーして、X（@inkaroma0431）あるいはDiscordに送ってください。'], true);
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
      mode: plan.mode, res: plan.res, halfFps: plan.halfFps,
      targetMB: plan.targetMB, targetBytes: plan.targetBytes, minBitrate: plan.minBitrate
    };
  }

  function finishRun() {
    state.running = false;
    state.job = null;
    state.attemptJob = null;
    releaseWakeLock();
    setRunningUi(false);
    refresh();
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
        plan.width + '×' + plan.height + '・' + (isFullTrimOf(plan) ? '位置情報だけ除いて元のまま' : 'トリミングのみ') +
        '（再圧縮なし）・' + fmtDuration(elapsed) +
        (res.audioDropped ? '・音声なし' : '');
      setAlert(els.outWarn, size > DISCORD_FREE_BYTES ? [MSG_OVER_DISCORD] : []);
      return;
    }
    els.outInfo.textContent = fmtBytes(state.file.size) + ' → ' + fmtBytes(size) + '（' + (ratio >= 0 ? '-' : '+') +
      Math.abs(ratio) + '%）・' + plan.width + '×' + plan.height + '・' + fmtRate(plan.videoBitrate) + '・' +
      fmtDuration(elapsed) + (res.attempts > 1 ? '・' + res.attempts + '回で調整' : '') +
      // Safari（WebKit）は CBR/VBR の指定をエンコーダに渡さないので、表示しない
      (res.rateMode && !isWebKit() ? (res.rateMode === 'variable' ? '・VBR' : '・CBR') : '') +
      (plan.audio.mode === 'none' && readSettings().audio ? '・音声なし' : '') + (engine === 'compat' ? '・互換モード' : '');

    var warns = [];
    if (plan.mode === 'size' && size >= plan.targetBytes) {
      warns.push(MSG_UNREACHABLE);
      // 60fpsのままだと、エンコーダが下限ビットレートまで下げきれず目標を超えることがある
      if (plan.outFps > 40 && !plan.halfFps) warns.push(MSG_HALF_FPS_HINT);
    }
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
    navigator.wakeLock.request('screen').then(function (lock) { state.wakeLock = lock; }).catch(function () { /* noop */ });
  }
  function releaseWakeLock() {
    if (state.wakeLock) {
      try { state.wakeLock.release(); } catch (e) { /* noop */ }
      state.wakeLock = null;
    }
  }

  // ---------------------------------------------------------------- 動画の読み込み
  // Android では、ファイル選択で渡された動画が時間が経つと読めなくなることがある（TypeError: network error）。
  // 読めるうちに中身をブラウザ内に写し取り、以降はその写しを使う（大きすぎる動画は写さない）
  function snapshotFile(file) {
    if (!/Android/i.test(navigator.userAgent || '') || file.size > SNAPSHOT_MAX_BYTES) return Promise.resolve(file);
    var t0 = Date.now();
    return file.arrayBuffer().then(function (buf) {
      log('動画をブラウザ内に写した（Android・' + ((Date.now() - t0) / 1000).toFixed(1) + '秒）');
      return new File([buf], file.name || 'video.mp4', { type: file.type || 'video/mp4', lastModified: file.lastModified });
    }, function (err) {
      log('動画をブラウザ内に写せなかった ' + errText(err));
      return file;
    });
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
        ' audio=' + (meta.audio ? meta.audio.codec + '/' + Math.round(meta.audio.bitrate / 1000) + 'kbps' : 'なし'));
      if (!meta.canDecode) { var e = new Error('decode'); e.codec = meta.videoCodec; throw e; }
      state.engine = 'fast';
      return meta;
    }).catch(function (err) {
      console.warn('高速モードで読み込めないため互換モードを使います:', err);
      log('高速モードで読み込めない ' + errText(err));
      var codec = err && err.codec;   // 中身は読めたが、映像の形式に対応していないとき
      if (!state.caps.compat) throw new Error(loadFailMessage(codec));
      state.engine = 'compat';
      els.srcInfo.textContent = '解析中…';
      return loadMetaCompat(els.srcVideo, codec);
    }).then(function (meta) {
      if (state.file !== file) return;
      state.meta = meta;
      setupTrim(meta.duration);
      renderPlayhead();
      els.srcInfo.textContent = meta.width + '×' + meta.height + '・' +
        (meta.fps ? fmtFps(meta.fps) : 'fps不明') + '・' + fmtDuration(meta.duration) + '・' + fmtBytes(file.size);
    }).catch(function (err) {
      log('読み込みに失敗 ' + errText(err));
      showDiag(true);
      state.file = null;
      els.srcInfo.textContent = '';
      state.loadError = (err && err.message) || String(err);
      setAlert(els.planWarn, [state.loadError], true);
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
    els[k].addEventListener('change', function () { wantSource = k === 'resSource'; });
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
    if (rerender) renderNameList(); else updateNamePreview();
    saveSettings();
    refresh();
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
    var s = readSettings();
    var q = [];
    var res = wantSource ? 'source' : s.res;
    if (res !== '720') q.push('res=' + res);
    if (s.mode !== 'size') q.push('mode=' + s.mode);
    if (s.targetMB !== DEFAULT_TARGET_MB) q.push('target=' + s.targetMB);
    if (s.minBitrate['720'] !== DEFAULT_MIN_KBPS['720'] * 1000) q.push('min720=' + s.minBitrate['720'] / 1000);
    if (s.minBitrate['1080'] !== DEFAULT_MIN_KBPS['1080'] * 1000) q.push('min1080=' + s.minBitrate['1080'] / 1000);
    if (!s.halfFps) q.push('fps=source');
    if (s.autoRun) q.push('auto=on');
    if (!s.audio) q.push('audio=off');
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
    if (!q.length) q.push('res=' + res);
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
    makePlan: makePlan, nextBitrate: nextBitrate, readSettings: readSettings,
    estimateFps: estimateFps, snapFps: snapFps, audioStrategy: audioStrategy,
    state: state,
    constants: {
      SIZE_SAFETY: SIZE_SAFETY, AUDIO_BITRATE: AUDIO_BITRATE, DEFAULT_MIN_KBPS: DEFAULT_MIN_KBPS,
      DISCORD_FREE_BYTES: DISCORD_FREE_BYTES, MAX_ATTEMPTS: MAX_ATTEMPTS, MB: MB
    }
  };
})();
