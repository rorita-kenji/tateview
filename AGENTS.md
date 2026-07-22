# AGENTS.md — 縦view（TateView）実装指示書 v3（実装確定）／v1.0

このファイルは、本プロジェクトを実装/保守するAIエージェント（ローカルLLM含む）向けの作業指示書である。
迷ったら本書のルールを最優先で従うこと。仕様の背景は `縦書きビュアー仕様_v4.md`（内容はv6 FIX）、全体設計は `縦書きビュアー実装プラン.md` を参照。

> **本プロジェクトは実装済み（FIX）。最終の確定事項は末尾「## 実装確定メモ（v3 / FIX → v1.0）」を参照し、以前の記述と差異がある場合はそちらを優先すること。**
> プロダクト名：**縦view**、バージョン：**v1.0**、配布ファイル：**dist/TateView.html**。

> v2での主な変更（監査反映）
> - 内部オフセットを **UTF-16 コードユニット基準**へ統一（旧：コードポイント基準）
> - ルビを **複合トークン（分割不能）** として表現
> - tokenizer を **ストリーミング（generator）** 化し、全Token配列を保持しない
> - ページ分割の **境界条件・半開区間・不変条件** を明文化
> - `showRuby` を `PaginateConfig` から除外（ルビ表示切替で再分割しない）
> - 位置保存キーをファイル名基準に変更
> - Worker通信に **documentId / requestId（世代管理）** を追加
> - ワーニングの **重複整理・重要度・範囲集約・見出し除外** を追加
> - 半角ランに `text-orientation: sideways` を明示
> - `build.js` を **main/worker の2バンドル**明示ビルドに変更
> - AIチェックのAPIキー入力欄は**今回スコープから除外**
> - 追加テストケースを拡充

---

## 0. 絶対に守る制約（Non-negotiable）

1. **外部ライブラリ・フレームワーク禁止。** 素の HTML / CSS / JavaScript(ES Modules) のみ。npm依存を追加しない。
2. **最終成果物は単一HTMLファイル** `dist/TateView.html`（CSS・JS・Workerを全てインライン化）。開発は `src/` の複数ファイルで行い、`build.js`（Node標準モジュールのみ）で結合する。
3. **ページ分割はDOM計測に依存してはならない。** ページ境界は「文字数モデル」だけで決定的に計算する。同じ原稿＋同じ設定なら、どの端末・どのウィンドウ幅でも必ず同じ境界になること。
4. **重い処理はすべて Web Worker 側**（文字コード判定・正規化・トークナイズ・ページ分割・ワーニング検出・検索）。メインスレッドは描画とUIのみ。
5. **オフセットは常に「正規化済みテキスト（改行LF化後）」上の UTF-16 コードユニット位置**で扱う（詳細は §3.0）。現在位置・検索・ワーニングすべてこの基準。
6. 各フェーズ完了時に、後述の受け入れ基準を満たす自動テスト（`tests/`）を通すこと。テストが通らない機能を「完了」と報告しない。

---

## 1. ディレクトリ構成

```
/src
  index.html          # 骨組み（UIのプレースホルダ）
  styles.css          # スタイル（縦書き含む）
  main.js             # メインスレッド エントリ（ES Module）
  worker.js           # Worker エントリ
  modules/
    encoding.js       # 文字コード判定・デコード
    normalize.js      # 改行正規化
    tokenizer.js      # トークナイズ・ルビ解析（ストリーミング）
    paginator.js      # ページ分割（禁則・ぶら下げ）
    warnings.js       # ワーニング検出（字下げ・約物・括弧・伸ばし棒・単独ニ 等）
    search.js         # 全文・見出し検索
  ui/
    renderer.js       # 縦書きDOM生成（表示ページのみ）
    navigator.js      # ナビゲーション操作
    position.js       # 現在位置保持・復帰
    settings.js       # LocalStorage 保存・復元
    filewatch.js      # File System Access API 監視
/tests
  fixtures/           # サンプル原稿(.txt) と期待値(.json)
  *.test.mjs          # node --test で実行できるテスト
build.js              # src を dist/TateView.html に結合（main/workerの2バンドル）
dist/
  TateView.html       # 最終成果物
```

`modules/` の各ファイルは **副作用のない純粋関数**として書き、Worker外（Node）からも import してテストできるようにする。DOMやWorker APIをこれらの中で直接触らないこと。

---

## 2. コーディング規約

