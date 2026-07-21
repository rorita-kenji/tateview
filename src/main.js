// main.js — メインスレッドの統括
import { pageIndexOfOffset } from './modules/paginator.js';
import { renderPage } from './ui/renderer.js';
import {
  PRESETS, DEFAULT_SETTINGS, loadSettings, saveSettings, savePosition, loadPosition,
} from './ui/settings.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: loadSettings(),
  worker: null,
  docId: 0,
  latest: { paginate: 0, warnings: 0, search: 0 },
  reqSeq: 0,
  text: '',
  pages: [],
  pageIndex: 0,
  pendingOffset: 0,
  fileName: 'untitled.txt',
  fileHandle: null,
  fileLastModified: 0,
  warnings: [],
  warnTotal: 0,
  warnIndex: -1,
  matches: [],
  matchIndex: -1,
};

function init() {
  state.worker = window.__createWorker();
  state.worker.onmessage = onWorkerMessage;
  bindUI();
  applyAppearance();
  buildPresetOptions();
  reflectSettingsToUI();
  populateFontSizes();
  installCopyHandler();
  window.addEventListener('resize', () => { populateFontSizes(); renderCurrent(); });
  window.addEventListener('keydown', onKey);
  window.addEventListener('mouseup', () => { scrubbing = false; });
  const wrap = $('pageWrap');
  wrap.addEventListener('wheel', onWheel, { passive: false });
  installSwipe(wrap);
  installDragAndDrop();
  startFileWatch();
}

/* ---------------- Drag & Drop ---------------- */
function installDragAndDrop() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) =>
    window.addEventListener(ev, (e) => { stop(e); document.body.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => { stop(e); if (ev === 'drop' || e.target === document.documentElement) document.body.classList.remove('dragover'); }));
  window.addEventListener('drop', async (e) => {
    document.body.classList.remove('dragover');
    const items = e.dataTransfer && e.dataTransfer.items;
    // File System Access のハンドルが取れれば自動更新監視も効く
    if (items && items.length && items[0].getAsFileSystemHandle) {
      try {
        const handle = await items[0].getAsFileSystemHandle();
        if (handle && handle.kind === 'file') {
          const file = await handle.getFile();
          openFile(file, handle);
          return;
        }
      } catch { /* フォールバック */ }
    }
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) openFile(file, null);
  });
}

