// paginator.js — ページ分割（文字数モデル・DOM非依存・半開区間）
//
// 入力: tokens(Generator|Array), cfg
// 出力: Page[]  Page = { index, range:{start,end}, columns:{start,end}[] }
//
// 不変条件:
//  - ページ範囲・列範囲は単調増加、隙間も重複もない
//  - 最終ページの range.end === text.length（＝全トークンを消費）
//  - 通常列は容量を超えない（超過はぶら下げ or 分割不能トークンの単独列のみ）
//  - 同一入力＋同一設定 → 常に同一結果

import { defaultKinsoku } from './kinsoku.js';

/**
 * @typedef {{
 *   charsPerColumn:number, columnsPerPage:number,
 *   kinsoku:boolean, burasage:boolean,
 *   kinsokuHead?:Set<string>, kinsokuTail?:Set<string>
 * }} PaginateConfig
 */

/**
 * @param {Iterable<object>} tokens
 * @param {PaginateConfig} cfg
 * @returns {{index:number, range:{start:number,end:number}, columns:{start:number,end:number}[]}[]}
 */
export function paginate(tokens, cfg) {
  const capacity = cfg.charsPerColumn;
  const perPage = cfg.columnsPerPage;
  const kin = cfg.kinsoku;
  const bura = cfg.burasage && kin;
  const head = cfg.kinsokuHead || defaultKinsoku().head;
  const tail = cfg.kinsokuTail || defaultKinsoku().tail;

  const pages = [];
  let pageCols = [];
  let pageStart = null;

  let colTokens = []; // 現在列に確定済みのトークン（バッファは現在列のみ）
  let usedMass = 0;
  let lastEnd = 0;

  function pushColumn(kept) {
    if (kept.length === 0) return;
    const start = kept[0].sourceStart;
    const end = kept[kept.length - 1].sourceEnd;
    pageCols.push({ start, end });
    if (pageStart === null) pageStart = start;
    lastEnd = end;
    if (pageCols.length >= perPage) flushPage(end);
  }
  function flushPage(end) {
    if (pageCols.length === 0) return;
    pages.push({ index: pages.length, range: { start: pageStart, end }, columns: pageCols });
    pageCols = [];
    pageStart = null;
  }

  const charOf = (t) => (t.type === 'full' ? t.text : '');
  const isHangable = (t) => t.type === 'full' && (t.text === '、' || t.text === '。');

  for (const t of tokens) {
    // 改行: 現在列に含めて閉じる（オフセットの穴を作らない）
    if (t.type === 'newline') {
      colTokens.push(t);
      pushColumn(colTokens);
      colTokens = [];
      usedMass = 0;
      continue;
    }

    if (usedMass + t.mass <= capacity) {
      colTokens.push(t);
      usedMass += t.mass;
      continue;
    }

    // 入りきらない
    if (colTokens.length === 0) {
      // 空列に対して分割不能トークンが容量超過 → 単独オーバーフロー列
      pushColumn([t]);
      colTokens = [];
      usedMass = 0;
      continue;
    }

    if (bura && isHangable(t)) {
      // ぶら下げ: はみ出して現在列に置き、閉じる
      colTokens.push(t);
      pushColumn(colTokens);
      colTokens = [];
      usedMass = 0;
      continue;
    }

    // t は次列へ繰り越し。禁則ONなら「最後の有効境界」を後方探索
    let carry = [t];
    if (kin) {
      const keptBackup = colTokens.slice();
      while (colTokens.length > 0) {
        const firstCarried = carry[0];
        const lastKept = colTokens[colTokens.length - 1];
        const headBad = head.has(charOf(firstCarried));
        const tailBad = tail.has(charOf(lastKept));
        if (headBad || tailBad) {
          carry.unshift(colTokens.pop());
        } else break;
      }
      if (colTokens.length === 0) {
        // 有効境界なし → 機械改列にフォールバック
        colTokens = keptBackup;
        carry = [t];
      }
    }

    pushColumn(colTokens);
    // 次列を carry で開始
    colTokens = [];
    usedMass = 0;
    for (const c of carry) {
      colTokens.push(c);
      usedMass += c.mass;
    }
  }

  // 末尾処理
  pushColumn(colTokens);
  flushPage(lastEnd);

  if (pages.length === 0) {
    pages.push({ index: 0, range: { start: 0, end: 0 }, columns: [] });
  }
  return pages;
}

/**
 * オフセットを含むページ番号を二分探索。
 * @param {{range:{start:number,end:number}}[]} pages
 * @param {number} offset
 * @returns {number}
 */
export function pageIndexOfOffset(pages, offset) {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = pages[mid].range;
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end && mid < pages.length - 1) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(pages.length - 1, lo));
}
