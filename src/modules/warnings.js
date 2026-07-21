// warnings.js — 校正ワーニング検出
// 位置は正規化テキスト上の UTF-16 半開区間 [start,end)。
// 半角ラン単位で集約、見出しプレフィックス・ルビ内は半角警告から除外、severity 付き。

export const WARNING_LABELS = {
  'indent-missing': '字下げ漏れ',
  'dialog-indent': '会話文の不要な字下げ',
  'period-before-bracket': '閉じ括弧前の句点',
  'no-space-after-bang': '！？後のスペース不足',
  'odd-leader-dash': '三点リーダ／ダッシュが偶数でない',
  halfwidth: '半角文字',
  'ruby-off': 'ルビ非表示箇所',
  tab: 'TAB文字',
  'trailing-space': '行末空白',
  'halfwidth-space': '半角スペース',
  'fullspace-only-line': '全角空白のみの行',
  'consecutive-blank': '連続空行',
  'ruby-syntax-error': 'ルビ構文エラー',
  'unclosed-bracket': '閉じていない括弧',
  'unmatched-close-bracket': '開きのない閉じ括弧',
  'repeated-chouon': '伸ばし棒の連続',
  'lonely-katakana-ni': '単独のカタカナ「ニ」（漢字「二」の誤りの可能性）',
};

const SEVERITY = {
  'indent-missing': 'warning',
  'dialog-indent': 'warning',
  'period-before-bracket': 'warning',
  'no-space-after-bang': 'warning',
  'odd-leader-dash': 'warning',
  halfwidth: 'info',
  'ruby-off': 'info',
  tab: 'warning',
  'trailing-space': 'warning',
  'halfwidth-space': 'info',
  'fullspace-only-line': 'warning',
  'consecutive-blank': 'info',
  'ruby-syntax-error': 'error',
  'unclosed-bracket': 'warning',
  'unmatched-close-bracket': 'warning',
  'repeated-chouon': 'warning',
  'lonely-katakana-ni': 'warning',
};

const DEFAULT_LIMIT = 1000;

/**
 * @param {string} text
 * @param {{ showRuby?:boolean, enabled?:Set<string>, limit?:number }} [opt]
 * @returns {{ items:{code,label,severity,range:{start,end}}[], total:number }}
 */
