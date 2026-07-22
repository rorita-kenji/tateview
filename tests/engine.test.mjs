import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeNewlines } from '../src/modules/normalize.js';
import { detectAndDecode } from '../src/modules/encoding.js';
import { tokenize, tokenizeToArray } from '../src/modules/tokenizer.js';
import { paginate, pageIndexOfOffset } from '../src/modules/paginator.js';
import { detectWarnings } from '../src/modules/warnings.js';
import { searchAll } from '../src/modules/search.js';
import { makeRecord, restoreOffset } from '../src/modules/position.js';
import { headingLevel, isHeadingLine, matchHeadingPrefix, headingTitle } from '../src/modules/heading.js';

const enc = (s) => new TextEncoder().encode(s);

/* ---------------- normalize ---------------- */
test('normalize: CRLF/CR/LF 混在 -> LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

/* ---------------- encoding ---------------- */
test('encoding: UTF-8 (BOMなし)', () => {
  const r = detectAndDecode(enc('こんにちは'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, 'こんにちは');
});
test('encoding: UTF-8 (BOMあり)', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('あ')]);
  const r = detectAndDecode(bytes);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, 'あ');
});
test('encoding: Shift_JIS', () => {
  // 「あいう」の Shift_JIS バイト列
  const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]);
  const r = detectAndDecode(sjis);
  assert.equal(r.encoding, 'shift_jis');
  assert.equal(r.text, 'あいう');
});

/* ---------------- tokenizer ---------------- */
test('tokenizer: 半角ランは ceil(n*0.5) マス', () => {
  const toks = tokenizeToArray('abc'); // 3 half
  assert.equal(toks.length, 1);
  assert.equal(toks[0].type, 'half');
  assert.equal(toks[0].mass, 2); // ceil(1.5)
});
test('tokenizer: 明示ルビ ｜親《ルビ》', () => {
  const toks = tokenizeToArray('｜漢字《かんじ》');
  assert.equal(toks.length, 1);
  assert.equal(toks[0].type, 'ruby');
  assert.equal(toks[0].baseText, '漢字');
  assert.equal(toks[0].rubyText, 'かんじ');
  assert.equal(toks[0].mass, 2);
});
test('tokenizer: 自動ルビ 漢字《ルビ》', () => {
  const toks = tokenizeToArray('東京《とうきょう》');
  assert.equal(toks[0].type, 'ruby');
  assert.equal(toks[0].baseText, '東京');
  assert.equal(toks[0].mass, 2);
});
test('tokenizer: サロゲートペア A😀B の sourceStart/End は UTF-16、slice で復元', () => {
  const text = 'A😀B';
  for (const t of tokenize(text)) {
    assert.equal(text.slice(t.sourceStart, t.sourceEnd), t.text === '' ? '\n' : text.slice(t.sourceStart, t.sourceEnd));
  }
  // 😀 は UTF-16 で2、range が正しいこと
  const toks = tokenizeToArray(text);
  const rejoined = toks.map((t) => text.slice(t.sourceStart, t.sourceEnd)).join('');
  assert.equal(rejoined, text);
});
test('tokenizer: 全トークンが隙間なく全文を被覆する', () => {
  const text = 'あA1｜漢《か》。\nEnd😀';
  const toks = tokenizeToArray(text);
  let pos = 0;
  for (const t of toks) {
    assert.equal(t.sourceStart, pos, 'contiguous start');
    pos = t.sourceEnd;
  }
  assert.equal(pos, text.length);
});

/* ---------------- paginator ---------------- */
function checkInvariants(pages, textLen) {
  let prevEnd = 0;
  for (const p of pages) {
    assert.equal(p.range.start, prevEnd, 'page contiguous');
    let colPrev = p.range.start;
    for (const c of p.columns) {
      assert.equal(c.start, colPrev, 'col contiguous');
      assert.ok(c.end >= c.start);
      colPrev = c.end;
    }
    if (p.columns.length) assert.equal(colPrev, p.range.end, 'page end == last col end');
    prevEnd = p.range.end;
  }
  assert.equal(prevEnd, textLen, 'last end == text length');
}

