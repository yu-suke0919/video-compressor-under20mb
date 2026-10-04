// 先行圧縮の書き出し（fragmented MP4）を読む関数（public/js/fmp4.js）の単体テスト（npm run test:unit）
// fixtures/frag-4s.mp4 … ffmpeg で作った 4秒・64×64・30fps・1秒ごとのキーフレーム・AAC 音声の、キーフレームごとに区切った mp4
//   （ffmpeg -f lavfi -i testsrc=size=64x64:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 4
//    -c:v libx264 -pix_fmt yuv420p -bf 0 -g 30 -keyint_min 30 -sc_threshold 0 -c:a aac -b:a 32k
//    -movflags frag_keyframe+empty_moov+default_base_moof frag-4s.mp4）
// fixtures/frag-bframes.mp4 … 同じ作り方で -bf 0 を付けない（B フレームあり。コマの並び順と表示の順が違う）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFragments, fragmentsBlob, readChunks, boxType } from '../../../public/js/fmp4.js';
import { exactCutBytes, CUT_OVERHEAD_BASE, CUT_OVERHEAD_PER_SAMPLE } from '../../../public/js/calc.js';

const load = name => new Uint8Array(readFileSync(new URL('./fixtures/' + name, import.meta.url)));
const FILE = load('frag-4s.mp4');

// 先頭からの箱の一覧（種類と大きさ）
function boxes(data) {
  const out = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let o = 0; o + 8 <= data.length;) {
    const size = dv.getUint32(o);
    out.push({ type: boxType(data, o + 4), size, at: o });
    o += size;
  }
  return out;
}
// 先行圧縮の書き出しを受け取ったときと同じ形（rec.chunks・rec.bytes）にする。sizes ごとに分けて届いたことにする
function received(data, sizes) {
  const rec = { chunks: [], bytes: 0 };
  let pos = 0;
  for (const n of sizes) {
    if (pos >= data.length) break;
    const part = data.subarray(pos, Math.min(data.length, pos + n));
    rec.chunks.push({ position: pos, data: part });
    pos += part.length;
    rec.bytes = pos;
  }
  return rec;
}

test('parseFragments：1コマごとの時刻・長さ・大きさ・キーフレームを読む', () => {
  const rec = received(FILE, [FILE.length]);
  parseFragments(rec);
  const v = rec.samples.video, a = rec.samples.audio;
  assert.equal(v.length, 120);   // 4秒 × 30fps
  assert.equal(v[0].t, 0);
  v.forEach((x, i) => {
    if (i > 0) assert.ok(Math.abs(x.t - (v[i - 1].t + v[i - 1].d)) < 1e-9, 'video t ' + i);   // 前のコマの終わりから
    if (i > 0) assert.ok(Math.abs(x.d - 1 / 30) < 1e-6, 'video d ' + i);   // （最初のコマだけ、音声に合わせて少し長い）
    assert.equal(x.k, i % 30 === 0, 'keyframe ' + i);   // 1秒ごとのキーフレーム
  });
  assert.ok(a.length > 180 && a.length < 200, 'audio ' + a.length);   // 48kHz・1024サンプルごと（約187）
  for (let i = 1; i < a.length; i++) assert.ok(a[i].t > a[i - 1].t);
  // コマの大きさを足すと、mdat の中身（見出しの 8バイトを除く）と同じになる
  const payload = boxes(FILE).filter(b => b.type === 'mdat').reduce((n, b) => n + b.size - 8, 0);
  assert.equal(v.concat(a).reduce((n, x) => n + x.s, 0), payload);
});

test('parseFragments：少しずつ届いても（区切りの途中で切れていても）、届いたたびに読み進めて同じ表になる', () => {
  const whole = received(FILE, [FILE.length]);
  parseFragments(whole);
  for (const step of [1000, 4096, 7777]) {
    const all = received(FILE, Array(Math.ceil(FILE.length / step)).fill(step));
    const rec = { chunks: [], bytes: 0 };
    let videoCounts = [];
    for (const c of all.chunks) {
      rec.chunks.push(c);
      rec.bytes = c.position + c.data.length;
      parseFragments(rec);
      videoCounts.push(rec.samples.video.length);
    }
    for (let i = 1; i < videoCounts.length; i++) assert.ok(videoCounts[i] >= videoCounts[i - 1]);   // 減らない
    assert.deepEqual(rec.samples, whole.samples, 'step ' + step);
  }
});

test('readChunks：届いていない所まで読もうとしたら null', () => {
  const rec = received(FILE, [100, 100]);
  assert.equal(readChunks(rec, 150, 40).length, 40);
  assert.equal(readChunks(rec, 180, 40), null);
});

test('fragmentsBlob：途中で止めた書き出しは、最後の区切りの終わりまでにする（届いた順でなくても組み立て直す）', async () => {
  const list = boxes(FILE);
  const secondMdat = list.filter(b => b.type === 'mdat')[1];
  const stopAt = secondMdat.at + secondMdat.size + 300;   // 3つ目の moof の途中まで届いた
  const rec = received(FILE.subarray(0, stopAt), [5000, 5000, 5000, 5000, 5000]);
  const blob = fragmentsBlob(rec);
  assert.equal(blob.size, secondMdat.at + secondMdat.size);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), FILE.subarray(0, blob.size));
  // 届いた順が入れ替わっていても、同じ中身
  const shuffled = { chunks: rec.chunks.slice().reverse(), bytes: rec.bytes };
  const again = fragmentsBlob(shuffled);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), FILE.subarray(0, blob.size));
  // 最後まで届いていれば、全体（mfra まで）
  assert.equal(fragmentsBlob(received(FILE, [FILE.length])).size, FILE.length);
});

test('読んだ表から、範囲を切り出したときの大きさを数える（映像は範囲の前のキーフレームから）', () => {
  const rec = received(FILE, [FILE.length]);
  parseFragments(rec);
  rec.done = true;
  const v = rec.samples.video, a = rec.samples.audio;
  const cut = exactCutBytes({ trimStart: 1.5, trimEnd: 2.5 }, rec);
  const key = v[30].t;   // 1.5秒より前でいちばん近いキーフレーム（約1秒）
  const vs = v.filter(x => x.t >= key - 1e-4 && x.t < 2.5 - 1e-4);
  const as = a.filter(x => x.t >= 1.5 - 1e-4 && x.t < 2.5 - 1e-4);
  const bytes = vs.concat(as).reduce((n, x) => n + x.s, 0);
  assert.equal(cut, bytes + CUT_OVERHEAD_BASE + CUT_OVERHEAD_PER_SAMPLE * (vs.length + as.length));
  assert.ok(vs.length >= 44 && vs.length <= 46, 'video ' + vs.length);
});

test('B フレームがあっても、表示の時刻（並び順ではない）で読む', () => {
  const data = load('frag-bframes.mp4');
  const rec = received(data, [data.length]);
  parseFragments(rec);
  const v = rec.samples.video;
  assert.equal(v.length, 120);
  assert.ok(v.some((x, i) => i > 0 && x.t < v[i - 1].t), '並び順と表示の順が違うコマがある');
  const times = v.map(x => x.t).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i] - times[i - 1] - 1 / 30) < 1e-6, 'step ' + i);   // 表示の順に並べると等間隔
  assert.equal(v.filter(x => x.k).length, 4);
});
