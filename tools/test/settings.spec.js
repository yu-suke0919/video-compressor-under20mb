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

test('元動画のビットレートを上限にし（HEVC なら1.5倍）、その上限で目標に収まるなら、「収まらない」にしない', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const st = { res: '720', mode: 'size', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const plan = (codec, size) => window.__compressor.makePlan({ width: 1280, height: 720, duration: 600, fps: 30, videoCodec: codec }, { start: 0, end: 600 }, st, none, size);
    return { avc: plan('avc', 18000000), hevc: plan('hevc', 12000000), hevcBig: plan('hevc', 18000000), over: plan('avc', 200000000) };
  });
  // H.264：元の 240kbps（18MB・600秒）が上限。目標（約259kbps）より低いので上限で圧縮し、収まる
  expect(r.avc.videoBitrate).toBe(240000);
  expect(r.avc.estBytes).toBe(18000000);
  expect(r.avc.unreachable).toBe(false);
  // HEVC：元の 160kbps（12MB・600秒）の1.5倍＝240kbps まで
  expect(r.hevc.videoBitrate).toBe(240000);
  // HEVC で1.5倍が目標より高ければ、目標で決まる
  expect(r.hevcBig.videoBitrate).toBe(Math.floor(20000000 * 8 * 0.97 / 600));
  // 元動画の上限を当てはめても収まらないときは、今までどおり「収まらない」
  expect(r.over.unreachable).toBe(true);
});

test('奇数の大きさでも、計画の幅・高さは偶数（元との違いは1px以内、720p・1080p では縮小）', async ({ page }) => {
  await open(page);
  const sizes = await page.evaluate(() => {
    const st = { res: '720', mode: 'quality', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const plan = (w, h, res) => window.__compressor.makePlan({ width: w, height: h, duration: 10, fps: 30 }, { start: 0, end: 10 },
      Object.assign({}, st, { res }), none, 20000000);
    return [plan(1279, 719, '720'), plan(1921, 1081, '720'), plan(1921, 1081, '1080'), plan(719, 1279, 'source'), plan(333, 177, '720')]
      .map(p => [p.width, p.height]);
  });
  for (const [w, h] of sizes) { expect(w % 2).toBe(0); expect(h % 2).toBe(0); }
  expect(sizes).toEqual([[1280, 720], [1280, 720], [1920, 1080], [720, 1280], [334, 178]]);
});

test('元動画のビットレートが下限より低い動画は、圧縮し直すときも同じ下限（設定の最小値）を使う', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    const st = { res: '720', mode: 'size', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const meta = { width: 1280, height: 720, duration: 600, fps: 30 };
    const first = c.makePlan(meta, { start: 0, end: 600 }, st, none, 24000000);
    // 初回が 20.5MB になったとして、圧縮し直すビットレート
    const next = Math.max(c.nextBitrate(first, 20500000, 0), first.floorBitrate);
    const second = c.makePlan(meta, { start: 0, end: 600 }, st, none, 24000000, next);
    // ふつうの動画（元のビットレートが高い）は、設定の下限を守る
    const normal = c.makePlan(meta, { start: 0, end: 600 }, st, none, 200000000, 500000);
    return { first: first.videoBitrate, floor: first.floorBitrate, next, second: second.videoBitrate, normal: normal.videoBitrate, normalFloor: normal.floorBitrate };
  });
  expect(r.first).toBe(Math.floor(20000000 * 8 * 0.97 / 600));   // 目標で決まる（元の 320kbps より低い）
  expect(r.floor).toBe(100000);          // 元が下限より低いので、この動画の下限は設定の最小値
  expect(r.next).toBeLessThan(r.first);  // 下げて圧縮し直せる（以前は下限の 1200kbps に戻され、打ち切っていた）
  expect(r.second).toBe(r.next);
  expect(r.normalFloor).toBe(1200000);
  expect(r.normal).toBe(1200000);        // 求め直した値が低くても、設定の下限は割らない
});

test('60fpsのまま書き出すときは、下限ビットレートを1.5倍にする（30fpsにするときは今までどおり）', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const c = window.__compressor;
    const none = { mode: 'none', bps: 0, label: 'なし', note: null };
    const st = { res: '1080', mode: 'quality', targetMB: 20, targetBytes: 20000000, halfFps: true, minBitrate: { 720: 1200000, 1080: 2700000 } };
    const meta = { width: 1920, height: 1080, duration: 60, fps: 60 };
    const plan = (s, m) => c.makePlan(m || meta, { start: 0, end: 60 }, Object.assign({}, st, s), none, 500000000);
    const size60 = plan({ mode: 'size', halfFps: false });
    return {
      half: plan({}).videoBitrate,
      keep60: plan({ halfFps: false }).videoBitrate,
      src30: plan({ halfFps: false }, { width: 1920, height: 1080, duration: 60, fps: 30 }).videoBitrate,
      size60Floor: size60.floorBitrate, size60Unreachable: size60.unreachable,
      source60: plan({ res: 'source', halfFps: false }).videoBitrate
    };
  });
  expect(r.half).toBe(2700000);       // 60fps → 30fps
  expect(r.keep60).toBe(4050000);     // 60fps のまま
  expect(r.src30).toBe(2700000);      // もともと30fps
  expect(r.size60Floor).toBe(4050000);
  expect(r.size60Unreachable).toBe(true);   // 60秒は 4.05Mbps では20MBに入らない
  expect(r.source60).toBe(Math.round(Math.round(1200000 * 1920 * 1080 / (1280 * 720)) * 1.5));
});

test('720p以下の動画では 720p にして 1080p を選べなくし、選んでいた 1080p は大きい動画を選んだら戻す（保存した設定も 1080p のまま）', async ({ page }) => {
  await open(page);
  await page.click('label[for="res1080"]');   // 画面で 1080p を選ぶ（保存される）
  await pick(page, '720p-60s.mp4');
  expect(await page.isChecked('#res720')).toBe(true);
  expect(await page.isDisabled('#res1080')).toBe(true);
  expect(await page.textContent('#planInfo')).toContain('1280×720');
  expect(await page.evaluate(() => window.__compressor.state.plan.floorBitrate)).toBe(1200000);   // 720p の下限で計画する
  // ほかの設定を変えて保存しても、解像度は 1080p のまま覚えている
  await page.click('label[for="modeQuality"]');
  await page.waitForTimeout(100);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('video-compressor-under20mb:settings')));
  expect(saved.res).toBe('1080');
  await pick(page, '1080p60-45s.mp4');
  expect(await page.isChecked('#res1080')).toBe(true);
  expect(await page.isDisabled('#res1080')).toBe(false);
  // もっと小さい動画（160×120）でも同じ
  await pick(page, 'tiny-160x120.mp4');
  expect(await page.isChecked('#res720')).toBe(true);
  expect(await page.isDisabled('#res1080')).toBe(true);
});

test('「元の解像度」は、720p の動画を経由しても、次の 1080p の動画を縮小しない', async ({ page }) => {
  await open(page, '?res=source');
  await pick(page, '720p-60s.mp4');
  expect(await page.isChecked('#res720')).toBe(true);
  expect(await page.isDisabled('#res1080')).toBe(true);
  await pick(page, '1080p60-45s.mp4');
  expect(await page.isChecked('#res1080')).toBe(true);
  expect(await planSize(page)).toBe('1920x1080');
  await pick(page, 'screenrec-886x1920.mp4');   // 「元の解像度」を出せる動画では、元の解像度に戻る
  expect(await page.isChecked('#resSource')).toBe(true);
  expect(await planSize(page)).toBe('886x1920');
});