test('paginator: 禁則OFF 固定期待値（4字×2行）', () => {
  const text = 'あいうえおかきくけこ'; // 10 full
  const cfg = { charsPerColumn: 4, columnsPerPage: 2, kinsoku: false, burasage: false };
  const pages = paginate(tokenize(text), cfg);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].columns, [{ start: 0, end: 4 }, { start: 4, end: 8 }]);
  assert.deepEqual(pages[1].columns, [{ start: 8, end: 10 }]);
  checkInvariants(pages, text.length);
});

test('paginator: 決定性（2回同一）', () => {
  const text = 'あ'.repeat(97) + 'ABCDE。」\n次の行';
  const cfg = { charsPerColumn: 20, columnsPerPage: 10, kinsoku: true, burasage: true };
  const a = paginate(tokenize(text), cfg);
  const b = paginate(tokenize(text), cfg);
  assert.deepEqual(a, b);
  checkInvariants(a, text.length);
});

test('paginator: 改行は直前列に含まれ穴を作らない', () => {
  const text = 'あい\nうえ';
  const cfg = { charsPerColumn: 10, columnsPerPage: 10, kinsoku: false, burasage: false };
  const pages = paginate(tokenize(text), cfg);
  checkInvariants(pages, text.length);
  assert.deepEqual(pages[0].columns[0], { start: 0, end: 3 }); // あい\n
});

test('paginator: 先頭改行・連続改行・末尾改行・空ファイル', () => {
  const cfg = { charsPerColumn: 5, columnsPerPage: 5, kinsoku: false, burasage: false };
  for (const text of ['\nあ', 'あ\n\n\nい', 'あ\n', '']) {
    const pages = paginate(tokenize(text), cfg);
    checkInvariants(pages, text.length);
    assert.ok(pages.length >= 1);
  }
});

test('paginator: 列幅より長い半角ランは単独列で空列を無限生成しない', () => {
  const text = 'abcdefghijklmnop'; // 16 half -> mass 8
  const cfg = { charsPerColumn: 4, columnsPerPage: 5, kinsoku: false, burasage: false };
  const pages = paginate(tokenize(text), cfg);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].columns.length, 1);
  assert.deepEqual(pages[0].columns[0], { start: 0, end: 16 });
  checkInvariants(pages, text.length);
});

test('paginator: 列幅より長いルビ親文字でも停止しない', () => {
  const text = '｜あいうえおかき《ルビ》';
  const cfg = { charsPerColumn: 3, columnsPerPage: 5, kinsoku: false, burasage: false };
  const pages = paginate(tokenize(text), cfg);
  assert.equal(pages[0].columns.length, 1);
  checkInvariants(pages, text.length);
});

test('paginator: 禁則ON 行頭に句読点・閉じ括弧が来ない', () => {
  // 列容量4。境界に 。 が来るように調整
  const text = 'あいう。えおかき';
  const cfg = { charsPerColumn: 4, columnsPerPage: 5, kinsoku: true, burasage: false };
  const pages = paginate(tokenize(text), cfg);
  checkInvariants(pages, text.length);
  // 各列の先頭文字が行頭禁則でない
  for (const p of pages)
    for (const c of p.columns) {
      const head = text[c.start];
      assert.ok(!'、。）」'.includes(head), `col head '${head}' は行頭禁則`);
    }
});

test('paginator: ぶら下げONで 。 が列末をはみ出す', () => {
  const text = 'あいうえ。';
  const cfg = { charsPerColumn: 4, columnsPerPage: 5, kinsoku: true, burasage: true };
  const pages = paginate(tokenize(text), cfg);
  checkInvariants(pages, text.length);
  // 「。」が最初の列に含まれる（5マス目としてぶら下げ）
  assert.equal(pages[0].columns[0].end, 5);
  assert.equal(pages[0].columns.length, 1);
});

test('paginator: ルビ有無でマス（境界）が一致', () => {
  const withRuby = '東京《とうきょう》は都';
  const plain = '東京は都';
  const cfg = { charsPerColumn: 2, columnsPerPage: 10, kinsoku: false, burasage: false };
  const colsWith = paginate(tokenize(withRuby), cfg).flatMap((p) => p.columns.length);
  const colsPlain = paginate(tokenize(plain), cfg).flatMap((p) => p.columns.length);
  // マス数が同じなので列数が一致
  assert.equal(colsWith[0], colsPlain[0]);
});

