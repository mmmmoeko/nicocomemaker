// CSV <-> Comment[] の相互変換。docs/spec.md §3 を参照。
import { COLORS, COLOR_ALIASES, POS_ALIASES, SIZE_ALIASES } from './config.js';

/** RFC4180 相当の CSV パーサ。引用符・改行入りフィールド・CRLF に対応 */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  text = text.replace(/^﻿/, ''); // BOM
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',' || ch === '\t') { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

const HEADER_MAP = {
  time: 'time', 時刻: 'time', 時間: 'time', 秒: 'time', 秒数: 'time', vpos: 'time',
  text: 'text', コメント: 'text', 本文: 'text', 内容: 'text', comment: 'text',
  color: 'color', 色: 'color', カラー: 'color',
  pos: 'pos', position: 'pos', 位置: 'pos', 場所: 'pos',
  size: 'size', サイズ: 'size', 大きさ: 'size', 文字サイズ: 'size',
};

/** "12" / "12.5" / "1:23" / "1:23.5" / "0:01:23" を秒に変換。不正なら null */
export function parseTime(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0, mi = +m[2], se = parseFloat(m[3]);
  // 「90:00」のように時が無い場合は 60 分以上も認める
  if (se >= 60 || (m[1] && mi > 59)) return null;
  return h * 3600 + mi * 60 + se;
}

export function formatTime(sec, withDecimal = true) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return withDecimal
    ? `${m}:${s.toFixed(1).padStart(4, '0')}`
    : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** CSV に書くときの時刻。往復で値がずれないよう 1ms まで保つ */
export function formatTimePrecise(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.round(sec * 1000) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) - h * 60;
  const s = total - (h * 3600 + m * 60);
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  const frac = ms ? '.' + String(ms).padStart(3, '0').replace(/0+$/, '') : '';
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(whole).padStart(2, '0')}${frac}`;
}

export function normalizeColor(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'white';
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map(c => c + c).join('')).toUpperCase();
  const key = s.toLowerCase();
  if (COLORS[key]) return key;
  if (COLOR_ALIASES[s]) return COLOR_ALIASES[s];
  return null;
}

/** 色名 or #RRGGBB → #RRGGBB */
export const resolveColor = (c) => (COLORS[c] ?? c);

export const normalizePos = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return 'naka';
  return POS_ALIASES[s] ?? POS_ALIASES[s.toLowerCase()] ?? null;
};

export const normalizeSize = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return 'medium';
  return SIZE_ALIASES[s] ?? SIZE_ALIASES[s.toLowerCase()] ?? null;
};

let idSeq = 0;
export const newId = () => `c${(++idSeq).toString(36)}${Math.floor(performance.now() * 1000).toString(36)}`;

/**
 * CSV テキスト → { comments, errors }
 * errors: [{ line, reason, raw }]
 */
export function csvToComments(text) {
  const rows = parseCSV(text);
  const comments = [], errors = [];
  if (!rows.length) return { comments, errors };

  // ヘッダー行の判定: 1行目のいずれかのセルが既知の列名なら、それをヘッダーとみなす
  const first = rows[0].map(c => c.trim());
  const mapped = first.map(c => HEADER_MAP[c] ?? HEADER_MAP[c.toLowerCase()] ?? null);
  const hasHeader = mapped.some(Boolean) && parseTime(first[0]) === null;

  let cols;
  if (hasHeader) {
    cols = mapped;
  } else if (parseTime(first[0]) === null) {
    // ヘッダーも時刻も無い ＝ 本文だけを並べた一覧。全部を自動配置にする
    cols = ['text', 'color', 'pos', 'size'];
  } else {
    cols = ['time', 'text', 'color', 'pos', 'size']; // ヘッダー無しは位置で対応
  }

  const start = hasHeader ? 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const line = r + 1;
    const cells = rows[r];
    if (!cells.length || cells.every(c => c.trim() === '')) continue;      // 空行
    if (cells[0].trim().startsWith('#')) continue;                          // コメント行

    const get = (name) => {
      const idx = cols.indexOf(name);
      return idx >= 0 ? (cells[idx] ?? '') : '';
    };
    const raw = cells.join(', ');

    // 時刻が空(または time 列そのものが無い)なら自動配置にする
    const rawTime = String(get('time') ?? '').trim();
    let time = 0, auto = true;
    if (rawTime !== '') {
      const t = parseTime(rawTime);
      if (t === null) { errors.push({ line, reason: '時刻を読めません', raw }); continue; }
      time = t; auto = false;
    }

    const text = String(get('text') ?? '').replace(/\\n/g, '\n');
    if (!text.trim()) { errors.push({ line, reason: '本文が空です', raw }); continue; }

    const color = normalizeColor(get('color'));
    if (color === null) { errors.push({ line, reason: `色「${get('color')}」を解釈できません`, raw }); continue; }

    const pos = normalizePos(get('pos'));
    if (pos === null) { errors.push({ line, reason: `位置「${get('pos')}」を解釈できません`, raw }); continue; }

    const size = normalizeSize(get('size'));
    if (size === null) { errors.push({ line, reason: `サイズ「${get('size')}」を解釈できません`, raw }); continue; }

    comments.push({ id: newId(), seq: comments.length, auto, time, text, color, pos, size });
  }
  comments.sort((a, b) => a.time - b.time);
  return { comments, errors };
}

const esc = (v) => {
  const s = String(v ?? '').replace(/\n/g, '\\n');
  return /[",\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Comment[] → CSV テキスト(スプレッドシートに貼り戻せる形)
 * 自動配置の行は time を空で書き出すので、読み直しても自動のままになる。
 * materializeAuto:true なら、その時点の時刻を書き込んで確定させる。
 */
export function commentsToCSV(comments, { materializeAuto = false } = {}) {
  const head = ['time', 'text', 'color', 'pos', 'size'];
  const lines = [head.join(',')];
  const ordered = [...comments].sort((a, b) => a.time - b.time || a.seq - b.seq);
  for (const c of ordered) {
    const t = (c.auto && !materializeAuto) ? '' : formatTimePrecise(c.time);
    lines.push([t, c.text, c.color, c.pos, c.size].map(esc).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
