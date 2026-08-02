"use strict";

const STORAGE_KEY = "cf-visualization-csv-v1";

/** 直近に読み込んだCSVの内容 */
let current = null; // { name, text, result }

/* =========================================================
 * 小さなユーティリティ
 * ======================================================= */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// 会計表記: 負の値は △1,234
function fmt(value) {
  const rounded = Math.round(value * 100) / 100;
  const abs = Math.abs(rounded).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  return rounded < 0 ? `△${abs}` : abs;
}

// チャート・ツールチップ用: +1,234 / −1,234
function fmtSigned(value) {
  const abs = Math.abs(value).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

function downloadText(filename, text) {
  // ExcelでそのままUTF-8として開けるようBOMを付ける
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================================================
 * CF計算(間接法)
 * ======================================================= */

function computeCF({ bs, pl, sup, ss }) {
  const d = (key) => bs.curr[key] - bs.prev[key]; // 当期末 − 前期末

  // --- 営業活動によるキャッシュ・フロー ---
  const operatingItems = [
    { label: "税引前当期純利益", value: pl.pretaxIncome, always: true },
    { label: "減価償却費", value: pl.depreciation },
    { label: "受取利息及び受取配当金", value: -pl.interestIncome },
    { label: "支払利息", value: pl.interestExpense },
    { label: pl.gainOnSale >= 0 ? "固定資産売却益" : "固定資産売却損", value: -pl.gainOnSale },
    { label: d("receivables") >= 0 ? "売上債権の増加額" : "売上債権の減少額", value: -d("receivables") },
    { label: d("inventory") >= 0 ? "棚卸資産の増加額" : "棚卸資産の減少額", value: -d("inventory") },
    { label: d("otherCA") >= 0 ? "その他流動資産の増加額" : "その他流動資産の減少額", value: -d("otherCA") },
    { label: d("payables") >= 0 ? "仕入債務の増加額" : "仕入債務の減少額", value: d("payables") },
    { label: d("otherCL") >= 0 ? "その他流動負債の増加額" : "その他流動負債の減少額", value: d("otherCL") },
  ];
  const subtotal = operatingItems.reduce((s, i) => s + i.value, 0);
  const afterSubtotalItems = [
    { label: "利息及び配当金の受取額", value: pl.interestIncome },
    { label: "利息の支払額", value: -pl.interestExpense },
    { label: "法人税等の支払額", value: -pl.incomeTaxes },
  ];
  const operatingCF = subtotal + afterSubtotalItems.reduce((s, i) => s + i.value, 0);

  // --- 投資活動によるキャッシュ・フロー ---
  // 売却簿価 = 売却収入 − 売却損益、取得額 = ΔPPE + 減価償却費 + 売却簿価
  const bookValueSold = sup.saleProceeds - pl.gainOnSale;
  const tangibleAcquired = d("tangible") + pl.depreciation + bookValueSold;
  const investingItems = [
    { label: "有形固定資産の取得による支出", value: -tangibleAcquired },
    { label: "有形固定資産の売却による収入", value: sup.saleProceeds },
    { label: d("investments") >= 0 ? "投資その他の資産の取得による支出" : "投資その他の資産の減少による収入", value: -d("investments") },
  ];
  const investingCF = investingItems.reduce((s, i) => s + i.value, 0);

  // --- 財務活動によるキャッシュ・フロー ---
  const financingItems = [
    { label: "短期借入金の純増減額", value: d("shortLoans") },
    { label: d("longLoans") >= 0 ? "長期借入れによる収入(純額)" : "長期借入金の返済による支出(純額)", value: d("longLoans") },
    { label: "株式の発行による収入", value: ss.stockIssue },
    { label: "自己株式の取得による支出", value: -ss.treasuryBuy },
    { label: "自己株式の処分による収入", value: ss.treasurySell },
    { label: "配当金の支払額", value: -ss.dividendsPaid },
  ];
  const financingCF = financingItems.reduce((s, i) => s + i.value, 0);

  const netChange = operatingCF + investingCF + financingCF;
  const beginningCash = bs.prev.cash;
  const endingCash = beginningCash + netChange;

  return {
    operatingItems, subtotal, afterSubtotalItems, operatingCF,
    investingItems, investingCF,
    financingItems, financingCF,
    netChange, beginningCash, endingCash,
  };
}

/* =========================================================
 * 整合性チェック
 * ======================================================= */

function computeChecks({ bs, pl, ss }, cf) {
  const assets = (p) => bs[p].cash + bs[p].receivables + bs[p].inventory +
    bs[p].otherCA + bs[p].tangible + bs[p].investments;
  const liabilities = (p) => bs[p].payables + bs[p].shortLoans + bs[p].otherCL + bs[p].longLoans;

  const checks = [];
  for (const [p, name] of [["prev", "前期末"], ["curr", "当期末"]]) {
    const diff = assets(p) - (liabilities(p) + bs[p].netAssets);
    checks.push({
      ok: Math.abs(diff) < 0.5,
      title: `BS貸借一致(${name})`,
      detail: Math.abs(diff) < 0.5
        ? `資産合計 ${fmt(assets(p))} = 負債・純資産合計 ${fmt(liabilities(p) + bs[p].netAssets)}`
        : `差額 ${fmt(diff)}(資産合計 ${fmt(assets(p))} / 負債・純資産合計 ${fmt(liabilities(p) + bs[p].netAssets)})`,
    });
  }

  const cashDiff = cf.endingCash - bs.curr.cash;
  checks.push({
    ok: Math.abs(cashDiff) < 0.5,
    title: "CF計算書とBSの現金残高の整合",
    detail: Math.abs(cashDiff) < 0.5
      ? `計算上の期末残高 ${fmt(cf.endingCash)} = BSの現金及び預金 ${fmt(bs.curr.cash)}`
      : `計算上の期末残高 ${fmt(cf.endingCash)} と BSの現金及び預金 ${fmt(bs.curr.cash)} に差額 ${fmt(cashDiff)} があります。CSVの入力値をご確認ください。`,
  });

  const netIncome = pl.pretaxIncome - pl.incomeTaxes;
  const expectedEquityChange = netIncome + ss.stockIssue - ss.dividendsPaid - ss.treasuryBuy + ss.treasurySell;
  const equityDiff = (bs.curr.netAssets - bs.prev.netAssets) - expectedEquityChange;
  checks.push({
    ok: Math.abs(equityDiff) < 0.5,
    title: "SSと純資産増減の整合(参考)",
    detail: Math.abs(equityDiff) < 0.5
      ? `純資産の増減 ${fmt(bs.curr.netAssets - bs.prev.netAssets)} = 当期純利益 + 増資 − 配当 − 自己株式取得 + 自己株式処分`
      : `純資産の増減 ${fmt(bs.curr.netAssets - bs.prev.netAssets)} と 変動事由の合計 ${fmt(expectedEquityChange)} に差額 ${fmt(equityDiff)} があります(その他の変動事由がある場合は差額が出ます)。`,
  });

  return checks;
}

/* =========================================================
 * 読み込み結果テーブルの描画
 * ======================================================= */

function renderLoadedTables(data) {
  const bsBody = document.getElementById("bs-body");
  bsBody.innerHTML = "";
  for (const f of DISPLAY_FIELDS.bs) {
    const label = el("td", { class: "label" });
    label.append(el("span", { class: "group-tag", text: f.group }), f.label);
    bsBody.append(el("tr", {},
      label,
      el("td", { class: "num", text: fmt(data.bs.prev[f.key]) }),
      el("td", { class: "num", text: fmt(data.bs.curr[f.key]) }),
    ));
  }

  for (const section of ["pl", "sup", "ss"]) {
    const body = document.getElementById(`${section}-body`);
    body.innerHTML = "";
    for (const f of DISPLAY_FIELDS[section]) {
      body.append(el("tr", {},
        el("td", { class: "label", text: f.label }),
        el("td", { class: "num", text: fmt(data[section][f.key]) }),
      ));
    }
  }

  const assets = (p) => data.bs[p].cash + data.bs[p].receivables + data.bs[p].inventory +
    data.bs[p].otherCA + data.bs[p].tangible + data.bs[p].investments;
  const liabEq = (p) => data.bs[p].payables + data.bs[p].shortLoans + data.bs[p].otherCL +
    data.bs[p].longLoans + data.bs[p].netAssets;
  document.getElementById("bs-assets-prev").textContent = fmt(assets("prev"));
  document.getElementById("bs-assets-curr").textContent = fmt(assets("curr"));
  document.getElementById("bs-liabeq-prev").textContent = fmt(liabEq("prev"));
  document.getElementById("bs-liabeq-curr").textContent = fmt(liabEq("curr"));
  document.getElementById("pl-netincome").textContent = fmt(data.pl.pretaxIncome - data.pl.incomeTaxes);
}

/* =========================================================
 * CF計算書の描画
 * ======================================================= */

function renderStatement(cf) {
  const table = document.getElementById("cf-statement");
  table.innerHTML = "";

  const row = (cls, label, value) => {
    const tr = el("tr", { class: cls });
    tr.append(el("td", { text: label }));
    const td = el("td", { class: "amount" });
    if (value !== null) td.textContent = fmt(value);
    tr.append(td);
    table.append(tr);
  };

  // 金額ゼロの明細行は省略(構造行は常に表示)
  const items = (list) => list.filter((i) => i.always || Math.abs(i.value) >= 0.005);

  row("head", "Ⅰ 営業活動によるキャッシュ・フロー", null);
  for (const i of items(cf.operatingItems)) row("item", i.label, i.value);
  row("subtotal", "小計", cf.subtotal);
  for (const i of items(cf.afterSubtotalItems)) row("item", i.label, i.value);
  row("section-total", "営業活動によるキャッシュ・フロー", cf.operatingCF);

  row("head", "Ⅱ 投資活動によるキャッシュ・フロー", null);
  for (const i of items(cf.investingItems)) row("item", i.label, i.value);
  row("section-total", "投資活動によるキャッシュ・フロー", cf.investingCF);

  row("head", "Ⅲ 財務活動によるキャッシュ・フロー", null);
  for (const i of items(cf.financingItems)) row("item", i.label, i.value);
  row("section-total", "財務活動によるキャッシュ・フロー", cf.financingCF);

  row("grand", "Ⅳ 現金及び現金同等物の増減額", cf.netChange);
  row("grand", "Ⅴ 現金及び現金同等物の期首残高", cf.beginningCash);
  row("grand", "Ⅵ 現金及び現金同等物の期末残高", cf.endingCash);
}

/* =========================================================
 * ウォーターフォールチャートの描画(SVG)
 * ======================================================= */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// 軸の目盛りをキリのよい数値に丸める
function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let t = start; t <= max + step * 0.001; t += step) ticks.push(Math.round(t / step) * step);
  return ticks;
}