test('paginator: pageIndexOfOffset', () => {
  const text = 'あいうえおかきくけこ';
  const cfg = { charsPerColumn: 4, columnsPerPage: 1, kinsoku: false, burasage: false };
  const pages = paginate(tokenize(text), cfg);
  assert.equal(pageIndexOfOffset(pages, 0), 0);
  assert.equal(pageIndexOfOffset(pages, 5), 1);
  assert.equal(pageIndexOfOffset(pages, 9), 2);
});

/* ---------------- warnings ---------------- */
function codes(text, opt) {
  return detectWarnings(text, opt).items.map((i) => i.code);
}
test('warnings: 字下げ漏れ／会話字下げ／見出し除外', () => {
  assert.ok(codes('地の文です').includes('indent-missing'));
  assert.ok(!codes('　地の文です').includes('indent-missing'));
  assert.ok(!codes('「セリフ」').includes('indent-missing'));
  assert.ok(codes('　「セリフ」').includes('dialog-indent'));
  assert.ok(!codes('# 第一章').includes('indent-missing'));
  const long = 'あいうえおかきくけこさしすせそ';
  const item = detectWarnings(long).items.find((i) => i.code === 'indent-missing');
  assert.ok(item);
  assert.match(item.label, /^字下げ漏れ　あいうえおかきくけこ…$/);
  assert.equal(long.slice(item.range.start, item.range.end), 'あいうえおかきくけこ');
});
test('warnings: 見出しの # と半角スペースは半角警告を出さない', () => {
  const c = codes('# 第一章');
  assert.ok(!c.includes('halfwidth'));
  assert.ok(!c.includes('halfwidth-space'));
});
test('warnings: カスタム章/話マーカーで字下げ除外', () => {
  const opt = { chapterMark: '【章】', episodeMark: '【話】' };
  assert.ok(!codes('【章】 はじまり', opt).includes('indent-missing'));
  assert.ok(!codes('【話】 その一', opt).includes('indent-missing'));
  assert.ok(codes('はじまり', opt).includes('indent-missing'));
  // 既定 # はカスタム時は見出しにならない
  assert.ok(codes('# 旧見出し', opt).includes('indent-missing'));
});
test('heading: ## を # より優先（話）', () => {
  assert.equal(headingLevel('## 話', { chapter: '#', episode: '##' }), 2);
  assert.equal(headingLevel('# 章', { chapter: '#', episode: '##' }), 1);
  assert.equal(matchHeadingPrefix('# 章', { chapter: '#', episode: '##' }).prefixLen, 2);
  assert.ok(isHeadingLine('\u3010\u8a71\u3011\u30bf\u30a4\u30c8\u30eb', { chapter: '\u3010\u7ae0\u3011', episode: '\u3010\u8a71\u3011' }));
});
test('heading: 行頭スペースのみ許容。他文字を挟むと本文。タイトルは切る', () => {
  const marks = { chapter: '#', episode: '##' };
  // 前に本文があると見出しにしない
  assert.equal(headingLevel('前置き ## サブタイトル', marks), 0);
  // 全角/半角スペースのみならOK
  assert.equal(headingLevel('　# 章タイトル', marks), 1);
  assert.equal(headingLevel('  ## 話タイトル', marks), 2);
  assert.equal(headingLevel('　  # 混在スペース', marks), 1);
  const t = headingTitle('　## とても長いタイトル文字列ですよ本当に長い', marks, 8);
  assert.equal(t.level, 2);
  assert.equal(t.text, 'とても長いタイト');
  assert.equal(headingLevel('これは本文', marks), 0);
  // 前置きありは字下げ漏れ対象（見出し除外されない）
  assert.ok(codes('前置き # 見出し行').includes('indent-missing'));
  assert.ok(!codes('　# 見出し行').includes('indent-missing'));
});
test('warnings: 閉じ括弧前の句点', () => {
  assert.ok(codes('「そうか。」').includes('period-before-bracket'));
  assert.ok(!codes('「そうか」').includes('period-before-bracket'));
});
test('warnings: ！？ 後のスペース不足', () => {
  assert.ok(codes('何だと！そんな').includes('no-space-after-bang'));
  assert.ok(!codes('何だと！　そんな').includes('no-space-after-bang'));
  assert.ok(!codes('何だと！」').includes('no-space-after-bang'));
  assert.ok(!codes('何だと！').includes('no-space-after-bang'));
});
test('warnings: 三点リーダ／ダッシュの奇数（単体も拾う）', () => {
  assert.ok(codes('あ…い').includes('odd-leader-dash'));
  assert.ok(!codes('あ……い').includes('odd-leader-dash'));
  assert.ok(codes('あ―い').includes('odd-leader-dash'));
  assert.ok(!codes('あ――い').includes('odd-leader-dash'));
});
test('warnings: 伸ばし棒ーの連続', () => {
  assert.ok(codes('　ああーー').includes('repeated-chouon'));
  assert.ok(codes('　うーーーっ').includes('repeated-chouon'));
  assert.ok(!codes('　ああー').includes('repeated-chouon'));
  const item = detectWarnings('xーーy').items.find((i) => i.code === 'repeated-chouon');
  assert.ok(item);
  assert.deepEqual(item.range, { start: 1, end: 3 });
  assert.equal(item.label, '伸ばし棒の連続');
});
test('warnings: 単独のカタカナ「ニ」', () => {
  assert.ok(codes('　ニ人が歩いた').includes('lonely-katakana-ni'));
  assert.ok(codes('　あとニつ').includes('lonely-katakana-ni'));
  // カタカナ語の一部は除外
  assert.ok(!codes('　ソニーの製品').includes('lonely-katakana-ni'));
  assert.ok(!codes('　ユニット').includes('lonely-katakana-ni'));
  assert.ok(!codes('　コンビニ').includes('lonely-katakana-ni'));
  // 漢字の二は対象外
  assert.ok(!codes('　二人が歩いた').includes('lonely-katakana-ni'));
});
test('warnings: 半角はラン単位で1件、ルビ内は除外', () => {
  const one = detectWarnings('ABCあ').items.filter((i) => i.code === 'halfwidth');
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].range, { start: 0, end: 3 });
  assert.ok(!codes('｜A《エー》').includes('halfwidth'));
});
test('warnings: 行末空白と半角は重ねない', () => {
  // 行末の半角スペースだけ → trailing-space のみ（halfwidth / halfwidth-space は出さない）
  const onlyTrail = detectWarnings('あいう ').items.map((i) => i.code);
  assert.ok(onlyTrail.includes('trailing-space'));
  assert.ok(!onlyTrail.includes('halfwidth'));
  assert.ok(!onlyTrail.includes('halfwidth-space'));

  // 半角語＋行末スペース → halfwidth は語のみ、スペースは trailing-space
  const mixed = detectWarnings('ABC ').items;
  const hw = mixed.filter((i) => i.code === 'halfwidth');
  const tr = mixed.filter((i) => i.code === 'trailing-space');
  const hs = mixed.filter((i) => i.code === 'halfwidth-space');
  assert.equal(hw.length, 1);
  assert.deepEqual(hw[0].range, { start: 0, end: 3 });
  assert.equal(tr.length, 1);
  assert.equal(hs.length, 0);

  // 行中の空白のみラン → halfwidth-space 1件（半角文字にはしない）
  const mid = detectWarnings('あ  い').items;
  assert.equal(mid.filter((i) => i.code === 'halfwidth-space').length, 1);
  assert.equal(mid.filter((i) => i.code === 'halfwidth').length, 0);
  assert.deepEqual(mid.find((i) => i.code === 'halfwidth-space').range, { start: 1, end: 3 });
});
test('warnings: 行頭半角スペースは字下げ漏れより先／二重にしない', () => {
  const items = detectWarnings(' 地の文です').items;
  const codesInOrder = items.map((i) => i.code);
  assert.ok(codesInOrder.includes('halfwidth-space'));
  // 行頭が半角スペースのときは字下げ漏れを出さない（半角を先に直す）
  assert.ok(!codesInOrder.includes('indent-missing'));
  // 半角のあとに続く字下げ漏れ行は、半角より後のオフセット順
  const multi = detectWarnings(' あ\n地の文').items;
  const iSpace = multi.findIndex((i) => i.code === 'halfwidth-space');
  const iIndent = multi.findIndex((i) => i.code === 'indent-missing');
  assert.ok(iSpace >= 0 && iIndent >= 0);
  assert.ok(iSpace < iIndent, '半角スペースが字下げ漏れより先');
});
test('warnings: TAB・行末空白・全角空白のみ行・連続空行', () => {
  assert.ok(codes('a\tb').includes('tab'));
  assert.ok(codes('あいう　').includes('trailing-space'));
  assert.ok(codes('　　').includes('fullspace-only-line'));
  assert.ok(codes('あ\n\n\nい').includes('consecutive-blank'));
});
test('warnings: ルビOFFで ruby-off、severity は info', () => {
  const r = detectWarnings('東京《とうきょう》', { showRuby: false });
  const off = r.items.filter((i) => i.code === 'ruby-off');
  assert.equal(off.length, 1);
  assert.equal(off[0].severity, 'info');
  assert.ok(!codes('東京《とうきょう》', { showRuby: true }).includes('ruby-off'));
});
test('warnings: ルビ構文エラー', () => {
  assert.ok(codes('《》').includes('ruby-syntax-error'));
  assert.ok(codes('漢字《ルビ').includes('ruby-syntax-error'));
  assert.ok(codes('｜漢字です').includes('ruby-syntax-error'));
  assert.ok(!codes('漢字《かんじ》').includes('ruby-syntax-error'));
});
test('warnings: 閉じていない括弧／開きのない閉じ括弧', () => {
  // 未閉じ
  const open = detectWarnings('　「こんにちは').items.filter((i) => i.code === 'unclosed-bracket');
  assert.equal(open.length, 1);
  assert.equal(open[0].label, '閉じていない括弧　「');
  assert.deepEqual(open[0].range, { start: 1, end: 2 });

  // 開きなし閉じ
  const close = detectWarnings('　こんにちは」').items.filter((i) => i.code === 'unmatched-close-bracket');
  assert.equal(close.length, 1);
  assert.equal(close[0].label, '開きのない閉じ括弧　」');

  // 正常
  assert.ok(!codes('　「こんにちは」').includes('unclosed-bracket'));
  assert.ok(!codes('　「こんにちは」').includes('unmatched-close-bracket'));
  assert.ok(!codes('　（注）と『書名』').includes('unclosed-bracket'));

  // ネスト
  assert.ok(!codes('　「彼は『いいえ』と言った」').includes('unclosed-bracket'));
  assert.ok(codes('　「彼は『いいえと言った」').includes('unclosed-bracket'));

  // ルビの《》は括弧警告にしない
  const ruby = codes('　東京《とうきょう》です');
  assert.ok(!ruby.includes('unclosed-bracket'));
  assert.ok(!ruby.includes('unmatched-close-bracket'));
});
test('warnings: 上限と total', () => {
  const text = 'a\n'.repeat(2000); // 半角aが2000ラン
  const r = detectWarnings(text, { limit: 100, enabled: new Set(['halfwidth']) });
  assert.equal(r.items.length, 100);
  assert.ok(r.total >= 2000);
});