/* ---------------- Toast ---------------- */
let _toastTimer = null;
function showToast(msg, ms = 1000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------- Worker ---------------- */
// リクエスト種別 -> チャンネル、レスポンス種別 -> チャンネル の対応。
// 世代管理は「チャンネル単位の最新 requestId」で行う。
const REQ_CHANNEL = { paginate: 'paginate', detectWarnings: 'warnings', search: 'search' };
const RES_CHANNEL = { paginated: 'paginate', warnings: 'warnings', searchResult: 'search' };

function send(type, payload) {
  const requestId = ++state.reqSeq;
  const ch = REQ_CHANNEL[type];
  if (ch) state.latest[ch] = requestId;
  state.worker.postMessage({ documentId: state.docId, requestId, type, payload });
  return requestId;
}
function onWorkerMessage(e) {
  const { documentId, requestId, type, payload } = e.data;
  if (documentId !== state.docId) return; // 古い原稿の結果は破棄
  const ch = RES_CHANNEL[type];
  if (ch && requestId !== state.latest[ch]) return; // 古い結果は破棄

  if (type === 'loaded') {
    state.text = payload.text;
    setProgress('');
    const encLabel = { 'utf-8': 'UTF-8', 'shift_jis': 'Shift_JIS', unknown: '不明' }[payload.encoding] || payload.encoding;
    $('fileMeta').textContent = `${state.fileName} ・ ${encLabel} ・ 改行 ${payload.newline} ・ ${state.text.length}字`;
    state.pendingOffset = loadPosition(state.fileName, state.text);
    requestPaginate();
    requestWarnings();
    updateSearchIndicator();
  } else if (type === 'needEncoding') {
    setProgress('文字コードを判定できませんでした');
    $('fileMeta').textContent = `${state.fileName} ・ 文字コード判定不可`;
  } else if (type === 'paginated') {
    state.pages = payload.pages;
    state.pageIndex = clampPage(pageIndexOfOffset(state.pages, state.pendingOffset));
    buildThumbnails();
    populateFontSizes();
    renderCurrent();
    // ページ境界が変わると警告のページ番号も変わる
    if (state.warnings.length) renderWarnings(state.warnTotal);
    setProgress('');
  } else if (type === 'warnings') {
    state.warnings = payload.items;
    state.warnTotal = payload.total || payload.items.length;
    renderWarnings(state.warnTotal);
  } else if (type === 'searchResult') {
    state.matches = payload.matches;
    state.matchIndex = state.matches.length ? 0 : -1;
    $('searchCount').textContent = payload.total ? `${payload.total}件` : '0件';
    if (state.matchIndex >= 0) gotoOffset(state.matches[0].start);
    else renderCurrent();
  } else if (type === 'error') {
    setProgress('エラー: ' + payload.message);
  }
}

function currentConfig() {
  const s = state.settings;
  return { charsPerColumn: s.charsPerColumn, columnsPerPage: s.columnsPerPage, kinsoku: s.kinsoku, burasage: s.burasage };
}
function requestPaginate() {
  setProgress('ページ分割中…');
  send('paginate', { config: currentConfig() });
}
function requestWarnings() {
  send('detectWarnings', { showRuby: state.settings.showRuby, enabled: null });
}

/* ---------------- File open ---------------- */
async function openFile(file, handle) {
  state.fileName = file.name || 'untitled.txt';
  state.fileHandle = handle || null;
  state.fileLastModified = file.lastModified || 0;
  updateReloadLabel();
  const buf = await file.arrayBuffer();
  state.docId++;
  setProgress('読み込み中…');
  send('load', { bytes: buf });
}

/* ---------------- Rendering ---------------- */
function renderCurrent() {
  const pageEl = $('page');
  if (!state.pages.length) {
    pageEl.textContent = '';
    updateStatus();
    return;
  }
  const page = state.pages[state.pageIndex];
  pageEl.classList.toggle('grid', !!state.settings.gridLines);
  const highlights = [];
  if (state.matchIndex >= 0 && state.matches[state.matchIndex]) {
    highlights.push({ ...state.matches[state.matchIndex], kind: 'search' });
  }
  if (state._warnHighlight) {
    highlights.push({ ...state._warnHighlight, kind: 'warn' });
  }

  const fs = effectiveFontSize();
  pageEl.style.transform = 'none';
  applyFs(fs);
  renderPage(pageEl, state.text, page, {
    showRuby: state.settings.showRuby,
    halfColor: state.settings.halfColor,
    spaceColor: state.settings.spaceColor,
    highlights,
  });
  markHeadings(pageEl, page);
  buildRulers(pageEl, fs * 1.05);

  // 指定した行数・字数が必ず収まるよう、はみ出す分だけページ全体を等倍縮小する。
  // フォント計算の誤差に依存せず、全列が確実に表示される。
  const wrap = $('pageWrap');
  const availW = wrap.clientWidth - 44;
  const availH = wrap.clientHeight - 44;
  const ext = measureExtent(pageEl);
  let scale = 1;
  if (ext && ext.w > 0 && ext.h > 0) {
    scale = Math.min(1, availW / ext.w, availH / ext.h);
  }
  pageEl.style.transformOrigin = 'center center';
  pageEl.style.transform = scale < 0.999 ? `scale(${scale})` : 'none';

  updateStatus();
  persistPosition();
}

/** 表示に使う字級。auto 時はウィンドウに収まる最大、手動時は指定値（上限は maxFit） */
function effectiveFontSize() {
  const max = maxFitFontSize();
  if (state.settings.fontSizeAuto !== false) return max;
  return Math.max(8, Math.min(state.settings.fontSize || max, max));
}

// 全列の実描画範囲（幅・高さ）を測る。overflow で見切れても正しい寸法が取れる。
function measureExtent(pageEl) {
  const cols = pageEl.querySelectorAll('.col');
  if (!cols.length) return null;
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  cols.forEach((c) => {
    const q = c.getBoundingClientRect();
    l = Math.min(l, q.left); r = Math.max(r, q.right);
    t = Math.min(t, q.top); b = Math.max(b, q.bottom);
  });
  return { w: r - l, h: b - t };
}

// 字級と升目用CSS変数をまとめて適用
function applyFs(fs) {
  const root = document.documentElement.style;
  root.setProperty('--fs', fs + 'px');
  const cell = fs * 1.05;
  root.setProperty('--cell', cell.toFixed(2) + 'px');
  root.setProperty('--col-h', (cell * state.settings.charsPerColumn).toFixed(2) + 'px');
}

// 升目の目盛り: ページ外周に一列だけ（右=文字位置, 上=列位置）
function buildRulers(pageEl, cell) {
  pageEl.querySelectorAll('.ruler').forEach((n) => n.remove());
  if (!state.settings.gridLines) return;
  const cols = pageEl.querySelectorAll('.col');
  if (!cols.length) return;
  const colW = cols[0].getBoundingClientRect().width;
  const chars = state.settings.charsPerColumn;
  const ncols = state.settings.columnsPerPage;

  const right = document.createElement('div');
  right.className = 'ruler ruler-right';
  for (let k = 5; k <= chars; k += 5) {
    const s = document.createElement('span');
    s.textContent = String(k);
    s.style.top = (k * cell - cell / 2) + 'px'; // 半文字上
    right.appendChild(s);
  }
  pageEl.appendChild(right);

  const top = document.createElement('div');
  top.className = 'ruler ruler-top';
  // 縦書きの「行」= 列。右端が1行目。数字は各行のセンターに置く
  for (let k = 5; k <= ncols; k += 5) {
    const s = document.createElement('span');
    s.textContent = String(k);
    s.style.right = ((k - 0.5) * colW) + 'px';
    top.appendChild(s);
  }
  pageEl.appendChild(top);
}

function markHeadings(pageEl, page) {
  // 見出し行（#/##）の列に色クラスを付与（組版は変えない）。#=章, ##=話 で色を分ける。
  const cols = pageEl.querySelectorAll('.col');
  page.columns.forEach((c, i) => {
    if (!cols[i]) return;
    const head = state.text.slice(c.start, c.start + 3);
    if (/^##(?:\s|#|$)/.test(head)) cols[i].classList.add('heading-2');
    else if (/^#(?:\s|$)/.test(head)) cols[i].classList.add('heading-1');
  });
}

// 1文字ぶんの実寸をプローブ測定し、指定の字数×行数が収まる最大字級を理論計算する。
// 推定係数に頼らないので、指定した行数が必ず表示される。
const FONT_SIZE_MAX_CAP = 120;
function maxFitFontSize() {
  const wrap = $('pageWrap');
  const availH = Math.max(40, wrap.clientHeight - 44);
  const availW = Math.max(40, wrap.clientWidth - 44);
  const s = state.settings;
  const PROBE_FS = 100;

  const probe = document.createElement('div');
  probe.className = 'col';
  probe.style.cssText = 'font-size:100px;visibility:hidden;position:absolute;left:-99999px;top:0;';
  probe.textContent = 'あ'.repeat(Math.max(1, s.charsPerColumn));
  wrap.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  wrap.removeChild(probe);

  const colH100 = rect.height;   // charsPerColumn 文字ぶんの列の長さ（fs=100）
  const colW100 = rect.width;    // 1列の幅（fs=100）
  if (!colH100 || !colW100) return s.fontSize || 20;

  // #page は flex の gap（columnGap ではない）
  const pageCs = getComputedStyle($('page'));
  const gap = parseFloat(pageCs.gap || pageCs.columnGap) || 0;
  const fsByH = (availH * PROBE_FS) / colH100;
  const fsByW = ((availW - (s.columnsPerPage - 1) * gap) * PROBE_FS) / (s.columnsPerPage * colW100);
  // 余白を少し見て安全側へ（はみ出し scale に頼る前にほぼ最大）
  const fit = Math.floor(Math.min(fsByH, fsByW) * 0.98);
  return Math.max(8, Math.min(FONT_SIZE_MAX_CAP, fit));
}

// 字級セレクトを「表示可能なサイズ」だけで再構築する。
// auto 時は常に最大を選び、ウィンドウ拡大に追随する。
function populateFontSizes() {
  const sel = $('fontSize');
  const max = maxFitFontSize();
  let cur;
  if (state.settings.fontSizeAuto !== false) {
    cur = max;
    state.settings.fontSizeAuto = true;
  } else {
    cur = Math.min(state.settings.fontSize || max, max);
    if (cur < 8) cur = 8;
    // 手動指定が実質最大と同じなら auto に戻して拡大に追随
    if (cur >= max) {
      cur = max;
      state.settings.fontSizeAuto = true;
    }
  }
  state.settings.fontSize = cur;

  const sizes = [];
  const step = max > 48 ? 4 : 2;
  for (let v = 8; v <= max; v += step) sizes.push(v);
  if (!sizes.includes(cur)) sizes.push(cur);
  if (!sizes.includes(max)) sizes.push(max);
  sizes.sort((a, b) => a - b);
  sel.innerHTML = '';
  for (const v of sizes) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = v === max ? `${v}px（最大）` : `${v}px`;
    sel.appendChild(o);
  }
  sel.value = String(cur);
}

/* ---------------- Thumbnails ---------------- */
let scrubbing = false;
function buildThumbnails() {
  const box = $('thumbs');
  box.innerHTML = '';
  state.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.i = String(i);
    const num = document.createElement('span');
    num.className = 'tnum';
    num.textContent = String(i + 1);
    t.appendChild(num);
    const hd = firstHeadingIn(p);
    if (hd) {
      const h = document.createElement('span');
      h.className = hd.level === 2 ? 'thead h2' : 'thead';
      h.textContent = hd.text;
      t.appendChild(h);
    }
    t.addEventListener('mousedown', (e) => { e.preventDefault(); scrubbing = true; gotoPage(i); });
    t.addEventListener('mouseenter', () => { if (scrubbing) gotoPage(i); });
    box.appendChild(t);
  });
  updateThumbActive();
}
function firstHeadingIn(p) {
  const seg = state.text.slice(p.range.start, p.range.end);
  for (const line of seg.split('\n')) {
    const m = /^(#{1,2})\s*(.+)$/.exec(line);
    if (m) return { level: m[1].length, text: m[2].slice(0, 24) };
  }
  return null;
}
function updateThumbActive() {
  const box = $('thumbs');
  const cur = box.querySelector('.thumb.active');
  if (cur) cur.classList.remove('active');
  const el = box.children[state.pageIndex];
  if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
}

function updateStatus() {
  const total = state.pages.length;
  const cur = total ? state.pageIndex + 1 : 0;
  const page = state.pages[state.pageIndex];
  const chars = page ? page.range.end - page.range.start : 0;
  $('totalPages').textContent = String(total);
  $('pageChars').textContent = String(chars);
  $('totalChars').textContent = String(state.text.length);
  const jump = $('jumpInput');
  jump.max = String(total);
  if (document.activeElement !== jump) jump.value = String(cur);
  updateThumbActive();
}

function setProgress(msg) {
  $('progress').textContent = msg;
}

// File System Access のハンドルがあれば自動更新監視が有効 →「自動更新」表示のみ。
// 不可なら「更新」ボタン（クリックで再読込）を表示。
function updateReloadLabel() {
  const btn = $('reloadBtn');
  const badge = $('autoLabel');
  if (state.fileHandle) {
    btn.hidden = true;
    badge.hidden = false;
  } else {
    btn.hidden = false;
    badge.hidden = true;
  }
}

/* ---------------- Navigation ---------------- */
function clampPage(i) {
  return Math.max(0, Math.min(state.pages.length - 1, i));
}
/** 再ページ分割後も今見ている位置を維持するため pendingOffset を同期する */
function syncPendingFromPage() {
  const page = state.pages[state.pageIndex];
  if (page) state.pendingOffset = page.range.start;
}
function go(delta) {
  const ni = clampPage(state.pageIndex + delta);
  if (ni !== state.pageIndex) {
    state.pageIndex = ni;
    syncPendingFromPage();
    renderCurrent();
  }
}
function gotoPage(i) {
  state.pageIndex = clampPage(i);
  syncPendingFromPage();
  renderCurrent();
}
function gotoOffset(offset) {
  if (!state.pages.length) return;
  state.pendingOffset = Math.max(0, Math.min(offset, state.text.length));
  state.pageIndex = clampPage(pageIndexOfOffset(state.pages, state.pendingOffset));
  renderCurrent();
}
function onKey(e) {
  // 文字入力中はページ送りしない（checkbox/button 上の Space はページ送りにする）
  const el = e.target;
  const tag = el && el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (tag === 'INPUT') {
    const ty = (el.type || 'text').toLowerCase();
    if (ty === 'text' || ty === 'search' || ty === 'number' || ty === 'password' || ty === '') return;
  }

  // 縦書きは右→左。ArrowLeft で次ページ、ArrowRight で前ページが自然。
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { go(1); e.preventDefault(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { go(-1); e.preventDefault(); }
  else if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
    // Space=次、Shift+Space=前
    go(e.shiftKey ? -1 : 1);
    e.preventDefault();
  }
}
let wheelAccum = 0;
function onWheel(e) {
  e.preventDefault();
  wheelAccum += e.deltaY;
  if (Math.abs(wheelAccum) > 60) {
    go(wheelAccum > 0 ? 1 : -1);
    wheelAccum = 0;
  }
}
function installSwipe(el) {
  let x0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); // 左スワイプ=次
    x0 = null;
  });
}

