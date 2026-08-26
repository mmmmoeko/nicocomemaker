// ブラウザだけで完結するバックエンド。サーバーが要らないので、
// 静的ホスティングに置いて URL で配れる。
//
// 読み書きは mediabunny(WebCodecs)。実測では ffmpeg 経由のローカル版より速い
// (ハードウェアエンコーダを使うため)。docs/spec.md §13 を参照。
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, EncodedPacketSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, EncodedAudioPacketSource,
  QUALITY_HIGH, canEncodeVideo,
} from '../vendor/mediabunny.mjs';
import { draw } from '../renderer.js';

export const name = 'browser';

export const capabilities = {
  targets: ['composite', 'layer:mp4'],
  canReveal: false,
  anyInputFormat: false,
};

/** ファイルごとの Input を覚えておく(書き出しで読み直すため) */
const inputs = new Map();

export async function probe() {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('このブラウザは動画の書き出しに対応していません(Chrome / Edge / Safari 17+ でお試しください)');
  }
  return { outputDir: null };
}

export async function loadVideo(file, { onProgress }) {
  onProgress?.(0, '読み込んでいます…');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error('映像が見つかりません');
  if (!(await vTrack.canDecode())) {
    throw new Error(`このブラウザは ${vTrack.codec} を再生できません(mp4 / H.264 でお試しください)`);
  }
  const aTrack = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();

  // fps はコンテナに書いていないこともあるので、先頭のパケットから実測する
  const stats = await vTrack.computePacketStats(120);
  const fps = stats.averagePacketRate > 0 && stats.averagePacketRate < 1000 ? stats.averagePacketRate : 30;

  const id = 'b' + Math.random().toString(36).slice(2, 10);
  inputs.set(id, { input, vTrack, aTrack, file });

  return {
    id, name: file.name,
    width: vTrack.displayWidth, height: vTrack.displayHeight,
    fps, fpsRational: String(Math.round(fps * 1000)) + '/1000',
    duration, vcodec: vTrack.codec, acodec: aTrack?.codec ?? null,
    hasAudio: !!aTrack, needsProxy: false,
    previewUrl: URL.createObjectURL(file),
  };
}

export async function exportVideo({ media, mode, format, bg, laid, settings, onProgress, isCancelled }) {
  const rec = inputs.get(media.id);
  if (!rec) throw new Error('動画が見つかりません');
  const { vTrack, aTrack } = rec;
  const { width: W, height: H, duration } = media;

  if (!(await canEncodeVideo('avc', { width: W, height: H }))) {
    throw new Error('このブラウザは H.264 の書き出しに対応していません');
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const dims = { w: W, h: H };

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource);

  // 合成のときだけ音声を持ち込む。コメントだけの書き出しに音は要らない
  const wantAudio = mode === 'composite' && !!aTrack;
  let audioSource = null, aConf = null;
  if (wantAudio) {
    aConf = await aTrack.getDecoderConfig();
    audioSource = new EncodedAudioPacketSource(aTrack.codec);
    output.addAudioTrack(audioSource);
  }
  await output.start();

  try {
    const total = Math.max(1, Math.round(duration * media.fps));
    let n = 0;

    if (mode === 'composite') {
      const sink = new VideoSampleSink(vTrack);
      for await (const sample of sink.samples()) {
        if (isCancelled()) throw new Error('__cancelled__');
        ctx.clearRect(0, 0, W, H);
        sample.draw(ctx, 0, 0, W, H);
        draw(ctx, laid, sample.timestamp, settings, dims, { clear: false });
        const ts = sample.timestamp, dur = sample.duration;
        sample.close();
        await videoSource.add(ts, dur);
        n++;
        if (n % 4 === 0) onProgress(Math.min(1, n / total), n, total);
      }
    } else {
      // コメントだけ。選んだ背景色の上に描く
      const fps = media.fps;
      for (let f = 0; f < total; f++) {
        if (isCancelled()) throw new Error('__cancelled__');
        ctx.fillStyle = bg || '#000000';
        ctx.fillRect(0, 0, W, H);
        draw(ctx, laid, f / fps, settings, dims, { clear: false });
        await videoSource.add(f / fps, 1 / fps);
        n++;
        if (n % 4 === 0) onProgress(n / total, n, total);
      }
    }
    videoSource.close();

    if (wantAudio) {
      onProgress(1, total, total, '音声を書き出しています…');
      const psink = new EncodedPacketSink(aTrack);
      let first = true;
      for await (const p of psink.packets()) {
        // AAC はエンコーダ遅延で先頭の時刻が負になることがある
        const q = p.timestamp < 0
          ? p.clone({ timestamp: 0, duration: Math.max(0, p.duration + p.timestamp) })
          : p;
        await audioSource.add(q, first ? { decoderConfig: aConf } : undefined);
        first = false;
      }
      audioSource.close();
    }

    onProgress(1, total, total, 'ファイルをまとめています…');
    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('書き出しに失敗しました');
    const blob = new Blob([buffer], { type: 'video/mp4' });

    const base = media.name.replace(/\.[^.]+$/, '').replace(/[/\\:]/g, '_');
    const ts = stamp();
    const fileName = mode === 'composite'
      ? `${base}_${ts}.mp4`
      : `${base}_comments_${ts}.mp4`;

    download(blob, fileName);
    return { name: fileName, size: blob.size, reveal: null };
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