- **オフセット・スライスは UTF-16 コードユニット基準**（`str.slice`, `str.indexOf`, 正規表現 `match.index`, DOM の文字オフセットと同じ単位）。長さは `str.length` を使ってよい。
- ただし **文字の走査は `for...of`（コードポイント単位）で行い、サロゲートペアを分割位置にしない**。位置は `char.length`（BMP=1, サロゲートペア=2）で加算する（§3.0のサンプル）。
- 「ソースオフセット（UTF-16）」「占有マス数（組版）」「文字数（表示用カウント）」は**別概念として分離**する。混同しない。
- 全ての公開関数にJSDocで引数・戻り値の型を書く。
- 変数・関数名は英語、コメントは日本語で可。
- `console.log` はデバッグ後に残さない。エラーはユーザー向けメッセージとしてUIに出す。
- マジックナンバー禁止。定数は `const` でファイル冒頭にまとめる。

---

## 3. データモデル（型契約）

### 3.0 オフセットの定義（重要）

内部オフセットは **正規化済みJavaScript文字列上の UTF-16 コードユニット位置**とする。走査は次の形で行い、サロゲートペアを割らない。

```js
let offset = 0;                 // UTF-16 コードユニット位置
for (const ch of text) {        // ch はコードポイント（絵文字も1単位）
  const sourceStart = offset;
  offset += ch.length;          // BMP=1, サロゲートペア=2
  const sourceEnd = offset;     // 半開区間 [sourceStart, sourceEnd)
  // ...
}
```

範囲はすべて **半開区間 `[start, end)`** で統一する。`text.slice(start, end)` でその範囲が復元できることを不変条件とする。

**絵文字・異体字セレクタ(VS)・結合文字の扱い**：本ビューアは1コードポイント＝1マス（全角相当）として扱い、VS・結合文字は直前の基底文字に付随してまとめて1マスにする（`for...of`では別コードポイントになるため、基底＋結合列を1トークンに束ねる簡易処理を入れる）。厳密な書記素クラスタ対応は将来課題とし、最低限「割れて表示崩壊しない」ことをテストで担保する。

### 3.1 型

```js
/** @typedef {{
 *   type: 'full' | 'half' | 'ruby' | 'newline',
 *   sourceStart: number,  // 正規化テキスト上 UTF-16 開始位置
 *   sourceEnd: number,    // 半開区間の終端（記法記号 ｜《》 も含めて消費）
 *   mass: number,         // 占有マス数: full=1, newline=0, half=ceil(halfCount*0.5), ruby=親文字マス数
 *   text: string,         // 表示テキスト（full=1字, half=半角ラン, newline='', ruby=親文字）
 *   ruby?: string         // type==='ruby' のときルビ文字列。マスには影響しない
 * }} Token */

/** @typedef {{ start:number, end:number }} Range   // 半開区間 [start,end) UTF-16 */

/** @typedef {{
 *   index:number, range:Range, columns: Range[]
 * }} Page */

/** @typedef {{
 *   charsPerColumn:number,   // 1列の文字数（字）＝列容量マス
 *   columnsPerPage:number,   // 1ページの列数（行）
 *   kinsoku:boolean,
 *   burasage:boolean,        // kinsoku=true のときのみ有効
 *   kinsokuHead:Set<string>, // 行頭禁則文字
 *   kinsokuTail:Set<string>  // 行末禁則文字
 * }} PaginateConfig */
```

> **注意：`showRuby` は `PaginateConfig` に含めない。** ルビの表示ON/OFFはページ境界に影響しない（§4.4・仕様5.3）。`showRuby` は renderer と warnings の設定にのみ渡す。

`Page.columns` は **オフセット範囲のみ**を持つ。描画時に renderer が範囲を再トークナイズして表示する。ruby・半角ランは分割不能トークンなので、列境界で文字が割れることはない。

---

## 4. 各モジュール実装仕様

### 4.1 encoding.js

```js
/** @param {Uint8Array} bytes
 *  @returns {{ encoding:'utf-8'|'shift_jis'|'unknown', text:string }} */
export function detectAndDecode(bytes) { ... }
```

手順：
1. 先頭3バイトが `EF BB BF` なら UTF-8(BOM)。BOMを除いて `TextDecoder('utf-8')` でデコードして返す。
2. BOM無しはまず `new TextDecoder('utf-8', { fatal:true })` でデコードを試す。成功すれば UTF-8。
3. 例外が出たら `TextDecoder('shift_jis')` でデコードし shift_jis とする。
4. shift_jis デコード結果に U+FFFD（置換文字）が多数（全体の1%超）含まれる場合は `unknown` を返し、UI側で手動選択させる。

