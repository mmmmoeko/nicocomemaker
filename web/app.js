import { DEFAULT_SETTINGS, BUNDLED_FONT, SYSTEM_FONT, effectiveSettings } from './config.js';
import { csvToComments, commentsToCSV, formatTime, parseTime, newId } from './parser.js';
import { layout, clearMetricsCache } from './layout.js';
import { draw, activeAt } from './renderer.js';
import { CommentTable } from './table.js';
import { applyAutoTimes } from './autotime.js';

// バックエンドは起動時に選ぶ(ローカルのサーバーがいれば local、いなければ browser)
let backend = null;


const $ = (id) => document.getElementById(id);
const dom = {};
for (const id of ['bar','drop-hint','stage','video','canvas','stage-busy','busy-text','video-info',
  'pick-video','pick-video2','file-video','file-csv','toggle-alpha','play','seek','time',
  'steps','step1','step2','step3','help','help-pop','help-wrap',
  'list-count','sel-info','del-selected','clear-sel','add-here','btn-paste','pick-csv','save-csv',
  'del-all','undo','redo','sel-all','errors','tbody','table','empty-state',
  'time-auto','time-manual','auto-opts','auto-mode','auto-rate','auto-rate-row','auto-jitter',
  'auto-start','auto-end-mode','auto-end','auto-readout','auto-fix','auto-all',
  'paste-box','paste-area','paste-apply','paste-close','paste-append',
  'empty-paste','empty-apply','empty-csv','empty-one',
  'fields','adv-fields','advanced','reset-settings',
  'export','export-target','bg-wrap','export-bg','bg-black','bg-green','cancel-export','reveal','export-status','export-progress','export-fill']) {
  dom[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
}

const state = {
  media: null,
  comments: [],
  laid: [],
  settings: structuredClone(DEFAULT_SETTINGS),
  eff: null,          // 「文字の大きさ」倍率を織り込んだ設定。描画はこちらを使う
  autoInfo: null,
  alpha: false,
  exporting: false,
  exportedOnce: false,
  exportBg: '#00B140',   // 「コメントだけ mp4」の背景色。既定はクロマキー用の緑
};
const recomputeEff = () => { state.eff = effectiveSettings(state.settings); };
recomputeEff();

const clone = (cs) => cs.map(c => ({
  id: c.id, seq: c.seq, auto: !!c.auto, time: c.time,
  text: c.text, color: c.color, pos: c.pos, size: c.size,
}));
const nextSeq = () => state.comments.reduce((m, c) => Math.max(m, c.seq ?? 0), -1) + 1;

// ---------------------------------------------------------------- フォント
async function loadFont() {
  try {
    await document.fonts.load('600 27px NicoComeJP', 'あアA亜1');
    await document.fonts.load('400 27px NicoComeJP', 'あアA亜1');
    await document.fonts.ready;
  } catch (e) {
    console.warn('同梱フォントを読み込めませんでした', e);
    state.settings.fontFamily = SYSTEM_FONT;
  }
}

// ---------------------------------------------------------------- 保存 / 復帰
const LS_SETTINGS = 'nicocome.settings.v2';
const LS_COMMENTS = 'nicocome.comments.v2';

function persist() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify({ ...state.settings, __exportBg: state.exportBg }));
    localStorage.setItem(LS_COMMENTS, JSON.stringify(clone(state.comments)));
  } catch {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (s) state.settings = {
      ...structuredClone(DEFAULT_SETTINGS), ...s,
      fontSize: { ...DEFAULT_SETTINGS.fontSize, ...(s.fontSize || {}) },
      lineCounts: { ...DEFAULT_SETTINGS.lineCounts, ...(s.lineCounts || {}) },
      auto: { ...DEFAULT_SETTINGS.auto, ...(s.auto || {}) },
    };
    if (s.__exportBg) state.exportBg = s.__exportBg;
    delete state.settings.__exportBg;
    const c = JSON.parse(localStorage.getItem(LS_COMMENTS) || 'null');
    if (Array.isArray(c) && c.length) {
      state.comments = c.map((x, i) => ({ ...x, seq: x.seq ?? i, auto: !!x.auto }));
    }
  } catch {}
  recomputeEff();
}

// ---------------------------------------------------------------- 履歴
let past = [], future = [], pendingSnapshot = null;

