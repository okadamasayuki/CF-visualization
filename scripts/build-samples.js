// sample.csv / sample-27.csv から js/samples.js を生成する。
// アプリは file:// で開いても動くようにするため、サンプルを fetch せず
// JavaScriptに埋め込んでいる。CSVを更新したらこのスクリプトを実行すること。
//
//   node scripts/build-samples.js
//
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function toLiteral(name, file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const body = lines.map((l) => `  ${JSON.stringify(l)},`).join('\n');
  return `const ${name} = [\n${body}\n].join("\\r\\n") + "\\r\\n";\n`;
}

const out = `"use strict";

/* =========================================================
 * サンプルデータ
 *
 * このファイルは scripts/build-samples.js が
 * sample.csv / sample-27.csv から自動生成しています。直接編集しないこと。
 * ======================================================= */

${toLiteral('SAMPLE_CSV', 'sample.csv')}
${toLiteral('SAMPLE_27_CSV', 'sample-27.csv')}`;

fs.writeFileSync(path.join(ROOT, 'js/samples.js'), out);
console.log(`js/samples.js を生成しました (${out.length} バイト)`);
