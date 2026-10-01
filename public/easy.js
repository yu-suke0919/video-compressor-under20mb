/*
 * 簡単モード（easy.html）
 * 3つのステップ（1. 圧縮の仕方を選ぶ → 2. 動画を選んでトリミング → 3. 共有・保存）を1つずつ出す。
 * 圧縮そのものは app.js（アプリの画面と同じ）。app.js が画面を出し直すたびに知らせてくる（compressor:update）ので、
 * 今の状態（圧縮中・圧縮後など）に合わせてステップを切り替える。
 */
'use strict';

(function () {
  var C = window.__compressor;
  if (!C) return;
  var $ = function (id) { return document.getElementById(id); };
  var LABELS = { quality: 'なるべく圧縮', size: '画質優先（20MB以内）' };
  var step = 1, preset = null;
  var cancelling = false;   // キャンセルを押した（圧縮が止まったら 2 に戻す）

  function show(el, on) { el.classList.toggle('hidden', !on); }
  function hasError() { return !$('outWarn').classList.contains('hidden') && !C.state.out; }

  function setStep(n) {
    step = n;
    [1, 2, 3].forEach(function (i) { $('step' + i).classList.toggle('is-current', i === n); });
    window.scrollTo(0, 0);
    update();
  }

  // 1. 圧縮の仕方を選んだら、設定を決めて 2 へ
  function choose(name) {
    preset = name;
    C.setEasyPreset(name);
    $('easyModeName').textContent = LABELS[name];
    document.querySelectorAll('.choice').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.preset === name)); });
    setStep(2);
  }

  // 圧縮した動画を消して、トリミングと設定を変えられる状態に戻す
  function redoIfCompressed() { if (C.isCompressed()) C.redo(); }

  // 今の状態に合わせて、ステップと表示を切り替える
  function update() {
    var s = C.state;
    // 圧縮を始めたら 3 へ。キャンセルして止まったら 2 へ戻す
    // （圧縮が終わった直後は、結果を出す前に一度「圧縮中でなく結果もない」状態を通るので、それだけでは戻さない）
    if (s.running && step !== 3) return setStep(3);
    if (cancelling && !s.running) {
      cancelling = false;
      if (!s.out && step === 3) return setStep(2);
    }

    // 手順の帯（今のステップを強調。圧縮中は戻れない）
    document.querySelectorAll('.steps li').forEach(function (li) {
      var i = Number(li.dataset.step);
      li.classList.toggle('is-current', i === step);
      li.classList.toggle('is-done', i < step);
      li.querySelector('button').disabled = s.running || i > step || (i === 2 && !preset);
    });

    // 2. 押せばすぐ出せるとき（予圧縮が使えるとき）は、その大きさを出す。目標以下の動画は、圧縮せずに進める
    var note = preset === 'size' ? $('quickNoteSize') : $('quickNote');
    var quick = !note.classList.contains('hidden') && note.textContent;
    $('easyQuick').textContent = quick || '';
    show($('easyQuick'), !!quick);
    show($('easyPass'), !!(s.out && s.out.original && !s.running));

    // 3. 圧縮中はキャンセル、終わったら共有・保存を目立たせ、やり直す・別の動画のボタンを出す
    var original = !!(s.out && s.out.original);
    $('step3Title').textContent = s.out && !s.running
      ? (original ? '圧縮しなくても送れます。共有・保存してください' : 'できました！共有・保存してください')
      : hasError() ? 'うまく圧縮できませんでした' : '圧縮しています…';
    show($('easyCancel'), s.running);
    show($('easyMore'), !s.running);
  }

  document.querySelectorAll('.choice').forEach(function (b) {
    b.addEventListener('click', function () { choose(b.dataset.preset); });
  });
  document.querySelectorAll('.steps li').forEach(function (li) {
    li.querySelector('button').addEventListener('click', function () {
      var i = Number(li.dataset.step);
      if (C.state.running || i >= step) return;
      redoIfCompressed();
      setStep(i);
    });
  });
  $('easyChange').addEventListener('click', function () { setStep(1); });
  $('easyPass').addEventListener('click', function () { setStep(3); });
  $('easyCancel').addEventListener('click', function () {
    if (!C.state.running) return;
    cancelling = true;
    $('runBtn').click();
  });
  $('easyBack').addEventListener('click', function () { redoIfCompressed(); setStep(2); });
  $('easyAnother').addEventListener('click', function () { $('file').click(); });
  // 動画を選んだら（3 で「別の動画を圧縮する」を選んだときも）2 へ
  $('file').addEventListener('change', function () { if (preset) setStep(2); });
  document.addEventListener('compressor:update', update);
  update();
})();