### 4.2 normalize.js

```js
/** @param {string} text @returns {string} */
export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
```

### 4.3 tokenizer.js（ストリーミング）

**全Token配列を保持しない。** generator（または callback）でトークンを1件ずつ yield し、paginator/warnings がそれを消費する。設定変更時はテキストを再走査する（Worker内なので許容）。

```js
/** @param {string} text  正規化済みテキスト
 *  @returns {Generator<Token>} */
export function* tokenize(text) { ... }
```

規則（`for...of` によるコードポイント走査、位置は §3.0）：

- **改行 `\n`** → `{type:'newline', mass:0, text:''}`。
- **半角文字ラン**：ASCII(U+0021–U+007E)・半角スペース(U+0020)・半角カナ(U+FF61–U+FF9F)が連続する範囲を1トークンに集約。`mass = Math.ceil(halfCount * 0.5)`、`type:'half'`、`text=そのラン`。
- **ルビ（複合トークン）**：
  - `｜`(U+FF5C) が来たら、直後から `《`(U+300A) までを親文字、`《`〜`》`(U+300B) をルビとする。
  - `《` が `｜`無しで来た場合、直前の連続する漢字（U+4E00–U+9FFF, U+3005 々 等）を親文字とする。親文字が特定できなければ**ルビ構文エラー**（warningsで検出）とし、`《…》`は通常のfullトークン列として出力。
  - 生成トークン：`{type:'ruby', baseText, rubyText, mass: 親文字のマス数(=親文字コードポイント数), text: baseText, ruby: rubyText}`。`sourceStart/End` は記法記号 `｜《》` を**含めて**消費する（オフセット整合）。
  - **ルビは分割不能トークン**。ページ分割で列またぎさせない。マスには一切影響させない（親文字より長くても字送り不変）。
- **上記以外の1文字** → `{type:'full', mass:1, text:char}`。全角スペース(U+3000)もfull(1マス)。VS・結合文字は直前トークンに束ねる（§3.0）。

### 4.4 paginator.js（最重要）

```js
/** @param {Generator<Token>|Token[]} tokens @param {PaginateConfig} cfg
 *  @returns {Page[]} */
export function paginate(tokens, cfg) { ... }
```

基本は「列容量 `charsPerColumn` マスを満たしたら改列、`columnsPerPage` 列で改ページ」。範囲は半開区間で記録する。

**境界条件（すべて定義済みとして実装する）：**

| ケース | 挙動 |
|--------|------|
| 空ファイル | 1ページ・0列 or 空列1つ。`range=[0,0)`。クラッシュしない |
| 先頭が改行 | 先頭に空列を作る（強制改列） |
| 連続改行 | 改行ごとに空列を生成（空列を許容） |
| 末尾の改行 | 末尾に空列を作らない（改行で列を閉じ、以降トークンが無ければ終了） |
| ページ境界上の改行 | 改行で列を閉じ、`columnsPerPage`到達なら改ページ |
| 1列より長い半角ラン | **分割不能のためフォールバック**：単独で1列を占有し、列容量を超えるオーバーフローを許容（rendererは列内で縮小/はみ出し表示）。空列を無限生成しない |
| ルビ親文字が1列より長い | 同上。単独列でオーバーフロー許容。異常として `ruby-too-long` の info ワーニングを出す |
| 禁則位置が見つからない | 禁則を諦め、列容量ちょうどで機械改列（デッドロック回避） |

**改行トークンのオフセット所有先（穴を作らないための規則）：**
改行を読んだら、**改行の `sourceEnd` までを現在列の範囲に含めて**列を閉じ、次列の `start` は `newline.sourceEnd` から始める。こうすると列範囲に隙間ができず、位置復帰・二分探索が安定する。改行文字自体は renderer で描画せず、強制改列の意味だけ使う。連続改行はそれぞれ空列（`[n.end, n.end)` を挟む列）を生成する。

```
改行 n を読んだら:
  col.range.end = n.sourceEnd   // 改行を現在列に含める
  列を確定
  nextCol.range.start = n.sourceEnd
```

