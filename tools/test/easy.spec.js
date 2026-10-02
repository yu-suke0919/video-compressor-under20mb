// アプリの画面（index.html・3ステップ）：1. 圧縮の仕方を選ぶ → 2. 動画を選んでトリミング → 3. 共有・保存
// （従来の画面 old.html のテストは、ほかのファイルで helpers の open を使う）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, setTrim, outputInfo } = require('./helpers');

// 3ステップの画面を開き、端末の対応状況を調べ終わるまで待つ（先行圧縮は probe= を指定したとき以外は止める）
async function openEasy(page, query = '?probe=off') {
  await page.goto('/' + query);
  await page.waitForFunction(() => /対応 VideoEncoder=/.test(document.getElementById('diagOut').value));
}
const currentStep = page => page.evaluate(() => ['step1', 'stepSet', 'step2', 'step3'].filter(id => document.getElementById(id).classList.contains('is-current')));
const settings = page => page.evaluate(() => window.__compressor.readSettings());
const plan = page => page.evaluate(() => { const p = window.__compressor.state.plan; return { w: p.width, h: p.height, fps: Math.round(p.outFps), mode: p.mode, bps: p.videoBitrate }; });
async function compressEasy(page) {
  await page.click('#runBtn');
  await page.waitForFunction(() => !window.__compressor.state.running, null, { timeout: 5 * 60 * 1000 });
}

test('なるべく圧縮：720p・30fps・指定ビットレートの初期値で圧縮し、3 で共有・保存を出す', async ({ page }) => {
  await openEasy(page);
  expect(await currentStep(page)).toEqual(['step1']);
  expect(await page.isVisible('#pickBtn')).toBe(false);   // 先に圧縮の仕方を選ぶ
  await page.click('.choice[data-preset="quality"]');
  expect(await currentStep(page)).toEqual(['step2']);
  expect(await page.textContent('#easyModeName')).toBe('なるべく圧縮');
  const s = await settings(page);
  expect([s.res, s.mode, s.halfFps, s.minBitrate['720'], s.targetMB]).toEqual(['720', 'quality', true, 1200000, 20]);

  await pick(page, '1080p60-45s.mp4');
  expect(await plan(page)).toEqual({ w: 1280, h: 720, fps: 30, mode: 'quality', bps: 1200000 });
  await setTrim(page, 0, 5);
  await compressEasy(page);
  expect(await currentStep(page)).toEqual(['step3']);
  expect(await page.textContent('#step3Title')).toBe('できました！共有・保存してください');
  expect(await page.isEnabled('#shareBtn')).toBe(true);
  expect(await page.isVisible('#easyMore')).toBe(true);
  const info = await outputInfo(page);
  expect([info.width, info.height]).toEqual([1280, 720]);

  // 範囲を変えてやり直す → 2 に戻り、圧縮した動画は消える
  await page.click('#easyBack');
  expect(await currentStep(page)).toEqual(['step2']);
  expect(await page.evaluate(() => window.__compressor.state.out)).toBe(null);
  expect(await page.isEnabled('#trimStart')).toBe(true);
});

test('画質優先：元の画質と fps のまま、20MB以内に圧縮する', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="size"]');
  const s = await settings(page);
  expect([s.mode, s.halfFps, s.minBitrate['1080'], s.targetMB]).toEqual(['size', false, 2700000, 20]);
  // 1080p60 は 1080p・60fps のまま
  await pick(page, '1080p60-45s.mp4');
  let p = await plan(page);
  expect([p.w, p.h, p.fps, p.mode]).toEqual([1920, 1080, 60, 'size']);
  // 画面録画（886×1920）・4K は元の解像度のまま（720p・1080p ではない動画）
  await pick(page, 'screenrec-886x1920.mp4');
  p = await plan(page);
  expect([p.w, p.h]).toEqual([886, 1920]);
  await pick(page, '4k-15s.mp4');
  p = await plan(page);
  expect([p.w, p.h]).toEqual([3840, 2160]);
  await pick(page, '1080p60-45s.mp4');
  await setTrim(page, 0, 10);
  await compressEasy(page);
  expect(await currentStep(page)).toEqual(['step3']);
  const info = await outputInfo(page);
  expect(info.size).toBeLessThan(20 * 1000 * 1000);
  expect([info.width, info.height]).toEqual([1920, 1080]);
});

