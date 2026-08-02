"use strict";

const STORAGE_KEY = "cf-visualization-csv-v2";

/** 画面の状態 */
const state = {
  companies: [],      // [{ name, data, cf, checks }]
  selected: 0,        // 明細を表示している会社のindex
  measure: "operatingCF",
  sort: { key: null, dir: 1 },
  sources: [],        // localStorage復元用 [{ name, text }]
};

/** 全社比較で選べる指標 */
const MEASURES = [
  { key: "operatingCF", label: "営業CF" },
  { key: "investingCF", label: "投資CF" },
  { key: "financingCF", label: "財務CF" },
  { key: "freeCF", label: "フリーCF(営業+投資)" },
  { key: "netChange", label: "現金の増減額" },
  { key: "endingCash", label: "期末現金残高" },
];

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
    freeCF: operatingCF + investingCF,
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
 * SVGの共通処理
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

/** バーのデータ側の端だけ角を丸めたパス(横向き) */
function hBarPath(x0, x1, yTop, h, r = 4) {
  const w = Math.abs(x1 - x0);
  const rr = Math.min(r, w, h / 2);
  const yBot = yTop + h;
  if (x1 >= x0) { // 右向き:右端を丸める
    return `M${x0},${yTop} L${x1 - rr},${yTop} Q${x1},${yTop} ${x1},${yTop + rr} L${x1},${yBot - rr} Q${x1},${yBot} ${x1 - rr},${yBot} L${x0},${yBot} Z`;
  }
  return `M${x0},${yTop} L${x1 + rr},${yTop} Q${x1},${yTop} ${x1},${yTop + rr} L${x1},${yBot - rr} Q${x1},${yBot} ${x1 + rr},${yBot} L${x0},${yBot} Z`;
}

/** マウス位置にツールチップを出す(横スクロール中でも追従させる) */
function positionTooltip(tooltip, svg, ev) {
  const wrapEl = svg.parentElement;
  const wrap = wrapEl.getBoundingClientRect();
  const sx = wrapEl.scrollLeft;
  const tx = Math.min(ev.clientX - wrap.left + sx + 14, sx + wrap.width - tooltip.offsetWidth - 4);
  const ty = Math.max(ev.clientY - wrap.top - tooltip.offsetHeight - 10, 0);
  tooltip.style.left = `${Math.max(tx, sx)}px`;
  tooltip.style.top = `${ty}px`;
}

/* =========================================================
 * 全社比較チャート(横向きの発散バー)
 * ======================================================= */