/* ---------------- Warnings panel ---------------- */
function renderWarnings(total) {
  const list = $('warnList');
  list.textContent = '';
  const shown = total != null ? total : state.warnTotal;
  $('warnTotal').textContent = shown ? `${shown}件` : '0件';
  state.warnings.forEach((w, idx) => {
    const li = document.createElement('li');
    li.className = 'warn-item sev-' + w.severity;
    li.dataset.idx = String(idx);
    fillWarningItemContent(li, w);
    li.title = w.severity + ' / ' + (w.label || w.code);
    if (idx === state.warnIndex) li.classList.add('active');
    li.addEventListener('click', () => jumpWarning(idx));
    list.appendChild(li);
  });
  syncWarnListActive();
}
/**
 * 一覧項目の表示を組み立てる。
 * 字下げ漏れは頻出のため「位置＋種別」と「行頭」を2行に分ける。
 */
function fillWarningItemContent(li, w) {
  const off = w.range && typeof w.range.start === 'number' ? w.range.start : 0;
  const loc = locateOnPages(off);
  const prefix = loc ? `p${loc.page} ${loc.line}行` : 'p– –行';
  const base = w.label || w.code || '';

  // 字下げ漏れ　行頭… → 2行表示
  if (w.code === 'indent-missing') {
    const headSep = '字下げ漏れ';
    let head = '';
    if (base.startsWith(headSep)) {
      head = base.slice(headSep.length).replace(/^　+/, '');
    }
    const line1 = document.createElement('div');
    line1.className = 'warn-line1';
    line1.textContent = `${prefix}　${headSep}`;
    li.appendChild(line1);
    if (head) {
      const line2 = document.createElement('div');
      line2.className = 'warn-line2';
      line2.textContent = head;
      li.appendChild(line2);
    }
    return;
  }

  li.textContent = `${prefix}　${base}`;
}
/**
 * オフセットが属する表示ページ番号（1始まり）と、
 * そのページ内の原稿用紙の行番号（1始まり＝縦書きの列番号）。
 * @param {number} offset
 * @returns {{page:number, line:number}|null}
 */
