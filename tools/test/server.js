// テスト用に public/ を配信する小さなサーバー（Cloudflare Pages の代わり。_headers の CSP も付ける）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'public');
const PORT = Number(process.env.PORT || 8777);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'
};

// _headers の「/*」に書いたヘッダーを、すべての応答に付ける
function readHeaders() {
  const lines = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n');
  const headers = {};
  let inAll = false;
  for (const line of lines) {
    if (/^\S/.test(line)) { inAll = line.trim() === '/*'; continue; }
    const m = /^\s+([^:#]+):\s*(.+)$/.exec(line);
    if (inAll && m) headers[m[1].trim()] = m[2].trim();
  }
  return headers;
}
const EXTRA = readHeaders();

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }, EXTRA));
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('テスト用サーバー: http://127.0.0.1:' + PORT + '/'));
