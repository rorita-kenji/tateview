// kinsoku.js — 禁則の既定文字セット

// 行頭禁則（列頭に置けない）
export const DEFAULT_KINSOKU_HEAD =
  '、。，．・：；？！ー）」』】〕》〉｝' +
  'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮゝゞヽヾ々';

// 行末禁則（列末に置けない）
export const DEFAULT_KINSOKU_TAIL = '（「『【〔《〈｛';

/**
 * 既定の禁則設定を Set で返す。
 * @returns {{ head:Set<string>, tail:Set<string> }}
 */
export function defaultKinsoku() {
  return {
    head: new Set(Array.from(DEFAULT_KINSOKU_HEAD)),
    tail: new Set(Array.from(DEFAULT_KINSOKU_TAIL)),
  };
}
