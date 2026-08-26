import { spawn } from 'node:child_process';
import { FFMPEG } from './ffmpeg.js';

/**
 * プレビュー用のプロキシ動画を作る。
 * 書き出しには使わない — あくまでブラウザで再生できる形にするためだけのもの。
 */
export function makeProxy(input, output, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-v', 'error', '-y',
      '-i', input,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-vf', 'scale=-2:min(720\\,ih)',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      output,
    ]);
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'out_time_ms' && duration > 0) {
          const done = Number(v) / 1e6;
          onProgress?.(Math.max(0, Math.min(1, done / duration)));
        }
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) { onProgress?.(1); resolve(output); }
      else reject(new Error(`プロキシ生成に失敗しました\n${err.slice(-2000)}`));
    });
  });
}
