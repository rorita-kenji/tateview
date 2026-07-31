// main.js — メインスレッドの統括
import { pageIndexOfOffset } from './modules/paginator.js';
import { headingLevel, headingTitle, resolveHeadingMarks } from './modules/heading.js';
import { WARNING_LABELS } from './modules/warnings.js';
import { firstMatchIndexFrom, searchInRange } from './modules/search.js';
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
  /** 再読込時は true。loaded で loadPosition せず pendingOffset を維持 */
  keepOffsetOnLoad: false,
  /** 「更新」から file ピッカーを開いた（開くとは別） */
  expectReloadPick: false,
  warnings: [],
  warnTotal: 0,
  warnIndex: -1,
  matches: [],
  matchTotal: 0,
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
  // 未読状態のガイド表示
  $('pageWrap').classList.add('empty');
  window.addEventListener('resize', () => {
    populateFontSizes();
    renderCurrent();
    if (state.pages.length) refreshThumbLayout();
  });
  window.addEventListener('keydown', onKey);
  bindThumbScrub();
  const wrap = $('pageWrap');
  wrap.addEventListener('wheel', onWheel, { passive: false });
  // 未読状態のとき、原稿表示領域のクリックでファイル選択ダイアログを開く
  wrap.addEventListener('click', (e) => {
    if (!state.text && state.fileName === 'untitled.txt') {
      e.preventDefault();
      $('fileInput').click();
    }
  });
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
    // 未読ガイドを消す
    $('pageWrap').classList.remove('empty');
    const encLabel = { 'utf-8': 'UTF-8', 'shift_jis': 'Shift_JIS', unknown: '不明' }[payload.encoding || ''] || payload.encoding;
    const meta = `${state.fileName} ・ ${encLabel} ・ 改行 ${payload.newline} ・ ${state.text.length}字`;
    $('fileMeta').textContent = meta;
    $('fileMeta').title = meta;
    // 初回オープンのみ位置復元。自動／手動の「更新」再読込は keepOffsetOnLoad で現在位置を維持
    if (state.keepOffsetOnLoad) {
      state.keepOffsetOnLoad = false;
      state.pendingOffset = Math.max(0, Math.min(state.pendingOffset, state.text.length));
    } else {
      state.pendingOffset = loadPosition(state.fileName, state.text);
    }
    requestPaginate();
    requestWarnings();
    updateSearchIndicator();
  } else if (type === 'needEncoding') {
    setProgress('文字コードを判定できませんでした');
    $('fileMeta').textContent = `${state.fileName} ・ 文字コード判定不可`;
    $('fileMeta').title = $('fileMeta').textContent;
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
    // 表示中ページ先頭以降の最初のヒットへ。無ければページはそのまま（文書先頭へ飛ばない）
    const from = searchStartOffset();
    state.matches = payload.matches || [];
    state.matchTotal = payload.total || state.matches.length;
    updateSearchCount();
    updateThumbSearchMarks();
    const i = firstMatchIndexFrom(state.matches, from, { wrap: false });
    if (i >= 0) gotoOffset(state.matches[i].start);
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
  const s = state.settings;
  // Build enabled set from individual toggle settings.
  // null → all on (legacy). Now we control per-code via settings.
  const enabled = new Set();
  for (const code of Object.keys(WARNING_LABELS)) {
    if (code === 'fullwidth-alpha' && !s.fullwidthAlpha) continue;
    if (code === 'fullwidth-digit' && !s.fullwidthDigit) continue;
    enabled.add(code);
  }
  send('detectWarnings', {
    showRuby: s.showRuby,
    enabled: [...enabled],
    chapterMark: s.chapterMark,
    episodeMark: s.episodeMark,
  });
}

/* ---------------- File open / reload ---------------- */
/**
 * @param {File} file
 * @param {FileSystemFileHandle|null} handle
 * @param {{ keepPosition?: boolean }} [opts] keepPosition=true は更新再読込（位置維持）
 */
async function openFile(file, handle, opts = {}) {
  state.fileName = file.name || 'untitled.txt';
  state.fileHandle = handle || null;
  state.fileLastModified = file.lastModified || 0;
  state.keepOffsetOnLoad = !!opts.keepPosition;
  if (opts.keepPosition) {
    const page = state.pages[state.pageIndex];
    if (page) state.pendingOffset = page.range.start;
    // pages が空でも呼び出し側で pendingOffset 済みならそれを使う
  }
  updateReloadLabel();
  const buf = await file.arrayBuffer();
  state.docId++;
  setProgress('読み込み中…');
  send('load', { bytes: buf });
}

/**
 * 「更新」ボタン用。開く（別ファイル選択）ではない。
 * File System Access あり → ハンドルから再読込。
 * なし → ブラウザ制限でディスク再読ができないため、同じファイルの再選択を促す。
 */
async function reloadManuscript() {
  if (state.fileHandle) {
    try {
      const file = await state.fileHandle.getFile();
      const page = state.pages[state.pageIndex];
      if (page) state.pendingOffset = page.range.start;
      state.fileLastModified = file.lastModified || 0;
      await openFile(file, state.fileHandle, { keepPosition: true });
      showToast('更新された');
    } catch {
      showToast('再読込に失敗しました');
    }
    return;
  }
  // 未オープン
  if (!state.text && state.fileName === 'untitled.txt') {
    showToast('先に「開く」で原稿を選択してください');
    return;
  }
  // 自動更新不可環境: 同じファイルを選び直してディスク上の最新を読む
  state.expectReloadPick = true;
  showToast('同じファイルを選び直してください', 2000);
  $('fileInput').click();
}

