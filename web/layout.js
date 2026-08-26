// レーン割り当ての事前計算。docs/spec.md §4 を参照。
//
// renderer が「時刻 t → その瞬間の画」を状態なしで描けるように、
// コメントの縦位置・幅・速度をここで一括で決めておく。
// 同じ入力からは必ず同じ結果が出る(乱数もシード付き)ので、
// プレビューと書き出しが一致する。

import { BASE_HEIGHT, lineHeight, stageWidth } from './config.js';

/** 文字列から決定的に 0..1 の値を作る。
 *  乱数だと再計算のたびに絵が変わってしまうので、必ずこれを使う。 */
export function seededUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

let measureCtx = null;
function getMeasureCtx() {
  if (!measureCtx) {
    const c = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(8, 8)
      : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
    measureCtx = c.getContext('2d');
  }
  return measureCtx;
}

export const fontSpec = (settings, size) =>
  `${settings.fontWeight} ${settings.fontSize[size]}px ${settings.fontFamily}`;

// 実際の字面の高さ。和文フォントは字面が em ボックスより大きいので、
// 行高だけで置くと画面の上端・下端で文字が切れる。
const metricsCache = new Map();

/** @returns {{ascent:number, descent:number, ink:number}} ベースラインからの上下 */
export function fontMetrics(settings, size) {
  const key = fontSpec(settings, size);
  let m = metricsCache.get(key);
  if (m) return m;
  const ctx = getMeasureCtx();
  ctx.font = key;
  const t = ctx.measureText('あA亜g');
  const fs = settings.fontSize[size];
  const ascent = t.fontBoundingBoxAscent ?? t.actualBoundingBoxAscent ?? fs * 0.88;
  const descent = t.fontBoundingBoxDescent ?? t.actualBoundingBoxDescent ?? fs * 0.24;
  m = { ascent, descent, ink: ascent + descent };
  metricsCache.set(key, m);
  return m;
}

export const clearMetricsCache = () => metricsCache.clear();

/**
 * 空きスロットを探す。
 * blockers: [{y, h}] その時刻にまだ場所を占有しているもの
 * fromTop=false なら下から詰める(shita 用)
 * 見つからなければ null
 */
function findSlot(blockers, h, baseH, fromTop) {
  const cands = [fromTop ? 0 : baseH - h];
  for (const b of blockers) cands.push(fromTop ? b.y + b.h : b.y - h);
  cands.sort((a, b) => (fromTop ? a - b : b - a));
  for (const y of cands) {
    if (y < -0.01 || y + h > baseH + 0.01) continue;
    if (blockers.some(b => y < b.y + b.h - 0.01 && b.y < y + h - 0.01)) continue;
    return Math.max(0, Math.min(baseH - h, y));
  }
  return null;
}

/**
 * コメント配列にレイアウトを付与して返す(元の配列は変更しない)。
 * 返り値の各要素には以下が加わる:
 *   _lines 描画する行  _w 幅  _h 高さ  _fs フォントサイズ  _lh 行高
 *   _speed 移動速度(基準座標系 px/秒)  y 縦位置  end 消える時刻
 *   visible 表示するか  overlapped 重ねて表示したか
 */
export function layout(comments, videoW, videoH, settings) {
  const ctx = getMeasureCtx();
  const baseW = stageWidth(videoW, videoH);
  const baseH = BASE_HEIGHT;
  const colRight = baseW * settings.collisionRight;
  const pad = baseW * settings.collisionPadding;

  const sorted = [...comments].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));

  // 占有状況。pos ごとに独立(本家も naka / ue / shita は別々に判定する)
  const slots = { naka: [], ue: [], shita: [] };
  const active = []; // 同時表示数の上限判定用

  const out = [];
  for (const c of sorted) {
    const d = { ...c };
    const fs = settings.fontSize[d.size];
    const lh = lineHeight(settings, d.size);
    const lines = String(d.text).slice(0, settings.maxLength).split('\n');

    ctx.font = fontSpec(settings, d.size);
    const w = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
    const h = lh * lines.length;

    d._lines = lines; d._fs = fs; d._lh = lh; d._w = w; d._h = h;

    const dur = d.pos === 'naka' ? settings.scrollDuration : settings.fixedDuration;
    d.end = d.time + dur;
    d._speed = d.pos === 'naka' ? (baseW + w) / settings.scrollDuration : 0;

    // 同時表示数の上限
    while (active.length && active[0] <= d.time) active.shift();
    if (active.length >= settings.maxActive) {
      d.visible = false; d.y = 0; d.overlapped = false;
      out.push(d);
      continue;
    }

    // レーンが空く時刻
    let freeAt;
    if (d.pos === 'naka') {
      // 右端の判定ラインを抜けきったら、後続を入れてよい
      const t = (baseW + w - colRight + pad) / d._speed;
      freeAt = d.time + Math.max(0, Math.min(settings.scrollDuration, t));
    } else {
      freeAt = d.end;
    }

    const list = slots[d.pos];
    // 期限切れを掃除
    for (let i = list.length - 1; i >= 0; i--) if (list[i].free <= d.time) list.splice(i, 1);

    let y = findSlot(list, h, baseH, d.pos !== 'shita');
    d.overlapped = y === null;
    if (y === null) y = seededUnit(d.id) * Math.max(0, baseH - h); // 空き無し → 重ねる

    d.y = y;
    d.visible = true;
    list.push({ y, h, free: freeAt });

    // active を終了時刻の昇順に保つ
    const at = d.end;
    let lo = 0, hi = active.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (active[mid] < at) lo = mid + 1; else hi = mid; }
    active.splice(lo, 0, at);

    out.push(d);
  }
  return out;
}
