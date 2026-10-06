// 20MB圧縮 — 動画をDiscordに投稿できるサイズに圧縮するWebアプリ（入口：画面の配線と起動）
//
// 処理方式は2つ:
//   高速モード … Mediabunny の Conversion で、動画ファイルを直接デコード→再エンコードする（実時間より速い）（fast.js）
//   互換モード … 高速モードで扱えない動画向け。<video> を再生しながら requestVideoFrameCallback で
//                フレームを取り出し、WebCodecs でエンコードして Mediabunny で mp4 にまとめる（compat.js）
//
// 圧縮の方針（解像度は選んだもの（720p / 1080p / 元の解像度）で固定し、ビットレートだけで容量を調整する）:
//   なるべく圧縮 … 解像度ごとの「指定ビットレート」で圧縮する
//   ◯MB以内に圧縮 … 指定ビットレートを下回らない範囲で、目標サイズに収まるなるべく高いビットレートにする。
//                   超えたら実サイズからビットレートを直し、最大2回まで再圧縮（run.js）
//
// すべて端末内で完結し、外部にデータは送信しない。
// モジュールの一覧と役割は README の「コードの構成」を参照

import { APP_VERSION, AUDIO_BITRATE, DEFAULT_MIN_KBPS, DISCORD_FREE_BYTES, MAX_ATTEMPTS, MB, SIZE_SAFETY } from './constants.js';
import { estimateFps, exactCutBytes, makePlan, nextBitrate, preEstimate, snapFps } from './calc.js';
import { $, els } from './dom.js';
import { state } from './state.js';
import { log, setAlert, show, showDiag } from './util.js';
import { cleanText, naming, renderNameList, setNaming } from './naming.js';
import { SAVED_FIELDS, buildUrl, copyText, hasSettingParams, readKbps, readPreUsePct, readSettings, resetSettings, saveSettings } from './settings.js';
import { audioStrategy, checkSupport, detectCaps, isIOS } from './media.js';
import { download, isCompressed, redo, refresh, share } from './view.js';
import { endSeekDrag, followPlayheadSoon, onSeekInput, onSeeked, onTrimInput, renderPlayhead, setupTrimBar } from './trim.js';
import { lastDonePre, pre, stopPre } from './precompress.js';
import { cancelRun, requestWakeLock, run } from './run.js';
import { onFileChosen } from './load.js';
import { resetAdjust, ruleName, setEasyPreset, setupAdjust } from './adjust.js';

setupTrimBar();
// 別のアプリに切り替えると、画面を暗くしない設定は自動で外れる。戻ったときに圧縮中（やり直し中を含む）なら取り直す
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.running) requestWakeLock();
  // 先行圧縮は、画面を離れたら止める（iPhone は裏に回ると読み込み・書き出しを壊す）。戻ったら最初からやり直す
  // （圧縮中に先行圧縮を使っているときは、圧縮の見回りに任せる）
  if (state.running) return;
  if (document.visibilityState !== 'visible') stopPre('画面を離れた');
  else if (state.meta) refresh();
});

// ---------------------------------------------------------------- 配線
els.pickBtn.addEventListener('click', function () { els.file.click(); });
// 3ステップの画面の 2 の解像度・fps・圧縮方法。設定のステップで設定を変えたら、2 で変えた値は戻す（設定のとおりにする）
setupAdjust();
if ($('stepSet')) ['input', 'change'].forEach(function (t) { $('stepSet').addEventListener(t, resetAdjust, true); });
els.repickBtn.addEventListener('click', function () { els.file.click(); });

// 説明書: 開く・閉じる（外側をタップしても閉じる）
function setupHelp() {
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
}
setupHelp();
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
els.srcVideo.addEventListener('playing', followPlayheadSoon);
// seeking: シークの完了を待たずに（大きな動画は時間がかかる）、移動先を表示する
['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'pause', 'ended', 'emptied'].forEach(function (type) {
  els.srcVideo.addEventListener(type, renderPlayhead);
});
els.srcVideo.addEventListener('timeupdate', function () {
  if (state.running || state.busy || !state.meta || els.srcVideo.paused) return;
  if (els.srcVideo.currentTime >= state.trim.end) els.srcVideo.pause();
});

['res480', 'res720', 'res1080', 'resSource', 'modeQuality', 'modeSize', 'halfFps', 'audioOn'].forEach(function (k) {
  els[k].addEventListener('change', refresh);
});
// 設定のステップの fps：「60fpsの動画は30fpsにする」のチェックを変えたことにする（保存も同じ）
['30', '60'].forEach(function (f) {
  var el = $('setFps' + f);
  if (el) el.addEventListener('change', function () {
    els.halfFps.checked = f === '30';
    els.halfFps.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
[els.minRate720, els.minRate1080].forEach(function (el) {
  el.addEventListener('input', refresh);
  el.addEventListener('change', function () {
    el.value = String(readKbps(el, DEFAULT_MIN_KBPS[el === els.minRate720 ? '720' : '1080']));   // 確定したら正規化
    refresh();
  });
});
els.preUse.addEventListener('input', refresh);
els.preUse.addEventListener('change', function () {
  els.preUse.value = String(readPreUsePct());   // 確定したら正規化
  refresh();
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
els.urlCopy.addEventListener('click', function () {
  var url = buildUrl();
  copyText(url, els.urlStatus, 'コピーできませんでした。次のURLを長押ししてコピーしてください: ' + url);
});
els.diagCopy.addEventListener('click', function () {
  copyText(els.diagOut.value, els.diagStatus, 'コピーできませんでした。上の欄を長押ししてコピーしてください。');
});

// ---------------------------------------------------------------- 起動
// 開発ブランチのプレビュー（<ブランチ名>.<プロジェクト名>.pages.dev）では、見出しにサイト名の代わりに版を出す
// （どの版を見ているか分かるように。本番の <プロジェクト名>.pages.dev はサイト名のまま）
function isPreviewHost(host) { return /\.pages\.dev$/.test(host) && host.split('.').length > 3; }
if (isPreviewHost(location.hostname)) {
  var heading = document.querySelector('header h1');
  if (heading) heading.textContent = 'ver ' + APP_VERSION;
}
setupIOSButtons();
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
  state: state, precomp: function () { return { pre: pre, last: lastDonePre }; },
  pickFile: function (file) { onFileChosen(file); },   // 自己テスト（selftest.html）から動画を渡す
  setEasyPreset: setEasyPreset, redo: redo, isCompressed: isCompressed, ruleName: ruleName,   // 3ステップの画面（easy.js）から使う
  urlSettings: hasSettingParams(), isPreviewHost: isPreviewHost,
  constants: {
    SIZE_SAFETY: SIZE_SAFETY, AUDIO_BITRATE: AUDIO_BITRATE, DEFAULT_MIN_KBPS: DEFAULT_MIN_KBPS,
    DISCORD_FREE_BYTES: DISCORD_FREE_BYTES, MAX_ATTEMPTS: MAX_ATTEMPTS, MB: MB
  }
};