function beginEdit() {
  if (!pendingSnapshot) return;
  past.push(pendingSnapshot); pendingSnapshot = null; future = [];
  if (past.length > 120) past.shift();
  updateHistoryUI();
}
function snapshot() {
  past.push(clone(state.comments)); future = []; pendingSnapshot = null;
  if (past.length > 120) past.shift();
  updateHistoryUI();
}
function updateHistoryUI() { dom.undo.disabled = !past.length; dom.redo.disabled = !future.length; }
function undo() {
  if (!past.length) return;
  future.push(clone(state.comments));
  state.comments = past.pop();
  refreshComments(true);
}
function redo() {
  if (!future.length) return;
  past.push(clone(state.comments));
  state.comments = future.pop();
  refreshComments(true);
}

// ---------------------------------------------------------------- テーブル
const table = new CommentTable(dom.tbody, dom.selAll, {
  onEdit: (structural) => { beginEdit(); refreshComments(structural); },
  onDelete: (id) => {
    snapshot();
    state.comments = state.comments.filter(c => c.id !== id);
    refreshComments(true);
  },
  onSeek: (t) => seekTo(t),
  onSelectionChange: (n) => updateSelectionUI(n),
});
dom.tbody.addEventListener('focusin', () => { pendingSnapshot = clone(state.comments); });

function updateSelectionUI(n) {
  const on = n > 0;
  dom.selInfo.hidden = !on;
  dom.delSelected.hidden = !on;
  dom.clearSel.hidden = !on;
  if (on) dom.selInfo.innerHTML = `· <b>${n}</b> 件を選択中`;
  dom.delAll.disabled = state.comments.length === 0;
}

function deleteComments(ids) {
  if (!ids.length) return;
  snapshot();
  const kill = new Set(ids);
  state.comments = state.comments.filter(c => !kill.has(c.id));
  table.clearSelection();
  refreshComments(true);
}

/** 2段階の確認。1回目で身構えて、3秒以内の2回目で実行する */
function armButton(btn, label, armedLabel, action) {
  let timer = null;
  const disarm = () => {
    clearTimeout(timer); timer = null;
    btn.classList.remove('armed'); btn.textContent = label;
  };
  btn.onclick = () => {
    if (timer) { disarm(); action(); return; }
    btn.classList.add('armed'); btn.textContent = armedLabel;
    timer = setTimeout(disarm, 3000);
  };
  btn.onblur = disarm;
}

// ---------------------------------------------------------------- 再計算
function relayout() {
  if (!state.media) { state.laid = []; return; }
  state.laid = layout(state.comments, state.media.width, state.media.height, state.eff);
  table.markHidden(new Set(state.laid.filter(c => !c.visible).map(c => c.id)));
}

/** structural=true なら並べ替えてテーブルを作り直す */
function refreshComments(structural) {
  state.autoInfo = applyAutoTimes(state.comments, state.media?.duration ?? 0, state.eff);

  if (structural) {
    state.comments.sort((a, b) => a.time - b.time || (a.seq ?? 0) - (b.seq ?? 0));
    table.render(state.comments);
  } else {
    table.syncAutoTimes(state.comments);
  }

  const n = state.comments.length;
  dom.emptyState.hidden = n > 0;
  dom.table.hidden = n === 0;
  const hidden = state.laid.filter(c => !c.visible).length;
  dom.listCount.textContent = `コメント ${n} 件` + (hidden ? ` (${hidden} 件は上限超過で非表示)` : '');
  dom.addHere.disabled = !state.media;
  dom.saveCsv.disabled = n === 0;

  updateSelectionUI(table.getSelection().length);
  updateExportEnabled();
  updateAutoReadout();
  updateSteps();
  relayout();
  redraw();
  persist();
}

// ---------------------------------------------------------------- 描画
let lastHighlight = 0;

function redraw() {
  if (!state.media) return;
  const ctx = dom.canvas.getContext('2d');
  const t = dom.video.currentTime || 0;
  draw(ctx, state.laid, t, state.eff, { w: dom.canvas.width, h: dom.canvas.height });

  const now = performance.now();
  if (now - lastHighlight > 90) {
    lastHighlight = now;
    table.highlight(new Set(activeAt(state.laid, t, state.eff).map(c => c.id)));
  }
  updateTransport();
}