/* ---------------- Rendering ---------------- */
function renderCurrent() {
  const pageEl = $('page');
  if (!state.pages.length) {
    pageEl.textContent = '';
    const peer = $('pagePeer');
    if (peer) peer.textContent = '';
    resetPageStrip(true);
    updateStatus();
    return;
  }
  // スワイプ確定アニメ中は中身を触らない（ストリップが隣ページを見せている）
  if (pageSwipeLock) {
    updateStatus();
    return;
  }
  if (!pageSwipeActive) {
    resetPageStrip(true);
  }
  paintPageSheet(pageEl, state.pageIndex, { highlights: true });
  // fit scale
  const wrap = $('pageWrap');
  const availW = wrap.clientWidth - 44;
  const availH = wrap.clientHeight - 44;
  const ext = measureExtent(pageEl);
  let scale = 1;
  if (ext && ext.w > 0 && ext.h > 0) {
    scale = Math.min(1, availW / ext.w, availH / ext.h);
  }
  pageFitScale = scale;
  applySheetScale(pageEl);
  if (pageSwipeActive && pageSwipePeerDir) {
    const peerEl = $('pagePeer');
    if (peerEl && peerEl.childNodes.length) applySheetScale(peerEl);
    applyStripTransform({ live: true });
  }
  updateStatus();
  persistPosition();
}

/**
 * 1ページ分を sheet に描画。
 * @param {HTMLElement} pageEl
 * @param {number} pageIndex
 * @param {{ highlights?: boolean }} [opt]
 */
function paintPageSheet(pageEl, pageIndex, opt) {
  const page = state.pages[pageIndex];
  if (!page || !pageEl) {
    if (pageEl) pageEl.textContent = '';
    return;
  }
  pageEl.classList.toggle('grid', !!state.settings.gridLines);
  const highlights = [];
  if (opt && opt.highlights && state.text) {
    const q = ($('searchInput') && $('searchInput').value) || '';
    if (q) {
      const live = searchInRange(state.text, q, page.range.start, page.range.end);
      for (const m of live) {
        highlights.push({ start: m.start, end: m.end, kind: 'search' });
      }
    }
    if (state._warnHighlight) {
      highlights.push({ ...state._warnHighlight, kind: 'warn' });
    }
  }
  const fs = effectiveFontSize();
  applyFs(fs);
  renderPage(pageEl, state.text, page, {
    showRuby: state.settings.showRuby,
    halfColor: state.settings.halfColor,
    spaceColor: state.settings.spaceColor,
    highlights,
  });
  markHeadings(pageEl, page);
  buildRulers(pageEl, fs * 1.05);
}

function applySheetScale(pageEl) {
  if (!pageEl) return;
  const s = pageFitScale < 0.999 ? pageFitScale : 1;
  pageEl.style.transform = s === 1 ? 'none' : `scale(${s})`;
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
  // 見出し行（LF行）: 行頭〜マーカー前が半角/全角スペースのみなら色クラス。
  // 改行で本文に戻る。
  const marks = resolveHeadingMarks(state.settings);
  const cols = pageEl.querySelectorAll('.col');
  page.columns.forEach((c, i) => {
    if (!cols[i]) return;
    const line = lineTextAt(state.text, c.start);
    const lv = headingLevel(line, marks);
    if (lv === 2) cols[i].classList.add('heading-2');
    else if (lv === 1) cols[i].classList.add('heading-1');
  });
}

/** offset を含む LF 行の本文（改行を含まない） */
function lineTextAt(text, offset) {
  const o = Math.max(0, Math.min(offset, text.length));
  const start = o === 0 ? 0 : text.lastIndexOf('\n', o - 1) + 1;
  let end = text.indexOf('\n', o);
  if (end < 0) end = text.length;
  // 列先頭が改行直後で o が次行のときも start は正しい。列が改行を含む場合は start 側の行を見る
  return text.slice(start, end);
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

/* ---------------- Thumbnails（ミニマップ: 領域内に全体表示・Y撫でで移動） ---------------- */
let scrubbing = false;

function buildThumbnails() {
  const box = $('thumbs');
  box.innerHTML = '';
  box.classList.remove('compact', 'ultra', 'scrubbing');
  if (!state.pages.length) return;

  // ビューポート枠 + 「Nページ」ラベル（常時）
  const vp = document.createElement('div');
  vp.className = 'thumb-viewport';
  vp.setAttribute('aria-hidden', 'true');
  const vpLabel = document.createElement('span');
  vpLabel.className = 'vp-label';
  vp.appendChild(vpLabel);
  box.appendChild(vp);

  const cpc = Math.max(1, state.settings.charsPerColumn || 40);
  state.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.i = String(i);
    const heads = headingsInPage(p);

    const num = document.createElement('span');
    num.className = 'tnum';
    num.textContent = String(i + 1);
    t.appendChild(num);
    // 章/話: 色バー幅 ≒ タイトル字数 / 1行字数。ラベルは高さがあるときだけ
    for (const hd of heads) {
      const mark = document.createElement('span');
      mark.className = hd.level === 2 ? 'tmark h2' : 'tmark h1';
      // 1行設定字数に対する実タイトル長（コードポイント）。1行分で 100%
      const pct = Math.min(100, Math.max(12, (hd.charLen / cpc) * 100));
      mark.style.width = `${pct}%`;
      mark.title = hd.text;
      t.appendChild(mark);

      const h = document.createElement('span');
      h.className = hd.level === 2 ? 'thead h2' : 'thead';
      h.textContent = hd.text;
      t.appendChild(h);
    }
    box.appendChild(t);
  });
  refreshThumbLayout();
  updateThumbActive();
  updateThumbSearchMarks();
}