function locateOnPages(offset) {
  if (!state.pages || !state.pages.length) return null;
  const pi = pageIndexOfOffset(state.pages, offset);
  const page = state.pages[pi];
  if (!page) return null;
  const cols = page.columns || [];
  let line = 1;
  if (cols.length) {
    // 半開区間 [start,end)。end ちょうどは次列だが、最終列 end は最終行に含める
    let found = -1;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const last = i === cols.length - 1;
      if (offset >= c.start && (offset < c.end || (last && offset <= c.end))) {
        found = i;
        break;
      }
    }
    // 列の隙間や境界ずれのときは最も近い列
    if (found < 0) {
      found = 0;
      for (let i = 0; i < cols.length; i++) {
        if (offset >= cols[i].start) found = i;
      }
    }
    line = found + 1;
  }
  return { page: pi + 1, line };
}
function jumpWarning(idx) {
  const w = state.warnings[idx];
  if (!w) return;
  state.warnIndex = idx;
  state._warnHighlight = w.range;
  syncWarnListActive();
  gotoOffset(w.range.start);
}
/** 校正の前/次。端では止まってループしない。先頭で「前」ならハイライト解除して1ページ目。 */
function stepWarning(delta) {
  if (!state.warnings.length) return;
  if (state.warnIndex < 0) {
    // 未選択: 「次」だけ先頭へ。「前」はループせず何もしない（または1ページ目）
    if (delta < 0) {
      clearWarningJump();
      gotoPage(0);
      return;
    }
    jumpWarning(0);
    return;
  }
  const ni = state.warnIndex + delta;
  if (ni < 0) {
    clearWarningJump();
    gotoPage(0);
    return;
  }
  if (ni >= state.warnings.length) return; // 末尾で次 → 止まってループしない
  jumpWarning(ni);
}
function clearWarningJump() {
  state.warnIndex = -1;
  state._warnHighlight = null;
  syncWarnListActive();
}
/** 一覧の選択行に本文と同じ黄＋枠を付け、見える位置へスクロール */
function syncWarnListActive() {
  const list = $('warnList');
  if (!list) return;
  let activeEl = null;
  list.querySelectorAll('.warn-item').forEach((li) => {
    const on = Number(li.dataset.idx) === state.warnIndex;
    li.classList.toggle('active', on);
    if (on) activeEl = li;
  });
  if (activeEl && typeof activeEl.scrollIntoView === 'function') {
    activeEl.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------- Search ---------------- */
function doSearch() {
  const q = $('searchInput').value;
  if (!q) { state.matches = []; state.matchIndex = -1; $('searchCount').textContent = ''; renderCurrent(); return; }
  send('search', { query: q, headingOnly: false });
}
function stepMatch(delta) {
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + delta + state.matches.length) % state.matches.length;
  gotoOffset(state.matches[state.matchIndex].start);
}
function updateSearchIndicator() {
  $('searchCount').textContent = '';
}

/* ---------------- Copy normalization（親文字のみ） ---------------- */
function installCopyHandler() {
  document.addEventListener('copy', (e) => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const frag = sel.getRangeAt(0).cloneContents();
    frag.querySelectorAll('rt, rp').forEach((n) => n.remove());
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', frag.textContent);
      e.preventDefault();
    }
  });
}