function frameLoop() {
  redraw();
  if ('requestVideoFrameCallback' in dom.video) dom.video.requestVideoFrameCallback(frameLoop);
  else requestAnimationFrame(frameLoop);
}

let seeking = false;
function updateTransport() {
  if (!state.media) return;
  const t = dom.video.currentTime || 0, d = state.media.duration || 0;
  dom.time.textContent = `${formatTime(t)} / ${formatTime(d, false)}`;
  if (!seeking) dom.seek.value = String(d ? Math.round((t / d) * 1000) : 0);
  dom.play.textContent = dom.video.paused ? '▶' : '❙❙';
}

function seekTo(t) {
  if (!state.media) return;
  dom.video.currentTime = Math.max(0, Math.min(state.media.duration - 0.001, t));
  redraw();
}

// ---------------------------------------------------------------- 3ステップの案内
function updateSteps() {
  const s1 = !!state.media, s2 = state.comments.length > 0;
  const set = (el, done, now) => { el.classList.toggle('done', done); el.classList.toggle('now', now); };
  set(dom.step1, s1, !s1);
  set(dom.step2, s2, s1 && !s2);
  set(dom.step3, state.exportedOnce, s1 && s2 && !state.exportedOnce);
  dom.steps.hidden = s1 && s2 && state.exportedOnce;
}

// ---------------------------------------------------------------- 動画
function busy(text) { dom.busyText.textContent = text; dom.stageBusy.hidden = false; }
function unbusy() { dom.stageBusy.hidden = true; }

async function loadVideo(file) {
  busy(`${file.name} を読み込んでいます…`);
  dom.videoInfo.textContent = '読み込み中…';
  dom.videoInfo.classList.remove('warn');
  try {
    const info = await backend.loadVideo(file, {
      onProgress: (r, label) => busy(`${label} ${Math.round(r * 100)}%`),
    });
    state.media = info;

    dom.video.src = info.previewUrl;
    await new Promise((resolve, reject) => {
      dom.video.onloadedmetadata = resolve;
      dom.video.onerror = () => reject(new Error('ブラウザがこの動画を再生できません'));
    });

    dom.stage.classList.remove('empty');
    dom.canvas.width = info.width;
    dom.canvas.height = info.height;
    dom.play.disabled = false; dom.seek.disabled = false;
    const fpsTxt = info.fps.toFixed(info.fps % 1 ? 2 : 0);
    dom.videoInfo.textContent =
      `${info.name} · ${info.width}×${info.height} · ${fpsTxt}fps · ${formatTime(info.duration, false)}` +
      (info.needsProxy ? ' · プレビューは変換版' : '');
    refreshComments(true);
    unbusy();
  } catch (e) {
    unbusy();
    dom.videoInfo.textContent = String(e.message || e);
    dom.videoInfo.classList.add('warn');
  }
  updateExportEnabled();
  updateSteps();
}

// ---------------------------------------------------------------- コメントの取り込み
function showErrors(errors) {
  dom.errors.hidden = errors.length === 0;
  if (!errors.length) return;
  dom.errors.replaceChildren();
  const h = document.createElement('div');
  h.innerHTML = `<b>${errors.length} 行を読み込めませんでした</b>`;
  dom.errors.append(h);
  for (const e of errors.slice(0, 40)) {
    const d = document.createElement('div');
    d.textContent = `${e.line} 行目: ${e.reason} — ${e.raw.slice(0, 70)}`;
    dom.errors.append(d);
  }
  if (errors.length > 40) {
    dom.errors.append(Object.assign(document.createElement('div'),
      { textContent: `…ほか ${errors.length - 40} 行` }));
  }
}

/** CSV / 貼り付けテキストを取り込む */
function importText(text, { append = false } = {}) {
  const { comments, errors } = csvToComments(text);
  showErrors(errors);
  if (!comments.length) return { added: 0, errors: errors.length };

  snapshot();
  if (append) {
    const base = nextSeq();
    state.comments.push(...comments.map((c, i) => ({ ...c, seq: base + i })));
  } else {
    state.comments = comments;
    table.clearSelection();
  }

  // 時刻の無い行があるなら、自動配置を自分で入れてやる
  if (state.comments.some(c => c.auto) && !state.settings.auto.enabled) {
    state.settings.auto.enabled = true;
  }
  syncAutoUI();
  refreshComments(true);
  return { added: comments.length, errors: errors.length };
}

