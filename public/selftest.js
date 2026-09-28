/*
 * 自己テスト（selftest.html）
 * この端末で、テスト用の動画をその場で作り（WebCodecs で H.264 と AAC/Opus に書き出す）、
 * 本番と同じ画面（index.html）を iframe で開いて実際に圧縮し、結果の中身を Mediabunny で調べる。
 * 画面の設定は URL で渡すので、この端末に保存してある設定は使わず、変えもしない。
 */
'use strict';

(function () {
  var M = window.Mediabunny;
  var $ = function (id) { return document.getElementById(id); };
  var UA = navigator.userAgent || '';
  var IS_IOS = /iPad|iPhone|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 0);
  var IS_ANDROID = /Android/i.test(UA);
  var MB = 1000 * 1000;   // アプリと同じく 1MB＝100万バイト
  var COMPRESS_TIMEOUT_MS = 5 * 60 * 1000;
  var SWITCH_TIMEOUT_MS = 10 * 60 * 1000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtMB(bytes) { return (bytes / MB).toFixed(2) + 'MB'; }

  // ---------------------------------------------------------------- テスト用の動画
  var VIDEOS = {
    v720: { label: '1280×720・30fps・8秒', w: 1280, h: 720, fps: 30, dur: 8, bitrate: 6e6 },
    v1080p60: { label: '1920×1080・60fps・5秒', w: 1920, h: 1080, fps: 60, dur: 5, bitrate: 10e6 },
    vVert: { label: '1080×1920（縦長）・30fps・5秒', w: 1080, h: 1920, fps: 30, dur: 5, bitrate: 10e6 },
    vSmall: { label: '320×240・30fps・3秒', w: 320, h: 240, fps: 30, dur: 3, bitrate: 1e6 },
    vShort: { label: '1280×720・30fps・0.4秒', w: 1280, h: 720, fps: 30, dur: 0.4, bitrate: 6e6 },
    vLong: { label: '1280×720・30fps・3分', w: 1280, h: 720, fps: 30, dur: 180, bitrate: 2e6 }
  };
  var made = {};   // 作った動画 { file, audio: 'AAC' | 'Opus' | null }

  var AUDIO_CANDIDATES = [
    { name: 'AAC', mb: 'aac', config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 } },
    { name: 'Opus', mb: 'opus', config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 } }
  ];

  function pickVideoConfig(spec) {
    var big = spec.w * spec.h > 1280 * 720 || spec.fps > 30;
    var codecs = big ? ['avc1.64002A', 'avc1.4D402A', 'avc1.640028', 'avc1.4D0028']
      : ['avc1.640028', 'avc1.4D0028', 'avc1.42E028', 'avc1.42001F'];
    var tries = [];
    codecs.forEach(function (codec) {
      ['no-preference', 'prefer-hardware', 'prefer-software'].forEach(function (hw) {
        tries.push({ codec: codec, width: spec.w, height: spec.h, bitrate: spec.bitrate, framerate: spec.fps, hardwareAcceleration: hw, avc: { format: 'avc' } });
      });
    });
    return tries.reduce(function (p, c) {
      return p.then(function (found) {
        if (found) return found;
        return VideoEncoder.isConfigSupported(c).then(function (r) { return r.supported ? c : null; }, function () { return null; });
      });
    }, Promise.resolve(null));
  }

  // 音（左 440Hz・右 550Hz）を AAC（だめなら Opus）で書き出す。どちらもだめなら音声なし
  async function makeAudio(dur) {
    if (typeof AudioEncoder === 'undefined') return null;
    for (var i = 0; i < AUDIO_CANDIDATES.length; i++) {
      var cand = AUDIO_CANDIDATES[i];
      try {
        var sup = await AudioEncoder.isConfigSupported(cand.config);
        if (!sup.supported) continue;
      } catch (e) { continue; }
      var packets = [], err = null;
      var enc = new AudioEncoder({
        output: function (chunk, meta) { packets.push({ packet: fixAudioPacket(M.EncodedPacket.fromEncodedChunk(chunk), cand), meta: fixAudioMeta(meta, cand) }); },
        error: function (e) { err = e; }
      });
      try {
        enc.configure(cand.mb === 'aac' ? Object.assign({ aac: { format: 'aac' } }, cand.config) : cand.config);
        var rate = 48000, ch = 2, total = Math.round(dur * rate), CHUNK = 1024;
        for (var pos = 0; pos < total; pos += CHUNK) {
          var len = Math.min(CHUNK, total - pos);
          var data = new Float32Array(len * ch);
          for (var c = 0; c < ch; c++) {
            for (var j = 0; j < len; j++) data[c * len + j] = 0.2 * Math.sin(2 * Math.PI * (440 + c * 110) * (pos + j) / rate);
          }
          var ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: len, numberOfChannels: ch, timestamp: Math.round(pos / rate * 1e6), data: data });
          try { enc.encode(ad); } finally { ad.close(); }
          if (enc.encodeQueueSize > 32) await sleep(1);
        }
        await enc.flush();
      } catch (e) {
        err = err || e;
      } finally {
        try { if (enc.state !== 'closed') enc.close(); } catch (e) { /* noop */ }
      }
      if (!err && packets.length) return { packets: packets, mb: cand.mb, name: cand.name };
    }
    return null;
  }

  // iPhone の Safari の AudioEncoder が書き出す AAC は、そのまま MP4 に書くと、読み直したときに形式がおかしく見える
  // （アプリが「読み込めない」と判断し、音声をコピーしようとして失敗する）。
  // 設定データ（AudioSpecificConfig）が付いていなければ作り、ADTS のヘッダーが付いていれば外して、正しい AAC として書く
  var audioDiag = null;   // エンコーダーが出してきたもの（結果に書く）
  function hex(bytes, n) {
    return Array.prototype.slice.call(bytes, 0, n).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function bufferBytes(buf) {
    if (!buf) return null;
    return buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  // AAC-LC の AudioSpecificConfig（種類 2・サンプリング周波数の番号・チャンネル数）
  var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function aacConfig(rate, channels) {
    var idx = Math.max(0, AAC_RATES.indexOf(rate));
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
  }
  function fixAudioMeta(meta, cand) {
    if (!meta || !meta.decoderConfig) return meta;
    var dc = meta.decoderConfig;
    var rate = dc.sampleRate || cand.config.sampleRate, ch = dc.numberOfChannels || cand.config.numberOfChannels;
    var desc = bufferBytes(dc.description);
    if (audioDiag === null) audioDiag = 'codec=' + dc.codec + ' description=' + (desc ? hex(desc, 16) + '（' + desc.length + 'バイト）' : 'なし');
    // 設定データがない・短い・種類（先頭5ビット）が AAC-LC / HE-AAC 以外なら、AAC-LC の設定データを作る
    var aot = desc && desc.length >= 2 ? desc[0] >> 3 : 0;
    if (cand.mb === 'aac' && [2, 5, 29].indexOf(aot) < 0) desc = aacConfig(rate, ch);
    return { decoderConfig: { codec: cand.config.codec, sampleRate: rate, numberOfChannels: ch, description: desc || undefined } };
  }
  var audioFirstBytes = null;
  function fixAudioPacket(packet, cand) {
    var d = packet.data;
    if (audioFirstBytes === null) audioFirstBytes = hex(d, 8);
    // ADTS のヘッダー（0xFFF で始まる）が付いていたら外す
    if (cand.mb === 'aac' && d.length > 9 && d[0] === 0xff && (d[1] & 0xf0) === 0xf0) {
      var headerLen = (d[1] & 1) ? 7 : 9;
      return new M.EncodedPacket(d.subarray(headerLen), packet.type, packet.timestamp, packet.duration);
    }
    return packet;
  }

  // 1コマ描く（色が変わり、丸が動くので、圧縮にそれなりの情報量が要る）
  function drawFrame(ctx, spec, i) {
    var w = spec.w, h = spec.h, t = i / spec.fps, hue = (t * 40) % 360;
    var g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'hsl(' + hue + ',70%,45%)');
    g.addColorStop(1, 'hsl(' + ((hue + 120) % 360) + ',70%,30%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    var r = Math.min(w, h) * 0.12;
    for (var k = 0; k < 6; k++) {
      ctx.fillStyle = 'hsl(' + ((hue + k * 60) % 360) + ',80%,60%)';
      ctx.beginPath();
      ctx.arc(w / 2 + Math.cos(t * (1 + k * 0.3) + k) * (w / 2 - r), h / 2 + Math.sin(t * (1.3 + k * 0.2) + k) * (h / 2 - r),
        r * (0.5 + k * 0.1), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.round(Math.min(w, h) / 9) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(w + '×' + h + '  ' + t.toFixed(2) + 's', w / 2, h / 2);
  }

  async function makeVideo(key) {
    if (made[key]) return made[key];
    var spec = VIDEOS[key];
    setStatus('テスト用の動画を作っています（' + spec.label + '）');
    var vconf = await pickVideoConfig(spec);
    if (!vconf) throw new Error('この端末ではテスト用の動画（H.264 ' + spec.w + '×' + spec.h + '）を作れません');
    var audio = await makeAudio(spec.dur);

    var output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
    var vsrc = new M.EncodedVideoPacketSource('avc');
    output.addVideoTrack(vsrc, { frameRate: spec.fps });
    var asrc = null;
    if (audio) { asrc = new M.EncodedAudioPacketSource(audio.mb); output.addAudioTrack(asrc); }
    await output.start();

    // 映像と音声をタイムスタンプ順に交互に渡す
    var chain = Promise.resolve(), ai = 0, encError = null;
    function pushAudioUntil(t) {
      if (!asrc) return;
      while (ai < audio.packets.length && audio.packets[ai].packet.timestamp <= t) {
        (function (p) { chain = chain.then(function () { return asrc.add(p.packet, p.meta); }); })(audio.packets[ai++]);
      }
    }
    var encoder = new VideoEncoder({
      output: function (chunk, meta) {
        var packet = M.EncodedPacket.fromEncodedChunk(chunk);
        pushAudioUntil(packet.timestamp);
        chain = chain.then(function () { return vsrc.add(packet, meta); });
      },
      error: function (e) { encError = e; }
    });
    encoder.configure(vconf);
    var canvas = document.createElement('canvas');
    canvas.width = spec.w;
    canvas.height = spec.h;
    var ctx = canvas.getContext('2d');
    var n = Math.max(1, Math.round(spec.dur * spec.fps)), gop = Math.round(spec.fps * 2);
    try {
      for (var i = 0; i < n; i++) {
        if (encError) throw encError;
        drawFrame(ctx, spec, i);
        var frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / spec.fps), duration: Math.round(1e6 / spec.fps) });
        try { encoder.encode(frame, { keyFrame: i % gop === 0 }); } finally { frame.close(); }
        while (encoder.encodeQueueSize > 4) await sleep(2);
        if (i % 15 === 0) {
          setStatus('テスト用の動画を作っています（' + spec.label + '）… ' + Math.round(i / n * 100) + '%');
          await sleep(0);
        }
      }
      await encoder.flush();
    } finally {
      try { if (encoder.state !== 'closed') encoder.close(); } catch (e) { /* noop */ }
    }
    if (encError) throw encError;
    pushAudioUntil(Infinity);
    await chain;
    vsrc.close();
    if (asrc) asrc.close();
    await output.finalize();
    made[key] = {
      file: new File([output.target.buffer], 'selftest-' + key + '.mp4', { type: 'video/mp4' }),
      audio: audio ? audio.name : null,
      label: spec.label
    };
    return made[key];
  }

  // ---------------------------------------------------------------- アプリを動かす
  var frameEl = $('app');
  function appWin() { return frameEl.contentWindow; }
  function appDoc() { return frameEl.contentDocument; }
  function appText(id) { var el = appDoc().getElementById(id); return el ? (el.value !== undefined && el.tagName === 'TEXTAREA' ? el.value : el.textContent) : ''; }
  var appVersion = null;

  function waitFor(cond, timeout, what) {
    var t0 = Date.now();
    return new Promise(function (resolve, reject) {
      (function check() {
        var ok = false;
        try { ok = cond(); } catch (e) { ok = false; }
        if (ok) return resolve();
        if (Date.now() - t0 > timeout) return reject(new Error(what + 'が' + Math.round(timeout / 1000) + '秒たっても終わりません'));
        setTimeout(check, 150);
      })();
    });
  }

  // アプリを開き直す（毎回まっさらな状態から始める）。query には必ず設定を1つ以上入れる（保存してある設定を使わないため）
  function openApp(query) {
    return new Promise(function (resolve) {
      frameEl.onload = resolve;
      frameEl.src = './?' + query;
    }).then(function () {
      return waitFor(function () { return appWin().__compressor && /対応 VideoEncoder=/.test(appText('diagOut')); }, 30000, 'アプリの準備');
    }).then(function () {
      var m = /ver=(\S+)/.exec(appText('diagOut'));
      if (m) appVersion = m[1];
      showDevice();
    });
  }

  // 動画は iframe の中の File として渡す（Blob かどうかの判定は、ページごとに別の Blob で行われるため）
  function pickInApp(file) {
    var w = appWin();
    w.__compressor.pickFile(new w.File([file], file.name, { type: file.type || 'video/mp4' }));
    return waitFor(function () {
      var s = appWin().__compressor.state;
      return !s.busy && !!(s.meta || s.loadError);
    }, 120000, '動画の読み込み');
  }

  function setTrim(start, end) {
    var d = appDoc(), w = appWin();
    var a = d.getElementById('trimStart'), z = d.getElementById('trimEnd');
    z.value = String(end); z.dispatchEvent(new w.Event('input'));
    a.value = String(start); a.dispatchEvent(new w.Event('input'));
  }

  function runInApp(timeout) {
    var btn = appDoc().getElementById('runBtn');
    if (btn.disabled) return Promise.resolve();
    btn.click();
    return sleep(200).then(function () {
      return waitFor(function () { return !appWin().__compressor.state.running; }, timeout, '圧縮');
    });
  }

  // 書き出した動画の中身
  async function inspect(appBlob) {
    var blob = new Blob([appBlob]);   // iframe の中の Blob を、このページの Blob にする
    var input = new M.Input({ source: new M.BlobSource(blob), formats: [M.MP4, M.QTFF] });
    try {
      var v = await input.getPrimaryVideoTrack();
      var a = await input.getPrimaryAudioTrack();
      var fps = null, audioOk = null, audioCodec = null;
      if (v) { try { fps = (await v.computePacketStats(120)).averagePacketRate; } catch (e) { fps = null; } }
      // 音声が入っていれば、この端末で読める形式になっているか（iPhone の AAC の設定データの問題が起きると読めない）
      if (a) {
        audioCodec = await a.getCodecParameterString().catch(function () { return null; });
        audioOk = await a.canDecode().catch(function () { return false; });
      }
      return {
        size: blob.size, w: v ? v.displayWidth : null, h: v ? v.displayHeight : null,
        fps: fps, audio: a ? a.codec : null, audioCodec: audioCodec, audioOk: audioOk, duration: await input.computeDuration()
      };
    } finally {
      try { input.dispose(); } catch (e) { /* noop */ }
    }
  }
  function describe(info) {
    return info.w + '×' + info.h + '・' + (info.fps ? Math.round(info.fps) + 'fps' : 'fps不明') + '・' + fmtMB(info.size) +
      '・' + info.duration.toFixed(1) + '秒・音声' + (info.audio ? '（' + info.audio + '）' : 'なし');
  }

  // ---------------------------------------------------------------- テストの一覧
  // expect: w,h（解像度）fps audio（true: あるはず / false: ないはず）maxBytes original duration
  var CASES = [
    { title: '720p → 720p（なるべく圧縮）', video: 'v720', query: 'res=720&mode=quality', expect: { w: 1280, h: 720, fps: 30, audio: true } },
    { title: '720p → 2MB以内に圧縮', video: 'v720', query: 'res=720&mode=size&target=2', expect: { w: 1280, h: 720, audio: true, maxBytes: 2 * MB } },
    { title: '音声をオフ', video: 'v720', query: 'res=720&mode=quality&audio=off', expect: { w: 1280, h: 720, audio: false } },
    // 読み込んだ時点で元の動画を渡せるようになる（「圧縮する」は押さない）
    { title: '目標以下なら元の動画をそのまま渡す', video: 'v720', query: 'res=720&mode=size&target=20', noRun: true, expect: { w: 1280, h: 720, original: true } },
    { title: 'トリミング（2〜5秒）', video: 'v720', query: 'res=720&mode=quality', trim: [2, 5], expect: { w: 1280, h: 720, duration: 3 } },
    // 目標に収まるので、再エンコードせずに切り出す（区切りはキーフレームに合わせて広がることがある）
    { title: 'トリミングのみ（再圧縮なし）', video: 'v720', query: 'res=720&mode=size&target=20', trim: [2, 5], expect: { w: 1280, h: 720, trimOnly: true, duration: 3, durationTol: 1.2 } },
    { title: '1080p60 → 720p30', video: 'v1080p60', query: 'res=720&mode=quality', expect: { w: 1280, h: 720, fps: 30, audio: true } },
    { title: '1080p60 → 1080p60（fps そのまま）', video: 'v1080p60', query: 'res=1080&mode=quality&fps=source', expect: { w: 1920, h: 1080, fps: 60, audio: true } },
    { title: '縦長 → 720p', video: 'vVert', query: 'res=720&mode=quality', expect: { w: 720, h: 1280, audio: true } },
    { title: '縦長 → 1080p', video: 'vVert', query: 'res=1080&mode=quality', expect: { w: 1080, h: 1920, audio: true } },
    { title: '小さい動画（拡大しない）', video: 'vSmall', query: 'res=720&mode=quality', expect: { w: 320, h: 240 } },
    { title: 'とても短い動画（0.4秒）', video: 'vShort', query: 'res=720&mode=quality', expect: { w: 1280, h: 720 } },
    // 高速モードで扱えない動画のときに使う、再生しながら処理する方式（音声はアプリが自分で AAC にする）
    { title: '互換モード', video: 'v720', query: 'res=720&mode=quality', compat: true, expect: { w: 1280, h: 720, audio: true } }
  ];

  // ---------------------------------------------------------------- 結果の表示
  var results = [];   // { title, status: ok|ng|warn|run|wait, detail, diag }
  function addResult(title) {
    var r = { title: title, status: 'wait', detail: '', diag: '' };
    results.push(r);
    render();
    return r;
  }
  function render() {
    var ol = $('results');
    ol.innerHTML = '';
    results.forEach(function (r) {
      var li = document.createElement('li');
      li.className = r.status;
      var mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = { ok: '✓', ng: '✗', warn: '!', run: '…', wait: '・' }[r.status];
      li.appendChild(mark);
      li.appendChild(document.createTextNode(r.title));
      if (r.detail) {
        var d = document.createElement('div');
        d.className = 'detail';
        d.textContent = r.detail;
        li.appendChild(d);
      }
      ol.appendChild(li);
    });
    var done = results.filter(function (r) { return r.status === 'ok' || r.status === 'ng' || r.status === 'warn'; });
    var ng = done.filter(function (r) { return r.status === 'ng'; }).length;
    var warn = done.filter(function (r) { return r.status === 'warn'; }).length;
    $('summary').textContent = !results.length ? 'まだ実行していません'
      : done.length + '/' + results.length + ' 件完了：成功 ' + (done.length - ng - warn) + '・失敗 ' + ng + '・注意 ' + warn;
    $('copyBtn').disabled = !done.length;
  }
  function setStatus(text) { $('status').textContent = text; }
  function setNotice(text) { $('notice').textContent = text || ''; $('notice').classList.toggle('hidden', !text); }
  function showDevice() {
    $('device').textContent = (IS_IOS ? 'iPhone / iPad' : IS_ANDROID ? 'Android' : 'PC') + (appVersion ? '・ver=' + appVersion : '') + '・' + UA;
  }

  // ---------------------------------------------------------------- 判定の共通部分
  function secondsSince(t) { return ((Date.now() - t) / 1000).toFixed(1) + '秒'; }
  function errorDetail(e) { return 'エラー: ' + ((e && e.message) || String(e)); }
  function usedCompat(s) { return s.engine === 'compat' || /互換モード/.test(appText('outInfo')); }
  // 失敗として書く（アプリの診断情報も残す）
  function fail(r, detail) {
    r.status = 'ng';
    r.detail = detail;
    try { r.diag = appText('diagOut'); } catch (e) { /* アプリを開く前に失敗したとき */ }
  }
  // 見つかった問題（失敗）と注意をまとめて書く。成功以外は診断情報も残す
  function judge(r, problems, warns) {
    r.status = problems.length ? 'ng' : warns.length ? 'warn' : 'ok';
    if (problems.length || warns.length) r.detail = problems.concat(warns).join('／') + (r.detail ? '（' + r.detail + '）' : '');
    if (r.status !== 'ok') r.diag = appText('diagOut');
  }
  // アプリを開き直して動画を渡す。読み込めなければ失敗と書いて null を返す
  async function openAndPick(query, file, r) {
    r.status = 'run';
    render();
    await openApp(query);
    await pickInApp(file);
    var s = appWin().__compressor.state;
    if (s.meta) return s;
    fail(r, '読み込めない: ' + (s.loadError || appText('planWarn')));
    return null;
  }

  // 1件分を実行して判定する
  async function runCase(c, source, r) {
    var s = await openAndPick(c.query, source.file, r);
    if (!s) return;
    // テスト用の動画の音声をアプリが読めないなら、アプリではなくテスト用の動画の問題
    var badSource = source.audio && s.meta.audio && s.meta.audio.canDecode === false;
    if (c.trim) setTrim(c.trim[0], c.trim[1]);
    if (c.compat) s.engine = 'compat';   // 互換モードを試す（画面からは選べない）
    var t0 = Date.now();
    if (!c.noRun) await runInApp(COMPRESS_TIMEOUT_MS);
    var sec = secondsSince(t0);
    var problems = [], warns = [];
    var out = s.out;
    if (!out) {
      problems.push('圧縮できない: ' + (appText('outWarn') || appText('planWarn') || '（理由不明）'));
    } else {
      var info = await inspect(out.blob);
      r.detail = describe(info) + (c.noRun ? '' : '・' + sec + 'で完了');
      var e = c.expect || {};
      if (e.w && (info.w !== e.w || info.h !== e.h)) problems.push('解像度が ' + info.w + '×' + info.h + '（正しくは ' + e.w + '×' + e.h + '）');
      if (e.fps && !(info.fps && Math.abs(info.fps - e.fps) <= 2)) problems.push('fps が ' + (info.fps ? Math.round(info.fps) : '不明') + '（正しくは ' + e.fps + '）');
      if (e.audio === false && info.audio) problems.push('音声をオフにしたのに音声がある');
      // 元の音声が AAC か、この端末が AAC で書き出せるなら、音声が残るはず
      if (e.audio === true && source.audio && (source.audio === 'AAC' || s.caps.aac) && !info.audio) problems.push('音声が消えた');
      if (e.maxBytes && info.size >= e.maxBytes) problems.push('目標サイズ（' + fmtMB(e.maxBytes) + '）を超えた');
      if (e.original !== undefined && !!out.original !== e.original) problems.push(e.original ? '元の動画のまま渡されなかった' : '元の動画のまま渡された');
      if (info.audio && info.audioOk === false) problems.push('書き出した音声を読めない（' + (info.audioCodec || info.audio) + '）');
      if (e.trimOnly && !/再圧縮なし/.test(appText('outInfo'))) problems.push('トリミングのみにならなかった');
      if (e.duration && Math.abs(info.duration - e.duration) > (e.durationTol || 0.6)) problems.push('長さが ' + info.duration.toFixed(1) + '秒（正しくは約' + e.duration + '秒）');
      if (c.compat && s.engine !== 'compat') problems.push('互換モードにならなかった');
      if (!c.compat && usedCompat(s)) warns.push('互換モードで処理した');
    }
    if (badSource) problems.unshift('テスト用の動画の音声（' + source.audio + '）をアプリが読めない（テスト用の動画の問題）');
    judge(r, problems, warns);
  }

  function setBusy(busy) {
    ['autoBtn', 'switchBtn', 'fileBtn'].forEach(function (id) { $(id).disabled = busy; });
  }

  async function runAll(list, getSource) {
    var rows = list.map(function (c) { return addResult(c.title); });
    for (var i = 0; i < list.length; i++) {
      var r = rows[i];
      try {
        var source = await getSource(list[i]);
        r.title = list[i].title + '（元: ' + source.label + (source.audio ? '・' + source.audio : '・音声なし') + '）';
        setStatus('テスト中 ' + (i + 1) + '/' + list.length + '：' + list[i].title);
        await runCase(list[i], source, r);
      } catch (e) {
        fail(r, errorDetail(e));
      }
      render();
    }
  }

  $('autoBtn').addEventListener('click', async function () {
    setBusy(true);
    setNotice('');
    try {
      await runAll(CASES, function (c) { return makeVideo(c.video); });
      setStatus('自動テストが終わりました');
    } finally {
      setBusy(false);
    }
  });

  // 別のアプリへの切り替え（手で切り替えてもらう）
  $('switchBtn').addEventListener('click', async function () {
    setBusy(true);
    var r = addResult('別のアプリに切り替えても、最後まで圧縮できる');
    try {
      var source = await makeVideo('vLong');
      r.status = 'run';
      render();
      await openApp('res=720&mode=quality');
      await pickInApp(source.file);
      setNotice('圧縮が始まったら、すぐにほかのアプリ（ホーム画面など）に切り替え、10秒ほど待ってから、この画面に戻ってください。');
      setStatus('圧縮中（切り替えて、10秒後に戻ってください）');
      var t0 = Date.now();
      await runInApp(SWITCH_TIMEOUT_MS);
      setNotice('');
      var s = appWin().__compressor.state, diag = appText('diagOut');
      var left = /画面から離れた/.test(diag);
      var retries = (diag.match(/最初からやり直し（/g) || []).length;
      if (s.out) {
        var info = await inspect(s.out.blob);
        r.detail = describe(info) + '・' + secondsSince(t0) + 'で完了' + (retries ? '・最初からやり直し ' + retries + '回' : '');
        if (!left) { r.status = 'warn'; r.detail = '切り替えたことを確認できませんでした（圧縮中に切り替えてください）（' + r.detail + '）'; }
        else if (usedCompat(s)) { r.status = 'warn'; r.detail = '互換モードに切り替わった（' + r.detail + '）'; }
        else r.status = 'ok';
      } else {
        r.status = 'ng';
        r.detail = /タスクキル|開き直して/.test(appText('outWarn')) ? 'デコーダーが固まった（ブラウザの再起動が必要）' : '圧縮できない: ' + appText('outWarn');
      }
      if (r.status !== 'ok') r.diag = diag;
      setStatus('切り替えのテストが終わりました');
    } catch (e) {
      fail(r, errorDetail(e));
      setNotice('');
    } finally {
      render();
      setBusy(false);
    }
  });

  // 手元の動画（iPhone で撮った HEVC・HDR・縦向きなど）
  $('fileBtn').addEventListener('click', function () { $('file').click(); });
  $('file').addEventListener('change', async function (ev) {
    var picked = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!picked) return;
    setBusy(true);
    try {
      // Android の Chrome は、選んだ動画を読む権限を、選んだページ（このページ）にしか与えない。
      // 埋め込んだアプリの側では読めない（NotReadableError）ので、ここで読み込んでから中身を渡す
      var file;
      try {
        setStatus('選んだ動画を読み込んでいます…');
        file = new File([await picked.arrayBuffer()], picked.name, { type: picked.type || 'video/mp4', lastModified: picked.lastModified });
      } catch (e) {
        fail(addResult('手元の動画を読み込む'), '読み込めない: ' + errorDetail(e));
        render();
        setStatus('手元の動画を読み込めませんでした');
        return;
      }
      var source = { file: file, audio: null, label: '手元の動画 ' + fmtMB(file.size) };
      var list = [
        { title: '手元の動画 → 720p', query: 'res=720&mode=quality', limit: 720 },
        { title: '手元の動画 → 1080p', query: 'res=1080&mode=quality', limit: 1080 }
      ];
      var rows = list.map(function (c) { return addResult(c.title); });
      for (var i = 0; i < list.length; i++) {
        var r = rows[i], c = list[i];
        try {
          setStatus('テスト中 ' + (i + 1) + '/' + list.length + '：' + c.title);
          var s = await openAndPick(c.query, file, r);
          if (!s) continue;
          var meta = s.meta;
          r.title = c.title + '（元: ' + meta.width + '×' + meta.height + '・' + (meta.codecString || meta.videoCodec) + (meta.hdr ? '・HDR' : '') + '・' + fmtMB(file.size) + '）';
          await runInApp(COMPRESS_TIMEOUT_MS);
          var problems = [], warns = [];
          if (!s.out) problems.push('圧縮できない: ' + (appText('outWarn') || appText('planWarn')));
          else {
            var info = await inspect(s.out.blob);
            r.detail = describe(info);
            var srcShort = Math.min(meta.width, meta.height), outShort = Math.min(info.w, info.h);
            if ((meta.width >= meta.height) !== (info.w >= info.h)) problems.push('縦横が変わった');
            if (outShort > Math.min(srcShort, c.limit) + 2) problems.push('解像度が大きすぎる');
            if (meta.audio && meta.audio.canDecode !== false && !info.audio && !s.out.original) warns.push('音声が消えた');
            if (usedCompat(s)) warns.push('互換モードで処理した');
          }
          judge(r, problems, warns);
        } catch (e) {
          fail(r, errorDetail(e));
        }
        render();
      }
      setStatus('手元の動画のテストが終わりました');
    } finally {
      setBusy(false);
    }
  });

  // ---------------------------------------------------------------- 結果のコピー
  function resultText() {
    var mark = { ok: '✓', ng: '✗', warn: '!', run: '…', wait: '・' };
    var lines = ['自己テストの結果 ' + new Date().toLocaleString('ja-JP'), $('device').textContent,
      'テスト用の音声のエンコーダーが出したもの: ' + (audioDiag ? audioDiag + ' 最初のデータ=' + audioFirstBytes : '（音声なし）'), $('summary').textContent, ''];
    results.forEach(function (r) {
      lines.push(mark[r.status] + ' ' + r.title + (r.detail ? '\n    ' + r.detail : ''));
    });
    var failed = results.filter(function (r) { return r.diag; });
    failed.forEach(function (r) {
      lines.push('', '--- 診断情報: ' + r.title, r.diag.trim());
    });
    return lines.join('\n');
  }
  $('copyBtn').addEventListener('click', function () {
    var text = resultText();
    var done = function () { setStatus('結果をコピーしました'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* noop */ }
    document.body.removeChild(ta);
  }

  // ---------------------------------------------------------------- 起動
  showDevice();
  if (!M || typeof VideoEncoder === 'undefined') {
    setStatus('この環境では自己テストを実行できません（WebCodecs に対応していません）');
    setBusy(true);
  }
  if (!IS_IOS && !IS_ANDROID) $('switchBtn').textContent = '別のアプリ（タブ）への切り替えを試す';
  window.__selftest = { results: results, resultText: resultText };
})();
