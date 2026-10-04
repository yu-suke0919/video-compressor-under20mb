// 3ステップの画面：2択の設定（EASY_PRESETS）と、2 でその動画だけ変える解像度・fps・圧縮方法・ファイル名

import { DEFAULT_FPS, DEFAULT_MIN_KBPS, DEFAULT_TARGET_MB, MB } from './constants.js';
import { isStandardRes, makePlan } from './calc.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { log, show } from './util.js';
import { cleanName, fileBase, randDigits, renderNameList, resetNaming, settingsName } from './naming.js';
import { SETTING_DEFS, applyUrlParams, hasSettingParams, loadSavedSettings, readSettings } from './settings.js';
import { audioStrategy } from './media.js';
import { clearOutput, isCompressed, refresh } from './view.js';

// ---------------------------------------------------------------- 3ステップの画面（index.html。ステップの切り替えは easy.js）
// 設定は3択で決める
//   なるべく圧縮・画質優先 … 決めた設定（EASY_PRESETS）。この端末に保存してある設定は読まず、保存もしない
//   詳しく設定する（custom） … 設定のステップで設定の部品を出し、保存してある設定を読んで、変えたら保存する。
//     URL に設定があれば（ショートカットから開いたときなど）、保存してある設定の代わりに URL の設定を使う
//   720p・1080p ではない 1080p 以下の動画（スマホの画面録画・小さい動画など）は、どれを選んでも元の解像度のまま（解像度は変えられない）。
//   1080p より大きい動画（4K など）は、ほかの動画と同じく解像度を選べる
//   2 で、解像度・fps・圧縮方法をその動画だけ変えられる（adjust。保存しない）
export var easyPreset = null;       // 3ステップの画面で選んだもの（quality・size・custom）
var EASY_PRESETS = {
  // なるべく圧縮：720p・30fps・指定ビットレートは初期値
  quality: { res: '720', mode: 'quality', halfFps: true },
  // 画質優先（20MB以内）：元の画質とfpsのまま、20MB に収まるなるべく高いビットレート
  size: { res: 'source', mode: 'size', halfFps: false }
};

// 3ステップの画面の 2 で変えた値（その動画だけ。新しい動画を選ぶ・1 で選び直す・設定のステップで設定を変えると戻す）
//   res     … 解像度（'1080' | '720' | '480'。null なら設定のまま）
//   halfFps … 60fpsの動画を30fpsにするか（null なら設定のまま）
//   mode    … 圧縮方法（'quality'＝指定ビットレートでなるべく圧縮 | 'size'＝目標サイズに収まるなるべく高いビットレート。null なら設定のまま）
export var adjust = { res: null, halfFps: null, mode: null };
// 2 の設定変更簡易メニューのファイル名（拡張子なし。空ならファイル名の設定どおり）。その動画だけ（新しい動画を選ぶと消す）。
// ファイル名の設定がオン（「詳しく設定する」）なら、手で変えるまでは、設定から作った名前を入れておく
//   （時刻は動画を選んだときのもの。設定を変えたら作り直す）
export var easyName = '', easyNameTouched = false, easyNameAt = null;
export function resetAdjust() { adjust = { res: null, halfFps: null, mode: null }; }
export function resetEasyName() { easyName = ''; easyNameTouched = false; easyNameAt = new Date(); }

