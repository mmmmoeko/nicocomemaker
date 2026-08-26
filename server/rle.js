// コメント層のフレームを復元する(受信側)。web/rle.js の encodeFrame と対になる。

/**
 * @param buf    圧縮済みフレーム
 * @param pixels 画素数 (width * height)
 * @returns Buffer 生の RGBA
 */
export function decodeFrame(buf, pixels) {
  // Uint32Array のビューを作るには 4 バイト境界に揃っている必要がある
  const aligned = (buf.byteOffset % 4 === 0)
    ? buf
    : Buffer.from(buf);
  const src = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength >> 2);

  const out = Buffer.alloc(pixels * 4); // 0 埋め = 完全透明
  const dst = new Uint32Array(out.buffer, out.byteOffset, pixels);

  let i = 0, p = 0;
  while (p < pixels && i < src.length) {
    p += src[i++];                       // 透明のぶんは 0 のまま進める
    if (i >= src.length) break;
    const lit = src[i++];
    for (let k = 0; k < lit; k++) dst[p++] = src[i++];
  }
  if (p !== pixels) throw new Error(`フレームの画素数が合いません (${p} / ${pixels})`);
  return out;
}