async function loadCSVFile(file) {
  importText(await file.text(), { append: false });
}

function saveCSV() {
  const blob = new Blob([commentsToCSV(state.comments)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'comments.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- 貼り付け
function wirePaste(area, applyBtn, getAppend) {
  const run = () => {
    const text = area.value.trim();
    if (!text) return;
    const r = importText(text, { append: getAppend() });
    if (r.added) { area.value = ''; dom.pasteBox.hidden = true; }
  };
  applyBtn.onclick = run;
  area.onpaste = () => setTimeout(run, 0);
  area.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  };
}

// ---------------------------------------------------------------- 設定パネル
const BASIC_FIELDS = [
  { group: '表示' },
  { path: 'fontScale', label: '文字の大きさ', type: 'range', min: 0.6, max: 2, step: 0.05,
    left: 'ちいさい', right: 'おおきい', fmt: v => `×${v.toFixed(2)}` },
  { path: 'fontWeight', label: '文字の太さ', type: 'range', min: 200, max: 900, step: 100,
    left: 'ほそい', right: 'ふとい', fmt: v => String(v) },
  { path: 'fontFamily', label: 'フォント', type: 'select',
    options: [[BUNDLED_FONT, '同梱 Noto Sans JP'], [SYSTEM_FONT, 'システム(ヒラギノ等)']] },
  { path: 'strokeOpacity', label: '縁取りの濃さ', type: 'range', min: 0, max: 1, step: 0.05,
    left: 'うすい', right: 'こい', fmt: v => `${Math.round(v * 100)}%` },

  { group: '流れ方' },
  { path: 'scrollDuration', label: '流れる速さ', type: 'range', min: 2, max: 8, step: 0.1,
    invert: true, left: 'ゆっくり', right: 'はやい', fmt: v => `${v.toFixed(1)} 秒で横断` },
  { path: 'fixedDuration', label: '上下固定の表示時間', type: 'number', min: 0.5, max: 20, step: 0.1 },

  { group: '量' },
  { path: 'maxActive', label: '画面に出す最大数', type: 'number', min: 1, max: 500, step: 1 },
  { note: 'これを超えたコメントは表示されません。一覧では薄く表示されます。' },
];

const ADV_FIELDS = [
  { group: 'フォントサイズ' },
  { path: 'fontSize.small', label: '小', type: 'number', min: 4, max: 200, step: 1 },
  { path: 'fontSize.medium', label: '中', type: 'number', min: 4, max: 200, step: 1 },
  { path: 'fontSize.big', label: '大', type: 'number', min: 4, max: 200, step: 1 },
  { group: '1画面に入る行数' },
  { path: 'lineCounts.small', label: '小', type: 'number', min: 1, max: 60, step: 0.1 },
  { path: 'lineCounts.medium', label: '中', type: 'number', min: 1, max: 60, step: 0.1 },
  { path: 'lineCounts.big', label: '大', type: 'number', min: 1, max: 60, step: 0.1 },
  { group: '縁取り' },
  { path: 'strokeWidth', label: '線幅', type: 'number', min: 0, max: 20, step: 0.1 },
  { group: 'その他' },
  { path: 'maxLength', label: '1件の最大文字数', type: 'number', min: 1, max: 500, step: 1 },
  { path: 'collisionRight', label: '当たり判定の右端', type: 'number', min: 0.2, max: 1, step: 0.01 },
  { note: '小さくすると、コメントが早めに次の行を空けるので詰まりにくくなります。' },
];

const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function buildFields(container, spec) {
  container.replaceChildren();
  for (const f of spec) {
    if (f.group) {
      container.append(Object.assign(document.createElement('h4'), { textContent: f.group }));
      continue;
    }
    if (f.note) {
      container.append(Object.assign(document.createElement('p'), { className: 'note', textContent: f.note }));
      continue;
    }
    if (f.type === 'range') { container.append(buildSlider(f)); continue; }

    const row = document.createElement('div');
    row.className = 'field';
    row.append(Object.assign(document.createElement('label'), { textContent: f.label }));
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, l] of f.options) {
        input.append(Object.assign(document.createElement('option'), { value: v, textContent: l }));
      }
      input.value = getPath(state.settings, f.path);
      input.onchange = () => { setPath(state.settings, f.path, input.value); onSettingsChanged(); };
    } else {
      input = Object.assign(document.createElement('input'),
        { type: 'number', min: f.min, max: f.max, step: f.step, value: getPath(state.settings, f.path) });
      input.oninput = () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < f.min || v > f.max) return;
        setPath(state.settings, f.path, v); onSettingsChanged();
      };
    }
    input.dataset.path = f.path;
    row.append(input);
    container.append(row);
  }
}