// ---------------------------------------------------------------- 3ステップの画面：2 の解像度・fps・圧縮方法（その動画だけ）
// 720p・1080p ではない 1080p 以下の動画は、圧縮の仕方に関係なく元の解像度のまま（解像度は選べない）。
// 1080p より大きい動画（4K など）は、下げられるように固定しない
export function easyResFixed() {
  return !!state.meta && !isStandardRes(state.meta) && Math.min(state.meta.width, state.meta.height) <= 1080 + 8;
}
var ADJ_RES = ['480', '720', '1080', 'source'];
function adjResEl(r) { return $(r === 'source' ? 'adjResSource' : 'adjRes' + r); }
export function updateAdjust(enabled) {
  if (!$('adjBox')) return;
  var hasFile = !!(state.file && state.meta);
  show($('adjMenu'), hasFile);   // 動画を選ぶまでは出さない（出しても、初めは閉じておく）
  var notes = [];
  if (hasFile) {
    var settings = readSettings();
    var short = Math.min(state.meta.width, state.meta.height);
    // 解像度：今の解像度を選んだ状態にし（元の解像度はそのまま。それ以外は元より大きくはしないので、その大きさの段）、
    // 元より大きい解像度は選べなくする
    // 元の動画が 480p・720p・1080p なら「元の解像度」は出さない（その解像度を選ぶのと同じなので）
    var stdSrc = [480, 720, 1080].some(function (l) { return Math.abs(short - l) <= 8; });
    $('adjResSeg').classList.toggle('is-four', !stdSrc);
    $('adjResSeg').classList.toggle('is-three', stdSrc);
    show($('adjResSource'), !stdSrc);
    show(document.querySelector('label[for="adjResSource"]'), !stdSrc);
    var pick = settings.res === 'source' && !stdSrc ? 'source' : (function () {
      var cur = settings.res === 'source' ? short : Math.min(Number(settings.res) || 720, short);
      return ['480', '720', '1080'].reduce(function (a, r) { return Math.abs(Number(r) - cur) < Math.abs(Number(a) - cur) ? r : a; }, '720');
    })();
    ADJ_RES.forEach(function (r) {
      var el = adjResEl(r), over = r !== 'source' && Number(r) > short + 8;
      el.checked = r === pick;
      el.classList.toggle('is-locked', over && enabled);
      el.disabled = !enabled || over;
    });
    show($('adjResSeg'), !easyResFixed());
    // fps：30fps にできるのは 60fps などの動画だけ（それ以外は元の fps のまま）
    var high = (state.meta.fps || DEFAULT_FPS) > 40;
    $('adjFps30').checked = !high || settings.halfFps;
    $('adjFps60').checked = high && !settings.halfFps;
    $('adjFps30').disabled = !enabled || !high;
    $('adjFps60').disabled = !enabled || !high;
    $('adjFps60').classList.toggle('is-locked', !high && enabled);
    $('adjFps30').classList.toggle('is-locked', !high && enabled);
    // 圧縮方法：なるべく圧縮（指定ビットレート）・◯MB以内に圧縮（目標サイズに収まるなるべく高いビットレート）
    $('adjModeQuality').checked = settings.mode === 'quality';
    $('adjModeSize').checked = settings.mode === 'size';
    $('adjModeQuality').disabled = $('adjModeSize').disabled = !enabled;
    $('adjSizeLabel').textContent = String(settings.targetMB);
    // ファイル名（手で変えるまでは、ファイル名の設定から作った名前。入力中は書き換えない）
    if (!easyNameTouched) {
      easyName = settingsName({ kind: 'compressed', now: easyNameAt || new Date(), rand: state.nameRand || randDigits(), base: fileBase(), settings: settings }) || '';
    }
    var nameEl = $('adjName');
    if (document.activeElement !== nameEl) nameEl.value = easyName;
    nameEl.disabled = !enabled;
    if (easyResFixed()) notes.push('720p・1080pではない動画のため、そのままの解像度（' + state.meta.width + '×' + state.meta.height + '）で圧縮します。');
  }
  $('adjNote').textContent = notes.join('\n');
  show($('adjNote'), !!notes.length);
  $('resFixedNote').textContent = easyResFixed() ? notes[0] : '';
  show($('resFixedNote'), easyResFixed());
}
function adjustable() { return !!state.meta && !state.running && !state.busy && !isCompressed(); }
function logAdjust(what) {
  log('2 で変更 ' + what + '（解像度 ' + (adjust.res || '設定のまま') + '・fps ' + (adjust.halfFps === null ? '設定のまま' : adjust.halfFps ? '30' : '元のまま') +
    '・圧縮方法 ' + (adjust.mode || '設定のまま') + '）');
}
export function setupAdjust() {
  if (!$('adjBox')) return;
  ADJ_RES.forEach(function (r) {
    adjResEl(r).addEventListener('change', function () {
      if (!adjustable()) return;
      adjust.res = r;
      logAdjust('解像度');
      refresh();
    });
  });
  ['30', '60'].forEach(function (f) {
    $('adjFps' + f).addEventListener('change', function () {
      if (!adjustable()) return;
      adjust.halfFps = f === '30';
      logAdjust('fps');
      refresh();
    });
  });
  // ファイル名：入れたら、その名前.mp4 で書き出す（元の動画のまま渡すときは、拡張子は元のまま）
  $('adjName').addEventListener('input', function () {
    easyName = $('adjName').value;
    easyNameTouched = true;
    refresh();
  });
  // 入れた名前は記録しない（診断情報に名前を入れないため）
  $('adjName').addEventListener('change', function () { log('2 で変更 ファイル名（' + (cleanName(easyName) ? '入力あり' : '空欄') + '）'); });
  [['adjModeQuality', 'quality'], ['adjModeSize', 'size']].forEach(function (m) {
    $(m[0]).addEventListener('change', function () {
      if (!adjustable()) return;
      adjust.mode = m[1];
      logAdjust('圧縮方法');
      refresh();
    });
  });
}