test('720p・1080p ではない動画は、どの圧縮の仕方でも元の解像度のまま（解像度は変えられず、そのことを出す）', async ({ page }) => {
  for (const preset of ['quality', 'size']) {
    await openEasy(page);
    await page.click('.choice[data-preset="' + preset + '"]');
    await pick(page, 'screenrec-886x1920.mp4');
    const p = await plan(page);
    expect([p.w, p.h]).toEqual([886, 1920]);
    expect(await page.textContent('#adjNote')).toContain('そのままの解像度（886×1920）で圧縮します。');
    expect(await page.evaluate(() => document.getElementById('adjResSeg').classList.contains('hidden'))).toBe(true);   // 解像度は選べない
    // 720p・1080p の動画では出さない
    await pick(page, '720p-60s.mp4');
    expect(await page.textContent('#adjNote')).not.toContain('そのままの解像度');
    expect(await page.evaluate(() => document.getElementById('adjResSeg').classList.contains('hidden'))).toBe(false);
  }
  // 「詳しく設定する」で 720p を選んでいても元の解像度のまま。設定のステップの解像度は押せず、同じことを出す
  await openEasy(page, '?res=720&mode=quality&probe=off');
  await pick(page, 'screenrec-886x1920.mp4');
  const p = await plan(page);
  expect([p.w, p.h]).toEqual([886, 1920]);
  await page.click('#easyChange');
  expect(await page.isVisible('#resFixedNote')).toBe(true);
  expect(await page.isDisabled('#res720')).toBe(true);
  await page.click('#easySetNext');
  await setTrim(page, 0, 3);
  await compressEasy(page);
  const info = await outputInfo(page);
  expect([info.width, info.height]).toEqual([886, 1920]);
});

// 2 の解像度・fps のつまみを押す（つまみの見た目はラベル）
// （設定変更簡易メニューは初めは閉じているので、開いてから押す）
const choose = async (page, id) => {
  await page.evaluate(() => { document.getElementById('adjMenu').open = true; });
  await page.click('label[for="' + id + '"]');
};

test('2 で、その動画だけ解像度（480p/720p/1080p）・fps（30/60）・圧縮方法（なるべく圧縮/◯MB以内）を変えられる', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="quality"]');
  expect(await page.isVisible('#adjMenu')).toBe(false);   // 動画を選ぶまでは出さない
  await pick(page, '1080p60-45s.mp4');
  // 設定変更簡易メニューは、初めは閉じている（変えると先行圧縮をやり直すことになるため）。見出しを押すと開く
  expect(await page.textContent('#adjMenu summary')).toBe('設定変更簡易メニュー');
  expect(await page.isVisible('#adjMenu')).toBe(true);
  expect(await page.isVisible('#adjBox')).toBe(false);
  await page.click('#adjMenu summary');
  expect(await page.isVisible('#adjBox')).toBe(true);
  expect(await plan(page)).toEqual({ w: 1280, h: 720, fps: 30, mode: 'quality', bps: 1200000 });
  expect(await page.isChecked('#adjRes720')).toBe(true);
  expect(await page.isChecked('#adjFps30')).toBe(true);
  expect(await page.isChecked('#adjModeQuality')).toBe(true);
  expect(await page.textContent('label[for="adjModeSize"]')).toBe('20MB以内に圧縮');
  // 解像度（なるべく圧縮は、その解像度の指定ビットレート）
  await choose(page, 'adjRes1080');
  expect(await plan(page)).toEqual({ w: 1920, h: 1080, fps: 30, mode: 'quality', bps: 2700000 });
  await choose(page, 'adjRes480');   // 縦横比はそのまま、短い辺を480に。指定ビットレートは720pの値を画素数に比例させる
  let p = await plan(page);
  expect([p.w, p.h, p.bps]).toEqual([854, 480, Math.round(1200000 * 4 / 9)]);
  await choose(page, 'adjRes720');
  p = await plan(page);
  expect([p.w, p.h, p.bps]).toEqual([1280, 720, 1200000]);
  // fps（60fps のままは、指定の1.5倍）
  await choose(page, 'adjFps60');
  p = await plan(page);
  expect([p.fps, p.bps]).toEqual([60, 1800000]);
  // 圧縮方法：20MB以内なら、目標サイズに収まるなるべく高いビットレート（元の動画より高くはしない）
  await setTrim(page, 0, 3);
  await choose(page, 'adjModeSize');
  p = await plan(page);
  expect(p.mode).toBe('size');
  expect(p.bps).toBeGreaterThan(1800000);
  await choose(page, 'adjModeQuality');
  expect((await plan(page)).mode).toBe('quality');
  // 圧縮すると、変えたとおりになる
  await choose(page, 'adjRes1080');
  await compressEasy(page);
  const info = await outputInfo(page);
  expect([info.width, info.height]).toEqual([1920, 1080]);
  // 新しい動画を選ぶと、元に戻る（その動画だけ）。保存はしない
  await page.click('#easyBack');
  await pick(page, '720p-60s.mp4');
  expect(await plan(page)).toEqual({ w: 1280, h: 720, fps: 30, mode: 'quality', bps: 1200000 });
  expect(await page.isDisabled('#adjRes1080')).toBe(true);   // 元が 720p
  expect(await page.isDisabled('#adjFps60')).toBe(true);     // 元が 30fps
  expect(await page.evaluate(() => localStorage.getItem('video-compressor-under20mb:settings'))).toBe(null);
});

