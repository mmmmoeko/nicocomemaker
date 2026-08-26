// 描画エンジン。プレビューと書き出しの両方がこれだけを使う。
// 「時刻 t → その瞬間の画」を状態なしで描くので、シークしても常に正しく、
// プレビューと出力が原理的に一致する。docs/spec.md §4.4 を参照。

import { BASE_HEIGHT, stageWidth } from './config.js';
import { resolveColor } from './parser.js';
import { fontSpec, fontMetrics } from './layout.js';

const hexToRgba = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** #RRGGBB が十分に暗ければ縁を白に反転する(本家は #000000 のときだけ) */
const strokeFor = (fill) => (fill.toUpperCase() === '#000000' ? '#FFFFFF' : '#000000');

/** t 秒時点で表示中のコメントを返す(時刻順の配列に対する範囲抽出) */
export function activeAt(laid, t, settings) {
  const maxDur = Math.max(settings.scrollDuration, settings.fixedDuration);
  // time >= t - maxDur の先頭を二分探索
  let lo = 0, hi = laid.length;
  const from = t - maxDur;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (laid[mid].time < from) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < laid.length; i++) {
    const c = laid[i];
    if (c.time > t) break;
    if (c.visible && t < c.end) out.push(c);
  }
  return out;
}

/**
 * @param ctx    2D コンテキスト(キャンバスは動画と同じ解像度)
 * @param laid   layout() の結果
 * @param t      秒
 * @param settings
 * @param dims   { w, h } キャンバスの実ピクセル
 * @param opts.clear すでに動画フレームを描いたキャンバスに重ねるときは false
 */
export function draw(ctx, laid, t, settings, dims, { clear = true } = {}) {
  if (clear) ctx.clearRect(0, 0, dims.w, dims.h);
  const scale = dims.h / BASE_HEIGHT;
  const baseW = stageWidth(dims.w, dims.h);

  ctx.save();
  ctx.scale(scale, scale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = settings.strokeWidth;

  for (const c of activeAt(laid, t, settings)) {
    const x = c.pos === 'naka'
      ? baseW - (t - c.time) * c._speed
      : (baseW - c._w) / 2;

    const fill = resolveColor(c.color);
    ctx.font = fontSpec(settings, c.size);
    ctx.strokeStyle = hexToRgba(strokeFor(fill), settings.strokeOpacity);
    ctx.fillStyle = fill;

    // 字面を行の中で縦中央に置き、画面の上下からはみ出す分だけ寄せる
    const fm = fontMetrics(settings, c.size);
    const inset = (c._lh - fm.ink) / 2;
    let shift = 0;
    const inkTop = c.y + inset;
    const inkBottom = c.y + (c._lines.length - 1) * c._lh + inset + fm.ink;
    if (inkTop < 0) shift = -inkTop;
    else if (inkBottom > BASE_HEIGHT) shift = Math.max(-inkTop, BASE_HEIGHT - inkBottom);

    for (let i = 0; i < c._lines.length; i++) {
      const baseline = c.y + i * c._lh + inset + fm.ascent + shift;
      ctx.strokeText(c._lines[i], x, baseline);
      ctx.fillText(c._lines[i], x, baseline);
    }
  }
  ctx.restore();
}
