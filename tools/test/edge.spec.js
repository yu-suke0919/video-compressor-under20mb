// 例外になる動画（小さすぎる・短すぎる・長すぎる・音声の種類・形式・壊れている など）
'use strict';

const { test, expect } = require('@playwright/test');
const { open, pick, compress, ui, outputInfo, setTrim, canEncodeAac } = require('./helpers');

test.describe('小さい・短い動画', () => {
  test('160×120：拡大しない・目標以下なら元のまま渡せる', async ({ page }) => {
    await open(page);
    await pick(page, 'tiny-160x120.mp4');
    const u = await ui(page);
    expect(u.planInfo).toContain('現在の設定：120p/');
    expect(u.original).toBe(true);
    expect(u.outInfo).toContain('元の動画のまま');
    await compress(page);
    const out = await outputInfo(page);
    expect([out.width, out.height]).toEqual([160, 120]);
  });

  test('0.3秒の動画：長さを「0.3秒」と出し、圧縮できる', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, 'short-0.3s.mp4');
    expect((await ui(page)).srcInfo).toContain('0.3秒');
    await compress(page);
    const out = await outputInfo(page);
    expect(out.duration).toBeLessThan(0.6);
  });

  test('1コマだけの動画も圧縮できる', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, 'oneframe.mp4');
    await compress(page);
    expect((await outputInfo(page)).videoCodec).toBe('avc');
  });

  test('目標以下の動画は、元の動画をそのまま渡せる（同じファイル）', async ({ page }) => {
    await open(page);
    await pick(page, 'small-5mb.mp4');
    const out = await outputInfo(page);
    expect(out.original).toBe(true);
    expect(out.sameAsInput).toBe(true);
    expect(out.name).toBe('small-5mb.mp4');
  });
});

// 長い動画の代わりに、1分の動画で目標サイズを小さくして試す（テストを短くするため）
test.describe('目標サイズに収まらない長さ', () => {
  test('収まらない長さ：ボタンを押せず、入る長さの目安を出す', async ({ page }) => {
    await open(page, '?target=5');
    await pick(page, '720p-60s.mp4');
    const u = await ui(page);
    expect(u.runDisabled).toBe(true);
    expect(u.planWarn).toMatch(/5MBに収まらない可能性があります（目安は約\d+秒まで）。/);
    expect(u.planWarn).toContain('トリミングして短くするか、設定変更から低い解像度・fpsを選択してください。');
    expect(u.planWarn).not.toContain('目標サイズに圧縮できません');   // 古い案内は出さない
    expect(u.planWarn).not.toContain('Discordの無料アカウント');   // 同じ内容の注意は重ねない
  });

  test('なるべく圧縮なら長くても最後まで圧縮し、20MB超えを知らせる', async ({ page }) => {
    await open(page, '?mode=quality&min720=3500');   // 1分で20MBを超えるビットレート
    await pick(page, '720p-60s.mp4');
    expect((await ui(page)).planWarn).toContain('20MBに収まらない可能性があります');   // 押す前に知らせる
    await compress(page);
    const u = await ui(page);
    const out = await outputInfo(page);
    expect(out.duration).toBeGreaterThan(59);
    expect(out.size).toBeGreaterThan(20 * 1000 * 1000);
    // 圧縮後は、大きさをオレンジで出す（20MB超えの文は出さない）
    expect(u.outWarn).toBe('');
    expect(await page.getAttribute('#outInfo .out-size', 'class')).toContain('is-over');
  });

  test('目安の長さに切り出せば目標サイズに収まる', async ({ page }) => {
    await open(page, '?target=5');
    await pick(page, '720p-60s.mp4');
    await setTrim(page, 0, 20);
    expect((await ui(page)).runDisabled).toBe(false);
    await compress(page);
    const out = await outputInfo(page);
    expect(out.size).toBeLessThan(5 * 1000 * 1000);
    expect(Math.abs(out.duration - 20)).toBeLessThan(1);
  });

  test('4K を元の解像度のままでは収まらないとき、入る長さの目安を出す', async ({ page }) => {
    await open(page, '?res=source');
    await pick(page, '4k-15s.mp4');
    const u = await ui(page);
    expect(u.runDisabled).toBe(true);
    expect(u.planWarn).toContain('20MBに収まらない可能性があります（目安は約14秒まで）。');
    expect(u.planInfo).toContain('14秒以内で20MBに収まります。');   // 予想の行も同じ目安
  });

  test('4K を 720p に縮小して圧縮できる', async ({ page }) => {
    await open(page);
    await pick(page, '4k-15s.mp4');
    await setTrim(page, 0, 5);   // 4K の縮小は時間がかかるので短く
    await compress(page);
    const out = await outputInfo(page);
    expect([out.width, out.height]).toEqual([1280, 720]);
    expect(out.size).toBeLessThan(20 * 1000 * 1000);
  });
});