/** ページ数と領域高さから compact/ultra を切替（スクロール無しで全体が見える） */
function refreshThumbLayout() {
  const box = $('thumbs');
  const n = state.pages.length;
  if (!n) {
    box.classList.remove('compact', 'ultra');
    return;
  }
  const h = box.clientHeight || 0;
  const per = h > 0 ? h / n : 0;
  // おおよそ: 16px未満で番号隠し、6px未満で帯のみ
  box.classList.toggle('compact', per > 0 && per < 18);
  box.classList.toggle('ultra', per > 0 && per < 7);
  updateThumbViewport();
}

function updateThumbViewport() {
  const box = $('thumbs');
  const vp = box.querySelector('.thumb-viewport');
  const n = state.pages.length;
  if (!vp || !n) return;
  const h = box.clientHeight;
  if (h <= 0) return;
  // padding は CSS と揃える（compact/ultra で少し変わるが位置の誤差は許容）
  const cs = getComputedStyle(box);
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBot = parseFloat(cs.paddingBottom) || 0;
  const inner = Math.max(0, h - padTop - padBot);
  const rowH = inner / n;
  // ラベル（20px）が読めるよう最低高さを確保し、行中央に合わせる
  const hh = Math.max(24, rowH);
  let top = padTop + state.pageIndex * rowH + (rowH - hh) / 2;
  // はみ出し防止
  const maxTop = padTop + inner - hh;
  top = Math.max(padTop, Math.min(maxTop, top));
  vp.style.top = `${top}px`;
  vp.style.height = `${hh}px`;
  const lab = vp.querySelector('.vp-label');
  if (lab) lab.textContent = `${state.pageIndex + 1}ページ`;
}

/** クライアントY → ページ index（領域高さに全ページを等分マップ） */
function pageIndexFromClientY(clientY) {
  const box = $('thumbs');
  const n = state.pages.length;
  if (!n) return 0;
  const rect = box.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  const p = (clientY - rect.top) / rect.height;
  const i = Math.floor(p * n);
  return clampPage(i);
}

function bindThumbScrub() {
  const box = $('thumbs');
  box.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    if (!state.pages.length) return;
    // マーク入力など他要素は対象外（thumbs 内に交互作用要素は置かない）
    scrubbing = true;
    box.classList.add('scrubbing');
    // 検索欄などにフォーカスが残ると Space/矢印がページ送りにならず
    // 「キーボードを受け付けない」ように見える。入力フォーカスを外して本文へ移す。
    blurTextEntryFocus();
    focusPageForKeys();
    try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    gotoPage(pageIndexFromClientY(e.clientY));
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    gotoPage(pageIndexFromClientY(e.clientY));
    e.preventDefault();
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    box.classList.remove('scrubbing');
    try {
      if (e && e.pointerId != null) box.releasePointerCapture(e.pointerId);
    } catch (_) { /* ignore */ }
    // キャプチャ解放後もキー操作先を本文に固定
    focusPageForKeys();
  };
  box.addEventListener('pointerup', endScrub);
  box.addEventListener('pointercancel', endScrub);
  box.addEventListener('lostpointercapture', () => {
    scrubbing = false;
    box.classList.remove('scrubbing');
  });
}

/** 検索・数値・見出し記号など「文字入力」フォーカスを外す */
function blurTextEntryFocus() {
  const ae = document.activeElement;
  if (!ae || ae === document.body || ae === document.documentElement) return;
  const tag = ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable) {
    try { ae.blur(); } catch (_) { /* ignore */ }
  }
}

/** ページキー（Space/矢印）を受け付けるよう本文領域へフォーカス */
function focusPageForKeys() {
  const wrap = $('pageWrap');
  if (!wrap) return;
  if (wrap.tabIndex < 0 && !wrap.hasAttribute('tabindex')) wrap.tabIndex = -1;
  try {
    wrap.focus({ preventScroll: true });
  } catch (_) {
    try { wrap.focus(); } catch (__) { /* ignore */ }
  }
}

/**
 * ページ範囲内の見出しを出現順ですべて返す。
 * text は表示用（長いと切る）、charLen はバー幅用の実タイトル字数（コードポイント）。
 * @returns {{ level: 1|2, text: string, charLen: number }[]}
 */
function headingsInPage(p) {
  const marks = resolveHeadingMarks(state.settings);
  const seg = state.text.slice(p.range.start, p.range.end);
  const out = [];
  for (const line of seg.split('\n')) {
    const full = headingTitle(line, marks, 0); // 切らずに実長を取る
    if (!full) continue;
    const charLen = Math.max(1, [...full.text].length);
    const text = full.text.length > 24 ? full.text.slice(0, 24) : full.text;
    out.push({ level: full.level, text, charLen });
  }
  return out;
}
function updateThumbActive() {
  const box = $('thumbs');
  const cur = box.querySelector('.thumb.active');
  if (cur) cur.classList.remove('active');
  // .thumb-viewport を除いた .thumb を対象
  const el = box.querySelector(`.thumb[data-i="${state.pageIndex}"]`);
  if (el) el.classList.add('active');
  updateThumbViewport();
}