function renderWaterfall(cf) {
  const svg = document.getElementById("waterfall");
  const tooltip = document.getElementById("wf-tooltip");
  svg.innerHTML = "";

  const steps = [
    { label: "期首残高", type: "total", from: 0, to: cf.beginningCash, value: cf.beginningCash },
    { label: "営業CF", type: "delta", value: cf.operatingCF },
    { label: "投資CF", type: "delta", value: cf.investingCF },
    { label: "財務CF", type: "delta", value: cf.financingCF },
    { label: "期末残高", type: "total", from: 0, to: cf.endingCash, value: cf.endingCash },
  ];

  // 累積を計算して各バーの上端・下端を決める
  let cum = 0;
  for (const s of steps) {
    if (s.type === "total") {
      cum = s.to;
    } else {
      s.from = cum;
      s.to = cum + s.value;
      cum = s.to;
    }
  }

  const W = 720, H = 340;
  const M = { top: 20, right: 16, bottom: 34, left: 76 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  let lo = Math.min(0, ...steps.map((s) => Math.min(s.from, s.to)));
  let hi = Math.max(0, ...steps.map((s) => Math.max(s.from, s.to)));
  if (lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  const ticks = niceTicks(lo - (lo < 0 ? pad : 0), hi + pad);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);

  const y = (v) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  // グリッド線と目盛りラベル
  for (const t of ticks) {
    svg.append(svgEl("line", {
      class: t === 0 ? "baseline" : "grid-line",
      x1: M.left, x2: M.left + plotW, y1: y(t), y2: y(t),
    }));
    const lbl = svgEl("text", { class: "tick-label", x: M.left - 8, y: y(t) + 4, "text-anchor": "end" });
    lbl.textContent = t.toLocaleString("ja-JP");
    svg.append(lbl);
  }

  const band = plotW / steps.length;
  const BAR_W = Math.min(24, band * 0.5);
  const R = 4; // データ端の角丸

  // 角丸をデータ側の端(上端 or 下端)にだけ付けたバーのパス
  function barPath(x, top, bottom, roundTop) {
    const w = BAR_W;
    const h = Math.max(bottom - top, 0.5);
    const r = Math.min(R, h / 2, w / 2);
    if (roundTop) {
      return `M${x},${bottom} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${bottom} Z`;
    }
    return `M${x},${top} L${x + w},${top} L${x + w},${bottom - r} Q${x + w},${bottom} ${x + w - r},${bottom} L${x + r},${bottom} Q${x},${bottom} ${x},${bottom - r} Z`;
  }

  steps.forEach((s, i) => {
    const cx = M.left + band * i + band / 2;
    const x0 = cx - BAR_W / 2;
    const topY = y(Math.max(s.from, s.to));
    const botY = y(Math.min(s.from, s.to));

    const g = svgEl("g", { class: "band" });

    const cls = s.type === "total" ? "bar-total" : s.value >= 0 ? "bar-pos" : "bar-neg";
    // データ端 = 増加・残高なら上端、減少なら下端
    const roundTop = s.type === "total" ? s.to >= 0 : s.value >= 0;
    g.append(svgEl("path", { class: `bar ${cls}`, d: barPath(x0, topY, botY, roundTop) }));

    // コネクタ(前のバーの終点 → このバーの始点)
    if (i > 0) {
      const prev = steps[i - 1];
      const prevCx = M.left + band * (i - 1) + band / 2;
      g.append(svgEl("line", {
        class: "connector",
        x1: prevCx + BAR_W / 2, x2: cx - BAR_W / 2,
        y1: y(prev.to), y2: y(prev.to),
      }));
    }

    // 値ラベル(データ端の外側)
    const labelY = roundTop ? topY - 6 : botY + 14;
    const vl = svgEl("text", { class: "value-label", x: cx, y: labelY, "text-anchor": "middle" });
    vl.textContent = s.type === "total" ? fmt(s.value) : fmtSigned(s.value);
    g.append(vl);

    const cl = svgEl("text", { class: "cat-label", x: cx, y: H - 12, "text-anchor": "middle" });
    cl.textContent = s.label;
    g.append(cl);

    // ホバー用ヒット領域(バーより大きく、バンド全体)
    const hit = svgEl("rect", {
      class: "hit", x: M.left + band * i, y: M.top, width: band, height: plotH,
    });
    hit.addEventListener("mousemove", (ev) => {
      const wrapEl = svg.parentElement;
      const wrap = wrapEl.getBoundingClientRect();
      tooltip.hidden = false;
      tooltip.innerHTML = "";
      tooltip.append(
        el("div", { class: "tt-title", text: s.label }),
        el("div", { class: "tt-value", text: s.type === "total" ? `残高: ${fmt(s.value)}` : `増減: ${fmtSigned(s.value)}` }),
        el("div", { class: "tt-value", text: s.type === "total" ? "" : `累計: ${fmt(s.to)}` }),
      );
      // 横スクロール中でもツールチップがカーソルに追従するよう scrollLeft を加味する
      const sx = wrapEl.scrollLeft;
      const tx = Math.min(ev.clientX - wrap.left + sx + 14, sx + wrap.width - tooltip.offsetWidth - 4);
      const ty = Math.max(ev.clientY - wrap.top - tooltip.offsetHeight - 10, 0);
      tooltip.style.left = `${Math.max(tx, sx)}px`;
      tooltip.style.top = `${ty}px`;
    });
    hit.addEventListener("mouseleave", () => { tooltip.hidden = true; });

    g.append(hit);
    svg.append(g);
  });
}

/* =========================================================
 * チェック結果・メッセージの描画
 * ======================================================= */

function renderChecks(checks) {
  const wrap = document.getElementById("checks");
  wrap.innerHTML = "";
  wrap.hidden = false;
  for (const c of checks) {
    const div = el("div", { class: `check ${c.ok ? "ok" : "ng"}` });
    div.append(
      el("span", { class: "icon", text: c.ok ? "✓" : "!" }),
      el("span", { text: c.title }),
      el("span", { class: "detail", text: c.detail }),
    );
    wrap.append(div);
  }
}

function renderMessages(errors, warnings) {
  const wrap = document.getElementById("messages");
  wrap.innerHTML = "";
  const all = [
    ...errors.map((t) => ({ kind: "error", text: t })),
    ...warnings.map((t) => ({ kind: "warn", text: t })),
  ];
  wrap.hidden = all.length === 0;
  for (const m of all) {
    wrap.append(el("div", { class: `message ${m.kind}` },
      el("span", { class: "icon", text: m.kind === "error" ? "×" : "!" }),
      el("span", { text: m.text }),
    ));
  }
}

/* =========================================================
 * 読み込み処理
 * ======================================================= */

function showEmptyState() {
  document.getElementById("loaded").hidden = true;
  document.getElementById("results").hidden = true;
  document.getElementById("checks").hidden = true;
  document.getElementById("empty-state").hidden = false;
  document.getElementById("btn-clear").hidden = true;
  document.getElementById("btn-export").hidden = true;
}

/** CSVテキストを取り込んで画面を更新する */
function applyCSV(text, name) {
  const result = parseFinancialCSV(text);
  current = { name, text, result };

  const status = document.getElementById("file-status");
  status.hidden = false;
  status.textContent = result.ok
    ? `${name} を読み込みました(${result.matched}件の科目を認識)`
    : `${name} を読み込めませんでした`;
  status.className = `file-status ${result.ok ? "ok" : "ng"}`;

  renderMessages(result.errors, result.warnings);

  if (!result.ok) {
    showEmptyState();
    document.getElementById("btn-clear").hidden = false;
    return;
  }

  const cf = computeCF(result.data);
  renderLoadedTables(result.data);
  renderChecks(computeChecks(result.data, cf));
  renderStatement(cf);
  renderWaterfall(cf);

  document.getElementById("loaded").hidden = false;
  document.getElementById("results").hidden = false;
  document.getElementById("empty-state").hidden = true;
  document.getElementById("btn-clear").hidden = false;
  document.getElementById("btn-export").hidden = false;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, text }));
  } catch (_) { /* 保存できなくても動作に影響はない */ }
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    renderMessages(["ファイルサイズが大きすぎます(5MBまで)。"], []);
    return;
  }
  try {
    applyCSV(await decodeFile(file), file.name);
  } catch (err) {
    renderMessages([`ファイルを読み込めませんでした: ${err.message}`], []);
    showEmptyState();
  }
}

