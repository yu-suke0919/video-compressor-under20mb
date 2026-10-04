// 版を上げる（npm run bump）。public/ のファイルを変えたら、コミットの前に1回実行する
//   js/constants.js の APP_VERSION … 診断情報に出す版。今日の日付＋英字（同じ日なら英字を1つ進める：…k → l）
//   sw.js のキャッシュ名 … v100 → v101。上げないと、利用者のスマホに前の版のキャッシュが残り続ける
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

// ファイルの中の1か所を書き換える（見つからなければ止める）
function bump(file, pattern, next) {
  const p = path.join(PUBLIC, file);
  const text = fs.readFileSync(p, 'utf8');
  const m = pattern.exec(text);
  if (!m) throw new Error(file + ' に版が見つかりません: ' + pattern);
  const to = next(m[1]);
  fs.writeFileSync(p, text.replace(pattern, m[0].replace(m[1], to)));
  console.log(file + ': ' + m[1] + ' → ' + to);
}

// 日付の後ろの英字を1つ進める（a → b … z → za）
function nextLetters(s) {
  if (!s) return 'a';
  const last = s[s.length - 1];
  return last === 'z' ? s + 'a' : s.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
}

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

bump('js/constants.js', /var APP_VERSION = '([^']+)'/, v => {
  const m = /^(\d{4}-\d{2}-\d{2})([a-z]*)$/.exec(v);
  const date = today();
  return m && m[1] === date ? date + nextLetters(m[2]) : date + 'a';
});
bump('sw.js', /CACHE_PREFIX \+ 'v(\d+)'/, v => String(Number(v) + 1));
