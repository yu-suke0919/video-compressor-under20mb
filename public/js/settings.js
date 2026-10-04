// 設定：画面からの読み取り、設定の一覧（SETTING_DEFS）、保存・読み込み・初期値に戻す、URL の読み取りと作成

import { DEFAULT_MIN_KBPS, DEFAULT_TARGET_MB, MAX_TARGET_MB, MB, MIN_KBPS_LIMITS, MIN_TARGET_MB, PRE_USE_PCT_DEFAULT, PRE_USE_PCT_LIMITS, SETTINGS_KEY } from './constants.js';
import { isSmallSource, onOffWord, resValue } from './calc.js';
import { els } from './dom.js';
import { state } from './state.js';
import { cleanText, naming, renderNameList, resetNaming, setNaming } from './naming.js';
import { isCompressed, refresh } from './view.js';
import { adjust, easyPreset, easyResFixed } from './adjust.js';

// ---------------------------------------------------------------- 設定
function radioValue(name, fallback) {
  var el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : fallback;
}
export function readKbps(input, fallback) {
  var v = parseFloat(input.value);
  if (!isFinite(v)) v = fallback;
  return Math.min(MIN_KBPS_LIMITS[1], Math.max(MIN_KBPS_LIMITS[0], Math.round(v)));
}
// 許容する最小サイズ（目標サイズに対する％）。入力がおかしければ初期値、範囲外なら範囲に収める
export function readPreUsePct() {
  var v = parseFloat(els.preUse.value);
  if (!isFinite(v)) v = PRE_USE_PCT_DEFAULT;
  return Math.min(PRE_USE_PCT_LIMITS[1], Math.max(PRE_USE_PCT_LIMITS[0], Math.round(v)));
}
export function syncResOption() {
  els.res1080.classList.toggle('is-locked', isSmallSource(state.meta));
}
// 目標サイズ（MB）。入力がおかしければ初期値、上限を超えたら上限にする
function readTargetMB() {
  var mb = parseFloat(els.targetSize.value);
  if (!isFinite(mb) || mb < MIN_TARGET_MB) mb = DEFAULT_TARGET_MB;
  return Math.min(mb, MAX_TARGET_MB);
}
export function readSettings() {
  var mb = readTargetMB();
  var s = {
    res: resValue(radioValue('res', '720')),
    mode: radioValue('mode', 'size') === 'quality' ? 'quality' : 'size',
    targetMB: mb,
    // 上限（この値「未満」に収める）。見積もりはこの97%を狙う
    targetBytes: Math.floor(mb * MB),
    // 許容する最小サイズ（目標サイズに対する割合）。「◯MB以内」で、先行圧縮を切り出した大きさがこれ以上なら、そのまま使う
    preUseRatio: readPreUsePct() / 100,
    halfFps: !!els.halfFps.checked,
    audio: !!els.audioOn.checked,
    autoRun: !!els.autoRun.checked,
    // 解像度ごとの下限ビットレート（bps）
    minBitrate: {
      '720': readKbps(els.minRate720, DEFAULT_MIN_KBPS['720']) * 1000,
      '1080': readKbps(els.minRate1080, DEFAULT_MIN_KBPS['1080']) * 1000
    }
  };
  // 480p（3ステップの画面の 2 だけで選べる）は、720p の下限を画素数に比例させる
  s.minBitrate['480'] = Math.round(s.minBitrate['720'] * 4 / 9);
  // 720p・1080p ではない 1080p 以下の動画は元の解像度のまま。2 で変えた値を重ねる
  if (easyResFixed()) s.res = 'source';
  else if (adjust.res) s.res = adjust.res;
  if (s.res === '1080' && isSmallSource(state.meta)) s.res = '720';   // 拡大はしないので、720p として計画する
  if (adjust.halfFps !== null) s.halfFps = adjust.halfFps;
  if (adjust.mode) s.mode = adjust.mode;
  return s;
}
// ---------------------------------------------------------------- 設定の一覧
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
export var SETTING_DEFS = [
  // 解像度（480p・720p・1080p・元の解像度）
  {
    key: 'res', url: 'res', def: '720', ids: ['res480', 'res720', 'res1080', 'resSource'],
    read: function () { return resValue(radioValue('res', '720')); },
    write: function (v) { ({ '480': els.res480, '1080': els.res1080, source: els.resSource }[resValue(v)] || els.res720).checked = true; },
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
  numberSetting('preuse', 'preUse', PRE_USE_PCT_DEFAULT, PRE_USE_PCT_LIMITS[0], PRE_USE_PCT_LIMITS[1], true, readPreUsePct),
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
export var SAVED_FIELDS = SETTING_DEFS.reduce(function (ids, d) { return ids.concat(d.ids); }, []);
export function saveSettings() {
  if (easyPreset !== 'custom') return;   // 2択は保存しない（「詳しく設定する」の設定を変えない）
  var data = {};
  SETTING_DEFS.forEach(function (d) { data[d.key] = d.read(); });
  data.name = { on: naming.on, order: naming.order, enabled: naming.enabled, text1: naming.text.text1, text2: naming.text.text2 };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境では覚えない */ }
}
export function loadSavedSettings() {
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
export function resetSettings() {
  // 圧縮中・圧縮後は、ほかの設定と同じく変えさせない（圧縮中の計画と画面の設定がずれないように）
  if (state.running || isCompressed()) return;
  try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* noop */ }
  SETTING_DEFS.forEach(function (d) { d.write(d.def); });
  resetNaming();
  renderNameList();
  refresh();
}

// ファイル名の設定の URL での名前（name=date,text1,opt と、自由入力の text1=… text2=…）
var SETTING_PARAMS = SETTING_DEFS.map(function (d) { return d.url; }).concat(['name', 'text1', 'text2']);
export function hasSettingParams() {
  try {
    var params = new URLSearchParams(window.location.search);
    return SETTING_PARAMS.some(function (k) { return params.has(k); });
  } catch (e) { return false; }
}
// ショートカットなどから URL で初期値を渡せる（詳細設定の項目も含む）
//   res=720|1080|source  mode=size|quality  target=MB  preuse=%  min720=kbps  min1080=kbps  fps=30|source  auto=on|off  audio=on|off
export function applyUrlParams() {
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

// ---------------------------------------------------------------- URLを作る
// 今の設定を URL パラメータにする（既定値と同じ項目は省く）。ショートカットやブックマーク用
export function buildUrl() {
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
export function copyText(text, status, failMsg) {
  var done = function () { status.textContent = 'コピーしました'; };
  var fallback = function () {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position: fixed; top: 0; left: 0; opacity: 0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    var ok;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    if (ok) done(); else status.textContent = failMsg;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