/**
 * 全文検索ヒットをミニマップ上に黄色で示す。
 * ページ帯を薄く塗り、ページ内相対位置に細いマークを置く（本文の hl-search と同系色）。
 * state.matches が空ならクリア（入力中のライブハイライトのみのときは出さない）。
 */
function updateThumbSearchMarks() {
  const box = $('thumbs');
  if (!box) return;
  for (const el of box.querySelectorAll('.thumb')) {
    el.classList.remove('has-search');
    el.querySelectorAll('.tsearch').forEach((n) => n.remove());
  }
  if (!state.matches.length || !state.pages.length) return;

  /** 1ページあたりの位置マーク上限（密集時の DOM 膨張を防ぐ） */
  const MAX_MARKS_PER_PAGE = 12;
  /** @type {Map<number, number>} */
  const counts = new Map();

  for (const m of state.matches) {
    const pi = pageIndexOfOffset(state.pages, m.start);
    if (pi < 0) continue;
    const thumb = box.querySelector(`.thumb[data-i="${pi}"]`);
    if (!thumb) continue;
    thumb.classList.add('has-search');

    const n = counts.get(pi) || 0;
    if (n >= MAX_MARKS_PER_PAGE) {
      counts.set(pi, n + 1);
      continue;
    }
    counts.set(pi, n + 1);

    const page = state.pages[pi];
    const span = Math.max(1, page.range.end - page.range.start);
    // ページ先頭=上、末尾=下（ミニマップの縦軸）
    const rel = Math.min(1, Math.max(0, (m.start - page.range.start) / span));
    const mark = document.createElement('span');
    mark.className = 'tsearch';
    mark.style.top = `${rel * 100}%`;
    mark.title = '検索ヒット';
    thumb.appendChild(mark);
  }
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
// 不可なら「更新」ボタン（手動再読込。開くではない）を表示。
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
    return true;
  }
  return false;
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

/* ---------------- ページ捲り（タッチ横スワイプ / トラックパッド横ドラッグ） ----------------
 * 現在ページ + 隣ページをストリップで並べ、translateX でスクロールイン。
 * 閾値を超えたら静止待ちせずそのまま完了アニメ。
 */
let pageFitScale = 1;
/** ストリップ横オフセット px（右=+ ＝次ページ方向） */
let pageSwipeTx = 0;
/** ドラッグ／wheel 追従中 */
let pageSwipeActive = false;
/** 閾値超え後の完了アニメ中（入力無視・render 抑制） */
let pageSwipeLock = false;
/** 表示中の隣ページ方向 1=次 / -1=前 / 0=なし */
let pageSwipePeerDir = 0;
let pageSwipePeerIndex = -1;
/** コミット中の方向 */
let pageSwipeCommitDir = 0;
/** transitionend ハンドラ（中断時に外す） */
let pageSwipeEndHandler = null;
let pageSwipeAnimTimer = 0;
let wheelSpringTimer = 0;
let pageSwipeIdleTimer = 0;
let wheelAccum = 0;
/** commit 世代（遅延 finish の二重実行防止） */
let pageSwipeGen = 0;
/**
 * いまのアクションで既に1ページ commit したか。
 * 解除は「横入力が止まってから」だけ（固定時間だと慣性で2ページ目に入る）。
 */
let pageSwipePageTaken = false;

/** 閾値（それ以上で自動完了）。実幅に対する割合も見る */
const SWIPE_COMMIT_RATIO = 0.08;
const SWIPE_COMMIT_MIN_PX = 28;
const SWIPE_ANIM_MS = 220;
/** 横入力がこの時間途切れたら次の1ページを許可 */
const SWIPE_IDLE_CLEAR_MS = 300;

function slideWidth() {
  // スロットは #pageStrip の 100% 幅。pageWrap.clientWidth（padding 込み）だと
  // 満幅アニメが行き過ぎて、复位で「戻る」ように見える。
  const strip = $('pageStrip');
  if (strip && strip.clientWidth > 40) return strip.clientWidth;
  const wrap = $('pageWrap');
  if (!wrap) return 600;
  const cs = getComputedStyle(wrap);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(200, (wrap.clientWidth || 600) - pad);
}

function commitThreshold() {
  return Math.max(SWIPE_COMMIT_MIN_PX, slideWidth() * SWIPE_COMMIT_RATIO);
}

/**
 * 横入力のたびに呼ぶ。入力が止まってから pageTaken を解除する。
 * （finish 直後の固定タイマー解除だと、慣性で2ページ目が走る）
 */
function armSwipeIdleClear() {
  if (pageSwipeIdleTimer) clearTimeout(pageSwipeIdleTimer);
  pageSwipeIdleTimer = setTimeout(() => {
    pageSwipeIdleTimer = 0;
    if (pageSwipeLock) {
      // アニメ中に明けない。終わってから再アーム
      armSwipeIdleClear();
      return;
    }
    pageSwipePageTaken = false;
    pageSwipeTx = 0;
    pageSwipeActive = false;
  }, SWIPE_IDLE_CLEAR_MS);
}

/**
 * 進行中の transition を破棄し、現在の見た目のまま固める。
 * @param {HTMLElement} strip
 */
