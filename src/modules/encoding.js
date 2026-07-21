// encoding.js — 文字コード自動判定＆デコード
// 対象: UTF-8(BOM有/無), Shift_JIS。判定不能は 'unknown'。

const REPLACEMENT = '�';
const UNKNOWN_THRESHOLD = 0.01; // 置換文字が全体の1%超なら unknown

/**
 * バイト列を判定してデコードする。
 * @param {Uint8Array} bytes
 * @param {string} [forced] - 'utf-8' | 'shift_jis' を強制する場合
 * @returns {{ encoding:'utf-8'|'shift_jis'|'unknown', text:string }}
 */
export function detectAndDecode(bytes, forced) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (forced === 'utf-8' || forced === 'shift_jis') {
    return { encoding: forced, text: new TextDecoder(forced).decode(stripBom(u8, forced)) };
  }

  // 1. BOM
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(u8.subarray(3)) };
  }

  // 2. UTF-8 妥当性
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    return { encoding: 'utf-8', text };
  } catch {
    /* UTF-8 ではない */
  }

  // 3. Shift_JIS
  try {
    const text = new TextDecoder('shift_jis').decode(u8);
    let repl = 0;
    for (const ch of text) if (ch === REPLACEMENT) repl++;
    if (text.length > 0 && repl / text.length > UNKNOWN_THRESHOLD) {
      return { encoding: 'unknown', text };
    }
    return { encoding: 'shift_jis', text };
  } catch {
    return { encoding: 'unknown', text: new TextDecoder('utf-8').decode(u8) };
  }
}

function stripBom(u8, forced) {
  if (forced === 'utf-8' && u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return u8.subarray(3);
  }
  return u8;
}
