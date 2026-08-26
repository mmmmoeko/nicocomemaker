// コメント層のフレームを軽量に圧縮する(送信側)。
// server/rle.js の decodeFrame と対になる。
//
// コメント層は画素のほとんどが完全透明(RGBA すべて 0)なので、
// 「透明が何画素続くか + 実データ何画素 + その中身」の繰り返しで表す。
// 実測でおおむね 1/50 〜 1/100 になり、生の RGBA を送るより桁違いに速い。

let scratch = null;

/**
 * @param data getImageData().data (Uint8ClampedArray)
 * @returns Uint8Array 圧縮済み
 */
export function encodeFrame(data) {
  const px = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  const n = px.length;
  // 最悪ケース(透明と不透明が1画素ずつ交互)で 1.5n ワード
  const need = Math.ceil(n * 1.5) + 16;
  if (!scratch || scratch.length < need) scratch = new Uint32Array(need);
  const out = scratch;

  let o = 0, i = 0;
  while (i < n) {
    let z = i;
    while (z < n && px[z] === 0) z++;
    out[o++] = z - i;
    i = z;
    let l = i;
    while (l < n && px[l] !== 0) l++;
    out[o++] = l - i;
    for (let k = i; k < l; k++) out[o++] = px[k];
    i = l;
  }
  return new Uint8Array(out.buffer.slice(0, o * 4));
}
