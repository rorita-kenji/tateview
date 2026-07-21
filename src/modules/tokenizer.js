// tokenizer.js — ストリーミング・トークナイザ（generator）
// 全Token配列を保持しない。オフセットは正規化済み文字列上の UTF-16 位置（半開区間）。
//
// Token:
//   { type:'full'|'half'|'ruby'|'newline', sourceStart, sourceEnd, text, mass,
//     baseText?, rubyText? }
//   full=1マス, newline=0マス, half=ceil(半角数*0.5)マス, ruby=親文字コードポイント数マス

const RUBY_BAR = '｜';   // U+FF5C 全角縦棒（ルビ親文字の明示開始）
const RUBY_OPEN = '《';  // U+300A
const RUBY_CLOSE = '》'; // U+300B

/** 半角文字か（ASCII可視+空白 / 半角カナ） */
function isHalf(cp) {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xff61 && cp <= 0xff9f);
}
/** 自動ルビの親文字となる漢字か */
function isKanji(cp) {
  return (
    cp === 0x3005 || // 々
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}
/** 結合文字・異体字セレクタ（直前の基底文字へ吸収する） */
function isCombining(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/**
 * テキストをコードポイント＋UTF-16位置の配列へ。
 * @param {string} text
 * @returns {{ch:string, cp:number, start:number, end:number}[]}
 */
function toChars(text) {
  const chars = [];
  let off = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    chars.push({ ch, cp, start: off, end: off + ch.length });
    off += ch.length;
  }
  return chars;
}

/**
 * ストリーミング・トークナイズ。
 * @param {string} text 正規化済みテキスト
 * @returns {Generator<object>}
 */
export function* tokenize(text) {
  const chars = toChars(text);
  const n = chars.length;
  let i = 0;

  while (i < n) {
    const c = chars[i];

    // 改行
    if (c.ch === '\n') {
      yield { type: 'newline', sourceStart: c.start, sourceEnd: c.end, text: '', mass: 0 };
      i++;
      continue;
    }

    // 明示ルビ ｜親《ルビ》
    if (c.ch === RUBY_BAR) {
      const open = findNext(chars, i + 1, RUBY_OPEN);
      const close = open >= 0 ? findNext(chars, open + 1, RUBY_CLOSE) : -1;
      if (open > i + 1 && close > open) {
        const baseText = sliceText(chars, i + 1, open);
        const rubyText = sliceText(chars, open + 1, close);
        yield {
          type: 'ruby',
          sourceStart: c.start,
          sourceEnd: chars[close].end,
          text: baseText,
          baseText,
          rubyText,
          mass: open - (i + 1), // 親文字コードポイント数
        };
        i = close + 1;
        continue;
      }
      // 不正記法 → ｜を全角1文字として扱う（warnings が別途検出）
      yield fullToken(c);
      i++;
      continue;
    }

    // 自動ルビ: 漢字ラン + 《ルビ》
    if (isKanji(c.cp)) {
      let j = i;
      while (j < n && isKanji(chars[j].cp)) j++;
      // 漢字ランの直後が 《…》 か？
      if (j < n && chars[j].ch === RUBY_OPEN) {
        const close = findNext(chars, j + 1, RUBY_CLOSE);
        if (close > j) {
          const baseText = sliceText(chars, i, j);
          const rubyText = sliceText(chars, j + 1, close);
          yield {
            type: 'ruby',
            sourceStart: c.start,
            sourceEnd: chars[close].end,
            text: baseText,
            baseText,
            rubyText,
            mass: j - i,
          };
          i = close + 1;
          continue;
        }
      }
      // ルビなし漢字ラン → 1文字ずつ full
      for (let k = i; k < j; k++) yield fullToken(chars[k]);
      i = j;
      continue;
    }

    // 半角ラン
    if (isHalf(c.cp)) {
      let j = i;
      while (j < n && isHalf(chars[j].cp)) j++;
      const runText = sliceText(chars, i, j);
      const count = j - i;
      yield {
        type: 'half',
        sourceStart: c.start,
        sourceEnd: chars[j - 1].end,
        text: runText,
        mass: Math.ceil(count * 0.5),
      };
      i = j;
      continue;
    }

    // それ以外の全角1文字（全角スペース含む）＋後続の結合文字を吸収
    let end = c.end;
    let j = i + 1;
    while (j < n && isCombining(chars[j].cp)) {
      end = chars[j].end;
      j++;
    }
    yield { type: 'full', sourceStart: c.start, sourceEnd: end, text: text.slice(c.start, end), mass: 1 };
    i = j;
  }
}

function fullToken(c) {
  return { type: 'full', sourceStart: c.start, sourceEnd: c.end, text: c.ch, mass: 1 };
}
function findNext(chars, from, target) {
  for (let k = from; k < chars.length; k++) if (chars[k].ch === target) return k;
  return -1;
}
function sliceText(chars, from, to) {
  let s = '';
  for (let k = from; k < to; k++) s += chars[k].ch;
  return s;
}

/** テスト・利用側向けに配列化するヘルパ（本体は使わない） */
export function tokenizeToArray(text) {
  return [...tokenize(text)];
}