test('warnings: 句読点の連続', () => {
  // 検出される例
  const dp = codes('あいう。、い');
  assert.ok(dp.includes('double-punctuation'));
  // 3文字連続も
  assert.ok(codes('。。。。。').includes('double-punctuation'));
  // 単独は対象外
  assert.ok(!codes('あいう。い').includes('double-punctuation'));
});

test('warnings: 括弧の不一致（mixed-bracket）', () => {
  const result = detectWarnings('「こんにちは」');
  assert.ok(!result.items.some((i) => i.code === 'mixed-bracket'));

  // 「で開いて」で閉じる → 一致
  const ok = codes('「こんにちは」');
  assert.ok(!ok.includes('mixed-bracket'));

  // 「で開いて]で閉じる → mismatch
  const mixed = detectWarnings('「こんにちは]').items.filter((i) => i.code === 'mixed-bracket');
  assert.equal(mixed.length, 1);
  assert.match(mixed[0].label, /括弧の不一致.*→\]/);

  // (で開いて」で閉じる → mismatch
  const mixed2 = detectWarnings('(こんにちは」').items.filter((i) => i.code === 'mixed-bracket');
  assert.equal(mixed2.length, 1);
});

test('warnings: 半角カナは halfwidth に統合', () => {
  // 半角カナは halfwidth として検出される
  assert.ok(codes('あいうｱい').includes('halfwidth'));

  // 半角カナのみでも halfwidth として拾う（字下げ漏れも出るが halfwidth は1件）
  const r = detectWarnings('ｱｲｳ');
  const hwItems = r.items.filter((i) => i.code === 'halfwidth');
  assert.equal(hwItems.length, 1);
  assert.deepEqual(hwItems[0].range, { start: 0, end: 3 });

  // 通常の全角カナは halfwidth ではない
  assert.ok(!codes('アイウエオ').includes('halfwidth'));

  // ルビ内は除外される
  assert.ok(!codes('｜A《エー》').includes('halfwidth'));
});

