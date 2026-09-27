// 端末（PC・Android・iPhone の画面）× 動画（720p・1080p・縦長・回転情報つき・画面録画）の基本の組み合わせ
'use strict';

const { test, expect } = require('@playwright/test');
const { PROFILES, open, pick, compress, ui, outputInfo } = require('./helpers');

// [動画, URL の設定, 出力の幅, 出力の高さ, 「元の解像度」が出るか]
const CASES = [
  ['720p-60s.mp4', '', 1280, 720, false],
  ['1080p60-45s.mp4', '', 1280, 720, false],
  ['1080p60-45s.mp4', '?res=1080', 1920, 1080, false],
  ['portrait-1080x1920.mov', '', 720, 1280, false],
  ['portrait-rot90.mov', '', 720, 1280, false],
  ['screenrec-886x1920.mp4', '', 720, 1560, true],
  ['screenrec-886x1920.mp4', '?res=source', 886, 1920, true],
];
// Android と iPhone の画面では、代表的なものだけ試す（中身の処理は同じ Chrome なので）
const MOBILE_CASES = CASES.filter(c => ['720p-60s.mp4|', '1080p60-45s.mp4|?res=1080', 'portrait-rot90.mov|', 'screenrec-886x1920.mp4|?res=source'].includes(c[0] + '|' + c[1]));

for (const [profile, cases] of [['pc', CASES], ['android', MOBILE_CASES], ['ios', MOBILE_CASES]]) {
  test.describe(profile, () => {
    test.use(PROFILES[profile]);
    for (const [file, query, w, h, three] of cases) {
      test(`${file} ${query || '（初期設定）'} → ${w}×${h}・20MB未満`, async ({ page }) => {
        await open(page, query);
        await pick(page, file);
        const before = await ui(page);
        expect(before.engine).toBe('fast');
        expect(before.threeRes).toBe(three);
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
        expect(out.name).toMatch(/_compressed\.mp4$/);
        if (profile === 'ios') expect(after.shareText).toBe('Discord等に共有・動画保存');   // iPhone は共有と保存を1つのボタンにまとめる
      });
    }
  });
}
