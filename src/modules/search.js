// search.js — 全文・見出し検索（UTF-16 半開区間）

import { isHeadingLine, resolveHeadingMarks } from './heading.js';

/**
 * 全一致検索（大小文字区別）。
 * @param {string} text
 * @param {string} query
 * @param {{ headingOnly?:boolean, limit?:number, chapterMark?:string, episodeMark?:string, headingMarks?:{chapter:string,episode:string} }} [opt]
 * @returns {{ matches:{start:number,end:number}[], total:number }}
 */
export function searchAll(text, query, opt = {}) {
  const matches = [];
  let total = 0;
  const limit = opt.limit || 5000;
  if (!query) return { matches, total: 0 };

  if (opt.headingOnly) {
    const headingMarks = resolveHeadingMarks(opt.headingMarks || opt);
    let lineStart = 0;
    for (const line of text.split('\n')) {
      if (isHeadingLine(line, headingMarks)) {
        collect(line, query, lineStart, matches, () => total++, limit);
      }
      lineStart += line.length + 1;
    }
    return { matches, total };
  }

  collect(text, query, 0, matches, () => total++, limit);
  return { matches, total };
}

/**
 * 開始オフセット以降の最初の一致インデックス。
 * @param {{start:number,end:number}[]} matches  start 昇順
 * @param {number} offset UTF-16
 * @param {{ wrap?:boolean }} [opt] wrap=true のとき以降が無ければ先頭へ。既定はラップしない（-1）
 * @returns {number}
 */
export function firstMatchIndexFrom(matches, offset, opt = {}) {
  if (!matches || !matches.length) return -1;
  const o = Math.max(0, offset | 0);
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].start >= o) return i;
  }
  return opt.wrap ? 0 : -1;
}

/**
 * 半開区間 [rangeStart, rangeEnd) 内に完全に収まる一致のみ（表示ページの即時ハイライト用）。
 * @param {string} text
 * @param {string} query
 * @param {number} rangeStart
 * @param {number} rangeEnd
 * @param {{ limit?:number }} [opt]
 * @returns {{start:number,end:number}[]}
 */
export function searchInRange(text, query, rangeStart, rangeEnd, opt = {}) {
  const matches = [];
  if (!query || !text) return matches;
  const limit = opt.limit || 2000;
  const rs = Math.max(0, rangeStart | 0);
  const re = Math.min(text.length, Math.max(rs, rangeEnd | 0));
  let from = rs;
  while (from < re) {
    const idx = text.indexOf(query, from);
    if (idx === -1 || idx >= re) break;
    const end = idx + query.length;
    // ページ境界をまたぐ一致はハイライトしない（完全内包のみ）
    if (end <= re && matches.length < limit) {
      matches.push({ start: idx, end });
    }
    from = idx + Math.max(1, query.length);
  }
  return matches;
}

function collect(hay, needle, base, out, inc, limit) {
  let from = 0;
  let idx;
  while ((idx = hay.indexOf(needle, from)) !== -1) {
    inc();
    if (out.length < limit) out.push({ start: base + idx, end: base + idx + needle.length });
    from = idx + needle.length;
  }
}