test('warnings: 全角アルファベット・全角数字は info', () => {
  const alpha = detectWarnings('　ＡＢＣです');
  const aItems = alpha.items.filter((i) => i.code === 'fullwidth-alpha');
  assert.equal(aItems.length, 1);
  assert.equal(aItems[0].severity, 'info');
  assert.equal(aItems[0].label, '全角アルファベット');
  assert.deepEqual(aItems[0].range, { start: 1, end: 4 });

  const digit = detectWarnings('　１２３円');
  const dItems = digit.items.filter((i) => i.code === 'fullwidth-digit');
  assert.equal(dItems.length, 1);
  assert.equal(dItems[0].severity, 'info');
  assert.equal(dItems[0].label, '全角数字');
  assert.deepEqual(dItems[0].range, { start: 1, end: 4 });

  // 半角英数は fullwidth 系に出さない
  assert.ok(!codes('　ABC123').includes('fullwidth-alpha'));
  assert.ok(!codes('　ABC123').includes('fullwidth-digit'));

  // 連続はラン1件
  const run = detectWarnings('　ＡａＺｚ０９').items;
  assert.equal(run.filter((i) => i.code === 'fullwidth-alpha').length, 1);
  assert.equal(run.filter((i) => i.code === 'fullwidth-digit').length, 1);

  // ルビ内除外
  assert.ok(!codes('｜Ａ《エー》').includes('fullwidth-alpha'));
  assert.ok(!codes('漢字《０１》').includes('fullwidth-digit'));
});

