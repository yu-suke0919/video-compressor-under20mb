// 画面の出し直し（予想の行・注意・ボタン）、圧縮結果の表示、共有・保存

import { DISCORD_FREE_BYTES, MB, MSG_DEVICE_FLOOR, MSG_LOCATION, MSG_OVER_DISCORD, MSG_OVER_HINT, MSG_UNREACHABLE, MSG_UNREACHABLE_FLOOR, SIZE_SAFETY, SMALL_RESULT_RATIO } from './constants.js';
import { fitSecOf, fmtBytes, fmtDuration, fmtFps, fmtRate, isOverTarget, isSmallSource, preKey } from './calc.js';
import { $, els } from './dom.js';
import { state } from './state.js';
import { log, setAlert, show } from './util.js';
import { customName, fileBase, passthroughName, randDigits, updateNamePreview } from './naming.js';
import { readSettings, syncResOption } from './settings.js';
import { errorLines, isWebKit } from './media.js';
import { currentPlan, isFullTrim } from './plan.js';
import { planParts, showPlanText, showPrecompressHints } from './estimate.js';
import { copyLabel, isFullTrimOf, trimOnlyEstimate } from './fast.js';
import { blobDuration, pre, prePlan, scheduleProbe } from './precompress.js';
import { easyResFixed, updateAdjust } from './adjust.js';

// ---------------------------------------------------------------- 表示の更新
// 圧縮前は元動画を大きく、圧縮が終わったら圧縮後の動画を大きく表示する。
// 元のまま共有できる（圧縮不要）ときや、圧縮し直している間は、元動画を大きくする
export function updateMediaLayout() {
  var done = isCompressed();
  els.srcBox.classList.toggle('is-large', !done);
  els.srcBox.classList.toggle('is-small', done);
  els.outBox.classList.toggle('is-large', done);
  els.outBox.classList.toggle('is-small', !done);
}