test('画質優先から「なるべく圧縮」に変えると、20MB以下の動画も圧縮する（元のまま渡すのをやめる）', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="size"]');
  await pick(page, 'small-5mb.mp4');
  expect(await page.isChecked('#adjModeSize')).toBe(true);
  expect(await page.isVisible('#easyPass')).toBe(true);
  await choose(page, 'adjModeQuality');
  expect((await plan(page)).mode).toBe('quality');
  expect(await page.isVisible('#easyPass')).toBe(false);
  expect(await page.evaluate(() => window.__compressor.state.out)).toBe(null);
});

test('圧縮ルールは設定のテンプレート：2 で変えて「なるべく圧縮」「画質優先」と違えば「カスタム」、同じになればその名前', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="quality"]');
  expect(await page.textContent('#easyModeName')).toBe('なるべく圧縮');
  expect(await page.textContent('.easy-mode')).toContain('圧縮ルール：');
  await pick(page, '1080p60-45s.mp4');
  expect(await page.textContent('#easyModeName')).toBe('なるべく圧縮');
  await choose(page, 'adjRes1080');
  expect(await page.textContent('#easyModeName')).toBe('カスタム');
  await choose(page, 'adjRes720');
  expect(await page.textContent('#easyModeName')).toBe('なるべく圧縮');
  // 画質優先と同じ設定（1080p の動画の 1080p は「元の解像度」と同じ・60fps・20MB以内）にすると、その名前
  await choose(page, 'adjModeSize');
  expect(await page.textContent('#easyModeName')).toBe('カスタム');
  await choose(page, 'adjFps60');
  await choose(page, 'adjRes1080');
  expect(await page.textContent('#easyModeName')).toBe('画質優先（20MB以内）');
  // 「← 戻る」は 1 に戻る（2択のとき）
  await page.click('#easyChange');
  expect(await currentStep(page)).toEqual(['step1']);
  // 画質優先は、動画を選ぶ前も「画質優先」
  await page.click('.choice[data-preset="size"]');
  expect(await page.textContent('#easyModeName')).toBe('画質優先（20MB以内）');
  // ショートカットの「なるべく圧縮」の URL（mode=quality）は、なるべく圧縮と同じ設定
  await openEasy(page, '?mode=quality&probe=off');
  expect(await page.textContent('#easyModeName')).toBe('なるべく圧縮');
});

test('目標以下の動画は、圧縮せずにそのまま共有・保存へ進める', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="size"]');
  await pick(page, 'small-5mb.mp4');
  expect(await page.isVisible('#easyPass')).toBe(true);
  await page.click('#easyPass');
  expect(await currentStep(page)).toEqual(['step3']);
  expect(await page.textContent('#step3Title')).toBe('圧縮しなくても送れます。共有・保存してください');
  expect(await page.isEnabled('#shareBtn')).toBe(true);
});

test('先行圧縮が済んでいれば、押したらすぐ出す（なるべく圧縮）', async ({ page }) => {
  await openEasy(page, '');
  await page.click('.choice[data-preset="quality"]');
  await pick(page, '720p-60s.mp4');
  await page.waitForFunction(() => { const p = window.__compressor.precomp().pre; return p && p.done; }, null, { timeout: 120000 });
  expect(await page.isVisible('#easyQuick')).toBe(true);
  expect(await page.textContent('#easyQuick')).toMatch(/^（[\d.]+MBで即出力します）$/);   // 「圧縮する」ボタンの2行目に出す
  await compressEasy(page);
  expect(await page.inputValue('#diagOut')).toMatch(/先行圧縮を使う（完了済み）/);
  expect(await currentStep(page)).toEqual(['step3']);
});