export function detectWarnings(text, opt = {}) {
  const showRuby = opt.showRuby !== false;
  const enabled = opt.enabled || null;
  const limit = opt.limit || DEFAULT_LIMIT;
  const on = (code) => (enabled ? enabled.has(code) : true);

  const rubyRanges = collectRubyRanges(text);
  const headingPrefixRanges = collectHeadingPrefixRanges(text);
  const excluded = (pos) =>
    inAny(rubyRanges, pos) || inAny(headingPrefixRanges, pos);

  const items = [];
  const counts = {};
  let total = 0;
  const add = (code, start, end, labelOverride) => {
    total++;
    counts[code] = (counts[code] || 0) + 1;
    if (counts[code] <= limit) {
      items.push({
        code,
        label: labelOverride || WARNING_LABELS[code],
        severity: SEVERITY[code],
        range: { start, end },
      });
    }
  };

  // 行単位（字下げ・会話字下げ・全角空白のみ行・行末空白）
  // 行末空白の範囲は半角スペース／半角文字と二重に出さないための除外に使う
  const trailingRanges = [];
  let lineStart = 0;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const start = lineStart;
    lineStart += line.length + 1; // +1 は \n

    const isHeading = /^#{1,2}(?:\s|$)/.test(line);

    if (on('fullspace-only-line') && line.length > 0 && /^　+$/.test(line)) {
      add('fullspace-only-line', start, start + line.length);
    }
    if (on('trailing-space')) {
      const m = /[ \t　]+$/.exec(line);
      if (m && line.length > 0) {
        const ts = start + m.index;
        const te = start + line.length;
        trailingRanges.push({ start: ts, end: te });
        add('trailing-space', ts, te);
      }
    }
    if (!isHeading && line.length > 0 && !/^[　\s]*$/.test(line)) {
      const first = line[0];
      if (on('dialog-indent') && line.startsWith('　「')) {
        add('dialog-indent', start, start + 2);
      } else if (
        on('indent-missing') &&
        first !== '　' &&
        !'「『（'.includes(first) &&
        // 行頭半角空白/TAB は halfwidth-space・tab 側を先に直す（字下げ漏れと二重・先回りしない）
        first !== ' ' &&
        first !== '\t'
      ) {
        // 一覧に行頭〜10文字程度を付けて該当行を判別しやすくする
        const { text: head, utf16Len } = headSnippet(line, 10);
        add(
          'indent-missing',
          start,
          start + Math.max(1, utf16Len),
          `${WARNING_LABELS['indent-missing']}　${head}`
        );
      }
    }
  }
  trailingRanges.sort((a, b) => a.start - b.start);
  const inTrailing = (pos) => inAny(trailingRanges, pos);

  // 全体スキャン系
  scan(text, /。[」』]/g, (m) => on('period-before-bracket') && add('period-before-bracket', m.index, m.index + m[0].length));
  scan(text, /[！？](?=[^\s　！？」』）】〉])/g, (m) => on('no-space-after-bang') && add('no-space-after-bang', m.index, m.index + 1));
  scan(text, /…+/g, (m) => on('odd-leader-dash') && [...m[0]].length % 2 === 1 && add('odd-leader-dash', m.index, m.index + m[0].length));
  scan(text, /―+/g, (m) => on('odd-leader-dash') && [...m[0]].length % 2 === 1 && add('odd-leader-dash', m.index, m.index + m[0].length));
  // 伸ばし棒「ー」(U+30FC) が2つ以上連続
  scan(text, /ー{2,}/g, (m) => on('repeated-chouon') && add('repeated-chouon', m.index, m.index + m[0].length));
  // 単独のカタカナ「ニ」（前後がカタカナ語を構成する文字でない）→ 漢字「二」誤変換が多い
  // カタカナ語の一部: ァ-ヶ・ー・゛゜・ヽヾ
  scan(text, /(?<![ァ-ヶー゛゜ヽヾ])ニ(?![ァ-ヶー゛゜ヽヾ])/g, (m) =>
    on('lonely-katakana-ni') && add('lonely-katakana-ni', m.index, m.index + 1)
  );
  scan(text, /\t/g, (m) => {
    // 行末TABは trailing-space に任せる（二重検出を避ける）
    if (on('tab') && !inTrailing(m.index)) add('tab', m.index, m.index + 1);
  });

  // 半角ラン（見出しプレフィックス・ルビ内を除外）
  // 優先度: 行末空白 > 半角スペース（空白のみラン） > 半角文字（非空白を含むラン）
  // 同じ箇所を3種で重ねない。
  scan(text, /[\x20-\x7e｡-ﾟ]+/g, (m) => {
    if (excluded(m.index)) return;
    const raw = m[0];
    const base = m.index;
    const pureWs = /^[ \t]+$/.test(raw);

    if (pureWs) {
      // 空白のみ: 行末に含まれる部分は trailing-space 済み。残りを halfwidth-space 1件にまとめる
      if (!on('halfwidth-space')) return;
      let i = 0;
      while (i < raw.length) {
        const abs = base + i;
        if (inTrailing(abs) || raw[i] !== ' ') {
          i++;
          continue;
        }
        let j = i;
        while (j < raw.length && raw[j] === ' ' && !inTrailing(base + j)) j++;
        if (j > i) add('halfwidth-space', base + i, base + j);
        i = Math.max(j, i + 1);
      }
      return;
    }

    // 非空白を含む半角ラン → halfwidth 1件（末尾の行末空白は範囲から除く）
    if (on('halfwidth')) {
      let end = base + raw.length;
      while (end > base && inTrailing(end - 1)) end--;
      // 除いた結果が空白だけ／空なら halfwidth は出さない
      const body = text.slice(base, end);
      if (body.length && /[\x21-\x7e｡-ﾟ]/.test(body)) {
        add('halfwidth', base, end);
      }
    }
    // ラン内の半角スペースは halfwidth に含めて示す（別項目にしない）
    // ただし「半角スペース」単独検出は空白のみランに限定（上の pureWs 分岐）
  });

  // 連続空行（3行以上）
  scan(text, /\n[ \t　]*\n[ \t　]*\n/g, (m) => on('consecutive-blank') && add('consecutive-blank', m.index, m.index + m[0].length));

  // ルビ非表示
  if (!showRuby && on('ruby-off')) {
    for (const r of rubyRanges) add('ruby-off', r.start, r.end);
  }

  // ルビ構文エラー
  if (on('ruby-syntax-error')) {
    scan(text, /《》/g, (m) => add('ruby-syntax-error', m.index, m.index + 2));
    scan(text, /《[^》\n]*(?:\n|$)/g, (m) => add('ruby-syntax-error', m.index, m.index + 1));
    scan(text, /｜(?![^《\n]*《)/g, (m) => add('ruby-syntax-error', m.index, m.index + 1));
  }

  // 括弧の対応（閉じていない開き／開きのない閉じ）
  // 《》はルビ記法のため対象外。ルビ範囲内の括弧もスキップ。
  if (on('unclosed-bracket') || on('unmatched-close-bracket')) {
    detectBracketBalance(text, rubyRanges, (code, start, end, mark) => {
      if (!on(code)) return;
      add(code, start, end, `${WARNING_LABELS[code]}　${mark}`);
    });
  }

  items.sort((a, b) => {
    const ds = a.range.start - b.range.start;
    if (ds) return ds;
    // 同一開始位置: 狭い範囲（より局所的）を先に
    const da = a.range.end - a.range.start;
    const db = b.range.end - b.range.start;
    if (da !== db) return da - db;
    return warnCodeOrder(a.code) - warnCodeOrder(b.code);
  });
  return { items, total };
}

