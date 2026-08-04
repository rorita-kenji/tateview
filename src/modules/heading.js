// heading.js — 章/話マーカー判定（設定で変更可能）
// 既定: 章='#', 話='##'。空白区切りで複数記号可。組み込みキーワード（第○章 等）あり。
// 行頭からマーカー直前までが半角/全角スペースのみのとき見出し（他文字を挟むと本文）。
// 見出しは改行まで。次の行から本文。

/**
 * @typedef {{ chapter: string, episode: string }} HeadingMarks
 */

/**
 * @typedef {{
 *   lv1: string,
 *   lv2: string,
 *   lv1On: boolean,
 *   lv2On: boolean,
 *   builtin: {
 *     chapterNum?: boolean,
 *     chapterWord?: boolean,
 *     episodeNum?: boolean,
 *     episodeWord?: boolean
 *   }
 * }} HeadCfg
 */

/**
 * @typedef {{
 *   level: 1|2,
 *   markStart: number,
 *   markEnd: number,
 *   prefixEnd: number,
 *   prefixLen: number
 * }} HeadingMatch
 */

/** @type {HeadingMarks} */
export const DEFAULT_HEADING_MARKS = Object.freeze({ chapter: '#', episode: '##' });

/** 組み込みキーワード（novedit 準拠・Lv1/Lv2 のみ。強調なし） */
export const BUILTIN_HEADINGS = Object.freeze({
  chapterNum: {
    level: 1,
    re: /^第[0-9０-９一二三四五六七八九十百千壱弐参]+[章幕部巻]/,
    label: '「第○章／幕」など（第一章・第1章・第三幕・第二部）',
  },
  chapterWord: {
    level: 1,
    re: /^(?:序章|序|終章|プロローグ|エピローグ|幕間|間章|あとがき|まえがき|前書き|後書き)/,
    label: '章・幕の語（序章・終章・プロローグ・エピローグ・幕間・あとがき など）',
  },
  episodeNum: {
    level: 2,
    re: /^第[0-9０-９一二三四五六七八九十百千壱弐参]+[話回節]/,
    label: '「第○話／回」など（第一話・第1話・第一回・第十二回）',
  },
  episodeWord: {
    level: 2,
    re: /^(?:最終話|閑話)/,
    label: '話・回の語（最終話・閑話）',
  },
});

export const BUILTIN_HEADING_ORDER = Object.freeze([
  'chapterNum',
  'chapterWord',
  'episodeNum',
  'episodeWord',
]);

/** @type {HeadCfg} */
export const DEFAULT_HEAD_CFG = Object.freeze({
  // novedit HEAD_DEFAULT と一致
  lv1: '# ＃ §',
  lv2: '▼ ▽ ■ □ ● 〇 ○ ## ＃＃',
  lv1On: true,
  lv2On: true,
  builtin: Object.freeze({
    chapterNum: true,
    chapterWord: true,
    episodeNum: true,
    episodeWord: true,
  }),
});

/**
 * 空白区切りトークン（重複除去・空除去）
 * @param {string} str
 * @returns {string[]}
 */
export function parseMarkTokens(str) {
  return [...new Set(String(str || '').split(/[\s\n]+/).filter(Boolean))];
}

/**
 * 設定から HeadCfg を正規化。旧 chapterMark/episodeMark も吸収。
 * @param {object|null|undefined} src
 * @returns {HeadCfg}
 */
