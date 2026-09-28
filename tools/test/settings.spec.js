// 設定の保存・読み込み・初期値に戻す・URL（読み取りと作成）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick } = require('./helpers');

// 画面の設定の状態
function readUi(page) {
  return page.evaluate(() => {
    const $ = id => document.getElementById(id);
    const s = window.__compressor.readSettings();
    return {
      res: s.res, mode: s.mode, target: $('targetSize').value, min720: $('minRate720').value, min1080: $('minRate1080').value,
      halfFps: $('halfFps').checked, auto: $('autoRun').checked, audio: $('audioOn').checked, nameOn: $('nameOn').checked
    };
  });
}
const DEFAULTS = { res: '720', mode: 'size', target: '20', min720: '1200', min1080: '2700', halfFps: true, auto: false, audio: true, nameOn: false };

// 「現在の設定を記憶したURLを生成してコピー」で作られる URL
async function copiedUrl(page, context) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('details.settings:not(#diagBox) > summary');
  await page.click('#urlCopy');
  await expect(page.locator('#urlStatus')).toHaveText('コピーしました');
  return page.evaluate(() => navigator.clipboard.readText());
}

test('何も指定しなければ初期値。URL は res だけ付ける（前回の設定を使わせないため）', async ({ page, context }) => {
  await open(page);
  expect(await readUi(page)).toEqual(DEFAULTS);
  expect(await copiedUrl(page, context)).toBe('http://127.0.0.1:' + (process.env.PORT || 8777) + '/?res=720');
});

test('URL の設定をすべて読み取り、同じ URL を作れる', async ({ page, context }) => {
  const query = '?res=1080&mode=quality&target=50&min720=1500&min1080=3000&fps=source&auto=on&audio=off&name=date,text1,rand&text1=abc';
  await open(page, query);
  expect(await readUi(page)).toEqual({ res: '1080', mode: 'quality', target: '50', min720: '1500', min1080: '3000', halfFps: false, auto: true, audio: false, nameOn: true });
  expect(new URL(await copiedUrl(page, context)).search).toBe(query);
});

test('元の解像度（res=source）は URL と保存の両方で覚える', async ({ page, context }) => {
  await open(page, '?res=source');
  expect(new URL(await copiedUrl(page, context)).search).toBe('?res=source');
});

test('URL の別名（720p・best・60・0・true など）も読み取る', async ({ page }) => {
  await open(page, '?res=1080p&mode=best&fps=60&audio=0&auto=true');
  expect(await readUi(page)).toEqual(Object.assign({}, DEFAULTS, { res: '1080', mode: 'quality', halfFps: false, audio: false, auto: true }));
  await open(page, '?res=720p&mode=target&fps=half&audio=true&auto=0');
  expect(await readUi(page)).toEqual(DEFAULTS);
});

test('URL の範囲外・おかしな値は無視して初期値のまま', async ({ page }) => {
  await open(page, '?target=9999&min720=5&min1080=abc&res=4k&mode=zzz&fps=x&audio=maybe');
  expect(await readUi(page)).toEqual(DEFAULTS);
});

test('画面で変えた設定を保存し、次に開いたときに戻す。「設定を初期値に戻す」で消える', async ({ page }) => {
  await open(page);
  await page.click('details.settings:not(#diagBox) > summary');
  await page.click('label[for="res1080"]');
  await page.click('label[for="modeQuality"]');
  await page.fill('#targetSize', '50'); await page.dispatchEvent('#targetSize', 'change');
  await page.fill('#minRate720', '1500'); await page.dispatchEvent('#minRate720', 'change');
  await page.fill('#minRate1080', '3000'); await page.dispatchEvent('#minRate1080', 'change');
  await page.uncheck('#halfFps');
  await page.check('#autoRun');
  await page.uncheck('#audioOn');
  await page.check('#nameOn');
  const changed = { res: '1080', mode: 'quality', target: '50', min720: '1500', min1080: '3000', halfFps: false, auto: true, audio: false, nameOn: true };
  expect(await readUi(page)).toEqual(changed);
  await page.waitForTimeout(100);

  await open(page);
  expect(await readUi(page)).toEqual(changed);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('video-compressor-under20mb:settings')));
  expect(saved).toMatchObject({ res: '1080', mode: 'quality', target: 50, min720: 1500, min1080: 3000, halfFps: false, auto: true, audio: false });
  expect(saved.name.on).toBe(true);

  await page.click('details.settings:not(#diagBox) > summary');
  await page.click('#resetSettings');
  expect(await readUi(page)).toEqual(DEFAULTS);
  expect(await page.evaluate(() => localStorage.getItem('video-compressor-under20mb:settings'))).toBe(null);
  await open(page);
  expect(await readUi(page)).toEqual(DEFAULTS);
});