**禁則処理（ON時）は「最後の有効境界」を探す方式：**
列容量付近の候補境界について、「直前トークンが行末禁則(`kinsokuTail`)でない」かつ「次トークンが行頭禁則(`kinsokuHead`)でない」を満たす最後の位置で改列する。候補が尽きたら機械改列（上表）。この方式は禁則文字の連続にも耐える。

**ぶら下げ（ON、kinsoku=true時のみ）：** 列末で `、。` が行頭禁則に触れる場合、その `、。` を列容量を超えて**はみ出して置く**（次列に送らない）。ぶら下げた事実を renderer に伝えるため、該当列の範囲にはぶら下げ文字を含め、rendererは列容量超過分を列外へ描画する。

**不変条件（テストで必ず検証）：**
```
- ページ範囲・列範囲は単調増加
- 範囲に隙間も重複も無い（前のend == 次のstart）
- 最終ページの range.end === text.length
- 通常列は容量を超えない（超過はぶら下げ or 明示例外のみ）
- 同一入力＋同一設定 → 常に同一結果（決定性）
```

**禁則の既定文字セット**（`kinsokuHead`/`kinsokuTail`、UIで編集可）：
```
行頭禁則（列頭に置けない）:
  、。，．・：；？！ー）」』】〕》〉｝
  小書き: ぁぃぅぇぉっゃゅょゎ ァィゥェォッャュョヮ ゝゞヽヾ々
行末禁則（列末に置けない）:
  （「『【〔《〈｛
```

### 4.5 warnings.js

```js
/** @param {string} text @param {{showRuby:boolean, headingPrefixes:string[], enabled:Set<string>}} opt
 *  @returns {{ code, label, severity:'error'|'warning'|'info', range:Range }[]} */
export function detectWarnings(text, opt) { ... }
```

**整理方針（監査反映）：**
- 半角文字(`halfwidth`)は1文字ずつでなく**連続ラン単位で1件**にまとめる。
- **見出しプレフィックス**（行頭 `# ` / `## `）は半角警告・半角スペース警告の対象から除外する。
- **ルビ内**の半角英数字は半角警告の対象外。
- `single-leader`/`single-dash` は `odd-leader-dash` と重複するため、**「奇数」判定に一本化**（孤立1個も奇数として拾う）。単体専用コードは出さない。
- 各項目に **severity** を持たせる。`ruby-off` は原稿の誤りでなく表示設定の通知なので `info`。
- 各項目は **ON/OFF 可能**（`opt.enabled`）。
- 一覧の保持には**上限**（例：各code 1000件）を設け、総件数は別途表示。

検出ルール（位置は範囲 `[start,end)`）：

| code | severity | ルール |
|------|----------|--------|
| indent-missing | warning | 地の文の段落先頭（改行直後・空行でなく `「『（`始まりでなく見出しでない）が `　`(U+3000)で始まらない |
| dialog-indent | warning | 会話行が `　「`（全角スペース＋開き括弧）で始まる |
| period-before-bracket | warning | `/。[」』]/` |
| no-space-after-bang | warning | `/[！？](?![！？」』）】〉\n　])/` |
| odd-leader-dash | warning | `……`(U+2026連続)・`――`(U+2015連続) の連続数が奇数（孤立1個も含む） |
| halfwidth | info | 半角ラン（見出しプレフィックス・ルビ内を除く）を**ラン単位**で1件 |
| halfwidth-space | info | 半角スペース U+0020（見出しプレフィックス・ルビ内を除く） |
| fullwidth-alpha | info | 全角英字 `Ａ-Ｚａ-ｚ` 連続ラン（ルビ内・見出しプレフィックス除外） |
| fullwidth-digit | info | 全角数字 `０-９` 連続ラン（同上） |
| emoji | info | 絵文字（ZWJ・国旗・キーキャップ。隣接連続1ラン。同上除外） |
| ruby-off | info | `showRuby===false` のとき各ルビ記法 |
| tab | warning | `/\t/` |
| trailing-space | warning | `/[ 　]+$/m` |
| fullspace-only-line | warning | `/^　+$/m` |
| consecutive-blank | info | 空行3行以上連続 `/\n[ \t　]*\n[ \t　]*\n/` |
| ruby-syntax-error | error | `《`に対応する`》`が無い／`《》`が空／`｜`後に`《…》`が続かない／親文字特定不可 |

### 4.6 search.js

