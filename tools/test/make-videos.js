// テスト用の動画を tools/test/videos/ に作る（ffmpeg が必要。場所は環境変数 FFMPEG で指定できる。既定は PATH の ffmpeg）
// 使い方: npm run test:videos
// すでにある動画は作り直さない（作り直すときは videos フォルダを消す）
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const OUT = path.join(__dirname, 'videos');
fs.mkdirSync(OUT, { recursive: true });

// 圧縮しにくい絵（動くテスト画像＋ノイズ）と、440Hz の音
const noisy = (size, rate) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate},noise=alls=12:allf=t`];
const plain = (size, rate) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`];
const tone = (rate = 48000) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}`];
const x264 = (bitrate) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate];
const aac = (bitrate = '128k', ch = 2) => ['-c:a', 'aac', '-b:a', bitrate, '-ac', String(ch)];

// 名前 → ffmpeg の引数（出力ファイル名は最後に付ける）
const VIDEOS = {
  // 端末ごとの基本の組み合わせ
  '720p-60s.mp4': [...noisy('1280x720', 30), ...tone(), '-t', '60', ...x264('6M'), ...aac()],
  '1080p60-45s.mp4': [...noisy('1920x1080', 60), ...tone(), '-t', '45', ...x264('12M'), ...aac()],
  'portrait-1080x1920.mov': [...noisy('1080x1920', 30), ...tone(), '-t', '40', ...x264('10M'), '-tag:v', 'avc1', ...aac()],
  'screenrec-886x1920.mp4': [...noisy('886x1920', 60), ...tone(), '-t', '30', ...x264('10M'), ...aac()],
  // 例外になる動画
  'tiny-160x120.mp4': [...noisy('160x120', 30), ...tone(), '-t', '10', ...x264('300k'), ...aac()],
  'short-0.3s.mp4': [...noisy('1280x720', 30), ...tone(), '-t', '0.3', ...x264('4M'), ...aac()],
  'oneframe.mp4': [...plain('1280x720', 30), '-frames:v', '1', ...x264('4M')],
  'long-5min.mp4': [...noisy('1280x720', 30), ...tone(), '-t', '300', ...x264('2M'), ...aac()],
  'long-10min-25mb-noaudio.mp4': [...plain('1280x720', 30), '-t', '600', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '330k', '-maxrate', '330k', '-bufsize', '660k', '-g', '60'],
  'noaudio.mp4': [...noisy('1280x720', 30), '-t', '30', ...x264('8M')],
  'small-5mb.mp4': [...noisy('1280x720', 30), ...tone(), '-t', '10', ...x264('3M'), ...aac()],
  'mp3-audio.mp4': [...noisy('1280x720', 30), ...tone(44100), '-t', '10', ...x264('3M'), '-c:a', 'libmp3lame', '-b:a', '128k'],
  'opus-audio.mp4': [...noisy('1280x720', 30), ...tone(), '-t', '10', ...x264('3M'), '-c:a', 'libopus', '-b:a', '128k'],
  'aac-5.1.mp4': [...noisy('1280x720', 30), ...tone(), '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]',
    '-map', '0:v', '-map', '[a]', '-t', '10', ...x264('3M'), '-c:a', 'aac', '-b:a', '384k'],
  'vp9.webm': [...noisy('1280x720', 30), ...tone(), '-t', '12', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '6M',
    '-c:a', 'libopus', '-b:a', '128k'],
  // 奇数の大きさ：testsrc2 と yuv420p（色の間引き）は奇数にできず、偶数に直されてしまう。
  // 偶数で作ってから奇数に縮め、色を間引かない yuv444p（H.264 High 4:4:4）で書く
  'odd-1279x719.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30,scale=1279:719,setsar=1,noise=alls=12:allf=t,format=yuv444p',
    ...tone(), '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '8M', ...aac()],
  '4k-15s.mp4': [...noisy('3840x2160', 30), ...tone(), '-t', '15', ...x264('25M'), ...aac()],
  'hevc-portrait.mov': [...noisy('1080x1920', 30), ...tone(), '-t', '10', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1',
    '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', '-b:v', '8M', ...aac()],
  // 読めない音声（AC-3）が AAC と一緒に入った動画（iPhone の空間オーディオと同じ状況）
  'two-audio.mov': [...noisy('1280x720', 30), ...tone(), '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '10', ...x264('8M'), '-c:a:0', 'aac', '-b:a:0', '160k', '-c:a:1', 'ac3', '-b:a:1', '192k'],
};

function run(args) { execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }); }

for (const [name, args] of Object.entries(VIDEOS)) {
  const file = path.join(OUT, name);
  if (fs.existsSync(file)) continue;
  process.stdout.write('作成: ' + name + ' … ');
  run([...args, file]);
  console.log((fs.statSync(file).size / 1e6).toFixed(1) + 'MB');
}

// 他の動画から作るもの
const derived = {
  // iPhone の縦動画と同じ「横長で保存して、回転情報で縦に見せる」形
  'portrait-rot90.mov': () => run(['-display_rotation', '90', '-i', path.join(OUT, '1080p60-45s.mp4'), '-c', 'copy', '-t', '20', path.join(OUT, 'portrait-rot90.mov')]),
  // 位置情報入りの小さい動画（Android の ©xyz と、iPhone の com.apple.quicktime.location.ISO6709 の2通り）
  'location-xyz.mov': () => run(['-i', path.join(OUT, 'small-5mb.mp4'), '-t', '5', '-c', 'copy', '-metadata', 'location=+35.6812+139.7671/',
    path.join(OUT, 'location-xyz.mov')]),
  'location-iphone.mp4': () => run(['-i', path.join(OUT, 'small-5mb.mp4'), '-t', '5', '-c', 'copy', '-movflags', 'use_metadata_tags',
    '-metadata', 'com.apple.quicktime.location.ISO6709=+35.6812+139.7671/', path.join(OUT, 'location-iphone.mp4')]),
  // 途中で切れた動画と、動画ではないファイル
  'truncated.mp4': () => fs.writeFileSync(path.join(OUT, 'truncated.mp4'), fs.readFileSync(path.join(OUT, '720p-60s.mp4')).subarray(0, 300000)),
  'text.mp4': () => fs.writeFileSync(path.join(OUT, 'text.mp4'), 'not a video\n'),
};
for (const [name, make] of Object.entries(derived)) {
  if (fs.existsSync(path.join(OUT, name))) continue;
  process.stdout.write('作成: ' + name + ' … ');
  make();
  console.log((fs.statSync(path.join(OUT, name)).size / 1e6).toFixed(1) + 'MB');
}
// 名前に大きさ（例: 1279x719）が入っている動画は、本当にその大きさで作れたかを確かめる（テストの前提が崩れていないか）
function videoSize(file) {
  let text = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) { text = String(e.stderr || ''); }
  const m = /Video: .*?, (\d+)x(\d+)/.exec(text);
  return m ? m[1] + 'x' + m[2] : null;
}
let wrong = 0;
for (const name of fs.readdirSync(OUT)) {
  const want = /(\d+)x(\d+)/.exec(name);
  if (!want) continue;
  const got = videoSize(path.join(OUT, name));
  if (got !== want[0]) {
    wrong++;
    console.error('大きさが違う: ' + name + ' → ' + got + '（このファイルを消して、もう一度 npm run test:videos を実行してください）');
  }
}
if (wrong) process.exit(1);
console.log('テスト用の動画: ' + OUT);