function clearAll() {
  current = null;
  document.getElementById("file-input").value = "";
  document.getElementById("file-status").hidden = true;
  document.getElementById("messages").hidden = true;
  document.getElementById("messages").innerHTML = "";
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 無視 */ }
  showEmptyState();
}

/* =========================================================
 * サンプルCSV(sample.csv と同じ内容)
 * ======================================================= */

const SAMPLE_CSV = [
  "区分,科目,前期末,当期末",
  "BS,現金及び預金,12000,7900",
  "BS,売上債権,18000,21000",
  "BS,棚卸資産,9000,10000",
  "BS,その他流動資産,2000,2500",
  "BS,有形固定資産(純額),35000,38000",
  "BS,投資その他の資産,4000,5000",
  "BS,仕入債務,11000,12500",
  "BS,短期借入金,6000,5000",
  "BS,その他流動負債,3000,3300",
  "BS,長期借入金,20000,18000",
  "BS,純資産合計,40000,45600",
  "PL,税引前当期純利益,,9000",
  "PL,減価償却費,,4500",
  "PL,受取利息及び受取配当金,,200",
  "PL,支払利息,,600",
  "PL,固定資産売却損益(益は+、損は−),,300",
  "PL,法人税等,,3100",
  "補足,有形固定資産の売却による収入,,1800",
  "SS,新株の発行(増資),,2000",
  "SS,剰余金の配当(配当金の支払額),,1800",
  "SS,自己株式の取得,,500",
  "SS,自己株式の処分,,0",
].join("\r\n") + "\r\n";