// 画面を出し直し、3ステップの画面（easy.js）にも知らせる（ステップの切り替えに使う）
export function refresh() {
  refreshUi();
  notifyUpdate();
}
// 3ステップの画面（easy.js）に、表示が変わったことを知らせる（エラーを出したあとなど、画面を出し直さないときも）
export function notifyUpdate() {
  try { document.dispatchEvent(new CustomEvent('compressor:update')); } catch (e) { /* noop */ }
}
export function refreshUi() {
  updateMediaLayout();
  syncResOption();
  var s = readSettings();
  els.sizeLabel.textContent = String(s.targetMB);
  // 狙うサイズは丸めずに見せる（例: 50MB → 48.5 MB、33MB → 32.01 MB）
  els.capLabel.textContent = String(Math.round(s.targetBytes * SIZE_SAFETY / MB * 100) / 100) + ' MB';
  els.preUseLabel.textContent = String(Math.round(s.targetBytes * s.preUseRatio / MB * 100) / 100) + ' MB';
  var hasFile = !!(state.file && state.meta);
  var locked = state.running || state.busy;
  // 圧縮が終わったら「やり直す」を押すまで、トリミングと設定を変えられないようにする
  var done = isCompressed();

  [els.trimStart, els.trimEnd].forEach(function (el) { el.disabled = !hasFile || locked || done; });
  // シークバーは圧縮後も元動画の確認に使えるようにする（圧縮中だけ止める）
  els.trimSeek.disabled = !hasFile || locked;
  [els.res720, els.res1080, els.resSource, els.modeQuality, els.modeSize, els.targetSize, els.preUse, els.halfFps, els.audioOn,
    els.minRate720, els.minRate1080, els.autoRun, els.nameOn, els.resetSettings].forEach(function (el) { el.disabled = state.running || done; });
  if (isSmallSource(state.meta)) els.res1080.disabled = true;   // 720p以下の動画は 1080p を選べない
  if (els.res480) els.res480.disabled = state.running || done;
  if (easyResFixed()) [els.res480, els.res720, els.res1080, els.resSource].forEach(function (el) { el.disabled = true; });
  // 設定のステップの fps（「60fpsの動画は30fpsにする」のチェックと同じ）
  if ($('fpsSeg')) {
    $('setFps30').checked = els.halfFps.checked;
    $('setFps60').checked = !els.halfFps.checked;
    $('setFps30').disabled = $('setFps60').disabled = state.running || done;
  }
  Array.prototype.forEach.call(els.nameList.querySelectorAll('input, button'), function (el) {
    el.disabled = state.running || done || (el.dataset.move === 'up' && !el.parentNode.previousSibling) ||
      (el.dataset.move === 'down' && !el.parentNode.nextSibling);
  });
  updateNamePreview();
  els.repickBtn.disabled = locked;
  // 文字が変わるときだけ書き直す（押している途中で中身を作り直すと、押したことにならないため）
  var runLabel = state.running ? 'キャンセル' : done ? 'やり直す' : '圧縮する';
  if (els.runBtn.dataset.label !== runLabel) {
    els.runBtn.textContent = runLabel;
    els.runBtn.dataset.label = runLabel;
  }

  if (!hasFile) {
    showPrecompressHints(null);
    els.runBtn.disabled = !state.running;
    els.planInfo.textContent = '';
    // 読み込みに失敗したときは、その理由を出したままにする
    setAlert(els.planWarn, state.loadError ? errorLines(state.loadError) : [], true);
    updateAdjust(false);
    return;
  }

  var plan = state.plan = currentPlan();
  updateAdjust(!locked && !done);
  scheduleProbe();
  showPrecompressHints(plan);
  els.audioLabel.textContent = '音声を残す（' + plan.audio.label + '）';
  var trimEst = trimOnlyEstimate(plan);
  showPlanText(planParts(plan, trimEst));

  var warns = [];
  // 目標サイズに収まらない見込みなら、1つの案内にまとめる（目安の秒数は予想の行・トリミングの帯と同じ計算）
  var over = isOverTarget(plan, trimEst);
  if (over) {
    warns.push(plan.targetMB + 'MBに収まらない可能性があります（目安は約' + fmtDuration(fitSecOf(plan)) + 'まで）。');
    warns.push(MSG_OVER_HINT);
  }
  if (plan.deviceFloor && !trimEst) warns.push(MSG_DEVICE_FLOOR);   // 指定ビットレートを下げても、先行圧縮の大きさが変わらなかった
  if (plan.audio.note) warns.push(plan.audio.note);   // 音声を残せないとき（圧縮する前に知らせる）
  if (state.meta.hasLocation === true) warns.push(MSG_LOCATION);
  // 目標サイズ（20MBより大きくしたとき）には収まるが、Discord の無料アカウントの上限を超えるとき
  if (!over && (trimEst ? trimEst > DISCORD_FREE_BYTES : plan.overDiscord)) warns.push(MSG_OVER_DISCORD);
  setAlert(els.planWarn, warns);

  // 目標サイズを超えるのが分かっているときは実行させない（処理中はキャンセル、圧縮後はやり直すボタンなので有効のまま）
  // （再圧縮では収まらなくても、トリミングのみ（再圧縮なし）で収まる見込みなら実行できる）
  els.runBtn.disabled = !state.running && !done && (state.busy || (plan.mode === 'size' && plan.unreachable && !trimEst));

  updatePassthrough(s);
}

// 元の動画から取り除く必要があるもの（元の動画をそのまま渡してはいけない理由）
//   location … 位置情報が入っている、または入っているか分からない
//   audio    … 「音声を残す」がオフなのに、元の動画に音声が入っている（または入っているか分からない）
export function stripNeeds(settings) {
  var meta = state.meta || {};
  return { location: meta.hasLocation !== false, audio: !settings.audio && meta.audio !== null };
}
// すでに目標サイズ以下なら、圧縮せずそのまま共有・保存できるようにする
export function updatePassthrough(settings) {
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
    setAlert(els.outWarn, []);
  } else if (!canPass && state.out && state.out.original) {
    clearOutput();
  }
}