function renderOverviewChart() {
  const svg = document.getElementById("overview-chart");
  const tooltip = document.getElementById("ov-tooltip");
  svg.innerHTML = "";

  const measure = MEASURES.find((m) => m.key === state.measure);
  // ランキングとして読ませるチャートなので、常に指標の降順に並べる
  const items = state.companies
    .map((c, index) => ({ index, name: c.name, value: c.cf[measure.key] }))
    .sort((a, b) => b.value - a.value);

  const ROW = 22, BAR_H = 12;
  const M = { top: 28, right: 76, bottom: 8, left: 132 };
  const W = 720;
  const plotW = W - M.left - M.right;
  const plotH = items.length * ROW;
  const H = M.top + plotH + M.bottom;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);

  // 目盛りの丸めで軸が広がりすぎないよう、描画範囲はデータの幅に合わせる
  const values = items.map((i) => i.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const x = (v) => M.left + ((v - lo) / (hi - lo || 1)) * plotW;
  const ticks = niceTicks(lo, hi).filter((t) => t >= lo && t <= hi);
  if (!ticks.includes(0)) ticks.push(0);

  // 目盛り線(0はベースラインとして少し濃く)
  for (const t of ticks) {
    svg.append(svgEl("line", {
      class: t === 0 ? "baseline" : "grid-line",
      x1: x(t), x2: x(t), y1: M.top - 6, y2: M.top + plotH,
    }));
    const lbl = svgEl("text", { class: "tick-label", x: x(t), y: M.top - 12, "text-anchor": "middle" });
    lbl.textContent = fmtSigned(t) === "0" ? "0" : fmtSigned(t).replace("+", "");
    svg.append(lbl);
  }

  const maxIdx = 0, minIdx = items.length - 1; // 直接ラベルは両極だけに付ける

  items.forEach((item, i) => {
    const yTop = M.top + i * ROW + (ROW - BAR_H) / 2;
    const g = svgEl("g", { class: "band" });

    const name = svgEl("text", {
      class: `cat-label row-name${item.index === state.selected ? " is-selected" : ""}`,
      x: M.left - 10, y: yTop + BAR_H - 2, "text-anchor": "end",
    });
    name.textContent = item.name;
    g.append(name);

    if (item.value !== 0) {
      g.append(svgEl("path", {
        class: `bar ${item.value >= 0 ? "bar-pos" : "bar-neg"}`,
        d: hBarPath(x(0), x(item.value), yTop, BAR_H),
      }));
    }

    // 最大・最小だけ値を直接ラベルする(全行に付けると読めなくなるため)
    if (i === maxIdx || i === minIdx) {
      const text = fmtSigned(item.value);
      const width = text.length * 7.5; // 12px semibold の概算
      const tip = x(item.value);
      const grows = item.value >= 0 ? 1 : -1;
      // 先端の外側に置く。はみ出す場合は、その行では空いている0の反対側へ逃がす。
      // 右側は値ラベル用の余白(M.right)まで使えるが、左側は会社名の列に入れない
      const fits = grows > 0
        ? tip + 8 + width <= W - 4
        : tip - 8 - width >= M.left;
      const anchor = fits ? (grows > 0 ? "start" : "end") : (grows > 0 ? "end" : "start");
      const px = fits ? tip + grows * 8 : x(0) - grows * 8;
      const vl = svgEl("text", {
        class: "value-label", x: px, y: yTop + BAR_H - 1, "text-anchor": anchor,
      });
      vl.textContent = text;
      g.append(vl);
    }

    const hit = svgEl("rect", {
      class: "hit", x: 0, y: M.top + i * ROW, width: W, height: ROW,
      role: "button", tabindex: "0",
    });
    hit.addEventListener("mousemove", (ev) => {
      tooltip.hidden = false;
      tooltip.innerHTML = "";
      const c = state.companies[item.index];
      tooltip.append(
        el("div", { class: "tt-title", text: item.name }),
        el("div", { class: "tt-value", text: `${measure.label}: ${fmtSigned(item.value)}` }),
        el("div", { class: "tt-value", text: `期末現金残高: ${fmt(c.cf.endingCash)}` }),
        el("div", { class: "tt-hint", text: "クリックで明細を表示" }),
      );
      positionTooltip(tooltip, svg, ev);
    });
    hit.addEventListener("mouseleave", () => { tooltip.hidden = true; });
    hit.addEventListener("click", () => selectCompany(item.index));
    hit.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCompany(item.index); }
    });

    g.append(hit);
    svg.append(g);
  });
}

/* =========================================================
 * 全社比較テーブル
 * ======================================================= */

const OVERVIEW_COLS = [
  { key: "name", label: "会社名", type: "text" },
  { key: "operatingCF", label: "営業CF" },
  { key: "investingCF", label: "投資CF" },
  { key: "financingCF", label: "財務CF" },
  { key: "freeCF", label: "フリーCF" },
  { key: "netChange", label: "増減額" },
  { key: "beginningCash", label: "期首残高" },
  { key: "endingCash", label: "期末残高" },
  { key: "ok", label: "整合", type: "check" },
];