export function normalizeHeadCfg(src = {}) {
  const s = src || {};
  /** @type {HeadCfg} */
  const out = {
    lv1: DEFAULT_HEAD_CFG.lv1,
    lv2: DEFAULT_HEAD_CFG.lv2,
    lv1On: true,
    lv2On: true,
    builtin: { ...DEFAULT_HEAD_CFG.builtin },
  };
  if (s.headCfg && typeof s.headCfg === 'object') {
    const h = s.headCfg;
    if (h.lv1 != null) out.lv1 = String(h.lv1);
    if (h.lv2 != null) out.lv2 = String(h.lv2);
    if (h.lv1On === false) out.lv1On = false;
    if (h.lv2On === false) out.lv2On = false;
    if (h.builtin && typeof h.builtin === 'object') {
      for (const k of BUILTIN_HEADING_ORDER) {
        if (h.builtin[k] === false) out.builtin[k] = false;
        else if (h.builtin[k] === true) out.builtin[k] = true;
      }
    }
  } else {
    // 旧キーのみ
    if (s.chapterMark != null) out.lv1 = String(s.chapterMark);
    if (s.episodeMark != null) out.lv2 = String(s.episodeMark);
    if (s.chapter != null) out.lv1 = String(s.chapter);
    if (s.episode != null) out.lv2 = String(s.episode);
  }
  // 直渡し lv1/lv2（resolve 用）
  if (s.lv1 != null && s.headCfg == null && s.chapterMark == null) out.lv1 = String(s.lv1);
  if (s.lv2 != null && s.headCfg == null && s.episodeMark == null) out.lv2 = String(s.lv2);
  // 旧単一キーが headCfg と併存するときも chapterMark をフォールバックにしない（headCfg 優先）
  if (!s.headCfg) {
    if (s.chapterMark != null && s.lv1 == null) out.lv1 = String(s.chapterMark);
    if (s.episodeMark != null && s.lv2 == null) out.lv2 = String(s.episodeMark);
  }
  if (!String(out.lv1).trim() && out.lv1On) out.lv1 = DEFAULT_HEAD_CFG.lv1;
  if (!String(out.lv2).trim() && out.lv2On) out.lv2 = DEFAULT_HEAD_CFG.lv2;
  return out;
}

/**
 * 設定オブジェクトから正規化した章/話マーカーを得る（後方互換の単一文字列）。
 * @param {{ chapterMark?: string, episodeMark?: string, chapter?: string, episode?: string, headCfg?: HeadCfg }|null|undefined} src
 * @returns {HeadingMarks}
 */
export function resolveHeadingMarks(src = {}) {
  const cfg = normalizeHeadCfg(src);
  const lv1 = cfg.lv1On === false ? '' : (parseMarkTokens(cfg.lv1)[0] || DEFAULT_HEADING_MARKS.chapter);
  const lv2 = cfg.lv2On === false ? '' : (parseMarkTokens(cfg.lv2)[0] || DEFAULT_HEADING_MARKS.episode);
  return {
    chapter: lv1 || DEFAULT_HEADING_MARKS.chapter,
    episode: lv2 || DEFAULT_HEADING_MARKS.episode,
  };
}

/**
 * 判定用にトークン列＋組み込みフラグへ展開
 * @param {object|null|undefined} src
 * @returns {{ tokens: { level: 1|2, mark: string }[], builtin: Record<string, boolean>, cfg: HeadCfg }}
 */
export function compileHeading(src = {}) {
  const cfg = normalizeHeadCfg(src);
  /** @type {{ level: 1|2, mark: string }[]} */
  const tokens = [];
  if (cfg.lv1On !== false) {
    for (const t of parseMarkTokens(cfg.lv1)) tokens.push({ level: 1, mark: t });
  }
  if (cfg.lv2On !== false) {
    for (const t of parseMarkTokens(cfg.lv2)) tokens.push({ level: 2, mark: t });
  }
  tokens.sort((a, b) => {
    if (b.mark.length !== a.mark.length) return b.mark.length - a.mark.length;
    return b.level - a.level;
  });
  return { tokens, builtin: { ...cfg.builtin }, cfg };
}

/**
 * 行の見出しマーカーを探す。
 * 条件: 行頭〜マーカー直前が半角スペース(U+0020)または全角スペース(U+3000)のみ
 * （他の文字を挟むと見出しにしない）。タブも行頭空白として許容。
 * 複数候補は「出現位置が早い方」、同位置なら長いマーカー、同一長なら話(2)を優先。
 * @param {string} line
 * @param {object} marks HeadCfg / HeadingMarks / settings 断片
 * @returns {HeadingMatch|null}
 */
