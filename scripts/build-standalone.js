// index.html と css/ js/ をひとつの HTML にまとめた「保存版」を生成する。
// 画面の「ツール本体をHTMLで保存」ボタンと同じものを、CI(GitHub Pages のデプロイ)でも
// 作っておき、固定URLからそのままダウンロードできるようにするためのスクリプト。
//
//   node scripts/build-standalone.js            → ./CF計算書ジェネレーター.html
//   node scripts/build-standalone.js out.html   → 指定した場所に書く
//
const fs = require("fs");
const path = require("path");
const { buildStandaloneHtml, STANDALONE_FILE_NAME } = require("../js/standalone.js");

const ROOT = path.join(__dirname, "..");
const outFile = path.resolve(process.argv[2] || path.join(ROOT, STANDALONE_FILE_NAME));

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const readAsset = async (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const out = await buildStandaloneHtml(html, readAsset, { stamp: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(outFile, out);
  console.log(`${path.relative(ROOT, outFile)} を生成しました (${(out.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