function renderOverviewTable() {
  const table = document.getElementById("overview-table");
  table.innerHTML = "";

  const rows = state.companies.map((c, index) => ({
    index, name: c.name, ok: c.checks.every((k) => k.ok), ...c.cf,
  }));

  const { key, dir } = state.sort;
  if (key) {
    rows.sort((a, b) => {
      if (key === "name") return a.name.localeCompare(b.name, "ja") * dir;
      if (key === "ok") return ((a.ok ? 1 : 0) - (b.ok ? 1 : 0)) * dir;
      return (a[key] - b[key]) * dir;
    });
  }

  // --- 見出し ---
  const thead = el("thead");
  const htr = el("tr");
  for (const col of OVERVIEW_COLS) {
    const th = el("th", {
      class: col.type === "text" ? "label-col" : col.type === "check" ? "check-col" : "",
      scope: "col", role: "button", tabindex: "0",
      "aria-sort": key === col.key ? (dir === 1 ? "ascending" : "descending") : "none",
    });
    th.append(col.label);
    if (key === col.key) th.append(el("span", { class: "sort-arrow", text: dir === 1 ? " ▲" : " ▼" }));
    const sort = () => {
      state.sort = key === col.key ? { key: col.key, dir: -dir } : { key: col.key, dir: col.type === "text" ? 1 : -1 };
      renderOverviewTable();
    };
    th.addEventListener("click", sort);
    th.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); sort(); }
    });
    htr.append(th);
  }
  thead.append(htr);
  table.append(thead);

  // --- 明細 ---
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", {
      class: r.index === state.selected ? "is-selected" : "",
      role: "button", tabindex: "0",
      "aria-label": `${r.name}の明細を表示`,
    });
    tr.append(el("td", { class: "label", text: r.name }));
    for (const col of OVERVIEW_COLS.slice(1, -1)) {
      tr.append(el("td", { class: "num", text: fmt(r[col.key]) }));
    }
    const okTd = el("td", { class: `num check-col ${r.ok ? "ok" : "ng"}` });
    okTd.textContent = r.ok ? "✓" : "!";
    okTd.setAttribute("title", r.ok ? "整合性チェックはすべてOK" : "整合しない項目があります");
    tr.append(okTd);

    tr.addEventListener("click", () => selectCompany(r.index));
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCompany(r.index); }
    });
    tbody.append(tr);
  }
  table.append(tbody);

  // --- 合計 ---
  const tfoot = el("tfoot");
  const ftr = el("tr");
  ftr.append(el("td", { class: "label", text: `合計(${rows.length}社)` }));
  for (const col of OVERVIEW_COLS.slice(1, -1)) {
    ftr.append(el("td", { class: "num", text: fmt(rows.reduce((s, r) => s + r[col.key], 0)) }));
  }
  const ngCount = rows.filter((r) => !r.ok).length;
  ftr.append(el("td", { class: `num check-col ${ngCount ? "ng" : "ok"}`, text: ngCount ? `${ngCount}社` : "✓" }));
  tfoot.append(ftr);
  table.append(tfoot);
}

/* =========================================================
 * 読み込み結果テーブル(選択中の1社)
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
 * CF計算書
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
 * ウォーターフォールチャート(選択中の1社)
 * ======================================================= */

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
  const R = 4;

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
    const roundTop = s.type === "total" ? s.to >= 0 : s.value >= 0;
    g.append(svgEl("path", { class: `bar ${cls}`, d: barPath(x0, topY, botY, roundTop) }));

    if (i > 0) {
      const prev = steps[i - 1];
      const prevCx = M.left + band * (i - 1) + band / 2;
      g.append(svgEl("line", {
        class: "connector",
        x1: prevCx + BAR_W / 2, x2: cx - BAR_W / 2,
        y1: y(prev.to), y2: y(prev.to),
      }));
    }

    const labelY = roundTop ? topY - 6 : botY + 14;
    const vl = svgEl("text", { class: "value-label", x: cx, y: labelY, "text-anchor": "middle" });
    vl.textContent = s.type === "total" ? fmt(s.value) : fmtSigned(s.value);
    g.append(vl);

    const cl = svgEl("text", { class: "cat-label", x: cx, y: H - 12, "text-anchor": "middle" });
    cl.textContent = s.label;
    g.append(cl);

    const hit = svgEl("rect", {
      class: "hit", x: M.left + band * i, y: M.top, width: band, height: plotH,
    });
    hit.addEventListener("mousemove", (ev) => {
      tooltip.hidden = false;
      tooltip.innerHTML = "";
      tooltip.append(
        el("div", { class: "tt-title", text: s.label }),
        el("div", { class: "tt-value", text: s.type === "total" ? `残高: ${fmt(s.value)}` : `増減: ${fmtSigned(s.value)}` }),
        el("div", { class: "tt-value", text: s.type === "total" ? "" : `累計: ${fmt(s.to)}` }),
      );
      positionTooltip(tooltip, svg, ev);
    });
    hit.addEventListener("mouseleave", () => { tooltip.hidden = true; });

    g.append(hit);
    svg.append(g);
  });
}

