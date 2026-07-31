// swipe.test.mjs — 連続スワイプ（パラパラ捲り）の挙動を jsdom で検証。
// dist/TateView.html をテスト用に計装（window.__T を生やす）してから読み込む。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { tokenize } from '../src/modules/tokenizer.js';
import { paginate } from '../src/modules/paginator.js';

const HOOK = `;window.__T={state:state,trackSwipeTx:trackSwipeTx,onSwipeRelease:onSwipeRelease,renderCurrent:renderCurrent,`
  + `onWheel:onWheel,slideWidth:slideWidth,commitThreshold:commitThreshold,`
  + `tx:function(){return pageSwipeTx;},lock:function(){return pageSwipeLock;},`
  + `setPages:function(t,p){state.text=t;state.pages=p;state.pageIndex=0;`
  + `document.getElementById('pageWrap').classList.remove('empty');renderCurrent();}};`;

let dom, win, wrap;

function makePages(n) {
  const text = Array.from({ length: n * 40 }, (_, i) => '文' + (i % 10)).join('');
  const pages = paginate(tokenize(text), {
    charsPerColumn: 20, columnsPerPage: 2, kinsoku: true, burasage: false,
  });
  return { text, pages };
}

class FakeWorker {
  constructor() { this.onmessage = null; }
  postMessage() { /* テストでは pages を直接注入するので不要 */ }
  terminate() {}
}

before(async () => {
  let html = readFileSync(new URL('../dist/TateView.html', import.meta.url), 'utf8');
  const marker = '\n})();\n\n</script>';
  const at = html.lastIndexOf(marker);
  assert.ok(at > 0, 'main バンドル末尾が見つからない');
  html = html.slice(0, at) + '\n' + HOOK + marker + html.slice(at + marker.length);

  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/',
    beforeParse(w) {
      w.Worker = FakeWorker;
      w.URL.createObjectURL = () => 'blob:fake';
      w.Element.prototype.setPointerCapture = function () {};
      w.Element.prototype.releasePointerCapture = function () {};
      w.Element.prototype.hasPointerCapture = () => false;
      // jsdom には PointerEvent が無い
      w.PointerEvent = class PointerEvent extends w.MouseEvent {
        constructor(type, init = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? 'touch';
        }
      };
    },
  });
  win = dom.window;
  await new Promise((r) => win.addEventListener('load', r, { once: true }));
  wrap = win.document.getElementById('pageWrap');
});

const settle = () => new Promise((r) => setTimeout(r, 320));

/** 直前テストの着地アニメを終わらせてから新しい原稿を入れる */
async function loadPages(n) {
  await settle();
  const { text, pages } = makePages(n);
  win.__T.setPages(text, pages);
  assert.ok(pages.length >= n / 2, 'ページが作れている');
  return pages.length;
}

function pointer(type, x, y, t, id) {
  const ev = new win.PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    pointerId: id != null ? id : 7, pointerType: 'touch',
  });
  if (t != null) Object.defineProperty(ev, 'timeStamp', { value: t });
  wrap.dispatchEvent(ev);
}

let clock = 0;

function wheel(dx, dy, t) {
  const ev = new win.WheelEvent('wheel', {
    bubbles: true, cancelable: true, deltaX: dx, deltaY: dy || 0,
  });
  Object.defineProperty(ev, 'timeStamp', { value: t != null ? t : (clock += 16) });
  wrap.dispatchEvent(ev);
}

/** 指がトラックパッド上で加速していくフェーズ */
function trackpadPush(sign, peak = 45) {
  for (const v of [2, 6, 14, 26, 38, peak]) { wheel(sign * v, 0, clock); clock += 16; }
  return peak;
}
/** 指を離したあとの慣性（macOS は等間隔で単調減衰） */
function trackpadMomentum(sign, from, steps) {
  let v = from;
  for (let i = 0; i < steps; i++) {
    v *= 0.86;
    if (v < 0.6) break;
    wheel(sign * v, 0, clock);
    clock += 16;
  }
}

const idx = () => win.__T.state.pageIndex;

