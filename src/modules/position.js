// position.js — 現在位置の保存・復帰（純粋ロジック）
// オフセットは UTF-16。周辺文字列 before/after の両一致を優先してスコアリング。

const CONTEXT = 20;
const WINDOW = 2000;

/**
 * 保存用レコードを作る。
 * @param {string} text @param {number} offset
 */
export function makeRecord(text, offset) {
  const o = clamp(offset, 0, text.length);
  return {
    offset: o,
    previousLength: text.length,
    before: text.slice(Math.max(0, o - CONTEXT), o),
    after: text.slice(o, Math.min(text.length, o + CONTEXT)),
    updatedAt: Date.now(),
  };
}

/**
 * 保存レコードから現在テキスト上の復帰オフセットを求める。
 * @param {string} text @param {{offset,before,after}} rec
 * @returns {number}
 */
export function restoreOffset(text, rec) {
  if (!rec) return 0;
  const anchor = clamp(rec.offset, 0, text.length);
  const lo = Math.max(0, anchor - WINDOW);
  const hi = Math.min(text.length, anchor + WINDOW);
  const region = text.slice(lo, hi);

  const candidates = [];
  // before+after 両一致（before の直後に after が続く位置）
  if (rec.before || rec.after) {
    const combo = rec.before + rec.after;
    if (combo) {
      pushAll(region, combo, lo + rec.before.length, candidates, 3);
    }
  }
  if (rec.after) pushAll(region, rec.after, lo, candidates, 2);
  if (rec.before) {
    // before 一致は before の直後を復帰点とする
    let idx = -1;
    while ((idx = region.indexOf(rec.before, idx + 1)) !== -1) {
      candidates.push({ pos: lo + idx + rec.before.length, score: 1 });
    }
  }

  if (candidates.length === 0) return anchor;
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.pos - anchor) - Math.abs(b.pos - anchor));
  return candidates[0].pos;
}

function pushAll(region, needle, offsetIntoMatch, out, score) {
  let idx = -1;
  while ((idx = region.indexOf(needle, idx + 1)) !== -1) {
    out.push({ pos: idx + offsetIntoMatch, score });
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