test.describe('音声', () => {
  test('音声のない動画', async ({ page }) => {
    await open(page);
    await pick(page, 'noaudio.mp4');
    await compress(page);
    expect((await outputInfo(page)).audioCodec).toBe(null);
  });

  for (const file of ['mp3-audio.mp4', 'opus-audio.mp4']) {
    test(`AAC 以外の音声（${file}）：AAC に変換するか、できない端末では事前に知らせる`, async ({ page }) => {
      await open(page, '?mode=quality');
      await pick(page, file);
      const aac = await canEncodeAac(page);
      const u = await ui(page);
      if (aac) expect(u.planWarn).not.toContain('音声なしで圧縮します');
      else expect(u.planWarn).toContain('音声をAACに変換できないため、音声なしで圧縮します。');
      await compress(page);
      expect((await outputInfo(page)).audioCodec).toBe(aac ? 'aac' : null);
    });
  }

  test('AAC 5.1ch の音声は残る', async ({ page }) => {
    await open(page, '?mode=quality');
    await pick(page, 'aac-5.1.mp4');
    await compress(page);
    expect((await outputInfo(page)).audioCodec).toBe('aac');
  });

  test('読めない音声（AC-3）が AAC と一緒に入っていても「音声なし」にしない', async ({ page }) => {
    await open(page);
    await pick(page, 'two-audio.mov');
    await compress(page);
    expect((await ui(page)).outInfo).not.toContain('音声なし');
    expect((await outputInfo(page)).audioCodec).toBe('aac');
  });

  test('「音声を残す」をオフにすると音声を外す', async ({ page }) => {
    await open(page, '?audio=off');
    await pick(page, '720p-60s.mp4');
    await compress(page);
    expect((await outputInfo(page)).audioCodec).toBe(null);
  });
});

test.describe('形式', () => {
  test('WebM（VP9）は互換モードで MP4（H.264）にする', async ({ page }) => {
    await open(page);
    await pick(page, 'vp9.webm');
    expect((await ui(page)).engine).toBe('compat');
    await compress(page);
    expect((await ui(page)).outInfo).toContain('互換モード');
    const out = await outputInfo(page);
    expect(out.videoCodec).toBe('avc');
    expect(out.name).toMatch(/\.mp4$/);
  });

  test('奇数の大きさの動画', async ({ page }) => {
    await open(page);
    await pick(page, 'odd-1279x719.mp4');
    const meta = (await ui(page)).meta;
    expect([meta.width, meta.height]).toEqual([1279, 719]);   // テストの前提：本当に奇数の大きさで読んでいる
    await compress(page);
    const out = await outputInfo(page);
    expect(out.width % 2).toBe(0);
    expect(out.height % 2).toBe(0);
    // いちばん近い偶数に丸める（元との違いは1px以内）
    expect(Math.abs(out.width - 1279)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.height - 719)).toBeLessThanOrEqual(1);
  });

  test('HEVC：読み込めれば圧縮でき、読み込めない端末では形式の案内をすぐ出す', async ({ page }) => {
    await open(page);
    const t0 = Date.now();
    await pick(page, 'hevc-portrait.mov');
    const u = await ui(page);
    if (u.meta) {
      await compress(page);
      expect((await outputInfo(page)).videoCodec).toBe('avc');
    } else {
      expect(Date.now() - t0).toBeLessThan(10000);   // 20秒待たされない
      expect(u.planWarn).toContain('HEVC/H.265');
      expect(u.pickVisible).toBe(true);
    }
  });

  for (const file of ['truncated.mp4', 'text.mp4']) {
    test(`読み込めないファイル（${file}）：選び直しを案内し、最初の画面に戻す`, async ({ page }) => {
      await open(page);
      await pick(page, file);
      const u = await ui(page);
      expect(u.planWarn).toContain('動画を読み込めませんでした。');
      expect(u.planWarn).toContain('もう一度選び直してください');
      expect(u.pickVisible).toBe(true);
      expect(u.srcVideoVisible).toBe(false);
      expect(u.runDisabled).toBe(true);
    });
  }
});