```js
/** @param {string} text @param {string} query @param {{headingOnly:boolean}} opt
 *  @returns {Range[]} */
export function searchAll(text, query, opt) { ... }
```

単純な全一致（大小文字は区別。将来正規表現）。`headingOnly` の場合は `#`/`##` 行のみを対象。件数・前後移動はUI側でインデックス管理。大量ヒット時は上限＋総件数表示。

---

## 5. Worker 通信契約（世代管理つき）

すべてのメッセージに `documentId`（原稿を開くたびに採番）と `requestId`（リクエストごとに単調増加）を付ける。**main側は最新の documentId かつ最新の requestId 以外の結果を破棄する。** これで設定連続変更やファイル切替時に古い結果が画面を上書きしない。

```
main → worker:
  { documentId, requestId, type:'load', bytes:ArrayBuffer, forcedEncoding? }
  { documentId, requestId, type:'paginate', config:PaginateConfig }
  { documentId, requestId, type:'detectWarnings', showRuby, enabled }
  { documentId, requestId, type:'search', query, headingOnly }
  { type:'cancel', documentId }              // 進行中処理の打ち切り要求

worker → main:
  { documentId, requestId, type:'loaded', encoding, text, charCount }
  { documentId, requestId, type:'needEncoding' }
  { documentId, requestId, type:'progress', phase, ratio }
  { documentId, requestId, type:'paginated', pages:Page[] }
  { documentId, requestId, type:'warnings', items:[...], total }
  { documentId, requestId, type:'searchResult', matches:[...], total }
  { documentId, requestId, type:'error', message }
```

大容量対策：`load`/`paginate` はチャンク（5000文字目安）でループし、途中 `progress` を送る。ループ内で**キャンセルフラグ**（`cancel` 受信 or documentId 変更）を確認し、早期打ち切りする。UIは初回分割中プログレスバーを表示する。

---

## 6. 描画（renderer.js）

- ルート要素に CSS `writing-mode: vertical-rl;` を適用。
- **表示中のページ（と前後1ページ程度のプリフェッチ）だけ**DOM生成。ページ切替で古いDOMは破棄。
- 半角ランは横倒しを確実にするため **`text-orientation: sideways`** を明示（既定の `mixed` は文字ごとの判定になり半角カナ等で挙動が揺れるため）。縦中横はしない（`text-combine-upright` を使わない）。半角色表示ONは `<span class="half">` で色付け。
  ```css
  .half { text-orientation: sideways; }
  ```
- ルビは `<ruby>親文字<rt>ルビ</rt></ruby>`。`showRuby===false` のときは **ルビ記法（`｜《》`）を含む元テキストをそのまま**プレーンな span で表示する（親文字のみにしない）。
- 見出し（`#`/`##`で始まる行）は**組版を変えず**、その行の文字に色＋太字クラスを付けるのみ。`#` 記号もそのまま表示。
- **テキスト選択・コピー**：`user-select: text`。装飾はインライン要素で選択が途切れない構造に。**通常コピーは親文字のみ**（ルビ・ルビ記法を含めない）。
  - ブラウザ任せにせず、`copy` イベントを捕捉して `clipboardData` を上書きし、選択範囲を親文字だけに正規化する（`<rt>` の内容を除去する）。`event.preventDefault()` の上で `setData('text/plain', 親文字のみの文字列)` を行う。
  - Chrome / Firefox / Safari の3ブラウザでコピー結果にルビ文字列が混入しないことをテストする。
  - 将来「原文（ルビ記法込み）をコピー」を別操作として追加する。
- ぶら下げ文字は列容量超過分を列外へはみ出して描画（paginatorが該当列範囲に含めている）。
- ウィンドウリサイズ時：ページ内容・境界は変えず、フォントサイズ／行間／セルサイズのみ再計算。

---

## 7. 現在位置保持（position.js）

保存レコード（LocalStorage、キーは §8）：
```js
{ previousLength:number, offset:number, before:string, after:string, updatedAt:number }
```
`before`/`after` は offset 前後それぞれ20文字（UTF-16）。

復帰アルゴリズム：
1. 保存 offset の周辺 ±2000文字で候補を探索。**`before` と `after` の両方一致**を最優先、次に `after` のみ、次に `before` のみ。
2. 各候補を「文脈一致度＋元offsetとの距離」でスコアリングし最良を採用。
3. 見つからなければ offset を `min(offset, text.length)` にクランプ。
4. 求めた offset を含むページを `pages` から二分探索して表示。

