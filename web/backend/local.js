// ローカル版のバックエンド。動画をサーバーに預け、書き出しは ffmpeg にやらせる。
// ProRes などブラウザが扱えない形式も通せるのが利点。
import { encodeFrame } from '../rle.js';
import { draw } from '../renderer.js';

export const name = 'local';

export const capabilities = {
  /** 書き出しの選択肢。値は index.html の <option> と対応する */
  targets: ['composite', 'layer:mp4', 'layer:qtrle', 'layer:prores', 'layer:png'],
  canReveal: true,
  /** サーバーが ffmpeg で変換するので、ブラウザが再生できない形式も読める */
  anyInputFormat: true,
};

export async function probe() {
  const res = await fetch('/api/info');
  if (!res.ok) throw new Error('サーバーがいません');
  return res.json();
}

export async function loadVideo(file, { onProgress }) {
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
    body: file,
  });
  const info = await res.json();
  if (!res.ok) throw new Error(info.error || '読み込みに失敗しました');

  let previewUrl = `/api/media/${info.id}/file`;
  if (info.needsProxy) {
    onProgress?.(0, 'プレビュー用に変換しています…');
    await makeProxy(info.id, (r) => onProgress?.(r, 'プレビュー用に変換しています…'));
    previewUrl += '?proxy=1';
  }
  return { ...info, previewUrl };
}

function makeProxy(id, onProgress) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/media/${id}/proxy`);
    es.addEventListener('progress', (e) => onProgress(JSON.parse(e.data).ratio));
    es.addEventListener('done', () => { es.close(); resolve(); });
    es.addEventListener('failed', (e) => { es.close(); reject(new Error(JSON.parse(e.data).error)); });
    es.onerror = () => { es.close(); reject(new Error('変換中に接続が切れました')); };
  });
}

/** 連結されたフレームのかたまりを作る。server/index.js の splitBatch と対になる */
const packBatch = (arrs) => {
  const size = 4 + arrs.reduce((s, a) => s + 4 + a.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let off = 0;
  dv.setUint32(off, arrs.length, true); off += 4;
  for (const a of arrs) { dv.setUint32(off, a.length, true); off += 4; out.set(a, off); off += a.length; }
  return out;
};

export async function exportVideo({ media, mode, format, bg, laid, settings, onProgress, isCancelled }) {
  const start = await fetch('/api/export', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaId: media.id, mode, format, bg }),
  }).then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error); return j; }));
  const exportId = start.exportId;

  try {
    const { width, height, fps, duration } = media;
    const total = Math.max(1, Math.round(duration * fps));
    const off = new OffscreenCanvas(width, height);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    const dims = { w: width, h: height };

    const MAX_BATCH_BYTES = 8 * 1024 * 1024;
    const MAX_BATCH_FRAMES = 60;

    const send = async (batch) => {
      const res = await fetch(`/api/export/${exportId}/frames`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: packBatch(batch),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'フレームの送信に失敗しました');
    };

    let batch = [], batchBytes = 0, inflight = null, sendError = null;
    const guard = (p) => p.catch((e) => { sendError = sendError || e; });

    for (let f = 0; f < total; f++) {
      if (isCancelled()) throw new Error('__cancelled__');
      if (sendError) throw sendError;
      draw(ctx, laid, f / fps, settings, dims);
      const enc = encodeFrame(ctx.getImageData(0, 0, width, height).data);
      batch.push(enc); batchBytes += enc.length;

      if (batchBytes >= MAX_BATCH_BYTES || batch.length >= MAX_BATCH_FRAMES || f === total - 1) {
        // 送信中に次のコマを描けるように 1 本だけ先行させる(順番は保つ)
        if (inflight) await inflight;
        if (sendError) throw sendError;
        const b = batch; batch = []; batchBytes = 0;
        inflight = guard(send(b));
        if (f === total - 1) { await inflight; if (sendError) throw sendError; }
      }
      if (f % 4 === 0 || f === total - 1) onProgress((f + 1) / total, f + 1, total);
    }

    onProgress(1, total, total, '仕上げています…');
    const fin = await fetch(`/api/export/${exportId}/finish`, { method: 'POST' })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error); return j; }));

    return {
      name: fin.name, size: fin.size,
      reveal: () => fetch('/api/reveal', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: fin.outPath }),
      }),
    };
  } catch (e) {
    await fetch(`/api/export/${exportId}/abort`, { method: 'POST' }).catch(() => {});
    throw e;
  }
}
