// vendor/mediabunny.min.js の元になるエントリ。
// アプリが使う機能だけを書き出し、esbuild で必要な部分だけを束ねる（npm run build:vendor）。
// 入力形式は MP4 / MOV（QTFF）だけに絞って容量を抑えている。
export {
  Input, BlobSource, MP4, QTFF,
  Output, Mp4OutputFormat, BufferTarget,
  Conversion, Quality, canEncodeVideo, canEncodeAudio,
  EncodedPacket, EncodedVideoPacketSource, EncodedAudioPacketSource
} from 'mediabunny';
