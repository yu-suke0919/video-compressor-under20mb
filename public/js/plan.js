// 圧縮の計画（解像度・fps・ビットレート・見込みのサイズ）と、圧縮し直すときのビットレート

import { makePlan } from './calc.js';
import { state } from './state.js';
import { readSettings } from './settings.js';
import { audioStrategy } from './media.js';
import { withEstimate } from './estimate.js';

// ---------------------------------------------------------------- 圧縮プラン

// 範囲が動画の全体か（ほんの少し（0.05秒以内）ずれているだけなら全体とみなす）
export var FULL_RANGE_MARGIN = 0.05;
export function isFullRange(start, end) {
  if (!state.meta) return true;
  return start <= FULL_RANGE_MARGIN && end >= state.meta.duration - FULL_RANGE_MARGIN;
}
export function isFullTrim() { return isFullRange(state.trim.start, state.trim.end); }

// mode … 画面で選んだモードの代わりに使うモード（省略時は画面のとおり）
export function currentPlan(mode) {
  var settings = readSettings();
  if (mode) settings.mode = mode;
  var audio = audioStrategy(state.meta, settings.audio, state.engine);
  // 先行圧縮の予想があれば当てはめる
  return withEstimate(makePlan(state.meta, state.trim, settings, audio, state.file.size));
}