function freezeStripTransition(strip) {
  if (!strip) return;
  const comp = getComputedStyle(strip).transform;
  strip.classList.remove('strip-anim', 'strip-live');
  strip.style.transition = 'none';
  // matrix を固定してから次の transform を書く（補間の逆走防止）
  strip.style.transform = (!comp || comp === 'none') ? 'none' : comp;
  // force reflow
  void strip.offsetWidth;
}

/**
 * ストリップ transform。
 * @param {{ live?: boolean, anim?: boolean, killTransition?: boolean }} [opt]
 */
function applyStripTransform(opt) {
  const strip = $('pageStrip');
  if (!strip) return;
  const live = !!(opt && opt.live);
  const anim = !!(opt && opt.anim);
  const kill = !!(opt && opt.killTransition);

  if (kill) freezeStripTransition(strip);

  strip.classList.toggle('strip-live', live);
  strip.classList.toggle('strip-anim', anim && !live);

  if (live || kill) {
    strip.style.transition = 'none';
  } else if (anim) {
    strip.style.transition = '';
  }

  const tx = pageSwipeTx;
  strip.style.transform = Math.abs(tx) < 0.4 ? 'none' : `translate3d(${tx}px,0,0)`;
}

function resetPageStrip(clearPeer) {
  pageSwipeTx = 0;
  pageSwipeActive = false;
  pageSwipePeerDir = 0;
  pageSwipePeerIndex = -1;
  const strip = $('pageStrip');
  if (strip) {
    freezeStripTransition(strip);
    strip.style.transform = 'none';
    strip.classList.remove('strip-live', 'strip-anim');
    requestAnimationFrame(() => {
      if (!pageSwipeActive && !pageSwipeLock) strip.style.transition = '';
    });
  }
  if (clearPeer) {
    const slot = $('slotPeer');
    const peer = $('pagePeer');
    if (slot) {
      slot.hidden = true;
      slot.classList.remove('peer-next', 'peer-prev');
    }
    if (peer) peer.textContent = '';
  }
}

/**
 * 隣ページを slotPeer に用意（方向が変わったときだけ再描画）。
 * @param {1|-1} dir
 * @returns {boolean} 隣が存在するか
 */
function ensureSwipePeer(dir) {
  const idx = state.pageIndex + dir;
  if (idx < 0 || idx >= state.pages.length) {
    hideSwipePeer();
    return false;
  }
  const slot = $('slotPeer');
  const peer = $('pagePeer');
  if (!slot || !peer) return false;
  if (pageSwipePeerDir === dir && pageSwipePeerIndex === idx && peer.childNodes.length) {
    slot.hidden = false;
    return true;
  }
  pageSwipePeerDir = dir;
  pageSwipePeerIndex = idx;
  slot.classList.toggle('peer-next', dir === 1);
  slot.classList.toggle('peer-prev', dir === -1);
  slot.hidden = false;
  paintPageSheet(peer, idx, { highlights: false });
  applySheetScale(peer);
  return true;
}

function hideSwipePeer() {
  pageSwipePeerDir = 0;
  pageSwipePeerIndex = -1;
  const slot = $('slotPeer');
  const peer = $('pagePeer');
  if (slot) {
    slot.hidden = true;
    slot.classList.remove('peer-next', 'peer-prev');
  }
  if (peer) peer.textContent = '';
}

/**
 * 進行中の commit / spring アニメを破棄（finish は呼ばない）。
 */
function abortSwipeAnimation() {
  const strip = $('pageStrip');
  if (pageSwipeAnimTimer) {
    clearTimeout(pageSwipeAnimTimer);
    pageSwipeAnimTimer = 0;
  }
  if (strip && pageSwipeEndHandler) {
    strip.removeEventListener('transitionend', pageSwipeEndHandler);
    pageSwipeEndHandler = null;
  }
  pageSwipeGen += 1;
}

/**
 * @param {number} tx
 * @returns {'track'|'commit'|'block'}
 */
function trackSwipeTx(tx) {
  if (!state.pages.length) return 'block';
  // アニメ中 or このアクションで送信済 → 動かさない
  if (pageSwipeLock || pageSwipePageTaken) return 'block';

  const atStart = state.pageIndex <= 0;
  const atEnd = state.pageIndex >= state.pages.length - 1;
  let x = tx;
  if (x > 0 && atEnd) x *= 0.25;
  if (x < 0 && atStart) x *= 0.25;
  const w = slideWidth();
  x = Math.max(-w, Math.min(w, x));

  pageSwipeActive = true;
  pageSwipeTx = x;

  if (Math.abs(x) > 2) {
    const dir = /** @type {1|-1} */ (x > 0 ? 1 : -1);
    const ok = ensureSwipePeer(dir);
    if (!ok) {
      pageSwipeTx = x * 0.5;
      applyStripTransform({ live: true });
      return 'track';
    }
  } else {
    hideSwipePeer();
  }
  applyStripTransform({ live: true });

  const th = commitThreshold();
  const dir = pageSwipeTx > 0 ? 1 : -1;
  if (Math.abs(pageSwipeTx) >= th) {
    const target = clampPage(state.pageIndex + dir);
    if (target !== state.pageIndex && ensureSwipePeer(dir)) {
      commitSwipe(dir);
      return 'commit';
    }
  }
  return 'track';
}

/**
 * @param {1|-1} dir
 */
