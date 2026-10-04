// 端末（PC・Android・iPhone の画面）× 動画（720p・1080p・縦長・回転情報つき・画面録画）の基本の組み合わせ
'use strict';

const { test, expect } = require('@playwright/test');
const { PROFILES, open, pick, compress, ui, outputInfo } = require('./helpers');

// [動画, URL の設定, 出力の幅, 出力の高さ]
// （画面録画（886×1920）は 720p・1080p ではない 1080p 以下の動画なので、設定に関係なく元の解像度のまま）
const CASES = [
  ['720p-60s.mp4', '', 1280, 720],
  ['1080p60-10s.mp4', '', 1280, 720],   // 縮小は時間がかかるので短い動画で（45秒は下の 1080p で）
  ['1080p60-45s.mp4', '?res=1080', 1920, 1080],
  ['portrait-1080x1920.mov', '', 720, 1280],
  ['portrait-rot90.mov', '', 720, 1280],
  ['screenrec-886x1920.mp4', '', 886, 1920],
  ['screenrec-886x1920.mp4', '?res=source', 886, 1920],
];
// Android と iPhone の画面では、端末で処理が変わるものだけ試す（中身の処理は同じ Chrome。ほかの組み合わせは PC と同じ処理を通るだけ）
//   Android … 動画をブラウザ内に写してから読む（いちばん短い動画で）
//   iPhone  … 解像度を変えないとき、全体を切り抜く指定で描き直す（元の解像度のまま）。共有と保存を1つのボタンにまとめる
const pick1 = key => CASES.filter(c => c[0] + '|' + c[1] === key);

for (const [profile, cases] of [['pc', CASES], ['android', pick1('720p-60s.mp4|')], ['ios', pick1('screenrec-886x1920.mp4|?res=source')]]) {
  test.describe(profile, () => {
    test.use(PROFILES[profile]);
    for (const [file, query, w, h] of cases) {
      test(`${file} ${query || '（初期設定）'} → ${w}×${h}・20MB未満`, async ({ page }) => {
        await open(page, query);
        await pick(page, file);
        const before = await ui(page);
        expect(before.engine).toBe('fast');
        expect(before.planWarn).toBe('');

        await compress(page);
        const after = await ui(page);
        expect(after.runText).toBe('やり直す');
        expect(after.outWarn).toBe('');
        const out = await outputInfo(page);
        expect(out.size).toBeLessThan(20 * 1000 * 1000);
        expect(out.size).toBeGreaterThan(10 * 1000 * 1000);   // 目標（19.4MB）に向けて容量を使えている（下げすぎていない）
        expect([out.width, out.height]).toEqual([w, h]);
        expect(out.videoCodec).toBe('avc');
        expect(out.audioCodec).toBe('aac');
        expect(out.name).toBe(file.replace(/\.[^.]+$/, '.mp4'));   // 元の動画の名前（_compressed なども付けない）
        if (profile === 'ios') expect(after.shareText).toBe('Discord等に共有・動画保存');   // iPhone は共有と保存を1つのボタンにまとめる
      });
    }
  });
}
