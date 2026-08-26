// コメント編集テーブル。docs/spec.md §7.1
import { COLORS } from './config.js';
import { parseTime, formatTime, normalizeColor } from './parser.js';

const POS_LABEL = { naka: '流れる', ue: '上固定', shita: '下固定' };
const SIZE_LABEL = { small: '小', medium: '中', big: '大' };

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

const select = (options, value, onchange) => {
  const s = el('select');
  for (const [v, label] of options) s.append(el('option', { value: v, textContent: label }));
  s.value = value;
  s.onchange = () => onchange(s.value);
  return s;
};

export class CommentTable {
  /**
   * @param tbody   <tbody>
   * @param selAll  ヘッダーの全選択チェックボックス
   * @param hooks   { onEdit(structural), onDelete(id), onSeek(time), onSelectionChange(ids) }
   */
  constructor(tbody, selAll, hooks) {
    this.tbody = tbody;
    this.selAll = selAll;
    this.hooks = hooks;
    this.rows = new Map(); // id -> <tr>
    this.comments = [];
    this.lit = new Set();
    this.selected = new Set();
    this.lastIndex = -1;    // 範囲選択の起点

    this.selAll.onclick = () => {
      if (this.selAll.checked) this.selectAll();
      else this.clearSelection();
    };
  }

  render(comments) {
    this.comments = comments;
    // 消えたコメントの選択は落とす
    const alive = new Set(comments.map(c => c.id));
    for (const id of [...this.selected]) if (!alive.has(id)) this.selected.delete(id);

    this.tbody.replaceChildren();
    this.rows.clear();
    this.lit.clear();
    const frag = document.createDocumentFragment();
    for (const c of comments) {
      const tr = this.#row(c);
      this.rows.set(c.id, tr);
      frag.append(tr);
    }
    this.tbody.append(frag);
    this.#syncSelectionUI();
  }

  // ---------------------------------------------------------------- 選択
  getSelection() { return [...this.selected]; }

  selectAll() {
    this.selected = new Set(this.comments.map(c => c.id));
    this.#syncSelectionUI();
  }

  clearSelection() {
    this.selected.clear();
    this.lastIndex = -1;
    this.#syncSelectionUI();
  }