function commitSwipe(dir) {
  if (pageSwipeLock || pageSwipePageTaken) return;
  if (!ensureSwipePeer(dir)) {
    springSwipeHome();
    return;
  }
  // このアクションでは1ページだけ
  pageSwipePageTaken = true;
  pageSwipeLock = true;
  pageSwipeActive = true;
  pageSwipeCommitDir = dir;
  armSwipeIdleClear(); // 慣性イベントのあいだ taken を維持
  if (wheelSpringTimer) {
    clearTimeout(wheelSpringTimer);
    wheelSpringTimer = 0;
  }
  const gen = ++pageSwipeGen;
  const strip = $('pageStrip');
  const w = slideWidth();
  const target = dir * w;
  let settled = false;

  freezeStripTransition(strip);
  pageSwipeTx = target;
  requestAnimationFrame(() => {
    if (gen !== pageSwipeGen || !pageSwipeLock) return;
    if (strip) {
      strip.classList.remove('strip-live');
      strip.classList.add('strip-anim');
      strip.style.transition = '';
      strip.style.transform = `translate3d(${target}px,0,0)`;
    }
  });

  const done = () => {
    if (settled || gen !== pageSwipeGen) return;
    settled = true;
    if (pageSwipeAnimTimer) {
      clearTimeout(pageSwipeAnimTimer);
      pageSwipeAnimTimer = 0;
    }
    if (strip && pageSwipeEndHandler) {
      strip.removeEventListener('transitionend', pageSwipeEndHandler);
      pageSwipeEndHandler = null;
    }
    finishSwipeCommit(dir, gen);
  };
  /** @param {TransitionEvent} ev */
  const onEnd = (ev) => {
    if (ev.target !== strip) return;
    if (ev.propertyName && ev.propertyName !== 'transform') return;
    done();
  };
  pageSwipeEndHandler = onEnd;
  if (strip) strip.addEventListener('transitionend', onEnd);

  if (pageSwipeAnimTimer) clearTimeout(pageSwipeAnimTimer);
  pageSwipeAnimTimer = setTimeout(done, SWIPE_ANIM_MS + 40);
}

/**
 * @param {1|-1} dir
 * @param {number} gen
 */
function finishSwipeCommit(dir, gen) {
  if (gen !== pageSwipeGen) return;

  const strip = $('pageStrip');
  const pageEl = $('page');
  const peerEl = $('pagePeer');

  freezeStripTransition(strip);

  const ni = clampPage(state.pageIndex + dir);
  state.pageIndex = ni;
  syncPendingFromPage();

  const keepScale = pageFitScale;
  if (peerEl && pageEl && peerEl.childNodes.length) {
    pageEl.className = peerEl.className.includes('grid')
      ? 'page-sheet grid'
      : 'page-sheet';
    pageEl.replaceChildren(...Array.from(peerEl.childNodes));
  } else {
    paintPageSheet(pageEl, state.pageIndex, { highlights: true });
  }
  pageFitScale = keepScale;
  applySheetScale(pageEl);

  pageSwipeTx = 0;
  pageSwipeCommitDir = 0;
  if (strip) {
    strip.style.transition = 'none';
    strip.style.transform = 'none';
    strip.classList.remove('strip-anim', 'strip-live');
    void strip.offsetWidth;
  }
  hideSwipePeer();

  pageSwipeLock = false;
  pageSwipeActive = false;
  pageSwipeTx = 0;
  // 次ページ許可は「入力アイドル」まで待つ（固定msだと慣性で2ページ目）
  armSwipeIdleClear();
  wheelAccum = 0;
  if (wheelSpringTimer) {
    clearTimeout(wheelSpringTimer);
    wheelSpringTimer = 0;
  }

  const paintGen = pageSwipeGen;
  requestAnimationFrame(() => {
    if (pageSwipeLock || pageSwipeActive || paintGen !== pageSwipeGen) return;
    paintPageSheet(pageEl, state.pageIndex, { highlights: true });
    const wrap = $('pageWrap');
    if (!wrap || !pageEl) return;
    const availW = wrap.clientWidth - 44;
    const availH = wrap.clientHeight - 44;
    const ext = measureExtent(pageEl);
    let scale = keepScale;
    if (ext && ext.w > 0 && ext.h > 0) {
      scale = Math.min(1, availW / ext.w, availH / ext.h);
    }
    pageFitScale = scale;
    applySheetScale(pageEl);
    if (strip) strip.style.transition = '';
  });

  updateStatus();
  persistPosition();
}

/** 閾値未満: 元の位置へばね戻し */
function springSwipeHome() {
  if (pageSwipeLock || pageSwipePageTaken) return;
  if (wheelSpringTimer) {
    clearTimeout(wheelSpringTimer);
    wheelSpringTimer = 0;
  }
  const gen = ++pageSwipeGen;
  const strip = $('pageStrip');
  let settled = false;
  pageSwipeActive = true;
  freezeStripTransition(strip);
  pageSwipeTx = 0;
  requestAnimationFrame(() => {
    if (gen !== pageSwipeGen) return;
    if (strip) {
      strip.classList.add('strip-anim');
      strip.classList.remove('strip-live');
      strip.style.transition = '';
      strip.style.transform = 'none';
    }
  });
  if (pageSwipeAnimTimer) clearTimeout(pageSwipeAnimTimer);
  const done = () => {
    if (settled || gen !== pageSwipeGen) return;
    settled = true;
    pageSwipeAnimTimer = 0;
    if (strip && pageSwipeEndHandler) {
      strip.removeEventListener('transitionend', pageSwipeEndHandler);
      pageSwipeEndHandler = null;
    }
    pageSwipeActive = false;
    freezeStripTransition(strip);
    hideSwipePeer();
    resetPageStrip(true);
    applySheetScale($('page'));
  };
  /** @param {TransitionEvent} ev */
  const onEnd = (ev) => {
    if (ev.target !== strip) return;
    if (ev.propertyName && ev.propertyName !== 'transform') return;
    done();
  };
  pageSwipeEndHandler = onEnd;
  if (strip) strip.addEventListener('transitionend', onEnd);
  pageSwipeAnimTimer = setTimeout(done, SWIPE_ANIM_MS + 40);
}

