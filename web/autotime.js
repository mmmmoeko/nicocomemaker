// 時刻を指定していないコメントに、自動で時刻を振る。
// docs/spec.md §3.5 を参照。
//
// 「自動」の行は time が計算で埋まるだけで、それ以外は普通のコメントと同じ。
// レンダラもレイアウトも書き出しも、自動かどうかを気にしない。

import { seededUnit } from './layout.js';

/**
 * comments の auto:true の行に time を振る(配列は書き換える)。
 * 並び順は seq を使うので、リストの上から順に流れる。
 *
 * @returns 密度の情報(UI に出す用)
 */
export function applyAutoTimes(comments, duration, settings) {
  const A = settings.auto;
  const autos = comments.filter(c => c.auto).sort((a, b) => a.seq - b.seq);
  const info = {
    count: autos.length, spacing: 0, rate: 0, onScreen: 0,
    overflow: 0, start: 0, end: 0, ready: false, cramped: false,
  };
  if (!autos.length || !(duration > 0)) return info;

  const start = Math.max(0, Math.min(A.start ?? 0, duration));

  // 区間の終わり。'fit' は、最後のコメントが動画の終わりまでに
  // 流れ切る位置(= 尺 - 横断秒数)で打ち切る。
  const mode = A.endMode ?? 'video';
  const rawEnd =
    mode === 'fit' ? duration - settings.scrollDuration :
    mode === 'custom' ? (A.end ?? duration) :
    duration;
  const end = Math.max(start + 0.05, Math.min(rawEnd, duration));
  const span = end - start;
  info.cramped = mode === 'fit' && rawEnd <= start;  // 尺が短すぎて区間が取れない

  const spacing = A.mode === 'rate'
    ? 1 / Math.max(0.05, A.rate)
    : span / autos.length;

  // ゆらぎはコメントIDから決定的に作る。乱数だと再計算のたびに全部が飛び跳ねる。
  const times = autos.map((c, i) =>
    start + (i + 0.5) * spacing + (seededUnit(c.id) - 0.5) * spacing * A.jitter);

  // ゆらぎで前後が入れ替わらないように並べ直す。
  // これで「リストの上から順」を保ったまま、間隔だけが不揃いになる。
  times.sort((a, b) => a - b);

  let overflow = 0;
  autos.forEach((c, i) => {
    let t = times[i];
    if (t < start) t = start;
    if (A.mode === 'spread' && t > end) t = end;
    if (t > duration) overflow++;
    c.time = Math.round(t * 1000) / 1000;
  });

  info.spacing = spacing;
  info.rate = 1 / spacing;
  info.onScreen = info.rate * settings.scrollDuration;
  info.overflow = overflow;
  info.start = start;
  info.end = end;
  info.ready = true;
  return info;
}
