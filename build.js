// build.js — src を単一HTML dist/viewer.html に結合（Node標準モジュールのみ）。
// main/worker の2バンドルを明示的に構成する。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'src');
const DIST = join(__dirname, 'dist', 'TateView.html');

// 依存順の登録リスト（キーは basename）
const ENGINE = ['modules/normalize', 'modules/encoding', 'modules/kinsoku', 'modules/tokenizer',
  'modules/paginator', 'modules/warnings', 'modules/search', 'modules/position'];
const UI = ['ui/renderer', 'ui/settings'];

/** モジュールを __mods 登録用の定義文字列へ変換 */
function defineModule(relPath) {
  const src = readFileSync(join(SRC, relPath + '.js'), 'utf8');
  const key = relPath.split('/').pop();
  const names = exportNames(src);
  const body = transform(src);
  return `__mods['${key}'] = (function(){ 'use strict';\n${body}\nreturn { ${names.join(', ')} };\n})();`;
}

/** グルー（worker.js / main.js）を実行文へ変換（登録しない） */
function glue(relPath) {
  const src = readFileSync(join(SRC, relPath + '.js'), 'utf8');
  return `(function(){ 'use strict';\n${transform(src)}\n})();`;
}

function exportNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+function\*?\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  return [...names];
}

function transform(src) {
  // import { a, b } from '.../x.js';  ->  const { a, b } = __mods['x'];
  let out = src.replace(
    /^import\s*\{([^}]*)\}\s*from\s*['"][^'"]*?\/?([A-Za-z0-9_]+)\.js['"];?\s*$/gm,
    (_all, names, key) => `const {${names.trim()}} = __mods['${key}'];`
  );
  // 先頭の export を除去
  out = out.replace(/^export\s+/gm, '');
  return out;
}

const engineDefs = ENGINE.map(defineModule).join('\n\n');
const uiDefs = UI.map(defineModule).join('\n\n');

const workerSource =
  `'use strict';\nconst __mods = {};\n${engineDefs}\n\n${glue('worker')}\n`;

const mainSource =
  `const __mods = {};\n${engineDefs}\n\n${uiDefs}\n\n${glue('main')}\n`;

// --- HTML 組み立て ---
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
let html = readFileSync(join(SRC, 'index.html'), 'utf8');

html = html.replace(
  '<link rel="stylesheet" href="./styles.css" />',
  `<style>\n${css}\n</style>`
);

// DEV スクリプト以降を差し替え
const devIdx = html.indexOf('<!-- DEV:');
html = html.slice(0, devIdx) +
  `<script id="worker-src" type="text/plain">\n${workerSource}\n</script>\n` +
  `<script>\nwindow.__createWorker = function(){\n` +
  `  var s = document.getElementById('worker-src').textContent;\n` +
  `  return new Worker(URL.createObjectURL(new Blob([s], { type: 'text/javascript' })));\n};\n` +
  `${mainSource}\n</script>\n</body>\n</html>\n`;

writeFileSync(DIST, html, 'utf8');

// --- ビルド検証 ---
const errors = [];
const scriptBundles = workerSource + '\n' + mainSource;
if (/^\s*import\s+/m.test(scriptBundles)) errors.push('未変換の import 文が残存');
if (/^\s*export\s+/m.test(scriptBundles)) errors.push('未変換の export 文が残存');
if (/<script[^>]+src=/.test(html)) errors.push('外部 script 参照が残存');
if (/<link[^>]+stylesheet/.test(html)) errors.push('外部 stylesheet 参照が残存');

if (errors.length) {
  console.error('BUILD FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`OK: ${DIST}`);
console.log(`  worker bundle: ${workerSource.length} chars`);
console.log(`  main bundle:   ${mainSource.length} chars`);
console.log(`  html total:    ${html.length} chars`);