function buildSlider(f) {
  const box = document.createElement('div');
  box.className = 'slider';
  const top = document.createElement('div');
  top.className = 'top';
  top.append(Object.assign(document.createElement('label'), { textContent: f.label }));
  const val = Object.assign(document.createElement('span'), { className: 'val' });
  top.append(val);

  const input = Object.assign(document.createElement('input'),
    { type: 'range', min: f.min, max: f.max, step: f.step });
  input.dataset.path = f.path;
  input.dataset.invert = f.invert ? '1' : '';

  const toSlider = (v) => (f.invert ? f.min + f.max - v : v);
  const fromSlider = (v) => (f.invert ? f.min + f.max - v : v);

  const paint = () => {
    const v = getPath(state.settings, f.path);
    input.value = String(toSlider(v));
    val.textContent = f.fmt(v);
  };
  input.oninput = () => {
    setPath(state.settings, f.path, fromSlider(Number(input.value)));
    paint();
    onSettingsChanged();
  };
  input._paint = paint;
  paint();

  const ends = document.createElement('div');
  ends.className = 'ends';
  ends.append(Object.assign(document.createElement('span'), { textContent: f.left }));
  ends.append(Object.assign(document.createElement('span'), { textContent: f.right }));

  box.append(top, input, ends);
  return box;
}

function syncSettingsUI() {
  for (const el of [...dom.fields.querySelectorAll('[data-path]'), ...dom.advFields.querySelectorAll('[data-path]')]) {
    if (el._paint) el._paint();
    else el.value = getPath(state.settings, el.dataset.path);
  }
}

function onSettingsChanged() {
  clearMetricsCache();
  recomputeEff();
  syncSettingsUI();
  // 「見切れないところまで」は横断秒数から終端を決めるので、
  // 表示設定を変えたら自動配置も計算し直す必要がある。
  refreshComments(false);
}

// ---------------------------------------------------------------- 時刻バー(自動配置)
function buildAutoUI() {
  const A = () => state.settings.auto;
  const changed = (structural = true) => refreshComments(structural);

  dom.timeAuto.onclick = () => {
    if (!A().enabled) {
      snapshot();
      A().enabled = true;
      // 自動の行が1つも無いなら、押した意図は「全部を自動に」のはず
      if (!state.comments.some(c => c.auto)) for (const c of state.comments) c.auto = true;
    }
    syncAutoUI(); changed();
  };
  dom.timeManual.onclick = () => {
    if (A().enabled) {
      snapshot();
      A().enabled = false;
      for (const c of state.comments) c.auto = false;  // いまの時刻でそのまま固定
    }
    syncAutoUI(); changed();
  };

  dom.autoMode.onchange = () => { A().mode = dom.autoMode.value; syncAutoUI(); changed(); };
  dom.autoRate.oninput = () => {
    const v = Number(dom.autoRate.value);
    if (v >= 0.1 && v <= 20) { A().rate = v; changed(); }
  };
  dom.autoJitter.oninput = () => {
    const v = Number(dom.autoJitter.value);
    if (v >= 0 && v <= 1) { A().jitter = v; changed(); }
  };
  const timeField = (input, key, fallback) => {
    input.onchange = () => {
      const raw = input.value.trim();
      if (raw === '') { A()[key] = fallback; changed(); return; }
      const v = parseTime(raw);
      if (v === null) { input.value = A()[key] === null ? '' : formatTime(A()[key], false); return; }
      A()[key] = v; changed();
    };
  };
  timeField(dom.autoStart, 'start', 0);
  timeField(dom.autoEnd, 'end', null);
  dom.autoEndMode.onchange = () => {
    A().endMode = dom.autoEndMode.value;
    // 「時刻を指定」に切り替えた直後は、いまの終端を初期値にしておく
    if (A().endMode === 'custom' && A().end === null) {
      A().end = state.autoInfo?.end ?? (state.media?.duration ?? 0);
    }
    syncAutoUI(); changed();
  };

  dom.autoFix.onclick = () => {
    if (!state.comments.some(c => c.auto)) return;
    snapshot();
    for (const c of state.comments) c.auto = false;
    syncAutoUI(); changed();
  };
  dom.autoAll.onclick = () => {
    snapshot();
    for (const c of state.comments) c.auto = true;
    syncAutoUI(); changed();
  };

  syncAutoUI();
}