test('圧縮中にキャンセルしたら 2 に戻る。手順の帯で 1 に戻って選び直せる', async ({ page }) => {
  await openEasy(page);
  await page.click('.choice[data-preset="quality"]');
  await pick(page, '720p-60s.mp4');
  await page.click('#runBtn');
  await page.waitForFunction(() => document.getElementById('step3').classList.contains('is-current'));
  expect(await page.isVisible('#easyCancel')).toBe(true);
  expect(await page.isDisabled('.steps li[data-step="1"] button')).toBe(true);   // 圧縮中は戻れない
  await page.click('#easyCancel');
  await page.waitForFunction(() => document.getElementById('step2').classList.contains('is-current'), null, { timeout: 30000 });
  await page.click('.steps li[data-step="1"] button');
  expect(await currentStep(page)).toEqual(['step1']);
  await page.click('.choice[data-preset="size"]');
  expect((await settings(page)).mode).toBe('size');
  expect(await page.evaluate(() => !!window.__compressor.state.meta)).toBe(true);   // 選んだ動画はそのまま
});

test('2択は、従来の画面と共通の保存してある設定を使わず、変えもしない', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    localStorage.setItem('video-compressor-under20mb:settings', JSON.stringify({ res: '1080', mode: 'size', target: 50, min720: 800, halfFps: false }));
  });
  const before = await page.evaluate(() => localStorage.getItem('video-compressor-under20mb:settings'));
  await openEasy(page);
  await page.click('.choice[data-preset="quality"]');
  const s = await settings(page);
  expect([s.res, s.mode, s.targetMB, s.minBitrate['720'], s.halfFps]).toEqual(['720', 'quality', 20, 1200000, true]);
  await page.click('.steps li[data-step="1"] button');
  await page.click('.choice[data-preset="size"]');
  expect(await page.evaluate(() => localStorage.getItem('video-compressor-under20mb:settings'))).toBe(before);
});

test('3ステップの画面（下のリンク）と従来の画面（/old）を行き来できる。従来の画面のリンクは、動画を選んだら（「別の動画」と並ばないよう）隠す', async ({ page }) => {
  await openEasy(page);
  expect(await page.title()).toBe('アップロード不要の動画圧縮');
  expect(await page.textContent('footer a[href="./old"]')).toBe('従来の画面');
  await open(page);   // 従来の画面
  expect(await page.title()).toBe('従来の画面｜アップロード不要の動画圧縮');
  expect(await page.getAttribute('#easyLink', 'href')).toBe('./');
  expect(await page.isVisible('#easyLink')).toBe(true);
  await pick(page, 'small-5mb.mp4');
  expect(await page.isVisible('#easyLink')).toBe(false);
});

test('URL に設定があれば（ショートカットから開いたとき）、その設定の「詳しく設定する」にして、すぐ動画を選べる', async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.setItem('video-compressor-under20mb:settings', JSON.stringify({ res: '720', mode: 'size', target: 50 })));
  await openEasy(page, '?res=1080&mode=quality&auto=on&probe=off');
  expect(await currentStep(page)).toEqual(['step2']);
  expect(await page.textContent('#easyModeName')).toBe('カスタム');   // なるべく圧縮（720p）・画質優先のどちらとも違う
  const s = await settings(page);
  expect([s.res, s.mode, s.targetMB, s.autoRun]).toEqual(['1080', 'quality', 20, true]);   // 保存してある設定ではなく URL の設定
  // 「動画を選んだらすぐ圧縮」なら、選んだらそのまま圧縮して 3 へ
  await pick(page, 'small-5mb.mp4');
  await page.waitForFunction(() => document.getElementById('step3').classList.contains('is-current') && !window.__compressor.state.running && !!window.__compressor.state.out, null, { timeout: 120000 });
});

