/*
 * 3ステップの画面（index.html）
 * ステップ（1. 圧縮の仕方を選ぶ →（「詳しく設定する」なら 設定）→ 2. 動画を選んでトリミング → 3. 共有・保存）を1つずつ出す。
 * 圧縮そのものは app.js（従来の画面 old.html と同じ）。app.js が画面を出し直すたびに知らせてくる（compressor:update）ので、
 * 今の状態（圧縮中・圧縮後など）に合わせてステップを切り替える。
 */
'use strict';

(function () {
  var C = window.__compressor;
  if (!C) return;
  var $ = function (id) { return document.getElementById(id); };
  // ステップの順番（set … 「詳しく設定する」のときだけ通る設定のステップ）と、その画面の id
  var ORDER = ['1', 'set', '2', '3'];
  var SECTION = { '1': 'step1', set: 'stepSet', '2': 'step2', '3': 'step3' };
  var step = '1', preset = null;
  var cancelling = false;   // キャンセルを押した（圧縮が止まったら 2 に戻す）

  function show(el, on) { el.classList.toggle('hidden', !on); }
  function hasError() { return !$('outWarn').classList.contains('hidden') && !C.state.out; }
  function pos(k) { return ORDER.indexOf(k); }

  function setStep(k) {
    step = k;
    ORDER.forEach(function (i) { $(SECTION[i]).classList.toggle('is-current', i === k); });
    window.scrollTo(0, 0);
    update();
  }

  // 1. 圧縮の仕方を選んだら、その設定にして、「詳しく設定する」なら設定のステップへ（skipSet なら飛ばす）、2択なら 2 へ
  function choose(name, skipSet) {
    preset = name;
    C.setEasyPreset(name);
    document.querySelectorAll('.choice').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.preset === name)); });
    setStep(name === 'custom' && !skipSet ? 'set' : '2');
  }

  // 圧縮した動画を消して、トリミングと設定を変えられる状態に戻す
  function redoIfCompressed() { if (C.isCompressed()) C.redo(); }

  // 今の状態に合わせて、ステップと表示を切り替える
  function update() {
    var s = C.state;
    // 圧縮を始めたら 3 へ。キャンセルして止まったら 2 へ戻す
    // （圧縮が終わった直後は、結果を出す前に一度「圧縮中でなく結果もない」状態を通るので、それだけでは戻さない）
    if (s.running && step !== '3') return setStep('3');
    if (cancelling && !s.running) {
      cancelling = false;
      if (!s.out && step === '3') return setStep('2');
    }

    // 手順の帯（今のステップを強調。設定のステップは「詳しく設定する」のときだけ。圧縮中は戻れない）。番号は出ている順に振る
    var n = 0;
    document.querySelectorAll('.steps li').forEach(function (li) {
      var k = li.dataset.step;
      var on = k !== 'set' || preset === 'custom';
      show(li, on);
      if (on) li.querySelector('b').textContent = String(++n);
      li.classList.toggle('is-current', k === step);
      li.classList.toggle('is-done', pos(k) < pos(step));
      li.querySelector('button').disabled = s.running || pos(k) > pos(step) || (k !== '1' && !preset);
    });

    // 2. 圧縮ルールの名前（今の設定がテンプレートと同じならその名前、違えば「カスタム」）
    $('easyModeName').textContent = preset ? C.ruleName() : '';

    // 2. 押せばすぐ出せるとき（先行圧縮が使えるとき）は、その大きさを出す。目標以下の動画は、圧縮せずに進める
    var note = C.readSettings().mode === 'size' ? $('quickNoteSize') : $('quickNote');
    // 「圧縮する」の2行目に出す（ボタンの文字は app.js が画面を出し直すたびに書き直すので、そのたびに足す）
    var quick = !note.classList.contains('hidden') && note.textContent;
    var run = $('runBtn');
    if (quick && !s.running && run.textContent === '圧縮する') {
      var main = document.createElement('span'), sub = document.createElement('span');
      main.textContent = '圧縮する';
      sub.id = 'easyQuick';
      sub.className = 'run-sub';
      sub.textContent = '（' + quick.replace(/するよ$/, 'します') + '）';
      run.textContent = '';
      run.appendChild(main);
      run.appendChild(sub);
    }
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
      var k = li.dataset.step;
      if (C.state.running || pos(k) >= pos(step)) return;
      redoIfCompressed();
      setStep(k);
    });
  });
  $('easySetNext').addEventListener('click', function () { setStep('2'); });
  // 2 の「← 戻る」：「詳しく設定する」なら設定のステップへ、2択なら 1 へ
  $('easyChange').addEventListener('click', function () { setStep(preset === 'custom' ? 'set' : '1'); });
  $('easyPass').addEventListener('click', function () { setStep('3'); });
  $('easyCancel').addEventListener('click', function () {
    if (!C.state.running) return;
    cancelling = true;
    $('runBtn').click();
  });
  $('easyBack').addEventListener('click', function () { redoIfCompressed(); setStep('2'); });
  $('easyAnother').addEventListener('click', function () { $('file').click(); });
  // 動画を選んだら（3 で「別の動画を圧縮する」を選んだときも）2 へ
  $('file').addEventListener('change', function () { if (preset) setStep('2'); });
  document.addEventListener('compressor:update', update);
  // URL に設定があれば（ショートカットから開いたときなど）、その設定の「詳しく設定する」にして、すぐ動画を選べるようにする
  if (C.urlSettings) choose('custom', true);
  else update();
})();
