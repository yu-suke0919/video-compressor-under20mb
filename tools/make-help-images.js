// アプリの画面（3ステップ）の説明書の画像（public/help/step-1.webp 〜 step-4.webp）と、
// ショートカットのページの「設定を指定して開く」の画像（public/help/sc-url.webp）を作る
// step-1・step-2・sc-url は、テスト用のサーバーでアプリを開き、iPhone の画面の大きさで撮る。
// step-3・step-4 は、実機（iPhone）のスクリーンショット（tools/help-shots/。動画が映る画面なので、実際のゲームの動画で撮ったもの）を使う。
// どれも説明の書き込み（番号・枠・矢印）を重ね、WebP にする。画面を変えたら作り直す（step-3・step-4 は実機で撮り直して差し替える）。
//   使い方: node tools/make-help-images.js
//   必要なもの: H.264 を扱える Chrome（CHROME_PATH。npm test と同じ）、ffmpeg（FFMPEG。WebP にする）
'use strict';

const { chromium } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8791);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(ROOT, 'public', 'help');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SHOTS = path.join(__dirname, 'help-shots');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

// 画面に説明の書き込みを重ねる（ページの中で動かす）。marks … [{ type, ... }]
//   frame  … 枠（sel の部品、または rect: { l, t, r, b } を囲む。color、tag はその上に付ける札）
//   circle … 丸（x, y を中心に）
//   note   … 番号つきの説明（n, text, x, y。to があれば、そこへ矢印を引く）
function draw(marks) {
  const RED = '#e5332a';
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', innerWidth);
  svg.setAttribute('height', innerHeight);
  svg.style.cssText = 'position:absolute;inset:0';
  svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
    '<path d="M0 0L10 5L0 10z" fill="' + RED + '"/></marker></defs>';
  layer.appendChild(svg);
  document.body.appendChild(layer);   // 先にページに入れる（説明の位置から矢印を引くため）
  const rect = sel => document.querySelector(sel).getBoundingClientRect();
  const add = html => { const d = document.createElement('div'); d.innerHTML = html; const el = d.firstChild; layer.appendChild(el); return el; };
  const line = (x1, y1, x2, y2) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mx = (x1 + x2) / 2 + (y2 - y1) * 0.15, my = (y1 + y2) / 2 - (x2 - x1) * 0.15;   // 少し曲げる
    p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' Q' + mx + ' ' + my + ' ' + x2 + ' ' + y2);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', RED);
    p.setAttribute('stroke-width', '3');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('marker-end', 'url(#ah)');
    svg.appendChild(p);
  };
  for (const m of marks) {
    if (m.type === 'frame') {
      const r = m.rect ? { left: m.rect.l, top: m.rect.t, right: m.rect.r, width: m.rect.r - m.rect.l, height: m.rect.b - m.rect.t } : rect(m.sel);
      const c = m.color || RED, pad = m.pad == null ? 4 : m.pad;
      add('<div style="position:absolute;left:' + (r.left - pad) + 'px;top:' + (r.top - pad) + 'px;width:' + (r.width + pad * 2) + 'px;height:' +
        (r.height + pad * 2) + 'px;border:3px solid ' + c + ';border-radius:16px;box-sizing:border-box"></div>');
      if (m.tag) {
        add('<div style="position:absolute;right:' + (innerWidth - r.right - pad + 10) + 'px;top:' + (r.top - pad - 14) + 'px;background:#fff;color:' + c +
          ';border:2px solid ' + c + ';border-radius:999px;padding:1px 10px;font:700 14px/1.5 sans-serif">' + m.tag + '</div>');
      }
    } else if (m.type === 'circle') {
      add('<div style="position:absolute;left:' + (m.x - 18) + 'px;top:' + (m.y - 22) + 'px;width:36px;height:44px;border:3px solid ' + RED +
        ';border-radius:50%;box-sizing:border-box"></div>');
    } else if (m.type === 'note') {
      const el = add('<div style="position:absolute;left:' + m.x + 'px;top:' + m.y + 'px;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.94);' +
        'border:2px solid ' + RED + ';border-radius:14px;padding:5px 10px 5px 6px;color:' + RED + ';font:700 18px/1.3 sans-serif;white-space:nowrap">' +
        '<span style="flex:none;width:26px;height:26px;border-radius:50%;background:' + RED + ';color:#fff;display:flex;align-items:center;' +
        'justify-content:center;font-size:16px">' + m.n + '</span><span>' + m.text + '</span></div>');
      for (const to of m.to || []) {
        const b = el.getBoundingClientRect();
        const fromX = to.x < b.left ? b.left : to.x > b.right ? b.right : (b.left + b.right) / 2;
        const fromY = to.y < b.top ? b.top : to.y > b.bottom ? b.bottom : (b.top + b.bottom) / 2;
        line(fromX, fromY, to.x, to.y);
      }
    }
  }
}

async function shoot(page, name, marks, keepScroll) {
  if (!keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(draw, marks);
  const png = path.join(os.tmpdir(), name + '.png');
  await page.screenshot({ path: png });
  await page.evaluate(() => document.body.lastElementChild.remove());   // 書き込みを消す
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '82', path.join(OUT, name + '.webp')]);
  console.log('作成: public/help/' + name + '.webp');
}