### 8. 設定・位置の保存キー（settings.js）

**位置キーはファイル名基準の安定キー**にする（文字数変化で迷子にならないよう、監査反映）：
```
tategaki-position:<fileName>
```
同名衝突はMVPでは許容。将来 File System Access API 環境ではファイルハンドルを IndexedDB に保持する方式を検討。

**設定**（原稿共通、別キー `tategaki-settings`）：ページ形式、テーマ、フォント種別、フォントサイズ／fontSizeAuto、禁則設定、ぶら下げ設定、ルビ表示、半角色、空白ハイライト、升目。起動時に復元、無ければ既定値（プリセット「40字×16行」、ライト、明朝、字級auto、禁則ON、ぶら下げON、ルビON、半角色ON、空白OFF、升目OFF）。

---

## 9. ビルド（build.js）— 2バンドル明示方式

汎用バンドラは自作しない。**main用とworker用の2つの依存グラフを明示的に列挙**して結合する。

```
main bundle  : main.js + ui/* + main が使う共有関数
worker bundle: worker.js + modules/*
```

変換方針：
- 各モジュールの `import`/`export` を除去し、依存順に連結して1つのIIFE（即時関数）へ包み、名前衝突を避ける（各バンドルを独立スコープに）。
- worker bundle は文字列化し、`new Blob([...], {type:'text/javascript'})` + `URL.createObjectURL` で Worker を生成する形へ変換して main bundle 内に埋め込む。
- 最終 `dist/TateView.html` に `<link>`/外部 `<script src>` を残さない（GA は https 時のみ JS で動的挿入）。

**ビルドテスト（tests/ に追加）：**
```
- dist/TateView.html に外部 script/link が無い（GA 動的挿入を除く）
- 相対 import / export 文が残っていない
- 生成した Worker が起動し ping→pong を返す
- file:// で最小原稿を読み込んで1ページ表示できる
```

---

## 10. テストと受け入れ基準

`node --test tests/` で全テストが緑になること。

- **encoding**：UTF-8(BOM有/無)・Shift_JIS を文字化けなくデコード。判定不能で `unknown`。
- **normalize**：CRLF/CR/LF混在→LF単一。
- **tokenizer**：
  - 半角ラン `mass=ceil(n*0.5)`。
  - ルビ2記法の `baseText`/`rubyText` 抽出、`sourceStart/End` 整合（`text.slice`で記法込み復元）。
  - `A😀B` の offset と slice 復元（サロゲートペア）。
  - 異体字セレクタ・結合文字が割れない。
- **paginator（最重要）**：
  - 禁則OFF・「20字×20行」で既知原稿のページ境界が固定期待値と完全一致。
  - 同一入力を2回paginateして同一（決定性）。
  - 半開区間の不変条件（隙間/重複なし・単調増加・最終end===length）。
  - 禁則ONで行頭に `。、）」`、行末に `（「` が来ない。行頭/行末禁則文字が**連続**しても破綻しない。
  - ぶら下げONで `。、` が列末をはみ出す（次列先頭に来ない）。
  - ルビ有無・長いルビでマス数（＝境界）が変わらない。
  - 列末直前のルビ。
  - **列幅より長い半角ラン**でフォールバック（空列を無限生成しない）。
  - ルビ親文字が列より長いケース。
  - 先頭改行・連続改行・末尾改行・空ファイル。
  - ページ境界上の改行。
  - ランダム入力による不変条件テスト（プロパティテスト）。
- **warnings**：各codeに「検出される例／されない例」の対。`# 見出し` が不要な半角警告を出さない。ルビ内半角が警告されない。単体`…`が`odd`で拾える。
- **position**：数十文字編集後も before/after 一致で近傍復帰。文字数変化後も同一キーで発見。
- **worker世代**：再分割中に別設定へ変更→古い結果を破棄。documentId変更で旧結果無視。
- **build**：§9のビルドテスト。
- **性能**：100万字（日本語のみ／ASCIIのみ）で初回分割時間・ページ送り・検索・大量警告候補を計測。

各フェーズ（プラン書のフェーズ順）ごとに該当テストを追加・通過させてからコミットすること。

---

## 11. 作業の進め方（エージェント向け手順）

監査提案の実装順を採用する。