test('長く引いても1スワイプでは1ページだけ', async () => {
  const total = await loadPages(30);
  const w = win.__T.slideWidth();
  let t = 0;
  pointer('pointerdown', 500, 300, t);
  // 3.5ページ分ひと続きにドラッグしても送るのは1ページ
  for (let i = 1; i <= 35; i++) {
    t += 16;
    pointer('pointermove', 500 + (w * 0.1 * i), 300, t);
  }
  pointer('pointerup', 500 + w * 3.5, 300, t + 16);
  await settle();
  assert.equal(idx(), 1, '1ページだけ進む');
  assert.ok(total > 4);
});

test('指を離して続けてスワイプすれば連続で捲れる', async () => {
  await loadPages(30);
  const w = win.__T.slideWidth();
  let t = 2000;
  // 着地アニメの完了を待たずに次のスワイプへ（連打）
  for (let n = 0; n < 4; n++) {
    pointer('pointerdown', 100, 300, t);
    for (let i = 1; i <= 4; i++) { t += 12; pointer('pointermove', 100 + w * 0.06 * i, 300, t); }
    t += 12;
    pointer('pointerup', 100 + w * 0.24, 300, t);
    t += 30; // 指を離してすぐ次
  }
  await settle();
  assert.equal(idx(), 4, '4回のスワイプで4ページ');
});

test('ごく僅かな横ずれでは捲れない（元に戻る）', async () => {
  await loadPages(30);
  let t = 4000;
  pointer('pointerdown', 100, 300, t);
  // 12px をゆっくり（勢いも距離も足りない）
  for (let i = 1; i <= 3; i++) { t += 90; pointer('pointermove', 100 + i * 4, 300, t); }
  t += 250; // 止めてから離す
  pointer('pointerup', 112, 300, t);
  await settle();
  assert.equal(idx(), 0);
});

test('先頭・末尾を越えない', async () => {
  const total = await loadPages(12);
  const w = win.__T.slideWidth();
  let t = 6000;
  for (let n = 0; n < total + 5; n++) {
    pointer('pointerdown', 0, 300, t);
    for (let i = 1; i <= 4; i++) { t += 12; pointer('pointermove', w * 0.06 * i, 300, t); }
    t += 12;
    pointer('pointerup', w * 0.24, 300, t);
    t += 30;
  }
  await settle();
  assert.equal(idx(), total - 1, '末尾で止まる');

  for (let n = 0; n < total + 5; n++) {
    pointer('pointerdown', 900, 300, t);
    for (let i = 1; i <= 4; i++) { t += 12; pointer('pointermove', 900 - w * 0.06 * i, 300, t); }
    t += 12;
    pointer('pointerup', 900 - w * 0.24, 300, t);
    t += 30;
  }
  await settle();
  assert.equal(idx(), 0, '先頭で止まる');
});

test('縦ドラッグではページが動かない', async () => {
  await loadPages(20);
  let t = 9000;
  pointer('pointerdown', 300, 100, t);
  for (let i = 1; i <= 20; i++) { t += 16; pointer('pointermove', 305, 100 + i * 30, t); }
  assert.equal(idx(), 0);
  pointer('pointerup', 305, 700, t + 16);
});

test('トラックパッド: 慣性込みの1スワイプで1ページだけ', async () => {
  await loadPages(40);
  const before = idx();
  const peak = trackpadPush(-1);
  trackpadMomentum(-1, peak, 60);
  await settle();
  assert.equal(idx(), before + 1, `慣性で行き過ぎない (idx=${idx()})`);
});

test('トラックパッド: 慣性に重なった同方向の連打は1ページ（行き過ぎ厳禁）', async () => {
  await loadPages(60);
  const before = idx();
  // 慣性が途切れないまま次のスワイプが重なるケース。
  // 指の動きか慣性かは区別できないので、まとめて1スワイプ扱いにする。
  for (let n = 0; n < 4; n++) {
    const peak = trackpadPush(-1, 50);
    trackpadMomentum(-1, peak, 12);
  }
  await settle();
  assert.equal(idx(), before + 1, `行き過ぎない (idx=${idx()})`);
});