// ---------------------------------------------------------------- 結果
export function setOutput(out) {
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
export function isCompressed() {
  return !!(state.out && !state.out.original) && !state.running;
}
// やり直す: 圧縮した動画を消して、トリミングと設定を変えられる状態に戻す
export function redo() {
  log('やり直す');
  clearOutput();
  refresh();
}

export function clearOutput() {
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

// 今の動画の先行圧縮で、この端末ではそれ以上ビットレートを下げられないと分かっているか
export function deviceFloorKnown(plan) {
  return !!(pre && pre.file === state.file && pre.floorHit && pre.key === preKey(prePlan(plan)));
}
export function showResult(res, plan, engine, elapsed) {
  var base = fileBase();
  var kind = !res.trimOnly ? 'compressed' : isFullTrimOf(plan) ? 'copy' : 'trimmed';
  var suffix = kind === 'compressed' ? '_compressed' : kind === 'trimmed' ? '_trimmed' : '';
  var name = customName({ kind: kind, now: new Date(), rand: randDigits(), base: base, settings: plan }) || base + suffix;
  setOutput({ blob: res.blob, name: name + '.mp4', type: 'video/mp4', original: false });

  var size = res.blob.size;
  var ratio = state.file.size > 0 ? Math.round((1 - size / state.file.size) * 100) : 0;
  // 圧縮結果は2行：1行目は書き出した動画（解像度/fps/長さ/ビットレート/VBR・CBR/圧縮時間）、2行目は大きさの変化（大きく出す）
  //   ビットレートは、書き出した大きさと長さから求めた実際の値（音声の分を引く）
  function info(duration) {
    var parts = [plan.width + '×' + plan.height, fmtFps(plan.outFps), fmtDuration(duration)];
    if (res.trimOnly) {
      parts.push(copyLabel(plan) + '（再圧縮なし）');
      if (res.audioDropped) parts.push('音声なし');
    } else {
      parts.push(fmtRate(Math.max(0, size * 8 / duration - plan.audioBitrate)));
      // Safari（WebKit）は CBR/VBR の指定をエンコーダに渡さないので、表示しない
      if (res.rateMode && !isWebKit()) parts.push(res.rateMode === 'variable' ? 'VBR' : 'CBR');
      if (res.attempts > 1) parts.push(res.attempts + '回で調整');
      if (plan.audio.mode === 'none' && plan.wantAudio) parts.push('音声なし');
      if (engine === 'compat') parts.push('互換モード');
    }
    parts.push('圧縮時間' + fmtDuration(elapsed));
    return parts.join('/');
  }
  function showInfo(duration) {
    els.outInfo.textContent = info(duration) + '\n';
    var big = document.createElement('span');
    // 目標サイズに収まれば緑、超えればオレンジ（2 の予想の大きさと同じ）
    big.className = 'out-size ' + (size < plan.targetBytes ? 'is-fit' : 'is-over');
    big.textContent = fmtBytes(state.file.size) + ' → ' + fmtBytes(size) + '（' + (ratio >= 0 ? '-' : '+') + Math.abs(ratio) + '%）';
    els.outInfo.appendChild(big);
  }
  // まず範囲の長さで出し、書き出した動画の長さが分かったら出し直す（コマの区切りの分、範囲の長さとわずかに違うことがある）
  showInfo(plan.duration);
  var out = state.out;
  blobDuration(res.blob).then(function (d) {
    if (state.out === out && d > 0) showInfo(d);
  }, function () { /* 範囲の長さのまま */ });
  if (res.trimOnly) {
    setAlert(els.outWarn, []);
    return;
  }

  // 目標よりかなり小さく仕上がったときは、そのわけを出す（悪いことではないので、注意ではなく補足として）
  var small = plan.mode === 'size' && size <= plan.targetBytes * SMALL_RESULT_RATIO;
  els.outNote.textContent = small ? 'これ以上大きくしても画質はほぼ上がらないため、' + fmtBytes(size).replace(' ', '') + 'に抑えました。' : '';
  show(els.outNote, small);

  var warns = [];
  if (plan.mode === 'size' && size >= plan.targetBytes) {
    // 圧縮し直しても小さくならなかった・先行圧縮で下げても小さくならなかったなら、下げる案内はしない
    warns.push(res.deviceFloor || deviceFloorKnown(plan) ? MSG_UNREACHABLE_FLOOR : MSG_UNREACHABLE);
  }
  if (plan.audio.afterFailure && plan.audio.note) warns.push(plan.audio.note);
  setAlert(els.outWarn, warns);
}

// ---------------------------------------------------------------- 共有・保存
export function outFile() {
  return new File([state.out.blob], state.out.name, { type: state.out.type || 'video/mp4' });
}

export function share() {
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

export function showShareProblem(message) {
  console.warn(message);
  setAlert(els.outWarn, [message], true);
}

export function download() {
  if (!state.out) return;
  var a = document.createElement('a');
  a.href = state.out.url;
  a.download = state.out.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