1. **仕様修正の反映**：オフセット(UTF-16)・ルビ複合トークン・ページ範囲(半開区間)・境界条件を本書どおり実装対象として確認。
2. `modules/` の純粋関数をテスト先行で実装：encoding→normalize→tokenizer(generator)→paginator。
3. **縦書き表示スパイク**：20〜30文字だけの最小縦書き表示を作り、半角英数・半角カナ・ルビ・選択コピーを Chrome/Edge/Firefox/Safari で実機確認（`text-orientation: sideways`、コピー結果が親文字のみ）。
4. `worker.js` で結線＋通信契約＋世代管理（documentId/requestId/cancel）を実装。
5. 本UI・設定・位置復帰。
6. ワーニング・検索。
7. ファイル自動更新（§12）・サムネイル・仕上げ。
8. `build.js`（2バンドル）で単一HTML化し、対応ブラウザで手動確認。

不明点は憶測で仕様を変えず `縦書きビュアー仕様_v5.md` に従う。仕様に無い判断が必要なら `// TODO(spec):` を残す。

---

## 12. ファイル自動更新（filewatch.js）

**対応環境（File System Access API：Chrome/Edge）：**
- `showOpenFilePicker()` で `FileSystemFileHandle` を保持。
- 一定間隔 or `visibilitychange` 時に `handle.getFile()` を呼び、`lastModified`/`size` の変化で再読み込み。現在位置は保持。
- ファイルピッカーは安全なコンテキスト＋ユーザー操作が必要。

**非対応環境（Safari/Firefox 等）：**
- `<input type="file">` で読み込み、「更新」ボタンで再選択（手動）。

`file://`（HTMLダブルクリック）での挙動はブラウザ差が大きいため、**最小プロトタイプ段階で確認**し、常に `<input type="file">` フォールバックを残す。README/仕様の「自動更新検知」は実機確認が済むまで「対応環境では更新確認」と控えめに書く。

## 13. スコープ外（今回作らない）

- **AIチェックのAPIキー入力欄は今回スコープから外す。** 機能未実装でUIだけあると完成機能に見え、キーをLocalStorageへ保存すると安全上の問題も生じるため。AI機能を設計する際に、通信方法・キー管理を含めて追加する。

---

## 実装確定メモ（v3 / FIX → v1.0）

実装済みの最終仕様。以前の記述と差異がある箇所は本節を優先する。
プロダクト名：**縦view**、バージョン **v1.0**、配布：**dist/TateView.html**。

### 実際のディレクトリ構成
```
/src
  index.html, styles.css, main.js, worker.js
  modules/  normalize.js encoding.js kinsoku.js tokenizer.js paginator.js heading.js warnings.js search.js position.js
  ui/       renderer.js settings.js   (navigator/filewatch/uiはmain.jsに集約)
/tests      engine.test.mjs（node --test）
build.js    → dist/TateView.html を生成（main/worker 2バンドル、外部参照なしを検証。GAは https 時のみ動的読込）
/sample     sample_utf8.txt / sample_sjis.txt
```
- 配布物は **dist/TateView.html**（単一HTML・ランタイム依存ゼロ）。ビルド：`node build.js`。テスト：`node --test`。
- リポジトリ: https://github.com/rorita-kenji/tateview

### 体裁プリセット（settings.js）
UI プルダウン表示は「N字 × M行」のみ（ページ総字数は出さない）。

| 表示名 | 字×行（既定） |
|--------|--------------|
| 20字 × 20行 | 20×20 |
| 40字 × 16行 | 40×16（既定） |
| 40字 × 32行 | 40×32 |
| 40字 × 34行 | 40×34 |
| 42字 × 34行 | 42×34 |

### レンダリング（renderer.js / main.js）確定事項
- **空行（中身のない列）も通常幅の空白列として表示**する。CSS `.col::after { content: "\200B"; }` で行ボックスを生成し列幅（＝行の太さ）を確保する。
- **字級 auto（fontSizeAuto）**：ウィンドウに収まる最大字級を実測プローブから算出し追随。手動で最大未満を選ぶと固定、最大を選ぶと auto に戻る。上限 120px。はみ出し時は従来どおり `#page` に `scale()`。
- **半角**：`text-orientation: sideways`。半角色ONで緑系。
- **空白ハイライト（spaceColor）**：全角スペース＝薄いピンク（`.space-full`）、半角スペース/TAB＝薄い緑（`.space-half`）。行頭半角スペースは `white-space: pre` で保持。
- **ルビOFF時はルビ記法込みの元テキストをそのまま表示**（親文字のみにしない）。
- **コピー**：`copy` イベントで `rt`/`rp` 除去、親文字のみ。
- **見出し**：設定の章/話マーカー（既定 `#` / `##`、`chapterMark`/`episodeMark`、LocalStorage）。  
  - 判定：行頭〜マーカー直前が半角/全角スペースのみ。他文字を挟むと本文。改行で本文に戻る。  
  - 色：`.heading-1`（章）/ `.heading-2`（話）。組版は変えず記号も表示。  
  - サムネ：ページ内の見出しタイトルをすべて表示（長い場合は切る）。