/* =========================================================
 * チェック結果・メッセージ
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
  const MAX = 12; // 何十社分もの警告で画面が埋まらないようにする
  const all = [
    ...errors.map((t) => ({ kind: "error", text: t })),
    ...warnings.map((t) => ({ kind: "warn", text: t })),
  ];
  wrap.hidden = all.length === 0;
  for (const m of all.slice(0, MAX)) {
    wrap.append(el("div", { class: `message ${m.kind}` },
      el("span", { class: "icon", text: m.kind === "error" ? "×" : "!" }),
      el("span", { text: m.text }),
    ));
  }
  if (all.length > MAX) {
    wrap.append(el("div", { class: "message warn" },
      el("span", { class: "icon", text: "!" }),
      el("span", { text: `ほか${all.length - MAX}件の警告があります。` }),
    ));
  }
}

/* =========================================================
 * 画面の組み立て
 * ======================================================= */

function selectCompany(index) {
  state.selected = index;
  renderDetail();
  renderOverviewTable();
  renderOverviewChart();
  document.getElementById("company-select").value = String(index);
  document.getElementById("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDetail() {
  const company = state.companies[state.selected];
  if (!company) return;
  const multi = state.companies.length > 1;

  document.getElementById("detail-title").textContent =
    multi ? `明細:${company.name}` : "読み込み結果";
  document.getElementById("statement-company").textContent = company.name;

  renderLoadedTables(company.data);
  renderChecks(company.checks);
  renderStatement(company.cf);
  renderWaterfall(company.cf);
}

function renderCompanySelect() {
  const select = document.getElementById("company-select");
  select.innerHTML = "";
  state.companies.forEach((c, i) => {
    select.append(el("option", { value: String(i), text: c.name }));
  });
  select.value = String(state.selected);
}

function render() {
  const multi = state.companies.length > 1;

  document.getElementById("overview").hidden = !multi;
  document.getElementById("company-bar").hidden = !multi;
  document.getElementById("detail").hidden = false;
  document.getElementById("results").hidden = false;
  document.getElementById("empty-state").hidden = true;
  document.getElementById("btn-clear").hidden = false;
  document.getElementById("btn-export").hidden = false;

  if (multi) {
    document.getElementById("overview-count").textContent = `${state.companies.length}社`;
    const picker = document.getElementById("measure-select");
    if (!picker.options.length) {
      for (const m of MEASURES) picker.append(el("option", { value: m.key, text: m.label }));
    }
    picker.value = state.measure;
    document.getElementById("chart-measure-label").textContent =
      MEASURES.find((m) => m.key === state.measure).label;
    renderOverviewChart();
    renderOverviewTable();
    renderCompanySelect();
  }
  renderDetail();
}

function showEmptyState() {
  for (const id of ["overview", "company-bar", "detail", "results", "checks"]) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("empty-state").hidden = false;
  document.getElementById("btn-clear").hidden = true;
  document.getElementById("btn-export").hidden = true;
}

/* =========================================================
 * 読み込み
 * ======================================================= */

/** ファイル名から拡張子を除いたもの(会社名の列がない場合の会社名) */
function baseName(filename) {
  return filename.replace(/\.[^.]+$/, "") || filename;
}

/**
 * 複数のCSV({name, text})をまとめて取り込む。
 * 同じ会社名が複数回出てきた場合は、同一科目の行と同じように合算する。
 */
function applySources(sources) {
  const errors = [], warnings = [];
  const merged = new Map();
  let matched = 0;

  for (const src of sources) {
    const result = parseFinancialCSV(src.text, baseName(src.name));
    const prefix = sources.length > 1 ? `${src.name}: ` : "";
    errors.push(...result.errors.map((e) => prefix + e));
    warnings.push(...result.warnings.map((w) => prefix + w));
    matched += result.matched;

    for (const { name, data } of result.companies) {
      if (!merged.has(name)) { merged.set(name, data); continue; }
      warnings.push(`「${name}」のデータが複数の箇所にあります。合算して1社として扱います。`);
      const acc = merged.get(name);
      for (const key of Object.keys(acc.bs.prev)) {
        acc.bs.prev[key] += data.bs.prev[key];
        acc.bs.curr[key] += data.bs.curr[key];
      }
      for (const section of ["pl", "sup", "ss"]) {
        for (const key of Object.keys(acc[section])) acc[section][key] += data[section][key];
      }
    }
  }

  const label = sources.length === 1 ? sources[0].name : `${sources.length}個のファイル`;
  const status = document.getElementById("file-status");
  status.hidden = false;

  if (merged.size === 0 || matched === 0) {
    status.textContent = `${label} を読み込めませんでした`;
    status.className = "file-status ng";
    if (errors.length === 0) errors.push("読み込めるデータがありませんでした。");
    renderMessages(errors, warnings);
    state.companies = [];
    showEmptyState();
    document.getElementById("btn-clear").hidden = false;
    return;
  }

  state.companies = [...merged].map(([name, data]) => {
    const cf = computeCF(data);
    return { name, data, cf, checks: computeChecks(data, cf) };
  });
  state.selected = 0;
  state.sort = { key: null, dir: 1 };
  state.sources = sources;

  status.textContent = `${label} を読み込みました(${state.companies.length}社 / ${matched}件の科目を認識)`;
  status.className = "file-status ok";
  renderMessages(errors, warnings);
  render();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
  } catch (_) { /* 容量超過などで保存できなくても動作に影響はない */ }
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > 20 * 1024 * 1024) {
    renderMessages(["ファイルサイズの合計が大きすぎます(20MBまで)。"], []);
    return;
  }
  try {
    const sources = [];
    for (const f of files) sources.push({ name: f.name, text: await decodeFile(f) });
    applySources(sources);
  } catch (err) {
    renderMessages([`ファイルを読み込めませんでした: ${err.message}`], []);
    showEmptyState();
  }
}

