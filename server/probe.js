import { FFPROBE, run } from './ffmpeg.js';

// ブラウザの <video> がそのまま再生できる見込みのあるコーデック
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const ratio = (s) => {
  const [n, d] = String(s || '0/1').split('/').map(Number);
  return d ? n / d : 0;
};

export async function probe(file) {
  const json = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(json);
  const v = data.streams.find(s => s.codec_type === 'video');
  const a = data.streams.find(s => s.codec_type === 'audio');
  if (!v) throw new Error('映像ストリームが見つかりません');

  // r_frame_rate はコンテナ由来で異常値のことがあるので avg_frame_rate も見る
  const rFps = ratio(v.r_frame_rate);
  const aFps = ratio(v.avg_frame_rate);
  const fps = (aFps > 0 && aFps < 1000) ? aFps : (rFps > 0 && rFps < 1000 ? rFps : 30);
  const fpsRational = (aFps > 0 && aFps < 1000) ? v.avg_frame_rate : (rFps > 0 && rFps < 1000 ? v.r_frame_rate : '30/1');

  const duration = Number(data.format?.duration ?? v.duration ?? 0);

  // 回転メタデータがあると表示上の縦横が入れ替わる
  const rot = Number(
    v.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? 0
  );
  const swap = Math.abs(rot) === 90 || Math.abs(rot) === 270;
  const width = swap ? v.height : v.width;
  const height = swap ? v.width : v.height;

  const vcodec = v.codec_name || '';
  const acodec = a?.codec_name || null;
  const needsProxy =
    !PLAYABLE_VIDEO.has(vcodec) || (acodec !== null && !PLAYABLE_AUDIO.has(acodec));

  return {
    width, height, fps, fpsRational, duration,
    vcodec, acodec, hasAudio: !!a, rotation: rot,
    needsProxy,
    proxyReason: needsProxy
      ? (!PLAYABLE_VIDEO.has(vcodec)
          ? `映像コーデック ${vcodec} はブラウザで再生できません`
          : `音声コーデック ${acodec} はブラウザで再生できません`)
      : null,
  };
}