/* ---------------- Position persist ---------------- */
function persistPosition() {
  const page = state.pages[state.pageIndex];
  if (page) savePosition(state.fileName, state.text, page.range.start);
}

/* ---------------- File watch (File System Access API) ---------------- */
function startFileWatch() {
  const check = async () => {
    if (!state.fileHandle) return;
    try {
      const file = await state.fileHandle.getFile();
      if (file.lastModified !== state.fileLastModified) {
        const keepOffset = state.pages[state.pageIndex] ? state.pages[state.pageIndex].range.start : 0;
        state.fileLastModified = file.lastModified;
        const buf = await file.arrayBuffer();
        state.docId++;
        state.pendingOffset = keepOffset;
        send('load', { bytes: buf });
        showToast('更新された');
      }
    } catch { /* 権限切れ等は無視 */ }
  };
  setInterval(check, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

/* ---------------- UI wiring ---------------- */
function buildPresetOptions() {
  const sel = $('presetSelect');
  PRESETS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.name;
    sel.appendChild(o);
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'カスタム';
  sel.appendChild(custom);
}
function reflectSettingsToUI() {
  const s = state.settings;
  $('presetSelect').value = s.presetIndex >= 0 ? String(s.presetIndex) : 'custom';
  $('cpc').value = s.charsPerColumn;
  $('cpp').value = s.columnsPerPage;
  $('kinsoku').checked = s.kinsoku;
  $('burasage').checked = s.burasage;
  $('showRuby').checked = s.showRuby;
  $('halfColor').checked = s.halfColor;
  $('spaceColor').checked = s.spaceColor;
  $('gridLines').checked = s.gridLines;
  $('themeSelect').value = s.theme;
  $('fontSelect').value = s.fontFamily;
  $('fontSize').value = s.fontSize;
  $('burasage').disabled = !s.kinsoku;
}
function applyAppearance() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.dataset.font = s.fontFamily;
}
function persist() { saveSettings(state.settings); }

function bindUI() {
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) openFile(f, null);
  });
  $('openFsBtn').addEventListener('click', async () => {
    if (!window.showOpenFilePicker) { $('fileInput').click(); return; }
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }] });
      const file = await handle.getFile();
      openFile(file, handle);
    } catch { /* キャンセル */ }
  });
  $('reloadBtn').addEventListener('click', () => $('fileInput').click());

  $('presetSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') { state.settings.presetIndex = -1; }
    else {
      const p = PRESETS[+v];
      state.settings.presetIndex = +v;
      state.settings.charsPerColumn = p.charsPerColumn;
      state.settings.columnsPerPage = p.columnsPerPage;
    }
    reflectSettingsToUI(); persist(); if (state.text) requestPaginate();
  });
  const onCustom = () => {
    state.settings.presetIndex = -1;
    state.settings.charsPerColumn = clampInt($('cpc').value, 1, 60, 40);
    state.settings.columnsPerPage = clampInt($('cpp').value, 1, 60, 18);
    $('presetSelect').value = 'custom';
    persist(); if (state.text) requestPaginate();
  };
  $('cpc').addEventListener('change', onCustom);
  $('cpp').addEventListener('change', onCustom);

  $('kinsoku').addEventListener('change', (e) => {
    state.settings.kinsoku = e.target.checked;
    $('burasage').disabled = !e.target.checked;
    persist(); if (state.text) requestPaginate();
  });
  $('burasage').addEventListener('change', (e) => {
    state.settings.burasage = e.target.checked; persist(); if (state.text) requestPaginate();
  });
  // ルビ表示: 再ページ分割しない。再描画＋ワーニング再検出のみ。
  $('showRuby').addEventListener('change', (e) => {
    state.settings.showRuby = e.target.checked; persist(); renderCurrent(); if (state.text) requestWarnings();
  });
  $('halfColor').addEventListener('change', (e) => {
    state.settings.halfColor = e.target.checked; persist(); renderCurrent();
  });
  $('spaceColor').addEventListener('change', (e) => {
    state.settings.spaceColor = e.target.checked; persist(); renderCurrent();
  });
  $('gridLines').addEventListener('change', (e) => {
    state.settings.gridLines = e.target.checked; persist(); renderCurrent();
  });
  $('themeSelect').addEventListener('change', (e) => {
    state.settings.theme = e.target.value; applyAppearance(); persist();
  });
  $('fontSelect').addEventListener('change', (e) => {
    state.settings.fontFamily = e.target.value; applyAppearance(); persist(); renderCurrent();
  });
  $('fontSize').addEventListener('change', (e) => {
    const max = maxFitFontSize();
    const v = clampInt(e.target.value, 8, FONT_SIZE_MAX_CAP, max);
    state.settings.fontSize = v;
    // 最大を選んだら auto（ウィンドウ拡大に追随）。それ以外は固定。
    state.settings.fontSizeAuto = v >= max;
    persist();
    populateFontSizes();
    renderCurrent();
  });

  $('prevBtn').addEventListener('click', () => go(-1));
  $('nextBtn').addEventListener('click', () => go(1));
  $('jumpInput').addEventListener('change', (e) => gotoPage((+e.target.value || 1) - 1));

  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('searchBtn').addEventListener('click', doSearch);
  $('searchPrev').addEventListener('click', () => stepMatch(-1));
  $('searchNext').addEventListener('click', () => stepMatch(1));

  $('warnPrev').addEventListener('click', () => stepWarning(-1));
  $('warnNext').addEventListener('click', () => stepWarning(1));

  $('togglePanel').addEventListener('click', () => document.body.classList.toggle('panel-open'));
}

function clampInt(v, lo, hi, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
