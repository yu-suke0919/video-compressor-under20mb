// 書き出す動画のファイル名（ファイル名の設定・組み立て・2 のファイル名）

import { els } from './dom.js';
import { state } from './state.js';
import { show } from './util.js';
import { readSettings } from './settings.js';
import { easyName, easyNameTouched } from './adjust.js';

// ---------------------------------------------------------------- 書き出す動画のファイル名
// 詳細設定でオンにすると、選んだ項目を選んだ順に「_」でつないだ名前にする（全部オフなら、元の名前に _compressed などを付けた名前）
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
export var naming = defaultNaming();
export function resetNaming() { naming = defaultNaming(); }
// ファイル名に使えない記号・制御文字を外し、長さをそろえる
export function cleanName(v, max) {
  // eslint-disable-next-line no-control-regex -- 制御文字（\u0000-\u001f）を外すため
  var t = String(v || '').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return Array.from(t).slice(0, max || NAME_ORIG_MAX).join('').trim();   // 文字単位で数える
}
// 自由入力は文字（ひらがな・カタカナ・漢字・英字）と数字、「-」「_」だけにする（絵文字・記号・空白は外す）
export function cleanText(v) {
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
export function randDigits() {
  var v = new Uint32Array(4), out = '';
  try { crypto.getRandomValues(v); } catch (e) { for (var j = 0; j < 4; j++) v[j] = Math.floor(Math.random() * 1e9); }
  for (var i = 0; i < 4; i++) out += RAND_CHARS.charAt(v[i] % RAND_CHARS.length);
  return out;
}
// 並び順と使う項目を整える（知らない項目は捨て、日付と日付+時間はどちらか1つ）
export function setNaming(on, enabledKeys, orderKeys) {
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
    return (s.res === 'source' ? '元解像度' : s.res + 'p') + '_' + (s.mode === 'quality' ? 'narubeku' : s.targetMB + 'MB');
  }
  if (key === 'orig') return cleanName(ctx.base);
  return '';
}
// 指定した名前（拡張子なし）。オフのとき・使う項目がないときは null（元の名前に _compressed などを付ける）
export function customName(ctx) {
  // 2 のファイル名の欄に入れた名前をそのまま使う（日付などは付けない）。
  // 空なら元の動画の名前（_compressed なども付けない）
  // （手で変えていなければ、ファイル名の設定から作り直す。トリミングのみなど、書き出し方に合った名前にするため）
  if (easyNameTouched) {
    var typed = limitBytes(cleanName(easyName, NAME_MAX_BYTES));
    if (typed) return typed;
  } else {
    var fromSettings = settingsName(ctx);
    if (fromSettings) return fromSettings;
  }
  return limitBytes(cleanName(ctx.base)) || null;
}
// ファイル名の設定から作る名前
export function settingsName(ctx) {
  if (!naming.on) return null;
  var parts = naming.order.filter(function (k) { return naming.enabled.indexOf(k) >= 0; })
    .map(function (k) { return namePart(k, ctx); })
    .filter(function (v) { return v; });
  return parts.length ? limitBytes(parts.join('_')) : null;
}
export function fileBase() { return String((state.file && state.file.name) || 'video').replace(/\.[^.]+$/, '') || 'video'; }
// 元の動画のまま渡すときの名前（拡張子は元のまま）
export function passthroughName() {
  var m = /\.[^.]+$/.exec((state.file && state.file.name) || '');
  var name = customName({ kind: 'original', now: new Date(), rand: state.nameRand || randDigits(), base: fileBase(), settings: readSettings() });
  return name ? name + (m ? m[0] : '.mp4') : ((state.file && state.file.name) || 'video.mp4');
}
// 詳細設定の項目の行を作り直す
export function renderNameList() {
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
export function updateNamePreview() {
  var name = customName({ kind: 'compressed', now: new Date(), rand: previewRand, base: state.file ? fileBase() : 'IMG_1234', settings: readSettings() });
  els.namePreview.textContent = name ? name + '.mp4' : '（項目がないので今までの名前）' + (state.file ? fileBase() : 'IMG_1234') + '_compressed.mp4';
}