test('詳しく設定する：1 と 2 の間の設定のステップで、アプリの画面と同じ設定を決める（保存してある設定を使い、変えたら保存する。2択は保存しない）', async ({ page }) => {
  const KEY = 'video-compressor-under20mb:settings';
  await open(page);
  await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ res: '1080', mode: 'quality', target: 50, min1080: 2000, halfFps: false })), KEY);
  await openEasy(page);
  expect(await page.isVisible('#resSeg')).toBe(false);
  await page.click('.choice[data-preset="custom"]');
  // 1 と 2 の間に、解像度・圧縮方法・詳細設定を広げた設定のステップを出す（手順の帯も 4 つにする）
  expect(await currentStep(page)).toEqual(['stepSet']);
  expect(await page.isVisible('#resSeg')).toBe(true);
  expect(await page.isVisible('#targetSize')).toBe(true);   // 詳細設定は開いたまま
  expect(await page.isVisible('.steps li[data-step="set"]')).toBe(true);
  expect(await page.textContent('.steps li[data-step="3"] b')).toBe('4');
  let s = await settings(page);
  expect([s.res, s.mode, s.targetMB, s.minBitrate['1080'], s.halfFps]).toEqual(['1080', 'quality', 50, 2000000, false]);

  // 変えたら保存する（アプリの画面と共通）
  await page.click('label[for="modeSize"]');
  await page.waitForFunction(k => JSON.parse(localStorage.getItem(k)).mode === 'size', KEY);
  // 次へ：2 は2択と同じく動画とトリミングだけ（設定の部品は出さない）
  await page.click('#easySetNext');
  expect(await currentStep(page)).toEqual(['step2']);
  expect(await page.textContent('#easyModeName')).toBe('カスタム');
  expect(await page.isVisible('#resSeg')).toBe(false);
  await pick(page, '1080p60-45s.mp4');
  const p = await plan(page);
  expect([p.w, p.h, p.fps, p.mode]).toEqual([1920, 1080, 60, 'size']);
  expect(await page.isVisible('#repickBtn')).toBe(true);   // 2 で別の動画を選び直せる

  // 「← 戻る」で設定のステップに戻る。2択に切り替えると、その設定になり、保存はしない。「詳しく設定する」に戻すと保存した設定に戻る
  await page.click('#easyChange');
  expect(await currentStep(page)).toEqual(['stepSet']);
  await page.click('.steps li[data-step="1"] button');
  await page.click('.choice[data-preset="quality"]');
  expect(await page.isVisible('.steps li[data-step="set"]')).toBe(false);
  s = await settings(page);
  expect([s.res, s.mode, s.targetMB]).toEqual(['720', 'quality', 20]);
  expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY)).mode).toBe('size');
  await page.click('#easyChange');
  await page.click('.choice[data-preset="custom"]');
  s = await settings(page);
  expect([s.res, s.mode, s.targetMB]).toEqual(['1080', 'size', 50]);

  // 「設定を記憶したURL」は、この画面の URL（開けば、その設定の「詳しく設定する」になる）
  const url = await page.evaluate(() => {
    let copied = null;
    navigator.clipboard.writeText = t => { copied = t; return Promise.resolve(); };
    document.getElementById('urlCopy').click();
    return copied;
  });
  expect(url).toMatch(/^http:\/\/[^/]+\/\?/);
});

test('開発ブランチのプレビューだけ、見出しにサイト名の代わりに版を出す', async ({ page }) => {
  await openEasy(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    return [c.isPreviewHost('feat-easy-mode.maka-u20mb.pages.dev'), c.isPreviewHost('maka-u20mb.pages.dev'), c.isPreviewHost('127.0.0.1')];
  });
  expect(r).toEqual([true, false, false]);
  expect(await page.textContent('header h1')).toBe('アップロード不要の動画圧縮');   // テストのサーバーはプレビューではない
});

test('見出しの「使い方」で、3ステップの画面の説明書（手順の画像4枚・ショートカット・よくある質問・更新情報）を開ける', async ({ page }) => {
  await openEasy(page);
  await page.click('#helpBtn');
  expect(await page.isVisible('#helpDlg')).toBe(true);
  const r = await page.evaluate(() => ({
    slides: document.getElementById('helpSlides').children.length,
    dots: document.getElementById('helpDots').children.length,
    imgs: Array.from(document.querySelectorAll('#helpSlides img')).map(i => i.getAttribute('src'))
  }));
  expect(r.slides).toBe(17);
  expect(r.dots).toBe(17);
  expect(r.imgs).toEqual(['./help/step-1.webp', './help/step-2.webp', './help/step-3.webp', './help/step-4.webp']);
  await expect.poll(() => page.evaluate(() => document.querySelector('#helpSlides img').naturalWidth), { timeout: 10000 }).toBeGreaterThan(0);
  expect(await page.textContent('#helpHint')).toContain('全17枚');
  await page.click('#helpClose');
  expect(await page.isVisible('#helpDlg')).toBe(false);
});
