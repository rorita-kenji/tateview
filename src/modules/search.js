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

function collect(hay, needle, base, out, inc, limit) {
  let from = 0;
  let idx;
  while ((idx = hay.indexOf(needle, from)) !== -1) {
    inc();
    if (out.length < limit) out.push({ start: base + idx, end: base + idx + needle.length });
    from = idx + needle.length;
  }
}
