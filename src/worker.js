// worker.js — 重い処理を担う Web Worker。documentId/requestId で世代管理。
import { detectAndDecode } from './modules/encoding.js';
import { normalizeNewlines } from './modules/normalize.js';
import { tokenize } from './modules/tokenizer.js';
import { paginate } from './modules/paginator.js';
import { detectWarnings } from './modules/warnings.js';
import { searchAll } from './modules/search.js';
import { defaultKinsoku } from './modules/kinsoku.js';

let currentText = '';
let currentDocId = null;

self.onmessage = (e) => {
  const msg = e.data || {};
  const { documentId, requestId, type, payload } = msg;

  try {
    if (type === 'load') {
      const { encoding, text } = detectAndDecode(payload.bytes, payload.forcedEncoding);
      if (encoding === 'unknown' && !payload.forcedEncoding) {
        post({ documentId, requestId, type: 'needEncoding', payload: {} });
        return;
      }
      const newline = detectNewline(text);
      currentText = normalizeNewlines(text);
      currentDocId = documentId;
      post({ documentId, requestId, type: 'loaded', payload: { encoding, newline, charCount: currentText.length, text: currentText } });
      return;
    }

    if (type === 'paginate') {
      if (documentId !== currentDocId) return;
      const cfg = buildConfig(payload.config);
      const pages = paginate(tokenize(currentText), cfg);
      post({ documentId, requestId, type: 'paginated', payload: { pages } });
      return;
    }

    if (type === 'detectWarnings') {
      if (documentId !== currentDocId) return;
      const { items, total } = detectWarnings(currentText, {
        showRuby: payload.showRuby,
        enabled: payload.enabled ? new Set(payload.enabled) : null,
      });
      post({ documentId, requestId, type: 'warnings', payload: { items, total } });
      return;
    }

    if (type === 'search') {
      if (documentId !== currentDocId) return;
      const { matches, total } = searchAll(currentText, payload.query, { headingOnly: payload.headingOnly });
      post({ documentId, requestId, type: 'searchResult', payload: { matches, total } });
      return;
    }
  } catch (err) {
    post({ documentId, requestId, type: 'error', payload: { message: String(err && err.message || err) } });
  }
};

function detectNewline(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const cr = (raw.match(/\r(?!\n)/g) || []).length;
  const lf = (raw.match(/(?<!\r)\n/g) || []).length;
  const kinds = [];
  if (crlf) kinds.push('CRLF');
  if (cr) kinds.push('CR');
  if (lf) kinds.push('LF');
  if (kinds.length === 0) return 'なし';
  if (kinds.length > 1) return '混在(' + kinds.join('/') + ')';
  return kinds[0];
}

function buildConfig(c) {
  const def = defaultKinsoku();
  return {
    charsPerColumn: c.charsPerColumn,
    columnsPerPage: c.columnsPerPage,
    kinsoku: c.kinsoku,
    burasage: c.burasage,
    kinsokuHead: c.kinsokuHead ? new Set(c.kinsokuHead) : def.head,
    kinsokuTail: c.kinsokuTail ? new Set(c.kinsokuTail) : def.tail,
  };
}

function post(m) {
  self.postMessage(m);
}