function syncAutoUI() {
  const A = state.settings.auto;
  const anyAuto = state.comments.some(c => c.auto);
  dom.timeAuto.classList.toggle('on', A.enabled);
  dom.timeManual.classList.toggle('on', !A.enabled);
  dom.autoOpts.hidden = !A.enabled;
  dom.autoReadout.hidden = !A.enabled;
  dom.autoMode.value = A.mode;
  dom.autoRateRow.hidden = A.mode !== 'rate';
  dom.autoRate.value = A.rate;
  dom.autoJitter.value = A.jitter;
  dom.autoStart.value = A.start ? formatTime(A.start, false) : '';
  dom.autoEndMode.value = A.endMode ?? 'video';
  dom.autoEnd.hidden = A.endMode !== 'custom';
  dom.autoEnd.value = A.end === null ? '' : formatTime(A.end, false);
  dom.autoAll.hidden = !A.enabled || anyAuto || !state.comments.length;
  dom.autoFix.hidden = !A.enabled || !anyAuto;
  syncAddLabel();
}

function updateAutoReadout() {
  if (!state.settings.auto.enabled) return;
  const n = state.comments.filter(c => c.auto).length;
  const i = state.autoInfo;
  let html;
  if (!n) html = '自動の行がありません';
  else if (!state.media) html = `自動 <b>${n}</b> 件 — 動画を読み込むと時刻が決まります`;
  else if (!i?.ready) html = `自動 <b>${n}</b> 件`;
  else {
    html = `自動 <b>${n}</b> 件 — 毎秒 <b>${i.rate.toFixed(2)}</b> 件 · 画面に常時 <b>約 ${i.onScreen.toFixed(1)}</b> 個`;
    if (i.overflow) html += ` <span class="warn">(${i.overflow} 件が動画の長さを超えています)</span>`;
    else if (i.cramped) html += ` <span class="warn">(動画が短すぎて見切れを防げません)</span>`;
    else html += ` · 最後は ${formatTime(i.end, false)}`;
  }
  dom.autoReadout.innerHTML = html;
}

function syncAddLabel() {
  const auto = state.settings.auto.enabled;
  dom.addHere.textContent = auto ? '＋ 末尾に追加' : '＋ 現在位置に追加';
  dom.addHere.title = auto
    ? 'リストの末尾にコメントを足します(時刻は自動で決まります)'
    : 'いま止まっている位置にコメントを追加します';
}

// ---------------------------------------------------------------- 書き出し
function updateExportEnabled() {
  dom.export.disabled = !state.media || state.exporting;
}

let cancelRequested = false;