/* =========================================================
 * 初期化
 * ======================================================= */

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");

  input.addEventListener("change", () => handleFile(input.files[0]));

  for (const type of ["dragenter", "dragover"]) {
    dropzone.addEventListener(type, (ev) => {
      ev.preventDefault();
      dropzone.classList.add("is-over");
    });
  }
  for (const type of ["dragleave", "dragend"]) {
    dropzone.addEventListener(type, () => dropzone.classList.remove("is-over"));
  }
  dropzone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dropzone.classList.remove("is-over");
    handleFile(ev.dataTransfer.files[0]);
  });
  // ページ外へのドロップでブラウザがファイルを開いてしまうのを防ぐ
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (ev) => {
      if (!dropzone.contains(ev.target)) ev.preventDefault();
    });
  }

  document.getElementById("btn-sample")
    .addEventListener("click", () => applyCSV(SAMPLE_CSV, "sample.csv"));
  document.getElementById("btn-template")
    .addEventListener("click", () => downloadText("cf-template.csv", buildTemplateCSV()));
  document.getElementById("btn-export")
    .addEventListener("click", () => {
      if (current) downloadText("cf-input.csv", buildTemplateCSV(current.result.data));
    });
  document.getElementById("btn-clear").addEventListener("click", clearAll);

  // 前回読み込んだCSVを復元
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && saved.text) applyCSV(saved.text, saved.name || "前回のファイル");
  } catch (_) { /* 無視 */ }
});