test('URL でファイル名の付け方を指定できる', async ({ page }) => {
  await open(page, '?name=datetime,text1,rand,opt&text1=' + encodeURIComponent('テスト'));
  await pick(page, 'small-5mb.mp4');
  await setTrim(page, 0, 8);   // 元のまま渡さないように、少し切る
  await compress(page);
  expect((await outputInfo(page)).name).toMatch(/^\d{14}_テスト_[a-z0-9]{4}_(720p_20MB|トリミング)\.mp4$/);
});

test('音声が2本ある動画は、メインの音声1本だけを書き出す（大きさの見積もりと合う）', async ({ page }) => {
  await open(page, '?mode=quality');
  await pick(page, 'two-aac.mp4');
  const countTracks = () => page.evaluate(async () => {
    const M = window.Mediabunny, o = window.__compressor.state.out;
    const input = new M.Input({ source: new M.BlobSource(o.blob), formats: [M.MP4, M.QTFF] });
    try { return { video: (await input.getVideoTracks()).length, audio: (await input.getAudioTracks()).length, size: o.blob.size }; }
    finally { input.dispose(); }
  });
  const est = await page.evaluate(() => window.__compressor.state.plan.estBytes);
  await compress(page);
  const r = await countTracks();
  expect([r.video, r.audio]).toEqual([1, 1]);
  expect(Math.abs(r.size / est - 1)).toBeLessThan(0.1);   // 音声1本ぶんの見積もりと合う
  // トリミングのみ（再圧縮なし）でも、メインの音声1本だけ
  await open(page, '?mode=size');
  await pick(page, 'two-aac.mp4');
  await setTrim(page, 0, 2);
  await compress(page);
  expect((await outputInfo(page)).name).toBe('two-aac.mp4');
  const c = await countTracks();
  expect([c.video, c.audio]).toEqual([1, 1]);
});

test('「30fps」は、30fps 以下になるまで元の fps を割る（120fps → 30fps）', async ({ page }) => {
  // 元の fps ごとの出力の fps の計算は、単体テスト（tools/test/unit/calc.test.mjs）で確かめる
  // 実際に書き出した動画（120fps → 30fps）
  await open(page, '?mode=quality&fps=30');
  await pick(page, 'hfr-120fps.mp4');
  expect(await page.evaluate(() => Math.round(window.__compressor.state.plan.outFps))).toBe(30);
  await compress(page);
  const rate = await page.evaluate(async () => {
    const M = window.Mediabunny;
    const input = new M.Input({ source: new M.BlobSource(window.__compressor.state.out.blob), formats: [M.MP4] });
    try { return (await (await input.getPrimaryVideoTrack()).computePacketStats(200)).averagePacketRate; } finally { input.dispose(); }
  });
  expect(Math.abs(rate - 30)).toBeLessThan(2);
});

