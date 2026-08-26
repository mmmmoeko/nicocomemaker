// 静的ホスティングに置いたときと同じ状態で web/ を配るだけのサーバー。
// API が無いので、アプリはブラウザ用のバックエンドに切り替わる。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT || 5179);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.csv': 'text/csv; charset=utf-8',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }

  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = Math.min(m[2] ? Number(m[2]) : stat.size - 1, stat.size - 1);
    res.writeHead(206, {
      'content-type': type, 'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ニコメメーカー (ブラウザ版のプレビュー)`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  ※ ffmpeg は使いません。静的ホスティングに置いたときと同じ動きです\n`);
});