async function runExport() {
  if (!state.media || state.exporting) return;
  const [mode, format = 'mp4'] = dom.exportTarget.value.split(':');

  state.exporting = true; cancelRequested = false;
  updateExportEnabled();
  dom.cancelExport.hidden = false;
  dom.reveal.hidden = true;
  dom.exportProgress.classList.add('on');
  dom.exportStatus.className = '';
  dom.exportStatus.textContent = '準備中…';
  dom.video.pause();

  const t0 = performance.now();
  try {
    const res = await backend.exportVideo({
      media: state.media, mode, format, bg: state.exportBg,
      // 書き出し中に設定やコメントを触られても出力が混ざらないよう、開始時点で固定する
      laid: state.laid,
      settings: structuredClone(state.eff),
      isCancelled: () => cancelRequested,
      onProgress: (ratio, n, total, label) => {
        dom.exportFill.style.width = `${(ratio * 100).toFixed(1)}%`;
        if (label) { dom.exportStatus.textContent = label; return; }
        const elapsed = (performance.now() - t0) / 1000;
        const remain = ratio > 0.01 ? elapsed / ratio - elapsed : null;
        dom.exportStatus.textContent =
          `${n} / ${total} コマ  ${Math.round(ratio * 100)}%` +
          (remain !== null ? `  残り約 ${formatTime(remain, false)}` : '');
      },
    });

    dom.exportFill.style.width = '100%';
    dom.exportStatus.className = 'ok';
    dom.exportStatus.textContent =
      `${res.name} を書き出しました (${(res.size / 1048576).toFixed(1)} MB` +
      `, ${((performance.now() - t0) / 1000).toFixed(1)} 秒)`;
    if (res.reveal) { dom.reveal.hidden = false; dom.reveal.onclick = res.reveal; }
    state.exportedOnce = true;
    updateSteps();
  } catch (e) {
    const cancelled = String(e.message) === '__cancelled__';
    dom.exportStatus.className = cancelled ? '' : 'err';
    dom.exportStatus.textContent = cancelled ? '中断しました' : `失敗: ${e.message}`;
    dom.exportFill.style.width = '0';
  } finally {
    state.exporting = false;
    dom.cancelExport.hidden = true;
    dom.exportProgress.classList.remove('on');
    updateExportEnabled();
  }
}

// ---------------------------------------------------------------- 入力
dom.pickVideo.onclick = dom.pickVideo2.onclick = () => dom.fileVideo.click();
dom.pickCsv.onclick = dom.emptyCsv.onclick = () => dom.fileCsv.click();
dom.saveCsv.onclick = saveCSV;
dom.fileVideo.onchange = () => dom.fileVideo.files[0] && loadVideo(dom.fileVideo.files[0]);
dom.fileCsv.onchange = () => dom.fileCsv.files[0] && loadCSVFile(dom.fileCsv.files[0]);

dom.btnPaste.onclick = () => {
  dom.pasteBox.hidden = !dom.pasteBox.hidden;
  if (!dom.pasteBox.hidden) dom.pasteArea.focus();
};
dom.pasteClose.onclick = () => { dom.pasteBox.hidden = true; };
wirePaste(dom.pasteArea, dom.pasteApply, () => dom.pasteAppend.checked);
wirePaste(dom.emptyPaste, dom.emptyApply, () => false);

dom.play.onclick = () => (dom.video.paused ? dom.video.play() : dom.video.pause());
dom.video.onplay = dom.video.onpause = updateTransport;
dom.seek.oninput = () => {
  seeking = true;
  seekTo((Number(dom.seek.value) / 1000) * (state.media?.duration || 0));
};
dom.seek.onchange = () => { seeking = false; };

function addComment() {
  snapshot();
  const auto = state.settings.auto.enabled;
  const c = {
    id: newId(), seq: nextSeq(), auto,
    time: auto ? 0 : (dom.video.currentTime || 0),
    text: '', color: 'white', pos: 'naka', size: 'medium',
  };
  state.comments.push(c);
  refreshComments(true);
  table.focusText(c.id);
}
dom.addHere.onclick = addComment;
dom.emptyOne.onclick = () => {
  if (!state.media) { dom.fileVideo.click(); return; }
  addComment();
};

dom.toggleAlpha.onclick = () => {
  state.alpha = !state.alpha;
  dom.stage.classList.toggle('alpha', state.alpha);
  dom.toggleAlpha.classList.toggle('on', state.alpha);
  dom.toggleAlpha.textContent = state.alpha ? '動画も表示' : 'コメントだけ表示';
  syncExportTarget();
};

dom.delSelected.onclick = () => deleteComments(table.getSelection());
dom.clearSel.onclick = () => table.clearSelection();
armButton(dom.delAll, '全削除', 'もう一度で全削除', () => {
  deleteComments(state.comments.map(c => c.id));
});
dom.undo.onclick = undo;
dom.redo.onclick = redo;

dom.resetSettings.onclick = () => {
  const keepAuto = state.settings.auto;
  state.settings = structuredClone(DEFAULT_SETTINGS);
  state.settings.auto = keepAuto; // 時刻の設定はここでは戻さない
  onSettingsChanged();
};

dom.help.onclick = (e) => { e.stopPropagation(); dom.helpPop.hidden = !dom.helpPop.hidden; };
document.addEventListener('click', (e) => {
  if (!dom.helpWrap.contains(e.target)) dom.helpPop.hidden = true;
});