  #toggle(index, on, range) {
    if (range && this.lastIndex >= 0) {
      const [a, b] = this.lastIndex < index ? [this.lastIndex, index] : [index, this.lastIndex];
      for (let i = a; i <= b; i++) {
        const id = this.comments[i]?.id;
        if (id) on ? this.selected.add(id) : this.selected.delete(id);
      }
    } else {
      const id = this.comments[index]?.id;
      if (id) on ? this.selected.add(id) : this.selected.delete(id);
    }
    this.lastIndex = index;
    this.#syncSelectionUI();
  }

  #syncSelectionUI() {
    for (const [id, tr] of this.rows) {
      const on = this.selected.has(id);
      tr.classList.toggle('sel', on);
      const box = tr.querySelector('.c-sel input');
      if (box) box.checked = on;
    }
    const n = this.selected.size, total = this.comments.length;
    this.selAll.checked = total > 0 && n === total;
    this.selAll.indeterminate = n > 0 && n < total;
    this.hooks.onSelectionChange?.(n);
  }

  #row(c) {
    const tr = el('tr');
    tr.dataset.id = c.id;
    tr.onmousedown = (e) => {
      if (e.target.closest('input, select, button')) return;
      this.hooks.onSeek(c.time);
    };

    // 選択。Shift 併用で範囲選択
    const box = el('input', { type: 'checkbox', checked: this.selected.has(c.id) });
    box.onclick = (e) => {
      const index = this.comments.indexOf(c);
      this.#toggle(index, box.checked, e.shiftKey);
    };
    tr.append(el('td', { className: 'c-sel' }, box));

    // 時刻。バッジで自動 / 固定を切り替える
    const pin = el('button', { className: 'pin', type: 'button' });
    const time = el('input', {
      type: 'text', value: formatTime(c.time), placeholder: '自動',
    });

    const paintPin = () => {
      pin.textContent = c.auto ? '自動' : '固定';
      pin.classList.toggle('is-auto', !!c.auto);
      pin.title = c.auto
        ? '自動で時刻が決まっています。押すとここに固定します'
        : 'この時刻に固定しています。押すと自動に戻します';
      time.classList.toggle('auto', !!c.auto);
    };
    paintPin();

    pin.onclick = () => {
      c.auto = !c.auto;
      paintPin();
      this.hooks.onEdit(true);
    };

    // 編集中の欄は syncAutoTimes に上書きさせない
    time.onfocus = () => { time.dataset.editing = '1'; };

    time.oninput = () => {
      time.dataset.editing = '1';
      const raw = time.value.trim();
      if (raw === '') {                          // 空 → 自動に戻す
        time.classList.remove('bad');
        if (!c.auto) { c.auto = true; paintPin(); this.hooks.onEdit(false); }
        return;
      }
      const v = parseTime(raw);
      time.classList.toggle('bad', v === null);
      if (v === null) return;
      c.time = v;
      if (c.auto) { c.auto = false; paintPin(); }
      this.hooks.onEdit(false);
    };

    time.onchange = () => {
      delete time.dataset.editing;
      const raw = time.value.trim();
      if (raw === '') { c.auto = true; paintPin(); this.hooks.onEdit(true); return; }
      const v = parseTime(raw);
      if (v === null) {                          // 直せない入力は元に戻す
        time.value = formatTime(c.time);
        time.classList.remove('bad');
        return;
      }
      c.time = v; c.auto = false; paintPin();
      this.hooks.onEdit(true);                   // 並べ替えて描き直す
    };

    const cell = el('div', { className: 'time-cell' }, pin, time);
    tr.append(el('td', { className: 'c-time' }, cell));

    // 本文
    const text = el('input', { type: 'text', value: c.text.replace(/\n/g, '\\n') });
    text.oninput = () => { c.text = text.value.replace(/\\n/g, '\n'); this.hooks.onEdit(false); };
    tr.append(el('td', { className: 'c-text' }, text));

    // 色
    const colorOpts = [...Object.keys(COLORS).map(k => [k, k]), ['custom', '任意の色…']];
    const isNamed = !!COLORS[c.color];
    const colorTd = el('td', { className: 'c-color' });
    const sel = select(colorOpts, isNamed ? c.color : 'custom', (v) => {
      if (v === 'custom') { colorTd.replaceChildren(custom); custom.focus(); return; }
      c.color = v; this.hooks.onEdit(false);
    });
    const custom = el('input', { type: 'text', value: isNamed ? '#FFFFFF' : c.color, placeholder: '#RRGGBB' });
    custom.oninput = () => {
      const v = normalizeColor(custom.value);
      custom.classList.toggle('bad', v === null);
      if (v) { c.color = v; this.hooks.onEdit(false); }
    };
    colorTd.append(isNamed ? sel : custom);
    tr.append(colorTd);

    // 位置 / サイズ
    tr.append(el('td', { className: 'c-pos' },
      select(Object.entries(POS_LABEL), c.pos, (v) => { c.pos = v; this.hooks.onEdit(false); })));
    tr.append(el('td', { className: 'c-size' },
      select(Object.entries(SIZE_LABEL), c.size, (v) => { c.size = v; this.hooks.onEdit(false); })));

    // 削除
    const del = el('button', { className: 'del-btn', textContent: '✕', title: '削除' });
    del.onclick = () => this.hooks.onDelete(c.id);
    tr.append(el('td', { className: 'c-del' }, del));

    return tr;
  }

  /** 再生位置に対応する行をハイライトする */
  highlight(activeIds) {
    for (const id of this.lit) {
      if (!activeIds.has(id)) this.rows.get(id)?.classList.remove('now');
    }
    for (const id of activeIds) {
      if (!this.lit.has(id)) this.rows.get(id)?.classList.add('now');
    }
    this.lit = activeIds;
  }

  /** 上限で表示されなかった行を薄くする */
  markHidden(hiddenIds) {
    for (const [id, tr] of this.rows) tr.classList.toggle('hidden-row', hiddenIds.has(id));
  }

  /** 自動配置の行の時刻表示だけを更新する(全体を作り直さずに済ませる) */
  syncAutoTimes(comments) {
    for (const c of comments) {
      if (!c.auto) continue;
      const input = this.rows.get(c.id)?.querySelector('.time-cell input');
      if (!input || input.dataset.editing) continue;
      const v = formatTime(c.time);
      if (input.value !== v) input.value = v;
      input.classList.add('auto');
    }
  }

  focusText(id) {
    const tr = this.rows.get(id);
    if (!tr) return;
    tr.scrollIntoView({ block: 'nearest' });
    tr.querySelector('.c-text input')?.focus();
  }
}