// 実機のスクリーンショットに書き込む。crop … 使う範囲（元の画像の縦の位置。上の Safari のアドレスバーと下のツールバーを除く）。
// 画面の幅（390）に合わせて縮め、足りない下の部分はアプリの背景の色で埋める。marks(at) … at(x, y) で元の画像の位置を画面の位置にする
async function shootShot(page, name, crop, marks) {
  const file = path.join(SHOTS, name + '.webp');
  const src = 'data:image/webp;base64,' + fs.readFileSync(file).toString('base64');
  await page.setContent('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;overflow:hidden"><div id="shot" style="position:relative;overflow:hidden;width:390px">' +
    '<img id="img" src="' + src + '" style="position:absolute;left:0;width:390px"></div></body></html>');
  const size = await page.evaluate(() => new Promise(r => { const i = document.getElementById('img'); (i.complete ? Promise.resolve() : new Promise(d => { i.onload = d; })).then(() => r({ w: i.naturalWidth, h: i.naturalHeight })); }));
  const s = 390 / size.w;
  await page.evaluate(o => {
    const i = document.getElementById('img'), box = document.getElementById('shot');
    i.style.top = (-o.top * o.s) + 'px';
    box.style.height = ((o.bottom - o.top) * o.s) + 'px';
    // 背景の色は、使う範囲の下の端の、左の余白から取る（埋める所とつながるように）
    const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(i, 0, 0);
    const d = g.getImageData(6, o.bottom - 4, 1, 1).data;
    document.body.style.background = 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
  }, { top: crop.top, bottom: crop.bottom, s });
  await shoot(page, name, marks((x, y) => ({ x: x * s, y: (y - crop.top) * s })), true);
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'test', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 800));
    const args = ['--autoplay-policy=no-user-gesture-required'].concat((process.env.CHROME_ARGS || '').split(' ').filter(Boolean));
    const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args } : { channel: 'chrome', args });
    const context = await browser.newContext({
      viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, colorScheme: 'light'
    });
    const page = await context.newPage();
    await page.goto(BASE + '/?probe=off');
    await page.waitForFunction(() => /対応 VideoEncoder=/.test(document.getElementById('diagOut').value));
    const box = sel => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, sel);

    // 1. 圧縮の仕方を選ぶ
    const last = await box('.choice[data-preset="custom"]');
    await shoot(page, 'step-1', [
      { type: 'frame', sel: '.choice[data-preset="quality"]', color: '#1f9d4c', tag: '軽さ重視' },
      { type: 'frame', sel: '.choice[data-preset="size"]', color: '#e8890c', tag: '画質重視' },
      { type: 'note', n: '①', text: 'どう圧縮するか選ぶ', x: 70, y: last.b + 18, to: [{ x: 200, y: last.b + 4 }] }
    ]);

    // 2. 動画を選ぶ
    await page.click('.choice[data-preset="quality"]');
    const pick = await box('#pickBtn');
    await shoot(page, 'step-2', [
      { type: 'frame', sel: '#pickBtn' },
      { type: 'note', n: '②', text: 'タップして動画を選ぶ', x: 70, y: pick.t + 12, to: [{ x: 195, y: pick.t + (pick.b - pick.t) / 2 - 36 }] }
    ]);

    // 3. 範囲を決めて、圧縮する（実機のスクリーンショット）
    const rectOf = (at, l, t, r, b) => { const a = at(l, t), z = at(r, b); return { l: a.x, t: a.y, r: z.x, b: z.y }; };
    await shootShot(page, 'step-3', { top: 334, bottom: 2348 }, at => {   // 位置は元の画像（1206×2622）のもの
      const left = at(148, 1614), right = at(1053, 1614), video = at(0, 1458), run = rectOf(at, 49, 1993, 1158, 2172);
      return [
        { type: 'circle', x: left.x, y: left.y },
        { type: 'circle', x: right.x, y: right.y },
        { type: 'note', n: '③', text: '青い線で使う範囲を決める', x: 40, y: video.y - 92, to: [{ x: left.x, y: left.y - 24 }, { x: right.x, y: right.y - 24 }] },
        { type: 'frame', rect: rectOf(at, 49, 1748, 1158, 1816), color: '#1f6feb', tag: 'お好みで画質を調整', pad: 6 },
        { type: 'frame', rect: run },
        { type: 'note', n: '④', text: '押して圧縮！', x: 120, y: run.b + 22, to: [{ x: 195, y: run.b + 6 }] }
      ];
    });

    // 4. 共有・保存（実機のスクリーンショット）
    await shootShot(page, 'step-4', { top: 334, bottom: 2348 }, at => {
      const share = rectOf(at, 49, 1636, 1158, 1816);
      return [
        { type: 'frame', rect: share },
        { type: 'note', n: '⑤', text: 'Discordに送る・写真に保存', x: 40, y: share.b + 22, to: [{ x: 195, y: share.b + 6 }] }   // 結果の行を隠さないよう、ボタンの下に
      ];
    });

    // ショートカットのページ：「詳しく設定する」の設定の画面で「現在の設定を記憶したURLを生成してコピー」を押す
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/?probe=off');
    await page.waitForFunction(() => /対応 VideoEncoder=/.test(document.getElementById('diagOut').value));
    await page.click('.choice[data-preset="custom"]');
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.resolve();   // コピーしたことにする（「コピーしました」を出す）
      document.getElementById('urlCopy').click();
      const r = document.getElementById('urlCopy').getBoundingClientRect();
      window.scrollBy(0, r.top - 560);   // ボタンが画面の下の方に来るようにする
    });
    await page.waitForTimeout(300);
    const copy = await box('#urlCopy');
    await shoot(page, 'sc-url', [
      { type: 'frame', sel: '#urlCopy', pad: 6 },
      { type: 'note', n: '★', text: '押すとURLがコピーされる', x: 70, y: copy.t - 58, to: [{ x: 300, y: copy.t - 8 }] }
    ], true);
    await browser.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
