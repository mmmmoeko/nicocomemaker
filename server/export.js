import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG } from './ffmpeg.js';
import { decodeFrame } from './rle.js';

const sessions = new Map();

export function timestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** docs/spec.md §9.3 のファイル名規則 */
export function outputName(sourceName, mode, format) {
  const base = path.basename(sourceName, path.extname(sourceName)).replace(/[/\\:]/g, '_');
  const ts = timestamp();
  if (mode === 'composite') return `${base}_${ts}.mp4`;
  if (format === 'png') return `${base}_comments_${ts}`;            // ディレクトリ
  if (format === 'mp4') return `${base}_comments_${ts}.mp4`;
  return `${base}_comments_${ts}.mov`;
}

/** ffmpeg に渡せる色に直す。おかしな値はフィルタを壊すので黒に倒す */
const ffColor = (hex) => (/^#[0-9a-fA-F]{6}$/.test(String(hex || '')) ? '0x' + hex.slice(1) : '0x000000');

function buildArgs({ mode, format, input, fpsRational, width, height, out, hasAudio, acodec, bg }) {
  const a = ['-v', 'error', '-y'];
  // コメント層は生の RGBA で受け取る。ブラウザ側の PNG エンコードが
  // 1コマ約1秒かかって現実的でないため(docs/spec.md §9)。
  const layerIn = [
    '-f', 'rawvideo', '-pixel_format', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', fpsRational, '-i', 'pipe:0',
  ];

  if (mode === 'composite') {
    a.push('-i', input, ...layerIn);
    a.push('-filter_complex', '[0:v][1:v]overlay=format=auto:eof_action=pass');
    a.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
    if (!hasAudio) a.push('-an');
    else if (acodec === 'aac') a.push('-c:a', 'copy');
    else a.push('-c:a', 'aac', '-b:a', '192k');
    a.push('-movflags', '+faststart');
  } else if (format === 'mp4') {
    // コメントだけを、選んだ背景色の上に置いて mp4 にする
    a.push('-f', 'lavfi', '-i', `color=c=${ffColor(bg)}:s=${width}x${height}:r=${fpsRational}`);
    a.push(...layerIn);
    a.push('-filter_complex', '[0:v][1:v]overlay=format=auto:shortest=1');
    a.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
    a.push('-an', '-movflags', '+faststart');
  } else {
    a.push(...layerIn);
    if (format === 'png') a.push('-c:v', 'png');
    else if (format === 'prores') a.push('-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le');
    else a.push('-c:v', 'qtrle', '-pix_fmt', 'argb');
    a.push('-an');
  }
  a.push(out);
  return a;
}

/**
 * 書き出しを開始する。フレームはブラウザから順に POST されてくる。
 * mode: 'composite' | 'layer'
 * format: 'qtrle' | 'prores' | 'png'   (layer のときだけ意味を持つ)
 */
export function startExport(opts) {
  const id = 'x' + Math.random().toString(36).slice(2, 10);
  const { mode, format, outDir, sourceName } = opts;
  const name = outputName(sourceName, mode, format);
  const outPath = path.join(outDir, name);

  const session = {
    id, mode, format, outPath,
    pixels: opts.width * opts.height,
    frames: 0, done: false, error: null, aborted: false, proc: null,
  };

  {
    if (mode === 'layer' && format === 'png') fs.mkdirSync(outPath, { recursive: true });
    const target = (mode === 'layer' && format === 'png')
      ? path.join(outPath, '%06d.png') : outPath;
    const args = buildArgs({ ...opts, out: target });
    const proc = spawn(FFMPEG, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdin.on('error', () => { /* kill 時の EPIPE は無視 */ });
    session.proc = proc;
    session.exited = new Promise((resolve) => {
      proc.on('error', (e) => { session.error = e.message; resolve(); });
      proc.on('close', (code) => {
        if (code !== 0 && !session.aborted) {
          session.error = `ffmpeg が異常終了しました (code ${code})\n${err.slice(-2000)}`;
        }
        resolve();
      });
    });
  }

  sessions.set(id, session);
  return session;
}

export const getExport = (id) => sessions.get(id);

/** フレームのまとまりを書き込む。ffmpeg の受け入れ速度に合わせて待つ(逆圧) */
export async function writeFrames(session, frames) {
  if (session.aborted) throw new Error('中断済みです');
  if (session.error) throw new Error(session.error);

  const stdin = session.proc.stdin;
  for (const encoded of frames) {
    if (session.aborted) throw new Error('中断済みです');
    if (!stdin.writable) throw new Error(session.error || 'ffmpeg への書き込みができません');
    if (!stdin.write(decodeFrame(encoded, session.pixels))) {
      await new Promise((res, rej) => {
        const onDrain = () => { cleanup(); res(); };
        const onClose = () => { cleanup(); rej(new Error(session.error || 'ffmpeg が終了しました')); };
        const cleanup = () => { stdin.off('drain', onDrain); stdin.off('close', onClose); };
        stdin.once('drain', onDrain);
        stdin.once('close', onClose);
      });
    }
    session.frames++;
  }
}

export async function finishExport(session) {
  session.proc.stdin.end();
  await session.exited;
  if (session.error) throw new Error(session.error);
  session.done = true;
  return session.outPath;
}

export async function abortExport(session) {
  session.aborted = true;
  if (session.proc) {
    session.proc.kill('SIGKILL');
    await session.exited.catch(() => {});
  }
  await fs.promises.rm(session.outPath, { recursive: true, force: true }).catch(() => {});
  sessions.delete(session.id);
}