/**
 * 指を離したとき: 未コミットなら閾値判定。
 */
function onSwipeRelease() {
  if (pageSwipeLock) return;
  if (pageSwipePageTaken) {
    pageSwipeActive = false;
    armSwipeIdleClear();
    return;
  }
  if (Math.abs(pageSwipeTx) >= commitThreshold()) {
    const dir = /** @type {1|-1} */ (pageSwipeTx > 0 ? 1 : -1);
    if (clampPage(state.pageIndex + dir) !== state.pageIndex) {
      commitSwipe(dir);
      return;
    }
  }
  if (Math.abs(pageSwipeTx) > 2) springSwipeHome();
  else {
    pageSwipeActive = false;
    hideSwipePeer();
    resetPageStrip(true);
  }
}

function onWheel(e) {
  // トラックパッド二本指横: 1アクション=1ページ。
  // 送信後は入力が完全に止まってから次を受け付ける。
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 1.5) {
    e.preventDefault();
    if (!state.pages.length) return;

    // 送信済／アニメ中: イベントは消費してアイドル解除タイマーだけ延長
    if (pageSwipePageTaken || pageSwipeLock) {
      pageSwipeTx = 0;
      armSwipeIdleClear();
      return;
    }

    const next = pageSwipeTx - e.deltaX;
    const result = trackSwipeTx(next);
    if (result === 'commit') {
      armSwipeIdleClear();
      return;
    }

    // 閾値未満のまま止まったらホームへ
    if (wheelSpringTimer) clearTimeout(wheelSpringTimer);
    wheelSpringTimer = setTimeout(() => {
      wheelSpringTimer = 0;
      if (!pageSwipeLock && !pageSwipePageTaken &&
          pageSwipeActive && Math.abs(pageSwipeTx) < commitThreshold()) {
        springSwipeHome();
      }
    }, 120);
    return;
  }

  e.preventDefault();
  if (pageSwipeActive || pageSwipeLock || pageSwipePageTaken) return;
  wheelAccum += e.deltaY;
  if (Math.abs(wheelAccum) > 60) {
    go(wheelAccum > 0 ? 1 : -1);
    wheelAccum = 0;
  }
}

/**
 * タッチ横スワイプ。1ドラッグ=1ページ。指を離してから次。
 * @param {HTMLElement} el #pageWrap
 */
