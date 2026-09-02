"use strict";

/* =========================================================
 * ツール本体の保存(単一HTML化)
 *
 * GitHub Pages が使えなくなっても(部署異動・公開停止など)手元で使い続けられるよう、
 * CSS と JavaScript をすべて埋め込んだ 1 つの HTML ファイルとして書き出す。
 * 書き出したファイルはダブルクリック(file://)で開くだけで同じように動く。
 *
 * このスクリプトは index.html の最後に読み込む。その時点では画面のタグが
 * すべて揃っていて、まだアプリが画面を書き換えていないので、
 * document.documentElement.outerHTML が「素の HTML」になる。
 *
 * scripts/build-standalone.js からも同じ関数を使う(CI で保存版を生成する)。
 * ======================================================= */

const STANDALONE_FILE_NAME = "CF計算書ジェネレーター.html";
const STANDALONE_META = "cf-standalone";

// ブラウザで読み込まれたときだけ、素の HTML を控えておく
const PRISTINE_HTML = typeof document !== "undefined"
  ? "<!DOCTYPE html>\n" + document.documentElement.outerHTML
  : "";

/** いま開いているのが保存版(単一HTML)かどうか */
function isStandaloneBuild() {
  return typeof document !== "undefined"
    && !!document.querySelector(`meta[name="${STANDALONE_META}"]`);
}

/** タグの属性値を取り出す(なければ null) */
function attrOf(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))
    || tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? m[1] : null;
}

/** 埋め込む中身が、囲っているタグを閉じてしまわないようにする */
function escapeInline(text, tagName) {
  return text.replace(new RegExp(`</${tagName}`, "gi"), `<\\/${tagName}`);
}

/**
 * HTML の外部 CSS / JS 参照を、中身を埋め込んだタグに置き替える。
 * @param {string} html            index.html の内容
 * @param {(path:string)=>Promise<string>} readAsset  相対パス(クエリなし)→ 中身
 * @param {{stamp?: string}} opts   生成日時などの注記
 */
async function buildStandaloneHtml(html, readAsset, { stamp = "" } = {}) {
  // すでに保存版なら、そのまま(重ねて埋め込まない)
  if (new RegExp(`<meta[^>]+name="${STANDALONE_META}"`, "i").test(html)) return html;

  const jobs = [];
  const linkRe = /<link\b[^>]*>/gi;
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi;

  // 置き替える対象を先に集めてから、中身をまとめて読む(順序を保つ)
  const targets = [];
  for (const m of html.matchAll(linkRe)) {
    const rel = attrOf(m[0], "rel");
    const href = attrOf(m[0], "href");
    if (!rel || !/\bstylesheet\b/i.test(rel) || !href || /^(https?:)?\/\//i.test(href)) continue;
    targets.push({ tag: m[0], path: href.split(/[?#]/)[0], kind: "style" });
  }
  for (const m of html.matchAll(scriptRe)) {
    const src = attrOf(m[0], "src");
    if (!src || /^(https?:)?\/\//i.test(src)) continue;
    targets.push({ tag: m[0], path: src.split(/[?#]/)[0], kind: "script" });
  }
  for (const t of targets) jobs.push(readAsset(t.path).then((text) => { t.text = text; }));
  await Promise.all(jobs);

  let out = html;
  for (const t of targets) {
    const body = t.kind === "style"
      ? `<style>\n/* ${t.path} */\n${escapeInline(t.text, "style")}\n</style>`
      : `<script>\n/* ${t.path} */\n${escapeInline(t.text, "script")}\n</script>`;
    out = out.replace(t.tag, () => body);
  }

  // 保存版であることの印(2重に埋め込まない・画面で見分ける)
  const meta = `<meta name="${STANDALONE_META}" content="${stamp || new Date().toISOString().slice(0, 10)}">`;
  out = /<meta\s+charset[^>]*>/i.test(out)
    ? out.replace(/<meta\s+charset[^>]*>/i, (m) => `${m}\n${meta}`)
    : out.replace(/<head[^>]*>/i, (m) => `${m}\n${meta}`);
  return out;
}

// Node.js(scripts/build-standalone.js)からも使えるようにする
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildStandaloneHtml, STANDALONE_FILE_NAME, STANDALONE_META };
}
