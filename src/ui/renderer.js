// renderer.js — 縦書きDOM生成（表示ページのみ）
import { tokenize } from '../modules/tokenizer.js';

const FULL_SPACE = '\u3000';

/** 半角空白扱い（半角スペース・TAB） */
function isHalfWs(ch) {
  return ch === ' ' || ch === '\t';
}
function hasHalfWs(text) {
  return text.includes(' ') || text.includes('\t');
}

/**
 * ページを描画する。
 * @param {HTMLElement} pageEl
 * @param {string} text
 * @param {{columns:{start,end}[]}} page
 * @param {{ showRuby:boolean, halfColor:boolean, spaceColor?:boolean,
 *           highlights?:{start,end,kind?:string}[],
 *           grid?:boolean, cell?:number, chars?:number }} opt
 */
export function renderPage(pageEl, text, page, opt) {
  pageEl.textContent = '';
  const highlights = opt.highlights || [];
  for (const col of page.columns) {
    const colEl = document.createElement('div');
    colEl.className = 'col';
    const slice = text.slice(col.start, col.end);
    for (const t of tokenize(slice)) {
      const absStart = col.start + t.sourceStart;
      const absEnd = col.start + t.sourceEnd;
      const hit = highlightHit(highlights, absStart, absEnd);
      if (t.type === 'newline') continue;
      let node;
      if (t.type === 'ruby') {
        if (opt.showRuby) {
          node = document.createElement('ruby');
          node.appendChild(document.createTextNode(t.baseText));
          const rt = document.createElement('rt');
          rt.textContent = t.rubyText;
          node.appendChild(rt);
        } else {
          // ルビOFF: ルビ記号（｜《》）も含め元テキストをそのまま表示
          node = document.createElement('span');
          if (opt.spaceColor) appendSpaceColored(node, slice.slice(t.sourceStart, t.sourceEnd), opt);
          else node.textContent = slice.slice(t.sourceStart, t.sourceEnd);
        }
      } else if (t.type === 'half') {
        node = buildHalfNode(t.text, opt);
      } else {
        node = buildFullNode(t.text, opt);
      }
      if (hit) {
        const mark = document.createElement('mark');
        if (hit.kind === 'warn') mark.className = 'hl-warn';
        else if (hit.kind === 'search') mark.className = 'hl-search';
        mark.appendChild(node);
        node = mark;
      }
      colEl.appendChild(node);
    }
    pageEl.appendChild(colEl);
  }
}

/**
 * 半角トークン。空白着色ON時は半角スペース/TAB区間を分離して緑系に。
 * @param {string} text
 * @param {{ halfColor:boolean, spaceColor?:boolean }} opt
 * @returns {HTMLElement}
 */
function buildHalfNode(text, opt) {
  const wrap = document.createElement('span');
  wrap.className = 'half';
  if (!opt.spaceColor || !hasHalfWs(text)) {
    if (opt.halfColor) wrap.classList.add('half-color');
    wrap.textContent = text;
    return wrap;
  }
  // 半角空白（SP/TAB）とその他をラン分割
  let i = 0;
  while (i < text.length) {
    const sp = isHalfWs(text[i]);
    let j = i + 1;
    while (j < text.length && isHalfWs(text[j]) === sp) j++;
    const seg = document.createElement('span');
    seg.className = 'half';
    if (sp) seg.classList.add('space-half');
    else if (opt.halfColor) seg.classList.add('half-color');
    seg.textContent = text.slice(i, j);
    wrap.appendChild(seg);
    i = j;
  }
  return wrap;
}

/**
 * 全角1トークン（結合文字付きの場合あり）。
 * 全角スペースは青系。TABは半角空白と同様に緑系。
 * @param {string} text
 * @param {{ spaceColor?:boolean }} opt
 * @returns {HTMLElement}
 */
function buildFullNode(text, opt) {
  const node = document.createElement('span');
  if (opt.spaceColor) {
    if (text[0] === FULL_SPACE) node.className = 'space-full';
    else if (text[0] === '\t') {
      // TAB は tokenizer 上 full だが、空白表示では半角スペースと同じ緑系
      node.className = 'half space-half';
    }
  }
  node.textContent = text;
  return node;
}

/**
 * プレーン文字列中の全角/半角スペース/TABを着色（ルビOFF時の記法表示用）。
 * @param {HTMLElement} parent
 * @param {string} text
 * @param {{ halfColor:boolean, spaceColor?:boolean }} opt
 */
function appendSpaceColored(parent, text, opt) {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // サロゲートはまとめて1単位
    const cpLen = ch >= '\uD800' && ch <= '\uDBFF' && i + 1 < text.length ? 2 : 1;
    const unit = text.slice(i, i + cpLen);
    if (unit === FULL_SPACE) {
      const s = document.createElement('span');
      s.className = 'space-full';
      s.textContent = unit;
      parent.appendChild(s);
      i += cpLen;
      continue;
    }
    if (isHalfWs(unit)) {
      let j = i + 1;
      while (j < text.length && isHalfWs(text[j])) j++;
      const s = document.createElement('span');
      s.className = 'half space-half';
      s.textContent = text.slice(i, j);
      parent.appendChild(s);
      i = j;
      continue;
    }
    // 非空白ラン
    let j = i + cpLen;
    while (j < text.length) {
      const c = text[j];
      if (c === FULL_SPACE || isHalfWs(c)) break;
      j += c >= '\uD800' && c <= '\uDBFF' && j + 1 < text.length ? 2 : 1;
    }
    parent.appendChild(document.createTextNode(text.slice(i, j)));
    i = j;
  }
}

/** 見出し行の着色は本文と組版を変えないため、行頭が #/## のトークン列にクラスを付ける処理は
 *  main 側で行頭検出して colEl にマーカーを足す簡易実装とする（ここでは範囲ハイライトのみ）。 */

function highlightHit(ranges, s, e) {
  // 後勝ち（warn を search より後に push すれば warn 優先）
  let hit = null;
  for (const r of ranges) {
    if (s < r.end && e > r.start) hit = r;
  }
  return hit;
}
