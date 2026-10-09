// ニコニコ動画の描画パラメータ。すべて「高さ384の基準座標系」で定義する。
// 出典: niconicomments (https://github.com/xpadev-net/niconicomments) の実装値
// docs/spec.md §2 を参照。

export const BASE_HEIGHT = 384;

export const BUNDLED_FONT = "'NicoComeJP'";
export const SYSTEM_FONT =
  "'ヒラギノ角ゴ ProN W6', HiraKakuProN-W6, 'Hiragino Kaku Gothic ProN', " +
  "Arial, 'ＭＳ Ｐゴシック', 'MS PGothic', sans-serif";

export const DEFAULT_SETTINGS = {
  // フォントサイズ(基準座標系 px)
  fontSize: { small: 18, medium: 27, big: 39 },
  // 1画面に入る行数 → 行高 = 384 / これ
  lineCounts: { small: 21, medium: 13.1, big: 8.4 },

  scrollDuration: 4.0, // naka が画面を横断する秒数
  fixedDuration: 3.0,  // ue / shita の表示秒数

  strokeWidth: 2.8,    // 縁取りの線幅(基準座標系 px)
  strokeOpacity: 0.4,  // 縁取りの不透明度

  maxActive: 40,       // 同時表示数の上限
  maxLength: 75,       // 1コメントの最大文字数

  // コメント同士の横の余白(ステージ幅に対する比率)。本家は 1920幅中 5px
  collisionPadding: 5 / 1920,

  fontFamily: BUNDLED_FONT,
  fontWeight: 600,
  fontScale: 1,      // 文字の大きさの倍率。サイズと行数をまとめて動かす

  // 時刻を指定しないコメントの自動配置(docs/spec.md §3.5)
  auto: {
    enabled: false,
    mode: 'spread',  // 'spread' = 区間全体に均等 / 'rate' = 毎秒N件
    rate: 2.5,       // mode === 'rate' のときの毎秒の件数
    jitter: 0.6,     // 間隔のゆらぎ 0〜1
    start: 0,        // 配置する区間の開始(秒)
    endMode: 'video',// 'video' 動画の最後まで / 'fit' 最後のコメントが流れ切るまで / 'custom' 時刻指定
    end: null,       // endMode === 'custom' のときの終了時刻
    csvMaterialize: false, // CSV書き出しで自動の時刻を確定させるか
  },
};

export const COLORS = {
  white: '#FFFFFF', red: '#FF0000', pink: '#FF8080', orange: '#FFC000',
  yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', blue: '#0000FF',
  purple: '#C000FF', black: '#000000',
};

export const COLOR_ALIASES = {
  白: 'white', しろ: 'white', シロ: 'white',
  赤: 'red', あか: 'red', アカ: 'red',
  桃: 'pink', 桃色: 'pink', ももいろ: 'pink', ピンク: 'pink',
  橙: 'orange', 橙色: 'orange', だいだい: 'orange', オレンジ: 'orange',
  黄: 'yellow', 黄色: 'yellow', きいろ: 'yellow', キイロ: 'yellow',
  緑: 'green', みどり: 'green', ミドリ: 'green',
  水: 'cyan', 水色: 'cyan', みずいろ: 'cyan', シアン: 'cyan',
  青: 'blue', あお: 'blue', アオ: 'blue',
  紫: 'purple', むらさき: 'purple', ムラサキ: 'purple', パープル: 'purple',
  黒: 'black', くろ: 'black', クロ: 'black',
};

export const POS_ALIASES = { 中: 'naka', 上: 'ue', 下: 'shita', naka: 'naka', ue: 'ue', shita: 'shita' };
export const SIZE_ALIASES = { 小: 'small', 中: 'medium', 大: 'big', small: 'small', medium: 'medium', big: 'big' };

export const lineHeight = (settings, size) => BASE_HEIGHT / settings.lineCounts[size];

/**
 * 「文字の大きさ」の倍率を織り込んだ設定を返す。
 * フォントサイズを k 倍したら行数は 1/k にしないと、
 * 文字だけ大きくなって行間が変わらない不自然な絵になる。
 */
export function effectiveSettings(s) {
  const k = s.fontScale ?? 1;
  if (Math.abs(k - 1) < 1e-6) return s;
  const scale = (o, f) => Object.fromEntries(Object.entries(o).map(([key, v]) => [key, f(v)]));
  return {
    ...s,
    fontSize: scale(s.fontSize, v => v * k),
    lineCounts: scale(s.lineCounts, v => v / k),
  };
}

/** 基準座標系でのステージ幅を、動画の縦横比から求める */
export const stageWidth = (videoW, videoH) => (videoW / videoH) * BASE_HEIGHT;