test('トラックパッド: 間を空けて振り直せば連続で捲れる', async () => {
  await loadPages(60);
  const before = idx();
  for (let n = 0; n < 5; n++) {
    const peak = trackpadPush(-1, 50);
    trackpadMomentum(-1, peak, 10);
    clock += 90; // 指を離して置き直す間
  }
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(idx(), before + 5, `5回振れば5ページ (idx=${idx()})`);
});

test('トラックパッド: 慣性が尽きたあとに動かせば次のスワイプになる', async () => {
  await loadPages(60);
  const before = idx();
  const peak = trackpadPush(-1, 50);
  trackpadMomentum(-1, peak, 60); // 最後はほぼ 0 まで減衰する
  const peak2 = trackpadPush(-1, 50);
  trackpadMomentum(-1, peak2, 10);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(idx(), before + 2, `止まったあとは別スワイプ (idx=${idx()})`);
});

test('トラックパッド: 間隔が詰まった連打も予約して必ず送る', async () => {
  await loadPages(80);
  const before = idx();
  for (let n = 0; n < 3; n++) {
    for (const v of [5, 14, 28, 44, 52]) { wheel(-v, 0, clock); clock += 16; }
    trackpadMomentum(-1, 52, 3);
    clock += 70; // 指を置き直す
  }
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(idx(), before + 3, `詰まっても3ページ (idx=${idx()})`);
});

test('トラックパッド: 1回のスクロール（多少ぶれても）は1ページ', async () => {
  await loadPages(60);
  const before = idx();
  const seq = [4, 12, 24, 30, 34, 32, 35, 31, 33, 28, 30, 26, 22, 24, 19, 15, 16, 12, 10, 11, 8, 6];
  for (const v of seq) { wheel(-v, 0, clock); clock += 16; }
  trackpadMomentum(-1, 6, 40);
  await settle();
  assert.equal(idx(), before + 1, `ぶれても1ページ (idx=${idx()})`);
});

test('トラックパッド: 指を置いたまま押し直しても1ページ（止まっていなければ同じスワイプ）', async () => {
  await loadPages(60);
  const before = idx();
  const seq = [4, 12, 24, 18, 12, 9, 7, 5, 4, 22, 30, 34];
  for (const v of seq) { wheel(-v, 0, clock); clock += 16; }
  trackpadMomentum(-1, 30, 40);
  await settle();
  assert.equal(idx(), before + 1, `速度が戻っただけでは増やさない (idx=${idx()})`);
});

test('トラックパッド: 速度がゆらぐ長いスワイプでも1ページだけ', async () => {
  await loadPages(60);
  const before = idx();
  // 指を置いたまま強弱をつけて長く払う（実機の deltaX は一定にならない）
  const seq = [3, 9, 18, 26, 22, 30, 27, 33, 25, 19, 24, 20, 14, 17, 11, 8, 9, 5, 4, 3];
  for (const v of seq) { wheel(-v, 0, clock); clock += 16; }
  trackpadMomentum(-1, 3, 30);
  await settle();
  assert.equal(idx(), before + 1, `ゆらいでも1ページ (idx=${idx()})`);
});

test('トラックパッド: ゆっくり小さく回しても1ページ送れる', async () => {
  await loadPages(40);
  const before = idx();
  // 弱いスクロールをだらだら（慣性ほぼ無し）
  for (let i = 0; i < 25; i++) { wheel(-6, 0, clock); clock += 24; }
  await settle();
  assert.equal(idx(), before + 1, `だらだら回しても1ページ (idx=${idx()})`);
});

test('トラックパッド: 逆向きに振ったら慣性に食われず戻る', async () => {
  await loadPages(40);
  win.__T.state.pageIndex = 10;
  win.__T.renderCurrent();
  let peak = trackpadPush(-1);
  trackpadMomentum(-1, peak, 6);
  // 慣性が残っているうちに（間を空けずに）逆向きへ
  peak = trackpadPush(1);
  trackpadMomentum(1, peak, 6);
  await settle();
  assert.equal(idx(), 10, '＋1して−1で元の位置に戻る');
});