function syncExportTarget() {
  const isBgLayer = dom.exportTarget.value === 'layer:mp4';
  dom.bgWrap.hidden = !isBgLayer;
  dom.exportBg.value = state.exportBg;
  // 背景色つきなら、プレビューの「コメントだけ表示」もその色で見せる
  dom.stage.style.setProperty('--alpha-bg', state.exportBg);
  dom.stage.classList.toggle('flat-bg', isBgLayer && state.alpha);
}
dom.exportTarget.onchange = syncExportTarget;
dom.exportBg.oninput = () => { state.exportBg = dom.exportBg.value; syncExportTarget(); persist(); };
dom.bgBlack.onclick = () => { state.exportBg = '#000000'; syncExportTarget(); persist(); };
dom.bgGreen.onclick = () => { state.exportBg = '#00B140'; syncExportTarget(); persist(); };

dom.export.onclick = runExport;
dom.cancelExport.onclick = () => { cancelRequested = true; };

// ドラッグ&ドロップ
let dragTimer = null;
const showDrop = () => {
  dom.dropHint.hidden = false;
  clearTimeout(dragTimer);
  dragTimer = setTimeout(() => { dom.dropHint.hidden = true; }, 250);
};
const hideDrop = () => { clearTimeout(dragTimer); dom.dropHint.hidden = true; };

window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault(); showDrop();
});
window.addEventListener('dragleave', hideDrop);
window.addEventListener('dragend', hideDrop);
window.addEventListener('drop', (e) => {
  e.preventDefault(); hideDrop();
  for (const f of e.dataTransfer.files) {
    if (/\.(csv|tsv|txt)$/i.test(f.name)) loadCSVFile(f);
    else loadVideo(f);
  }
});

// キーボード
window.addEventListener('keydown', (e) => {
  const typing = /input|select|textarea/i.test(e.target.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.shiftKey ? redo() : undo(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing) {
    e.preventDefault(); table.selectAll(); return;
  }
  if (e.key === 'Escape') { dom.helpPop.hidden = true; if (!typing) table.clearSelection(); return; }
  if (typing) return;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const sel = table.getSelection();
    if (sel.length) { e.preventDefault(); deleteComments(sel); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); dom.play.click(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(dom.video.currentTime - (e.shiftKey ? 5 : 1 / (state.media?.fps || 30))); }
  if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(dom.video.currentTime + (e.shiftKey ? 5 : 1 / (state.media?.fps || 30))); }
});

window.addEventListener('beforeunload', (e) => { if (state.exporting) e.preventDefault(); });

// ---------------------------------------------------------------- 起動
/** ローカルのサーバーがいれば local、いなければ browser */
async function pickBackend() {
  // ローカル版のサーバーは 127.0.0.1 にしか立たないので、
  // 公開ホストではそもそも探しに行かない
  const maybeLocal = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
  if (maybeLocal) {
    try {
      const local = await import('./backend/local.js');
      await local.probe();
      return local;
    } catch { /* サーバーがいなければブラウザ版へ */ }
  }
  const browser = await import('./backend/browser.js');
  await browser.probe();
  return browser;
}

/** バックエンドが対応していない書き出し先は消す */
function applyCapabilities() {
  const ok = new Set(backend.capabilities.targets);
  for (const opt of dom.exportTarget.options) opt.hidden = !ok.has(opt.value);
  for (const g of dom.exportTarget.querySelectorAll('optgroup')) {
    g.hidden = [...g.children].every(o => o.hidden);
  }
  if (!ok.has(dom.exportTarget.value)) dom.exportTarget.value = [...ok][0];
  document.body.dataset.backend = backend.name;
}

(async function main() {
  restore();
  await loadFont();
  buildFields(dom.fields, BASIC_FIELDS);
  buildFields(dom.advFields, ADV_FIELDS);
  buildAutoUI();

  try {
    backend = await pickBackend();
  } catch (e) {
    dom.videoInfo.textContent = String(e.message || e);
    dom.videoInfo.classList.add('warn');
    dom.pickVideo.disabled = dom.pickVideo2.disabled = true;
    return;
  }
  applyCapabilities();
  syncExportTarget();
  table.render(state.comments);
  refreshComments(false);
  updateHistoryUI();
  frameLoop();
})();