test('warnings: 絵文字は info', () => {
  const smile = '😀';
  const r = detectWarnings(`　あ${smile}い`);
  const items = r.items.filter((i) => i.code === 'emoji');
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'info');
  assert.equal(items[0].label, '絵文字');
  assert.deepEqual(items[0].range, { start: 2, end: 2 + smile.length });

  // 隣接連続は1ラン
  const double = `${smile}${smile}`;
  const run = detectWarnings(`　${double}`).items.filter((i) => i.code === 'emoji');
  assert.equal(run.length, 1);
  assert.deepEqual(run[0].range, { start: 1, end: 1 + double.length });

  // ZWJ 家族など1シーケンス
  const family = '👨\u200D👩\u200D👧';
  const zwj = detectWarnings(`　${family}`).items.filter((i) => i.code === 'emoji');
  assert.equal(zwj.length, 1);
  assert.deepEqual(zwj[0].range, { start: 1, end: 1 + family.length });

  // 国旗
  const flag = '🇯🇵';
  assert.equal(
    detectWarnings(`　${flag}`).items.filter((i) => i.code === 'emoji').length,
    1
  );

  // 通常の日本語・※★は絵文字にしない
  assert.ok(!codes('　あいう※★').includes('emoji'));

  // ルビ内除外
  assert.ok(!codes(`漢字《${smile}》`).includes('emoji'));
});

/* ---------------- search ---------------- */
test('search: 全文・見出し', () => {
  const text = '# 章タイトル\n本文に章がある。章は続く。';
  assert.equal(searchAll(text, '章').total, 3);
  const h = searchAll(text, '章', { headingOnly: true });
  assert.equal(h.total, 1);
  const custom = '【章】タイトル\n本文に章';
  assert.equal(searchAll(custom, '章', { headingOnly: true, chapterMark: '【章】', episodeMark: '【話】' }).total, 1);
  assert.equal(searchAll(custom, '章', { headingOnly: true }).total, 0);
});

/* ---------------- position ---------------- */
test('position: 編集で文字数が変わっても近傍復帰', () => {
  const original = 'ゼロ。' + 'あ'.repeat(50) + '目印テキスト' + 'い'.repeat(50);
  const off = original.indexOf('目印テキスト');
  const rec = makeRecord(original, off);
  // 冒頭に文字を挿入して文字数を変える
  const edited = '＝追加＝' + original;
  const restored = restoreOffset(edited, rec);
  assert.equal(edited.slice(restored, restored + 6), '目印テキスト');
});
test('position: 見つからなければクランプ', () => {
  const rec = makeRecord('あいうえお', 3);
  const restored = restoreOffset('まったく別の内容', rec);
  assert.ok(restored >= 0 && restored <= 'まったく別の内容'.length);
});
