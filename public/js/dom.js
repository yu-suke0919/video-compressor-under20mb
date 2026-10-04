// 画面の要素（ほかのモジュールを読み込まない）

// ---------------------------------------------------------------- 要素
export var $ = function (id) { return document.getElementById(id); };
export var els = {
  unsupported: $('unsupported'), file: $('file'), pickBtn: $('pickBtn'), repickBtn: $('repickBtn'),
  app: document.querySelector('.app'),
  srcVideo: $('srcVideo'), srcInfo: $('srcInfo'), srcBox: $('srcBox'), outBox: $('outBox'),
  trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimFill: $('trimFill'), trimBox: $('trimBox'), quickNote: $('quickNote'), quickNoteSize: $('quickNoteSize'), trimLabel: $('trimLabel'),
  trimTicks: $('trimTicks'), trimSeek: $('trimSeek'),
  res480: $('res480'), res720: $('res720'), res1080: $('res1080'), resSource: $('resSource'), resSeg: $('resSeg'), modeQuality: $('modeQuality'), modeSize: $('modeSize'),
  sizeLabel: $('sizeLabel'), planInfo: $('planInfo'), planWarn: $('planWarn'),
  targetSize: $('targetSize'), halfFps: $('halfFps'), audioOn: $('audioOn'), audioLabel: $('audioLabel'),
  minRate720: $('minRate720'), minRate1080: $('minRate1080'), autoRun: $('autoRun'), capLabel: $('capLabel'),
  preUse: $('preUse'), preUseLabel: $('preUseLabel'),
  urlCopy: $('urlCopy'), urlStatus: $('urlStatus'),
  resetSettings: $('resetSettings'), runBtn: $('runBtn'), progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressNote: $('progressNote'),
  phase: $('phase'), pct: $('pct'),
  outVideo: $('outVideo'), outEmpty: $('outEmpty'), outInfo: $('outInfo'), outNote: $('outNote'), outWarn: $('outWarn'),
  shareBtn: $('shareBtn'), saveBtn: $('saveBtn'),
  nameOn: $('nameOn'), nameBox: $('nameBox'), nameList: $('nameList'), namePreview: $('namePreview'),
  diagBox: $('diagBox'), diagOut: $('diagOut'), diagCopy: $('diagCopy'), diagStatus: $('diagStatus')
};