/** 同一オフセット時の表示・移動順（小さいほど先） */
function warnCodeOrder(code) {
  const order = {
    'ruby-syntax-error': 10,
    'unmatched-close-bracket': 12,
    'unclosed-bracket': 14,
    tab: 20,
    'halfwidth-space': 30,
    halfwidth: 40,
    'trailing-space': 50,
    'period-before-bracket': 60,
    'no-space-after-bang': 70,
    'odd-leader-dash': 80,
    'repeated-chouon': 85,
    'lonely-katakana-ni': 87,
    'dialog-indent': 90,
    'indent-missing': 100,
    'fullspace-only-line': 110,
    'consecutive-blank': 120,
    'ruby-off': 130,
  };
  return order[code] ?? 500;
}

/**
 * 括弧対応チェック。
 * @param {string} text
 * @param {{start:number,end:number}[]} rubyRanges
 * @param {(code:string, start:number, end:number, mark:string) => void} emit
 */
function detectBracketBalance(text, rubyRanges, emit) {
  /** @type {Record<string,string>} */
  const openToClose = {
    '「': '」',
    '『': '』',
    '（': '）',
    '【': '】',
    '〔': '〕',
    '［': '］',
    '〈': '〉',
    '(': ')',
    '[': ']',
    '{': '}',
  };
  /** @type {Record<string,string>} */
  const closeToOpen = {};
  for (const [o, c] of Object.entries(openToClose)) closeToOpen[c] = o;

  /** @type {{ open:string, close:string, start:number }[]} */
  const stack = [];
  let i = 0;
  while (i < text.length) {
    // ルビ記法範囲は括弧判定から除外（親文字中の「」等は稀だが、《》誤検知を防ぐ）
    if (inAny(rubyRanges, i)) {
      // 範囲の end までスキップ
      let end = i + 1;
      for (const r of rubyRanges) {
        if (i >= r.start && i < r.end) {
          end = r.end;
          break;
        }
      }
      i = end;
      continue;
    }
    const ch = text[i];
    const cpLen = ch >= '\uD800' && ch <= '\uDBFF' && i + 1 < text.length ? 2 : 1;
    // サロゲートは括弧にならない
    if (cpLen === 2) {
      i += 2;
      continue;
    }

    if (openToClose[ch]) {
      stack.push({ open: ch, close: openToClose[ch], start: i });
    } else if (closeToOpen[ch]) {
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.close === ch) {
        stack.pop();
      } else {
        emit('unmatched-close-bracket', i, i + 1, ch);
      }
    }
    i += 1;
  }
  for (const fr of stack) {
    emit('unclosed-bracket', fr.start, fr.start + fr.open.length, fr.open);
  }
}

function scan(text, re, cb) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    cb(m);
    if (m.index === re.lastIndex) re.lastIndex++; // 空マッチ対策
  }
}

function collectRubyRanges(text) {
  const ranges = [];
  scan(text, /｜[^《\n]*《[^》\n]*》/g, (m) => ranges.push({ start: m.index, end: m.index + m[0].length }));
  scan(text, /[㐀-䶿一-鿿々]+《[^》\n]*》/g, (m) => ranges.push({ start: m.index, end: m.index + m[0].length }));
  return ranges.sort((a, b) => a.start - b.start);
}

function collectHeadingPrefixRanges(text) {
  const ranges = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const m = /^#{1,2}\s?/.exec(line);
    if (m) ranges.push({ start: lineStart, end: lineStart + m[0].length });
    lineStart += line.length + 1;
  }
  return ranges;
}

function inAny(ranges, pos) {
  for (const r of ranges) {
    if (pos >= r.start && pos < r.end) return true;
    if (r.start > pos) break;
  }
  return false;
}

/** 行頭から最大 n コードポイントを切り出し、長い場合は … を付ける */
function headSnippet(line, n) {
  let text = '';
  let count = 0;
  let utf16Len = 0;
  for (const ch of line) {
    text += ch;
    utf16Len += ch.length;
    count++;
    if (count >= n) break;
  }
  let more = false;
  let seen = 0;
  for (const _ of line) {
    seen++;
    if (seen > n) {
      more = true;
      break;
    }
  }
  if (more) text += '…';
  return { text, utf16Len };
}
