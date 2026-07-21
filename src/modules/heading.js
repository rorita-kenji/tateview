// heading.js — 章/話マーカー判定（設定で変更可能）
// 既定: 章='#', 話='##'。
// 行頭からマーカー直前までが半角/全角スペースのみのとき見出し（他文字を挟むと本文）。
// 見出しは改行まで。次の行から本文。

/**
 * @typedef {{ chapter: string, episode: string }} HeadingMarks
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

/**
 * 設定オブジェクトから正規化した章/話マーカーを得る。空は既定に戻す。
 * @param {{ chapterMark?: string, episodeMark?: string, chapter?: string, episode?: string }|null|undefined} src
 * @returns {HeadingMarks}
 */
export function resolveHeadingMarks(src = {}) {
  const s = src || {};
  let chapter = s.chapterMark != null ? String(s.chapterMark) : s.chapter != null ? String(s.chapter) : DEFAULT_HEADING_MARKS.chapter;
  let episode = s.episodeMark != null ? String(s.episodeMark) : s.episode != null ? String(s.episode) : DEFAULT_HEADING_MARKS.episode;
  if (!chapter) chapter = DEFAULT_HEADING_MARKS.chapter;
  if (!episode) episode = DEFAULT_HEADING_MARKS.episode;
  return { chapter, episode };
}

/**
 * 行の見出しマーカーを探す。
 * 条件: 行頭〜マーカー直前が半角スペース(U+0020)または全角スペース(U+3000)のみ
 * （他の文字を挟むと見出しにしない）。
 * 複数候補は「出現位置が早い方」、同位置なら長いマーカー、同一長なら話(2)を優先。
 * @param {string} line
 * @param {HeadingMarks} marks
 * @returns {HeadingMatch|null}
 */
export function matchHeadingInLine(line, marks) {
  const m = resolveHeadingMarks(marks);
  /** @type {{ level: 1|2, mark: string }[]} */
  const cands = [
    { level: 2, mark: m.episode },
    { level: 1, mark: m.chapter },
  ];
  cands.sort((a, b) => {
    if (b.mark.length !== a.mark.length) return b.mark.length - a.mark.length;
    return b.level - a.level;
  });

  /** @type {HeadingMatch|null} */
  let best = null;
  for (const c of cands) {
    if (!c.mark) continue;
    let from = 0;
    while (from <= line.length - c.mark.length) {
      const idx = line.indexOf(c.mark, from);
      if (idx === -1) break;
      // 行頭〜マーカー直前は半角/全角スペースのみ
      if (!isOnlyLeadingSpaces(line, idx)) {
        from = idx + 1;
        continue;
      }
      if (!isValidAfterMarkAt(line, idx, c.mark)) {
        from = idx + 1;
        continue;
      }
      let prefixEnd = idx + c.mark.length;
      // 半角警告除外用: 直後の半角スペース1つまで
      if (line[prefixEnd] === ' ') prefixEnd += 1;
      /** @type {HeadingMatch} */
      const hit = {
        level: c.level,
        markStart: idx,
        markEnd: idx + c.mark.length,
        prefixEnd,
        prefixLen: prefixEnd,
      };
      if (
        !best ||
        hit.markStart < best.markStart ||
        (hit.markStart === best.markStart && c.mark.length > best.markEnd - best.markStart) ||
        (hit.markStart === best.markStart &&
          c.mark.length === best.markEnd - best.markStart &&
          hit.level > best.level)
      ) {
        best = hit;
      }
      break; // このマーカー種別は最初の有効位置のみ
    }
  }
  return best;
}

/**
 * line[0..idx) が半角/全角スペースのみか。
 * @param {string} line
 * @param {number} idx
 */
function isOnlyLeadingSpaces(line, idx) {
  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '　') return false;
  }
  return true;
}

/**
 * @param {string} line
 * @param {HeadingMarks} marks
 * @returns {HeadingMatch|null}
 */
export function matchHeadingPrefix(line, marks) {
  return matchHeadingInLine(line, marks);
}

/**
 * @param {string} line
 * @param {HeadingMarks} marks
 * @returns {boolean}
 */
export function isHeadingLine(line, marks) {
  return matchHeadingInLine(line, marks) != null;
}

/**
 * @param {string} line
 * @param {HeadingMarks} marks
 * @returns {0|1|2}
 */
export function headingLevel(line, marks) {
  const m = matchHeadingInLine(line, marks);
  return m ? m.level : 0;
}

/**
 * 見出し行のタイトル文字列（マーカー以降。長すぎる場合は maxLen で切る）。
 * @param {string} line
 * @param {HeadingMarks} marks
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
 * 見出しマーカー範囲（半角警告除外用）を集める。
 * @param {string} text
 * @param {HeadingMarks} [marks]
 * @returns {{ start: number, end: number }[]}
 */
export function collectHeadingPrefixRanges(text, marks) {
  const m = resolveHeadingMarks(marks);
  const ranges = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const hit = matchHeadingInLine(line, m);
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