test('縦ホイールでもページが送れる', async () => {
  await loadPages(20);
  const before = idx();
  wheel(0, 200);
  assert.equal(idx(), before + 1, '1イベントで1ページ');
});

test('タッチ: シュパパパと短く速いフリックを連発しても全部効く', async () => {
  await loadPages(40);
  const before = idx();
  let t = 20000;
  for (let n = 0; n < 5; n++) {
    pointer('pointerdown', 200, 300, t);
    // 30px を 3 サンプル・36ms で払う（距離は閾値未満、勢いで確定させる）
    for (let i = 1; i <= 3; i++) { t += 12; pointer('pointermove', 200 + i * 10, 300, t); }
    pointer('pointerup', 230, 300, t);
    t += 40; // 次のフリックまで 40ms（着地アニメの完了を待たない）
  }
  await settle();
  assert.equal(idx(), before + 5, `5フリックで5ページ (idx=${idx()})`);
});

test('指が重なっても（前の指の up 前に次が触れても）両方拾う', async () => {
  await loadPages(40);
  const before = idx();
  const w = win.__T.slideWidth();
  let t = 30000;
  // 1本目: up が来ないまま次の指が触れる
  pointer('pointerdown', 200, 300, t, 11);
  for (let i = 1; i <= 4; i++) { t += 12; pointer('pointermove', 200 + w * 0.06 * i, 300, t, 11); }
  t += 20;
  // 2本目
  pointer('pointerdown', 200, 300, t, 22);
  for (let i = 1; i <= 4; i++) { t += 12; pointer('pointermove', 200 + w * 0.06 * i, 300, t, 22); }
  pointer('pointerup', 200 + w * 0.24, 300, t, 22);
  // 1本目の up が遅れて届く（もう効いてはいけない）
  t += 5;
  pointer('pointerup', 200 + w * 0.24, 300, t, 11);
  await settle();
  assert.equal(idx(), before + 2, `重なった2本ぶん捲れる (idx=${idx()})`);
});

test('lostpointercapture が飛んできてもジェスチャーを壊さない', async () => {
  await loadPages(40);
  const before = idx();
  const w = win.__T.slideWidth();
  let t = 35000;
  pointer('pointerdown', 200, 300, t, 33);
  // 直前の指の capture 解放通知が遅れて届く（iOS で起きる）
  wrap.dispatchEvent(new win.PointerEvent('lostpointercapture', {
    bubbles: true, pointerId: 32, pointerType: 'touch',
  }));
  for (let i = 1; i <= 4; i++) { t += 12; pointer('pointermove', 200 + w * 0.06 * i, 300, t, 33); }
  pointer('pointerup', 200 + w * 0.24, 300, t, 33);
  await settle();
  assert.equal(idx(), before + 1, '巻き添えで消えない');
});

test('タッチ: 指を離した瞬間に確定する（小さく払っても効く）', async () => {
  await loadPages(40);
  const before = idx();
  let t = 40000;
  pointer('pointerdown', 200, 300, t);
  for (let i = 1; i <= 3; i++) { t += 14; pointer('pointermove', 200 + i * 9, 300, t); }
  pointer('pointerup', 227, 300, t);
  await settle();
  assert.equal(idx(), before + 1, '27px の払いでも1ページ送る');
});

test('ページ番号入力は4桁でも欠けない', async () => {
  await loadPages(700);
  const jump = win.document.getElementById('jumpInput');
  const total = Number(win.document.getElementById('totalPages').textContent);
  assert.ok(total >= 1234, `4桁のページ数になっている (${total})`);
  win.__T.state.pageIndex = 1233;
  win.__T.renderCurrent();
  assert.equal(jump.value, '1234', '4桁がそのまま入る');
  assert.equal(jump.max, String(total));
  // スピナーで幅を食わないこと・4桁ぶんの幅が指定されていること
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#jumpInput::-webkit-inner-spin-button/);
  assert.match(css, /#controls #jumpInput \{[^}]*width: 4ch/);
});
