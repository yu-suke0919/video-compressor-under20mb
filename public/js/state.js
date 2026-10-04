// アプリの状態（ほかのモジュールを読み込まない）

// ---------------------------------------------------------------- 状態
export var state = {
  file: null,
  meta: null,          // { duration, width, height, fps, fpsMeasured, audio: {codec, bitrate}|null|undefined }
  engine: null,        // 'fast' | 'compat'
  trim: { start: 0, end: 0 },
  plan: null,
  caps: { aac: false, compat: false },
  running: false,
  busy: false,         // 読み込み・解析中
  picking: null,       // 選んだ動画（Android でブラウザ内に写している間に、別の動画が選ばれたかを見分ける）
  job: null,           // 実行中の圧縮1回ぶん（キャンセルは実行ごとに管理する）
  attemptJob: null,    // その中の1回の処理（進まなくなったらこれだけ止める）
  loadError: null,     // 動画を読み込めなかった理由（次の動画を選ぶまで表示する）
  srcUrl: null,
  out: null,           // { blob, name, type, original, url }
  compatAudio: null,   // 互換モードで再圧縮するときに音声を使い回す
  wakeLock: null
};