- **升目**：罫線は淡色（`--grid`）。目盛り右＝文字位置（半文字上）、上＝行番号を各行センターに。

### UI構成（index.html）確定事項
- 上部：ロゴ／開く／ファイル情報／検索／更新／体裁／字／行／校正。
- 左サイド（幅 168px）：**章記号／話記号**（`#markBar`・サムネ上に常時1行）＋サムネ＋controls。チェックは **2列×3行**（禁則・ぶら下げ／ルビ・半角色／空白・升目）。テーマ。フォントと字級は横並び（「書体」ラベルなし）。クレジット `v1.0` / by やまもりやもり。
- 右 aside（幅 140px）：校正パネル。見出し下に **全角英字／全角数字** の検出ON/OFF（既定ON・LocalStorage）。項目先頭 `p{N} {行}行`。字下げ漏れは2行表示。選択中は黄＋枠。前/次は端でループしない（先頭の前→1ページ目・ハイライト解除）。
- キー：Space=次、Shift+Space=前。←/↓=次、→/↑=前。
- DnD対応。GA は `location.protocol === 'https:'` のときのみ。

### 校正ワーニング（warnings.js）確定
| code | severity | 概要 |
|------|----------|------|
| indent-missing | warning | 字下げ漏れ（行頭半角SP/TAB時は出さない。ラベルに行頭〜10字） |
| dialog-indent | warning | `　「` 始まり |
| period-before-bracket | warning | `。」` 等 |
| no-space-after-bang | warning | ！？直後の不足 |
| odd-leader-dash | warning | …／― の連続が奇数 |
| repeated-chouon | warning | `ー` が2つ以上連続 |
| lonely-katakana-ni | warning | 単独カタカナ「ニ」 |
| unclosed-bracket | warning | 閉じていない開き括弧 |
| unmatched-close-bracket | warning | 開きのない閉じ括弧 |
| double-punctuation | warning | 句読点の連続 `。。` `、、` |
| mixed-bracket | warning | 括弧の不一致（開きと閉じの種類が違う） |
| halfwidth | info | 非空白を含む半角ラン（行末空白は範囲から除外） |
| halfwidth-space | info | 行中の空白のみラン（行末は trailing に任せる） |
| fullwidth-alpha | info | 全角英字ラン `Ａ-Ｚａ-ｚ`（ルビ内・見出しプレフィックス除外。校正パネルでON/OFF） |
| fullwidth-digit | info | 全角数字ラン `０-９`（同上。校正パネルでON/OFF） |
| emoji | info | 絵文字（ZWJ・国旗・キーキャップ含む。隣接連続は1ラン。ルビ内除外） |
| trailing-space | warning | 行末空白（最優先） |
| tab / fullspace-only-line / consecutive-blank / ruby-off / ruby-syntax-error | … | 従来どおり |

合計 **22** code。ユーザー向け簡易: `docs/校正ワーニング一覧_簡易.md`。実装詳細: `docs/校正ワーニング一覧.md`。

重複抑制：行末空白 > 半角スペース（空白のみ） > 半角文字。括弧の `《》` とルビ範囲は除外。見出し行（上記マーカー条件）は字下げ漏れ・半角系から除外。全角英数・絵文字もルビ／見出しプレフィックス除外。

### 入力・更新確定事項
- 文字コードは**自動判定のみ**。改行コード表示あり。
- File System Access 時は自動再読込＋トースト。`pendingOffset` はページ移動・ジャンプで更新し再分割後も位置維持。

### Worker通信（実装形）
- `{ documentId, requestId, type, payload }`。チャンネル単位の最新 requestId 以外破棄。

### 残課題（実機でのみ確認可能）
- 縦書き描画・`text-orientation`・選択コピー結果・`file://`でのBlob Worker起動は実ブラウザ確認が必要。