function installSwipe(el) {
  /** @type {number|null} */
  let pointerId = null;
  let x0 = 0;
  let y0 = 0;
  let baseTx = 0;
  let axisLocked = /** @type {null|'h'|'v'} */ (null);

  const onDown = (e) => {
    if (!state.pages.length) return;
    if (e.pointerType === 'mouse') return;
    if (pointerId != null) return;
    if (pageSwipeLock) return;
    // 新しいドラッグ = 新しい1ページ枠
    pageSwipePageTaken = false;
    if (pageSwipeIdleTimer) {
      clearTimeout(pageSwipeIdleTimer);
      pageSwipeIdleTimer = 0;
    }
    pointerId = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    baseTx = 0;
    pageSwipeTx = 0;
    axisLocked = null;
    pageSwipeActive = true;
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };

  const onMove = (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    if (pageSwipeLock || pageSwipePageTaken) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!axisLocked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axisLocked = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      if (axisLocked === 'v') {
        pointerId = null;
        try { el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (Math.abs(pageSwipeTx) > 2) springSwipeHome();
        else {
          pageSwipeActive = false;
          resetPageStrip(true);
        }
        return;
      }
    }
    if (axisLocked !== 'h') return;
    e.preventDefault();
    trackSwipeTx(baseTx + dx);
  };

  const onUp = (e) => {
    if (pointerId == null || (e.pointerId != null && e.pointerId !== pointerId)) return;
    pointerId = null;
    axisLocked = null;
    try {
      if (e.pointerId != null) el.releasePointerCapture(e.pointerId);
    } catch (_) { /* ignore */ }
    onSwipeRelease();
    // 指を離したら次のドラッグを受け付ける（quiet 中でも次タッチは onDown で解除）
    if (!pageSwipeLock) pageSwipePageTaken = false;
  };

  el.addEventListener('pointerdown', onDown, { passive: true });
  el.addEventListener('pointermove', onMove, { passive: false });
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', () => {
    if (pointerId == null) return;
    pointerId = null;
    if (!pageSwipeLock) {
      onSwipeRelease();
      pageSwipePageTaken = false;
    }
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
/** 検索開始オフセット: 常に表示中ページの先頭（ワード変更でも文書先頭へ戻さない） */
function searchStartOffset() {
  const page = state.pages[state.pageIndex];
  if (page) return page.range.start;
  return Math.max(0, state.pendingOffset || 0);
}
function updateSearchCount() {
  const n = state.matches.length;
  const t = state.matchTotal || n;
  if (!n) {
    $('searchCount').textContent = t ? `${t}件` : '0件';
    return;
  }
  // カーソル番号は出さない（件数のみ）
  $('searchCount').textContent = t === n ? `${n}件` : `${n}/${t}件`;
}
/** ヒットを含むページ番号（昇順・重複なし） */
function pagesWithMatches() {
  if (!state.matches.length || !state.pages.length) return [];
  const out = [];
  let last = -1;
  for (const m of state.matches) {
    const pi = pageIndexOfOffset(state.pages, m.start);
    if (pi !== last) {
      out.push(pi);
      last = pi;
    }
  }
  return out;
}
function doSearch() {
  const q = $('searchInput').value;
  if (!q) {
    state.matches = [];
    state.matchTotal = 0;
    $('searchCount').textContent = '';
    updateThumbSearchMarks();
    renderCurrent();
    return;
  }
  send('search', {
    query: q,
    headingOnly: false,
    chapterMark: state.settings.chapterMark,
    episodeMark: state.settings.episodeMark,
  });
}
/** 前/次: ヒットがあるページ単位で移動（同一ページ内の一致はまとめて1ステップ） */
function stepMatch(delta) {
  if (!state.matches.length || !state.pages.length) return;
  const pages = pagesWithMatches();
  if (!pages.length) return;
  const cur = state.pageIndex;
  let target = null;
  if (delta > 0) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i] > cur) { target = pages[i]; break; }
    }
    if (target == null) target = pages[0]; // 末尾の次 → 先頭ページへ
  } else {
    for (let i = pages.length - 1; i >= 0; i--) {
      if (pages[i] < cur) { target = pages[i]; break; }
    }
    if (target == null) target = pages[pages.length - 1]; // 先頭の前 → 末尾ページへ
  }
  // そのページ先頭の一致へ（ハイライトはページ内全件）
  for (const m of state.matches) {
    if (pageIndexOfOffset(state.pages, m.start) === target) {
      gotoOffset(m.start);
      return;
    }
  }
  gotoPage(target);
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
        const keepOffset = state.pages[state.pageIndex] ? state.pages[state.pageIndex].range.start : state.pendingOffset;
        state.fileLastModified = file.lastModified;
        state.pendingOffset = keepOffset;
        await openFile(file, state.fileHandle, { keepPosition: true });
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
  $('fullwidthAlpha').checked = s.fullwidthAlpha;
  $('fullwidthDigit').checked = s.fullwidthDigit;
  $('gridLines').checked = s.gridLines;
  $('themeSelect').value = s.theme;
  $('fontSelect').value = s.fontFamily;
  $('fontSize').value = s.fontSize;
  $('burasage').disabled = !s.kinsoku;
  $('chapterMark').value = s.chapterMark != null ? s.chapterMark : '#';
  $('episodeMark').value = s.episodeMark != null ? s.episodeMark : '##';
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
    const reloadPick = state.expectReloadPick;
    state.expectReloadPick = false;
    // キャンセルや空選択で change が来ないこともある。来たら input を空にして同じファイル再選択を可能に
    e.target.value = '';
    if (f) openFile(f, null, { keepPosition: reloadPick });
  });
  $('openFsBtn').addEventListener('click', async () => {
    state.expectReloadPick = false; // 「開く」は初回扱い
    if (!window.showOpenFilePicker) { $('fileInput').click(); return; }
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }] });
      const file = await handle.getFile();
      openFile(file, handle, { keepPosition: false });
    } catch { /* キャンセル */ }
  });
  // 「更新」＝自動更新できないときの手動再読込（ファイルオープンUIの代替ではない）
  $('reloadBtn').addEventListener('click', () => { reloadManuscript(); });

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
  $('fullwidthAlpha').addEventListener('change', (e) => {
    state.settings.fullwidthAlpha = e.target.checked; persist(); if (state.text) requestWarnings();
  });
  $('fullwidthDigit').addEventListener('change', (e) => {
    state.settings.fullwidthDigit = e.target.checked; persist(); if (state.text) requestWarnings();
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
  // 入力のたびに表示中ページへ該当ワードを色付け（全文検索は Enter）
  $('searchInput').addEventListener('input', () => {
    // クエリ変更で旧全文結果は無効（前/次が古い語に飛ばないように）
    state.matches = [];
    state.matchTotal = 0;
    state.matchIndex = 0;
    $('searchCount').textContent = '';
    updateThumbSearchMarks();
    renderCurrent();
  });
  $('searchBtn').addEventListener('click', doSearch);
  $('searchPrev').addEventListener('click', () => stepMatch(-1));
  $('searchNext').addEventListener('click', () => stepMatch(1));

  $('warnPrev').addEventListener('click', () => stepWarning(-1));
  $('warnNext').addEventListener('click', () => stepWarning(1));

  $('togglePanel').addEventListener('click', () => document.body.classList.toggle('panel-open'));

  const onHeadingMarkChange = () => {
    let chapter = String($('chapterMark').value ?? '');
    let episode = String($('episodeMark').value ?? '');
    // 空欄は既定に戻す
    if (!chapter) chapter = '#';
    if (!episode) episode = '##';
    state.settings.chapterMark = chapter;
    state.settings.episodeMark = episode;
    $('chapterMark').value = chapter;
    $('episodeMark').value = episode;
    persist();
    renderCurrent();
    if (state.pages.length) buildThumbnails();
    if (state.text) requestWarnings();
  };
  $('chapterMark').addEventListener('change', onHeadingMarkChange);
  $('episodeMark').addEventListener('change', onHeadingMarkChange);
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