// 圧縮ルールの名前（2 に出す）。圧縮ルールは設定のテンプレート（なるべく圧縮・画質優先）として扱い、
// 今の設定（2 で変えた値を含む）がテンプレートと同じならその名前、違えば「カスタム」にする（「詳しく設定する」で選んだときも同じ）。
// 動画を選んでいれば、書き出す動画が同じになるか（解像度・fps・圧縮方法・ビットレート・目標サイズ・音声）で比べる
// （1080p の動画の「元の解像度」と「1080p」、30fps の動画の「60fpsを30fpsにする」のあり・なしなどは同じとみる）
var RULE_NAMES = { quality: 'なるべく圧縮', size: '画質優先（20MB以内）' };
var RULE_CUSTOM = 'カスタム';
function templateSettings(name) {
  var p = EASY_PRESETS[name];
  var s = {
    res: easyResFixed() ? 'source' : p.res, mode: p.mode, halfFps: p.halfFps, audio: true, autoRun: false,
    targetMB: DEFAULT_TARGET_MB, targetBytes: Math.floor(DEFAULT_TARGET_MB * MB),
    minBitrate: { '720': DEFAULT_MIN_KBPS['720'] * 1000, '1080': DEFAULT_MIN_KBPS['1080'] * 1000 }
  };
  s.minBitrate['480'] = Math.round(s.minBitrate['720'] * 4 / 9);
  return s;
}
function sameRule(a, b) {
  if (a.mode !== b.mode || a.audio !== b.audio || (a.mode === 'size' && a.targetBytes !== b.targetBytes)) return false;
  if (!state.meta || !state.file) {
    return a.res === b.res && a.halfFps === b.halfFps &&
      a.minBitrate['720'] === b.minBitrate['720'] && a.minBitrate['1080'] === b.minBitrate['1080'];
  }
  var plan = function (s) { return makePlan(state.meta, state.trim, s, audioStrategy(state.meta, s.audio, state.engine), state.file.size); };
  var pa = plan(a), pb = plan(b);
  return pa.width === pb.width && pa.height === pb.height && Math.round(pa.outFps) === Math.round(pb.outFps) &&
    pa.videoBitrate === pb.videoBitrate && pa.floorBitrate === pb.floorBitrate && pa.audio.mode === pb.audio.mode;
}
export function ruleName() {
  var cur = readSettings();
  // 動画を選ぶ前は、選んでいる解像度で比べる（「元の解像度」は、出せない動画のあいだ画面では 1080p を選んだ状態にしてあるため）
  if (!state.meta && !adjust.res) cur.res = SETTING_DEFS.filter(function (d) { return d.key === 'res'; })[0].read();
  for (var k in RULE_NAMES) if (sameRule(cur, templateSettings(k))) return RULE_NAMES[k];
  return RULE_CUSTOM;
}

// 3ステップの画面で選ぶ。圧縮した動画があれば消す
//   2択 … 初期値の設定に、選んだ方の設定を重ねる。custom … 初期値に保存してある設定を重ねる（アプリの画面と同じ）
export function setEasyPreset(name) {
  var p = EASY_PRESETS[name];
  if ((!p && name !== 'custom') || state.running) return;
  if (isCompressed()) clearOutput();
  easyPreset = name;
  resetAdjust();
  SETTING_DEFS.forEach(function (d) { d.write(p && d.key in p ? p[d.key] : d.def); });
  resetNaming();
  if (name === 'custom') {
    if (hasSettingParams()) applyUrlParams(); else loadSavedSettings();
  }
  renderNameList();
  log('3ステップの画面 ' + name);
  refresh();
}