test('以前の形式で保存した設定も読み込める。おかしな値は無視する', async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.setItem('video-compressor-under20mb:settings', JSON.stringify({
    res: '1080', mode: 'quality', target: 30, min720: 900, min1080: 99999, halfFps: 'yes', auto: true, audio: false,
    name: { on: true, order: ['text1', 'date'], enabled: ['text1'], text1: 'あいう😀!', text2: '' }
  })));
  await open(page);
  expect(await readUi(page)).toEqual({ res: '1080', mode: 'quality', target: '30', min720: '900', min1080: '2700', halfFps: true, auto: true, audio: false, nameOn: true });
  await page.click('details.settings:not(#diagBox) > summary');
  expect(await page.textContent('#namePreview')).toBe('あいう.mp4');   // 自由入力は文字と数字だけ
});

// 画面の圧縮の計画（解像度）
const planSize = page => page.evaluate(() => {
  const s = window.__compressor.state, st = window.__compressor.readSettings();
  const audio = window.__compressor.audioStrategy(s.meta, st.audio, s.engine);
  const p = window.__compressor.makePlan(s.meta, s.trim, st, audio, s.file.size);
  return p.width + 'x' + p.height;
});

test('URL の「元の解像度」は、1080p の動画を縮小せず、選択肢が出る動画では「元の解像度」に戻る', async ({ page }) => {
  await open(page, '?res=source');
  await pick(page, '1080p60-45s.mp4');
  expect(await page.isChecked('#res1080')).toBe(true);
  expect(await planSize(page)).toBe('1920x1080');
  await pick(page, 'screenrec-886x1920.mp4');   // 720p・1080p 以外の大きい動画
  expect(await page.isChecked('#resSource')).toBe(true);
  expect(await planSize(page)).toBe('886x1920');
});

test('保存した「元の解像度」も、1080p の動画を縮小しない', async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.setItem('video-compressor-under20mb:settings', JSON.stringify({ res: 'source' })));
  await open(page);
  await pick(page, '1080p60-45s.mp4');
  expect(await planSize(page)).toBe('1920x1080');
});

test('元動画のビットレートが低く、上限（元の80%）で目標に収まるなら、「収まらない」にしない', async ({ page }) => {
  await open(page);
  const plan = await page.evaluate(() => window.__compressor.makePlan(
    { width: 1280, height: 720, duration: 600, fps: 30 }, { start: 0, end: 600 },
    { res: '720', mode: 'size', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } },
    { mode: 'none', bps: 0, label: 'なし', note: null }, 24000000));
  expect(plan.videoBitrate).toBe(256000);
  expect(plan.estBytes).toBe(19200000);
  expect(plan.unreachable).toBe(false);
  // 元動画の上限を当てはめても収まらないときは、今までどおり「収まらない」
  const over = await page.evaluate(() => window.__compressor.makePlan(
    { width: 1280, height: 720, duration: 600, fps: 30 }, { start: 0, end: 600 },
    { res: '720', mode: 'size', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } },
    { mode: 'none', bps: 0, label: 'なし', note: null }, 200000000));
  expect(over.unreachable).toBe(true);
});
