// 定数（ほかのモジュールを読み込まない）。APP_VERSION は npm run bump で上げる

export var M = globalThis.Mediabunny;   // vendor/mediabunny.min.js（Node の単体テストでは無い）

// ---------------------------------------------------------------- 定数
export var DEFAULT_TARGET_MB = 20;            // Discord無料アカウントの上限（2026年8月に10MBから引き上げ）
export var MIN_TARGET_MB = 1;
// 許容する最小サイズ（目標サイズに対する％）。「◯MB以内」で、先行圧縮を切り出した大きさがこれ以上（目標未満）なら、そのまま使う
export var PRE_USE_PCT_DEFAULT = 80;
export var PRE_USE_PCT_LIMITS = [50, 100];
export var MAX_TARGET_MB = 500;
export var MB = 1000 * 1000;                  // 1MB = 100万バイト（iPhoneのファイル表示と同じ数え方）
export var SIZE_SAFETY = 0.97;                // 目標サイズの97%を狙う（20MB→19.4MB）。エンコーダの誤差（数%）を吸収して再圧縮を避ける
// 「◯MB以内に圧縮」で、目標のこの割合以下に仕上がったら、小さく済んだ理由を出す（エンコーダーが、画質が十分な所で使う量を抑えた）
export var SMALL_RESULT_RATIO = 0.8;
export var AUDIO_BITRATE = 128000;            // 音声を再エンコードするときのビットレート
export var AUDIO_COPY_MAX_BITRATE = 192000;   // これ以下のAACは再エンコードせずそのまま使う
export var DISCORD_FREE_BYTES = 20 * MB;     // Discord無料アカウントの上限（注意文の基準）
// 下限ビットレートの既定値（kbps）。720p30で1.2Mbps、1080pは画素数に比例させて同等の画質
export var DEFAULT_MIN_KBPS = { '720': 1200, '1080': 2700 };
export var MIN_KBPS_LIMITS = [100, 50000];
// 60fps のまま書き出すときは、下限ビットレートをこの倍率にする（下限は30fpsを前提にした値。
// 60fps のままだと1コマあたりのデータが半分になる。60fps はとなりのコマが似ていて圧縮しやすいので2倍までは要らない）
export var HIGH_FPS_FLOOR_FACTOR = 1.5;
// 映像ビットレートの上限（元の動画のビットレートに対する倍率）。元より高いビットレートで焼き直しても、画質は上がらず容量が増えるだけ。
// 元が HEVC のときは、書き出す H.264 で同じ画質にするのに約1.5倍のビットレートが要るので、1.5倍まで許す
export var SRC_CAP_RATIO = 1, SRC_CAP_RATIO_HEVC = 1.5;
export var MSG_UNREACHABLE = '目標サイズに圧縮できません。トリミングして短くするか、設定変更から低い解像度・fpsを選択してください。';
// 2 で、目標サイズに収まらない見込みのときの案内（2行目）
export var MSG_OVER_HINT = 'トリミングして短くするか、設定変更から低い解像度・fpsを選択してください。';
// 指定ビットレートを下げても大きさが変わらない端末（エンコーダーがそれ以上下げない）。下げる案内の代わりに出す
export var MSG_DEVICE_FLOOR = 'この端末ではこれ以上ビットレートを下げられないみたいです。';
export var MSG_UNREACHABLE_FLOOR = '目標サイズに圧縮できません。' + MSG_DEVICE_FLOOR;
export var MSG_OVER_DISCORD = '20MBを超えるため、Discordの無料アカウントでは送信できません。';
export var MSG_LOCATION = '位置情報が含まれている動画です。この情報はアップロードされず、圧縮後の動画には位置情報を含めません。';
export var SETTINGS_KEY = 'video-compressor-under20mb:settings';   // 画面で変えた設定を覚えておく場所（この端末のブラウザ内だけ）
export var DEFAULT_FPS = 30;
export var MAX_FPS = 60;
export var MAX_ATTEMPTS = 3;                  // 初回 + 最大2回の再圧縮
// ビットレートを下げて圧縮し直しても（先行圧縮をやり直しても）、前回よりこの割合以上小さくならなければ、
// この端末ではそれ以上下げられないとみる（VBR の指定を守らず、下げても小さくならないエンコーダーがある。Android の実機であった）。
// 「◯MB以内」の圧縮し直しはそこでやめ、指定ビットレートを下げる案内の代わりに MSG_DEVICE_FLOOR を出す
export var MIN_SHRINK = 0.03;
export var KEYFRAME_INTERVAL = 2;             // 秒
export var MIN_TRIM_LENGTH = 0.5;             // 秒
export var AUDIO_DECODE_MAX_BYTES = 400 * MB;   // 互換モードで音声を扱うファイルサイズの上限
export var APP_VERSION = '2026-10-07a';        // 診断情報に出す（どの版で起きたかを見分ける）
export var CANCELLED = 'cancelled';
export var SNAPSHOT_MAX_BYTES = 600 * MB;     // Android で動画をブラウザ内に写し取る上限（これより大きい動画は写さない）
export var STALLED = 'stalled';
export var STALL_MS = 20000;                  // 画面を表示しているのに進捗がこれだけ止まったら、互換モードに切り替える
export var BG_STALL_MS = 3000;                // 別のアプリから戻ったあと、進捗がこれだけ止まっていたら、最初からやり直す（動いていれば戻って1秒以内に進む）
export var CLEANUP_WAIT_MS = 3000;            // やり直す前に、止めた処理の後片付けを待つ上限
export var DECODER_CHECK_MS = 2000;           // デコーダーがこれだけ応答しなければ、固まっているとみなす（普段はすぐ応答し、固まると全く応答しない）
export var FAIL_SETTLE_MS = 1500;             // 失敗してから、別のアプリに切り替えたかを見極めるまで待つ時間
export var FROZEN_GAP_MS = 3000;              // 1秒ごとの見回りの間がこれより空いたら、ページが止められていた（裏に回っていた）とみなす
export var MAX_BG_RETRIES = 3;                // 別のアプリに切り替えたために失敗したとき、やり直す回数の上限
export var MSG_BG_RETRY = '別のアプリに切り替えたため、最初からやり直し中';

// 出力に使うコーデック（優先順）。高速モードは Mediabunny の名前、互換モードは WebCodecs のコーデック文字列
export var FAST_VIDEO_CODECS = ['avc', 'hevc'];
export var FAST_AUDIO_CODEC = 'aac';
export var COMPAT_VIDEO_CODECS = [
  { codec: 'avc1.4D0028', mb: 'avc', extra: { avc: { format: 'avc' } } },
  { codec: 'avc1.42E028', mb: 'avc', extra: { avc: { format: 'avc' } } },
  { codec: 'avc1.640028', mb: 'avc', extra: { avc: { format: 'avc' } } },
  { codec: 'avc1.42E01F', mb: 'avc', extra: { avc: { format: 'avc' } } },
  { codec: 'avc1.640033', mb: 'avc', extra: { avc: { format: 'avc' } } },   // 1080pより大きい「元の解像度」用（レベル5.1）
  { codec: 'hvc1.1.6.L123.B0', mb: 'hevc', extra: { hevc: { format: 'hevc' } } }
];
export var COMPAT_AUDIO_CODEC = { codec: 'mp4a.40.2', mb: 'aac' };
// 高速モードで読める入力形式。iPhoneの撮影動画(mov)とSwitchの動画(mp4)が対象。それ以外は互換モードで処理する
export var INPUT_FORMATS = M ? [M.MP4, M.QTFF] : [];