function clearAll() {
  state.companies = [];
  state.sources = [];
  document.getElementById("file-input").value = "";
  document.getElementById("file-status").hidden = true;
  const messages = document.getElementById("messages");
  messages.hidden = true;
  messages.innerHTML = "";
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 無視 */ }
  showEmptyState();
}

/* =========================================================
 * 初期化
 * ======================================================= */

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");

  input.addEventListener("change", () => handleFiles(input.files));

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
    handleFiles(ev.dataTransfer.files);
  });
  // ページ外へのドロップでブラウザがファイルを開いてしまうのを防ぐ
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (ev) => {
      if (!dropzone.contains(ev.target)) ev.preventDefault();
    });
  }

  document.getElementById("btn-sample")
    .addEventListener("click", () => applySources([{ name: "sample.csv", text: SAMPLE_CSV }]));
  document.getElementById("btn-sample-27")
    .addEventListener("click", () => applySources([{ name: "sample-27.csv", text: SAMPLE_27_CSV }]));
  document.getElementById("btn-template")
    .addEventListener("click", () => downloadText("cf-template.csv", buildTemplateCSV()));
  document.getElementById("btn-export")
    .addEventListener("click", () => {
      if (state.companies.length) downloadText("cf-input.csv", buildTemplateCSV(state.companies));
    });
  document.getElementById("btn-clear").addEventListener("click", clearAll);

  document.getElementById("company-select").addEventListener("change", (ev) => {
    selectCompany(Number(ev.target.value));
  });
  document.getElementById("measure-select").addEventListener("change", (ev) => {
    state.measure = ev.target.value;
    document.getElementById("chart-measure-label").textContent =
      MEASURES.find((m) => m.key === state.measure).label;
    renderOverviewChart();
  });

  // 前回読み込んだCSVを復元
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved) && saved.length) applySources(saved);
  } catch (_) { /* 無視 */ }
});
