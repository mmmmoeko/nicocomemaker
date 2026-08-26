import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** ffmpeg / ffprobe が使えるか確認する */
export async function checkTools() {
  const missing = [];
  for (const bin of [FFMPEG, FFPROBE]) {
    const ok = await new Promise((res) => {
      const p = spawn(bin, ['-version'], { stdio: 'ignore' });
      p.on('error', () => res(false));
      p.on('close', (code) => res(code === 0));
    });
    if (!ok) missing.push(bin);
  }
  return missing;
}

export function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; onStderr?.(String(d)); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}\n${err.slice(-4000)}`));
    });
  });
}
