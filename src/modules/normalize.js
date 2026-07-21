// normalize.js — 改行コード正規化（CRLF/CR -> LF）
// 副作用なしの純粋関数。Node / ブラウザ双方から import 可能。

/**
 * 改行を LF に正規化する。
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