export function matchHeadingInLine(line, marks) {
  const compiled = compileHeading(marks);
  /** @type {HeadingMatch|null} */
  let best = null;

  const consider = (/** @type {HeadingMatch} */ hit) => {
    if (
      !best ||
      hit.markStart < best.markStart ||
      (hit.markStart === best.markStart && hit.markEnd - hit.markStart > best.markEnd - best.markStart) ||
      (hit.markStart === best.markStart &&
        hit.markEnd - hit.markStart === best.markEnd - best.markStart &&
        hit.level > best.level)
    ) {
      best = hit;
    }
  };

  for (const c of compiled.tokens) {
    if (!c.mark) continue;
    let from = 0;
    while (from <= line.length - c.mark.length) {
      const idx = line.indexOf(c.mark, from);
      if (idx === -1) break;
      if (!isOnlyLeadingSpaces(line, idx)) {
        from = idx + 1;
        continue;
      }
      if (!isValidAfterMarkAt(line, idx, c.mark)) {
        from = idx + 1;
        continue;
      }
      let prefixEnd = idx + c.mark.length;
      if (line[prefixEnd] === ' ') prefixEnd += 1;
      consider({
        level: c.level,
        markStart: idx,
        markEnd: idx + c.mark.length,
        prefixEnd,
        prefixLen: prefixEnd,
      });
      break;
    }
  }

  // 組み込みキーワード（行頭空白除去後）
  let lead = 0;
  while (lead < line.length) {
    const ch = line[lead];
    if (ch !== ' ' && ch !== '　' && ch !== '\t') break;
    lead += 1;
  }
  if (lead < line.length) {
    const body = line.slice(lead);
    const st = body.replace(/[ 　\t]+$/, '');
    for (const k of BUILTIN_HEADING_ORDER) {
      if (!compiled.builtin[k]) continue;
      const b = BUILTIN_HEADINGS[k];
      if (!b) continue;
      const m = st.match(b.re);
      if (!m) continue;
      const markLen = m[0].length;
      let prefixEnd = lead + markLen;
      if (line[prefixEnd] === ' ') prefixEnd += 1;
      consider({
        level: /** @type {1|2} */ (b.level),
        markStart: lead,
        markEnd: lead + markLen,
        prefixEnd,
        prefixLen: prefixEnd,
      });
    }
  }

  return best;
}

/**
 * line[0..idx) が半角/全角スペース/タブのみか。
 * @param {string} line
 * @param {number} idx
 */
function isOnlyLeadingSpaces(line, idx) {
  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '　' && ch !== '\t') return false;
  }
  return true;
}

/**
 * @param {string} line
 * @param {object} marks
 * @returns {HeadingMatch|null}
 */
export function matchHeadingPrefix(line, marks) {
  return matchHeadingInLine(line, marks);
}

/**
 * @param {string} line
 * @param {object} marks
 * @returns {boolean}
 */
export function isHeadingLine(line, marks) {
  return matchHeadingInLine(line, marks) != null;
}

/**
 * @param {string} line
 * @param {object} marks
 * @returns {0|1|2}
 */
export function headingLevel(line, marks) {
  const m = matchHeadingInLine(line, marks);
  return m ? m.level : 0;
}

/**
 * 見出し行のタイトル文字列（マーカー以降。長すぎる場合は maxLen で切る）。
 * @param {string} line
 * @param {object} marks
 * @param {number} [maxLen=24]
 * @returns {{ level: 1|2, text: string }|null}
 */
export function headingTitle(line, marks, maxLen = 24) {
  const hit = matchHeadingInLine(line, marks);
  if (!hit) return null;
  let title = line.slice(hit.prefixEnd).replace(/^[\s　]+/, '');
  if (!title) title = line.trim() || line;
  if (maxLen > 0 && title.length > maxLen) title = title.slice(0, maxLen);
  return { level: hit.level, text: title };
}

/**
 * 文書内の見出し件数（ダイアログ preview 用）
 * @param {string} text
 * @param {object} [marks]
 * @returns {{ lv1: number, lv2: number }}
 */
export function countHeadings(text, marks) {
  let lv1 = 0;
  let lv2 = 0;
  for (const line of String(text || '').split('\n')) {
    const lv = headingLevel(line, marks);
    if (lv === 1) lv1 += 1;
    else if (lv === 2) lv2 += 1;
  }
  return { lv1, lv2 };
}

/**
 * 見出しマーカー範囲（半角警告除外用）を集める。
 * @param {string} text
 * @param {object} [marks]
 * @returns {{ start: number, end: number }[]}
 */
export function collectHeadingPrefixRanges(text, marks) {
  const ranges = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const hit = matchHeadingInLine(line, marks);
    if (hit) {
      ranges.push({ start: lineStart + hit.markStart, end: lineStart + hit.prefixEnd });
    }
    lineStart += line.length + 1;
  }
  return ranges;
}

/**
 * マーカー直後が有効か（idx はマーカー開始位置）。
 * @param {string} line
 * @param {number} idx
 * @param {string} mark
 */
function isValidAfterMarkAt(line, idx, mark) {
  const after = idx + mark.length;
  if (after >= line.length) return true;
  const next = line[after];
  if (next === '　' || /\s/.test(next)) return true;
  if (/^#+$/.test(mark)) {
    return next === '#';
  }
  return true;
}
