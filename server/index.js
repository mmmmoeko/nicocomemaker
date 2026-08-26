import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkTools } from './ffmpeg.js';
import { probe } from './probe.js';
import { makeProxy } from './proxy.js';
import { startExport, getExport, writeFrames, finishExport, abortExport } from './export.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const WORK = path.join(ROOT, 'work');
const OUTPUT = process.env.NICOCOME_OUTPUT || path.join(ROOT, 'output');
const PORT = Number(process.env.PORT || 5178);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

const media = new Map(); // id -> { name, file, proxyFile, info }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req, limit = 512 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('本文が大きすぎます')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/** Range 対応のファイル配信(<video> のシークに必要) */
function serveFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

/** 連結された PNG のかたまりを 1 枚ずつに切り分ける */
function splitBatch(buf) {
  const out = [];
  let off = 0;
  const count = buf.readUInt32LE(off); off += 4;
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(off); off += 4;
    out.push(buf.subarray(off, off + len)); off += len;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- 動画の受け取り
    if (p === '/api/media' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || 'input.mp4');
      const id = 'm' + Math.random().toString(36).slice(2, 10);
      const file = path.join(WORK, id + (path.extname(name) || '.mp4'));
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(file);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      const info = await probe(file);
      media.set(id, { name, file, proxyFile: null, info });
      return json(res, 200, { id, name, ...info });
    }

    // ---- 動画の配信(<video> 用)
    let m = /^\/api\/media\/([^/]+)\/file$/.exec(p);
    if (m && req.method === 'GET') {
      const rec = media.get(m[1]);
      if (!rec) return json(res, 404, { error: '動画が見つかりません' });
      const useProxy = url.searchParams.get('proxy') === '1' && rec.proxyFile;
      return serveFile(req, res, useProxy ? rec.proxyFile : rec.file);
    }

    // ---- プロキシ生成(進捗を SSE で返す)
    m = /^\/api\/media\/([^/]+)\/proxy$/.exec(p);
    if (m && req.method === 'GET') {
      const rec = media.get(m[1]);
      if (!rec) return json(res, 404, { error: '動画が見つかりません' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (rec.proxyFile && fs.existsSync(rec.proxyFile)) {
        send('done', { ok: true });
        return res.end();
      }
      const out = path.join(WORK, m[1] + '_proxy.mp4');
      try {
        await makeProxy(rec.file, out, rec.info.duration, (r) => send('progress', { ratio: r }));
        rec.proxyFile = out;
        send('done', { ok: true });
      } catch (e) {
        send('failed', { error: String(e.message || e) });
      }
      return res.end();
    }

    // ---- 書き出し開始
    if (p === '/api/export' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 1 << 20));
      const rec = media.get(body.mediaId);
      if (!rec) return json(res, 404, { error: '動画が見つかりません' });
      const session = startExport({
        mode: body.mode === 'layer' ? 'layer' : 'composite',
        format: body.format || 'qtrle',
        bg: body.bg,
        input: rec.file,
        width: rec.info.width,
        height: rec.info.height,
        fpsRational: rec.info.fpsRational,
        hasAudio: rec.info.hasAudio,
        acodec: rec.info.acodec,
        outDir: OUTPUT,
        sourceName: rec.name,
      });
      return json(res, 200, { exportId: session.id, outPath: session.outPath });
    }

    // ---- フレーム受け取り
    m = /^\/api\/export\/([^/]+)\/frames$/.exec(p);
    if (m && req.method === 'POST') {
      const session = getExport(m[1]);
      if (!session) return json(res, 404, { error: '書き出しセッションがありません' });
      const buf = await readBody(req);
      await writeFrames(session, splitBatch(buf));
      return json(res, 200, { frames: session.frames });
    }

    // ---- 書き出し完了 / 中断
    m = /^\/api\/export\/([^/]+)\/(finish|abort)$/.exec(p);
    if (m && req.method === 'POST') {
      const session = getExport(m[1]);
      if (!session) return json(res, 404, { error: '書き出しセッションがありません' });
      if (m[2] === 'abort') { await abortExport(session); return json(res, 200, { ok: true }); }
      const outPath = await finishExport(session);
      const size = fs.statSync(outPath).size ?? 0;
      return json(res, 200, { ok: true, outPath, name: path.basename(outPath), size });
    }

    // ---- Finder で表示
    if (p === '/api/reveal' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 1 << 16));
      const target = path.resolve(body.path || OUTPUT);
      if (!target.startsWith(path.resolve(OUTPUT))) return json(res, 400, { error: '範囲外です' });
      spawn('open', ['-R', target], { stdio: 'ignore', detached: true }).unref();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/info' && req.method === 'GET') {
      return json(res, 200, { outputDir: OUTPUT });
    }

    // ---- 静的ファイル
    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const file = path.join(WEB, rel);
      if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
      return serveFile(req, res, file);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
    else res.end();
  }
});

const missing = await checkTools();
if (missing.length) {
  console.error(`\n  ${missing.join(' と ')} が見つかりません。`);
  console.error('  Homebrew なら: brew install ffmpeg\n');
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ニコメメーカー`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  書き出し先: ${OUTPUT}\n`);
});
