"use strict";

const STORAGE_KEY = "cf-visualization-csv-v3";
const TREND_QUARTERS = 10; // 推移グラフに表示する四半期数

const state = {
  datasets: [],       // [{ company, period, data, hasPrev, derivedPrev, cfAvailable, cf, checks, metrics }]
  byKey: new Map(),   // "会社\u0000四半期" → dataset
  byCompany: new Map(), // 会社 → 四半期昇順のdataset配列
  companies: [],
  periods: [],        // 四半期(昇順)
  company: "",
  period: "",
  measure: "operatingCF",
  sort: { key: null, dir: 1 },
  trendMode: "balance", // balance | delta
  sources: [],
  tab: "summary",
  previews: new Map(),  // ファイル名 → CSVプレビュー(必要になったとき作る)
  dataFile: 0,
  dataFilter: true,
  dataLimit: 200,
};

const DATA_PAGE = 500; // 「さらに表示」で増やす行数

/** 全社比較で選べる指標 */
const MEASURES = [
  { key: "operatingCF", label: "営業CF" },
  { key: "investingCF", label: "投資CF" },
  { key: "financingCF", label: "財務CF" },
  { key: "freeCF", label: "フリーCF" },
  { key: "netChange", label: "現金の増減額" },
  { key: "endingCash", label: "期末現金残高" },
  { key: "revenue", label: "売上高" },
  { key: "operatingIncome", label: "営業利益" },
  { key: "ebitda", label: "EBITDA" },
  { key: "workingCapital", label: "運転資金" },
  { key: "interestBearingDebt", label: "有利子負債" },
  { key: "netDebt", label: "ネット有利子負債" },
  { key: "deposits", label: "預け金" },
  { key: "roic", label: "ROIC", kind: "pct" },
  { key: "equityRatio", label: "自己資本比率", kind: "pct" },
];

/** 全社サマリー表の列 */
const OVERVIEW_COLS = [
  { key: "name", label: "会社名", type: "text" },
  { key: "revenue", label: "売上高" },
  { key: "ebitda", label: "EBITDA" },
  { key: "roic", label: "ROIC", kind: "pct" },
  { key: "workingCapital", label: "運転資金" },
  { key: "interestBearingDebt", label: "有利子負債" },
  { key: "deposits", label: "預け金" },
  { key: "operatingCF", label: "営業CF" },
  { key: "freeCF", label: "フリーCF" },
  { key: "endingCash", label: "期末残高" },
  { key: "ok", label: "整合", type: "check" },
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
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  const abs = Math.abs(rounded).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  return rounded < 0 ? `△${abs}` : abs;
}

// チャート・ツールチップ用: +1,234 / −1,234
function fmtSigned(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

function fmtPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const v = value * 100;
  return `${v < 0 ? "△" : ""}${Math.abs(v).toFixed(digits)}%`;
}

/** 指標の種類に応じた表示 */
function fmtBy(kind, value) {
  return kind === "pct" ? fmtPct(value) : fmt(value);
}

/** 軸ラベル用の短い四半期表記(2025Q1 → 25Q1) */
function shortPeriod(period) {
  return period.q ? `${String(period.year).slice(-2)}Q${period.q}` : period.label;
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

const keyOf = (company, periodLabel) => `${company}\u0000${periodLabel}`;

function currentDataset() {
  return state.byKey.get(keyOf(state.company, state.period)) || null;
}

/* =========================================================
 * CF計算(間接法)
 * ======================================================= */

function computeCF({ bs, pl, sup, ss }) {
  const d = (key) => bs.curr[key] - bs.prev[key]; // 当期末 − 前期末

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

  // 売却簿価 = 売却収入 − 売却損益、取得額 = ΔPPE + 減価償却費 + 売却簿価
  const bookValueSold = sup.saleProceeds - pl.gainOnSale;
  const tangibleAcquired = d("tangible") + pl.depreciation + bookValueSold;
  const investingItems = [
    { label: "有形固定資産の取得による支出", value: -tangibleAcquired },
    { label: "有形固定資産の売却による収入", value: sup.saleProceeds },
    { label: d("investments") >= 0 ? "投資その他の資産の取得による支出" : "投資その他の資産の減少による収入", value: -d("investments") },
    { label: d("deposits") >= 0 ? "預け金の預入による支出" : "預け金の払戻による収入", value: -d("deposits") },
  ];
  const investingCF = investingItems.reduce((s, i) => s + i.value, 0);

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

  return {
    operatingItems, subtotal, afterSubtotalItems, operatingCF,
    investingItems, investingCF,
    financingItems, financingCF,
    freeCF: operatingCF + investingCF,
    netChange, beginningCash, endingCash: beginningCash + netChange,
  };
}

/* =========================================================
 * 整合性チェック
 * ======================================================= */

function computeChecks({ bs, pl, ss }, cf) {
  const assets = (p) => bs[p].cash + bs[p].deposits + bs[p].receivables + bs[p].inventory +
    bs[p].otherCA + bs[p].tangible + bs[p].investments;
  const liabilities = (p) => bs[p].payables + bs[p].shortLoans + bs[p].otherCL + bs[p].longLoans;

  const checks = [];
  const periods = cf ? [["prev", "期首"], ["curr", "期末"]] : [["curr", "期末"]];
  for (const [p, name] of periods) {
    const diff = assets(p) - (liabilities(p) + bs[p].netAssets);
    checks.push({
      ok: Math.abs(diff) < 0.5,
      title: `BS貸借一致(${name})`,
      detail: Math.abs(diff) < 0.5
        ? `資産合計 ${fmt(assets(p))} = 負債・純資産合計 ${fmt(liabilities(p) + bs[p].netAssets)}`
        : `差額 ${fmt(diff)}(資産合計 ${fmt(assets(p))} / 負債・純資産合計 ${fmt(liabilities(p) + bs[p].netAssets)})`,
    });
  }

  if (cf) {
    const cashDiff = cf.endingCash - bs.curr.cash;
    checks.push({
      ok: Math.abs(cashDiff) < 0.5,
      title: "CF計算書とBSの現金残高の整合",
      detail: Math.abs(cashDiff) < 0.5
        ? `計算上の期末残高 ${fmt(cf.endingCash)} = BSの現金及び預金 ${fmt(bs.curr.cash)}`
        : `計算上の期末残高 ${fmt(cf.endingCash)} と BSの現金及び預金 ${fmt(bs.curr.cash)} に差額 ${fmt(cashDiff)} があります。`,
    });

    const netIncome = pl.pretaxIncome - pl.incomeTaxes;
    const expected = netIncome + ss.stockIssue - ss.dividendsPaid - ss.treasuryBuy + ss.treasurySell;
    const equityDiff = (bs.curr.netAssets - bs.prev.netAssets) - expected;
    checks.push({
      ok: Math.abs(equityDiff) < 0.5,
      title: "SSと純資産増減の整合(参考)",
      detail: Math.abs(equityDiff) < 0.5
        ? `純資産の増減 ${fmt(bs.curr.netAssets - bs.prev.netAssets)} = 純利益 + 増資 − 配当 − 自己株式取得 + 自己株式処分`
        : `純資産の増減 ${fmt(bs.curr.netAssets - bs.prev.netAssets)} と 変動事由の合計 ${fmt(expected)} に差額 ${fmt(equityDiff)} があります(その他の変動事由がある場合は差額が出ます)。`,
    });
  }
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

/** データ側の端だけ角を丸めた横向きバー */
function hBarPath(x0, x1, yTop, h, r = 4) {
  const w = Math.abs(x1 - x0);
  const rr = Math.min(r, w, h / 2);
  const yBot = yTop + h;
  if (x1 >= x0) {
    return `M${x0},${yTop} L${x1 - rr},${yTop} Q${x1},${yTop} ${x1},${yTop + rr} L${x1},${yBot - rr} Q${x1},${yBot} ${x1 - rr},${yBot} L${x0},${yBot} Z`;
  }
  return `M${x0},${yTop} L${x1 + rr},${yTop} Q${x1},${yTop} ${x1},${yTop + rr} L${x1},${yBot - rr} Q${x1},${yBot} ${x1 + rr},${yBot} L${x0},${yBot} Z`;
}

/** データ側の端だけ角を丸めた縦向きバー */
function vBarPath(x, w, yBase, yValue, r = 4) {
  const up = yValue <= yBase;
  const h = Math.abs(yBase - yValue);
  const rr = Math.min(r, h, w / 2);
  if (up) {
    return `M${x},${yBase} L${x},${yValue + rr} Q${x},${yValue} ${x + rr},${yValue} L${x + w - rr},${yValue} Q${x + w},${yValue} ${x + w},${yValue + rr} L${x + w},${yBase} Z`;
  }
  return `M${x},${yBase} L${x + w},${yBase} L${x + w},${yValue - rr} Q${x + w},${yValue} ${x + w - rr},${yValue} L${x + rr},${yValue} Q${x},${yValue} ${x},${yValue - rr} Z`;
}

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
 * 預け金・借入金の推移(選択中の会社)
 * ======================================================= */

const TREND_SERIES = [
  { key: "deposits", label: "預け金", cls: "s1" },
  { key: "interestBearingDebt", label: "借入金(有利子負債)", cls: "s2" },
];

function trendWindow() {
  const series = state.byCompany.get(state.company) || [];
  const at = series.findIndex((d) => d.period.label === state.period);
  const end = at >= 0 ? at + 1 : series.length;
  return { series, window: series.slice(Math.max(0, end - TREND_QUARTERS), end) };
}

function renderTrend() {
  const svg = document.getElementById("trend-chart");
  const tooltip = document.getElementById("tr-tooltip");
  svg.innerHTML = "";

  const { series, window: win } = trendWindow();
  const enough = win.length >= 2;
  document.getElementById("trend-empty").hidden = enough;
  document.getElementById("trend-count").textContent = `直近${win.length}四半期`;
  if (!enough) return;

  const delta = state.trendMode === "delta";
  const valueAt = (d, key) => {
    if (!delta) return d.metrics[key];
    const i = series.indexOf(d);
    const prev = i > 0 ? series[i - 1] : null;
    return prev ? d.metrics[key] - prev.metrics[key] : null;
  };

  const points = win.map((d) => ({
    period: d.period,
    values: TREND_SERIES.map((s) => valueAt(d, s.key)),
  }));
  const all = points.flatMap((p) => p.values).filter((v) => v !== null);
  if (all.length === 0) return;

  const W = 720, H = 300;
  const M = { top: 20, right: 78, bottom: 40, left: 84 }; // 右は終点ラベルの分を空ける
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const dataMin = Math.min(0, ...all);
  const dataMax = Math.max(0, ...all);
  const pad = (dataMax - dataMin || 1) * 0.08;
  const ticks = niceTicks(dataMin - (dataMin < 0 ? pad : 0), dataMax + pad);
  const lo = Math.min(dataMin, ticks[0]);
  const hi = Math.max(dataMax, ticks[ticks.length - 1]);
  const y = (v) => M.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / points.length;
  const cx = (i) => M.left + band * i + band / 2;

  for (const t of ticks) {
    svg.append(svgEl("line", {
      class: t === 0 ? "baseline" : "grid-line",
      x1: M.left, x2: M.left + plotW, y1: y(t), y2: y(t),
    }));
    const lbl = svgEl("text", { class: "tick-label", x: M.left - 8, y: y(t) + 4, "text-anchor": "end" });
    lbl.textContent = fmtSigned(t).replace("+", "");
    svg.append(lbl);
  }

  points.forEach((p, i) => {
    const lbl = svgEl("text", { class: "cat-label", x: cx(i), y: H - 14, "text-anchor": "middle" });
    lbl.textContent = shortPeriod(p.period);
    svg.append(lbl);
  });

  if (delta) {
    // 前四半期差は符号のあるフローなので、0を基準にした縦棒で表す
    const BAR_W = Math.min(24, (band - 6) / 2);
    points.forEach((p, i) => {
      p.values.forEach((v, s) => {
        if (v === null) return;
        const x = cx(i) - BAR_W - 1 + s * (BAR_W + 2); // 2pxの隙間で隣り合わせる
        svg.append(svgEl("path", {
          class: `bar series-${TREND_SERIES[s].cls}`,
          d: vBarPath(x, BAR_W, y(0), y(v)),
        }));
      });
    });
  } else {
    TREND_SERIES.forEach((s, si) => {
      const pts = points.map((p, i) => ({ x: cx(i), v: p.values[si] })).filter((p) => p.v !== null);
      if (pts.length === 0) return;
      svg.append(svgEl("path", {
        class: `line series-${s.cls}`,
        d: pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${y(p.v)}`).join(" "),
      }));
      for (const p of pts) {
        svg.append(svgEl("circle", { class: `dot series-${s.cls}`, cx: p.x, cy: y(p.v), r: 4 }));
      }
    });

    // 終点の直接ラベル(2本が近すぎるときは凡例とツールチップに任せる)
    const ends = TREND_SERIES.map((s, si) => {
      const last = [...points].reverse().find((p) => p.values[si] !== null);
      return last ? { v: last.values[si], y: y(last.values[si]) } : null;
    });
    const labelX = cx(points.length - 1) + 10;
    const roomy = ends.every((e) => !e || labelX + fmt(e.v).length * 7.5 <= W - 4);
    if (ends[0] && ends[1] && Math.abs(ends[0].y - ends[1].y) >= 16 && roomy) {
      for (const e of ends) {
        const t = svgEl("text", { class: "value-label", x: labelX, y: e.y + 4, "text-anchor": "start" });
        t.textContent = fmt(e.v);
        svg.append(t);
      }
    }
  }

  // ホバー: 縦のクロスヘアと、その四半期の全系列を出すツールチップ
  const crosshair = svgEl("line", { class: "crosshair", y1: M.top, y2: M.top + plotH, x1: 0, x2: 0 });
  crosshair.style.display = "none";
  svg.append(crosshair);

  points.forEach((p, i) => {
    const hit = svgEl("rect", { class: "hit", x: M.left + band * i, y: M.top, width: band, height: plotH });
    hit.addEventListener("mousemove", (ev) => {
      crosshair.style.display = "";
      crosshair.setAttribute("x1", cx(i));
      crosshair.setAttribute("x2", cx(i));
      tooltip.hidden = false;
      tooltip.innerHTML = "";
      tooltip.append(el("div", { class: "tt-title", text: p.period.label }));
      TREND_SERIES.forEach((s, si) => {
        const row = el("div", { class: "tt-row" });
        row.append(
          el("span", { class: `tt-swatch series-${s.cls}` }),
          el("span", { class: "tt-value", text: `${s.label}: ${delta ? fmtSigned(p.values[si]) : fmt(p.values[si])}` }),
        );
        tooltip.append(row);
      });
      positionTooltip(tooltip, svg, ev);
    });
    hit.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
      crosshair.style.display = "none";
    });
    svg.append(hit);
  });
}

/* =========================================================
 * 財務指標(前年同期比)
 * ======================================================= */

/** 前年同期のデータセット。四半期が解釈できない場合は4つ前で代用する */
function yoyDataset(dataset) {
  const series = state.byCompany.get(dataset.company) || [];
  if (dataset.period.year !== null) {
    const want = series.find((d) =>
      d.period.year === dataset.period.year - 1 && d.period.q === dataset.period.q);
    if (want) return want;
  }
  const i = series.indexOf(dataset);
  return i >= 4 ? series[i - 4] : null;
}

function renderMetrics() {
  const dataset = currentDataset();
  const table = document.getElementById("metrics-table");
  table.innerHTML = "";
  if (!dataset) return;

  const prevYear = yoyDataset(dataset);
  document.getElementById("metrics-subject").textContent =
    `${dataset.company} / ${dataset.period.label}`;
  document.getElementById("metrics-yoy-label").textContent =
    prevYear ? `前年同期(${prevYear.period.label})との比較` : "前年同期のデータがないため、増減は表示できません";

  const head = el("tr", {},
    el("th", { class: "label-col", scope: "col", text: "指標" }),
    el("th", { scope: "col", text: "当四半期" }),
    el("th", { scope: "col", text: "前年同期" }),
    el("th", { scope: "col", text: "増減" }),
    el("th", { scope: "col", text: "増減率" }),
  );
  table.append(el("thead", {}, head));

  const tbody = el("tbody");
  for (const row of METRIC_ROWS) {
    const cur = dataset.metrics[row.key];
    const old = prevYear ? prevYear.metrics[row.key] : null;

    const label = el("td", { class: "label" });
    label.append(row.label);
    if (row.note) label.append(el("span", { class: "metric-note", text: row.note }));
    if (row.key === "roic" && dataset.metrics.roicBasis) {
      label.append(el("span", { class: "metric-note", text: `年換算: ${dataset.metrics.roicBasis}` }));
    }

    const tr = el("tr", {}, label,
      el("td", { class: "num", text: fmtBy(row.kind, cur) }),
      el("td", { class: "num muted", text: fmtBy(row.kind, old) }),
    );

    // 比率はポイント差、金額は差額と変化率で見せる
    let diff = null, rate = null;
    if (cur !== null && old !== null && cur !== undefined && old !== undefined) {
      diff = cur - old;
      if (row.kind !== "pct" && old !== 0) rate = diff / Math.abs(old);
    }
    const diffText = diff === null ? "—"
      : row.kind === "pct" ? `${diff < 0 ? "△" : "+"}${Math.abs(diff * 100).toFixed(1)}pt`
        : fmtSigned(diff);
    // 色は「増えたか」ではなく「良くなったか」で付ける(有利子負債の減少は改善)
    let tone = "";
    if (row.good && diff !== null && diff !== 0) {
      const better = row.good === "up" ? diff > 0 : diff < 0;
      tone = better ? "up" : "down";
    }
    tr.append(el("td", { class: `num ${tone}`, text: diffText }));
    tr.append(el("td", {
      class: "num", text: rate === null ? "—" : `${rate < 0 ? "△" : "+"}${Math.abs(rate * 100).toFixed(1)}%`,
    }));
    tbody.append(tr);
  }
  table.append(tbody);

  const est = dataset.metrics.operatingIncomeEstimated;
  document.getElementById("metrics-estimate-note").hidden = !est;
}

/* =========================================================
 * 全社比較(選択中の四半期)
 * ======================================================= */

function overviewRows() {
  return state.companies
    .map((name) => state.byKey.get(keyOf(name, state.period)))
    .filter(Boolean)
    .map((d) => ({
      name: d.company,
      ok: d.checks.every((c) => c.ok),
      ...d.metrics,
    }));
}

function renderOverviewChart() {
  const svg = document.getElementById("overview-chart");
  const tooltip = document.getElementById("ov-tooltip");
  svg.innerHTML = "";

  const measure = MEASURES.find((m) => m.key === state.measure);
  const items = overviewRows()
    .map((r) => ({ name: r.name, value: r[measure.key] }))
    .filter((r) => r.value !== null && r.value !== undefined && !Number.isNaN(r.value))
    .sort((a, b) => b.value - a.value);

  const missing = overviewRows().length - items.length;
  const note = document.getElementById("overview-missing");
  note.hidden = missing === 0;
  note.textContent = missing ? `${missing}社はこの指標を算出できないため、グラフから除いています。` : "";
  if (items.length === 0) return;

  const ROW = 22, BAR_H = 12;
  const M = { top: 28, right: 76, bottom: 8, left: 132 };
  const W = 720;
  const plotW = W - M.left - M.right;
  const plotH = items.length * ROW;
  const H = M.top + plotH + M.bottom;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);

  const values = items.map((i) => i.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const x = (v) => M.left + ((v - lo) / (hi - lo || 1)) * plotW;
  const ticks = niceTicks(lo, hi).filter((t) => t >= lo && t <= hi);
  if (!ticks.includes(0)) ticks.push(0);

  for (const t of ticks) {
    svg.append(svgEl("line", {
      class: t === 0 ? "baseline" : "grid-line",
      x1: x(t), x2: x(t), y1: M.top - 6, y2: M.top + plotH,
    }));
    const lbl = svgEl("text", { class: "tick-label", x: x(t), y: M.top - 12, "text-anchor": "middle" });
    lbl.textContent = measure.kind === "pct" ? fmtPct(t, 0) : fmtSigned(t).replace("+", "");
    svg.append(lbl);
  }

  items.forEach((item, i) => {
    const yTop = M.top + i * ROW + (ROW - BAR_H) / 2;
    const g = svgEl("g", { class: "band" });

    const name = svgEl("text", {
      class: `cat-label row-name${item.name === state.company ? " is-selected" : ""}`,
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
    if (i === 0 || i === items.length - 1) {
      const text = measure.kind === "pct" ? fmtPct(item.value) : fmtSigned(item.value);
      const width = text.length * 7.5;
      const tip = x(item.value);
      const grows = item.value >= 0 ? 1 : -1;
      // 先端の外側に置く。はみ出す場合は、その行では空いている0の反対側へ逃がす
      const fits = grows > 0 ? tip + 8 + width <= W - 4 : tip - 8 - width >= M.left;
      const vl = svgEl("text", {
        class: "value-label",
        x: fits ? tip + grows * 8 : x(0) - grows * 8,
        y: yTop + BAR_H - 1,
        "text-anchor": fits ? (grows > 0 ? "start" : "end") : (grows > 0 ? "end" : "start"),
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
      const d = state.byKey.get(keyOf(item.name, state.period));
      tooltip.append(
        el("div", { class: "tt-title", text: item.name }),
        el("div", { class: "tt-value", text: `${measure.label}: ${fmtBy(measure.kind, item.value)}` }),
        el("div", { class: "tt-value", text: `営業CF: ${fmt(d.metrics.operatingCF)}` }),
        el("div", { class: "tt-hint", text: "クリックで明細を表示" }),
      );
      positionTooltip(tooltip, svg, ev);
    });
    hit.addEventListener("mouseleave", () => { tooltip.hidden = true; });
    hit.addEventListener("click", () => selectCompany(item.name));
    hit.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCompany(item.name); }
    });

    g.append(hit);
    svg.append(g);
  });
}

function renderOverviewTable() {
  const table = document.getElementById("overview-table");
  table.innerHTML = "";
  const rows = overviewRows();

  const { key, dir } = state.sort;
  if (key) {
    rows.sort((a, b) => {
      if (key === "name") return a.name.localeCompare(b.name, "ja") * dir;
      if (key === "ok") return ((a.ok ? 1 : 0) - (b.ok ? 1 : 0)) * dir;
      const av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av - bv) * dir;
    });
  }

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
      state.sort = key === col.key
        ? { key: col.key, dir: -dir }
        : { key: col.key, dir: col.type === "text" ? 1 : -1 };
      renderOverviewTable();
    };
    th.addEventListener("click", sort);
    th.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); sort(); }
    });
    htr.append(th);
  }
  table.append(el("thead", {}, htr));

  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", {
      class: r.name === state.company ? "is-selected" : "",
      role: "button", tabindex: "0", "aria-label": `${r.name}の明細を表示`,
    });
    tr.append(el("td", { class: "label", text: r.name }));
    for (const col of OVERVIEW_COLS.slice(1, -1)) {
      tr.append(el("td", { class: "num", text: fmtBy(col.kind, r[col.key]) }));
    }
    const okTd = el("td", { class: `num check-col ${r.ok ? "ok" : "ng"}`, text: r.ok ? "✓" : "!" });
    okTd.setAttribute("title", r.ok ? "整合性チェックはすべてOK" : "整合しない項目があります");
    tr.append(okTd);
    tr.addEventListener("click", () => selectCompany(r.name));
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCompany(r.name); }
    });
    tbody.append(tr);
  }
  table.append(tbody);

  // 合計行(比率は合算できないので空欄にする)
  const ftr = el("tr");
  ftr.append(el("td", { class: "label", text: `合計(${rows.length}社)` }));
  for (const col of OVERVIEW_COLS.slice(1, -1)) {
    if (col.kind === "pct") { ftr.append(el("td", { class: "num muted", text: "—" })); continue; }
    const vals = rows.map((r) => r[col.key]).filter((v) => v !== null && v !== undefined);
    ftr.append(el("td", { class: "num", text: vals.length ? fmt(vals.reduce((s, v) => s + v, 0)) : "—" }));
  }
  const ng = rows.filter((r) => !r.ok).length;
  ftr.append(el("td", { class: `num check-col ${ng ? "ng" : "ok"}`, text: ng ? `${ng}社` : "✓" }));
  table.append(el("tfoot", {}, ftr));
}

/* =========================================================
 * CF計算書とウォーターフォール
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

  let cum = 0;
  for (const s of steps) {
    if (s.type === "total") cum = s.to;
    else { s.from = cum; s.to = cum + s.value; cum = s.to; }
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
    lbl.textContent = fmtSigned(t).replace("+", "");
    svg.append(lbl);
  }

  const band = plotW / steps.length;
  const BAR_W = Math.min(24, band * 0.5);

  steps.forEach((s, i) => {
    const cx = M.left + band * i + band / 2;
    const topY = y(Math.max(s.from, s.to));
    const botY = y(Math.min(s.from, s.to));
    const g = svgEl("g", { class: "band" });

    const cls = s.type === "total" ? "bar-total" : s.value >= 0 ? "bar-pos" : "bar-neg";
    const roundTop = s.type === "total" ? s.to >= 0 : s.value >= 0;
    // データ端(増加・残高は上端、減少は下端)だけ角を丸める
    const yBase = roundTop ? botY : topY;
    const yValue = roundTop ? topY : botY;
    g.append(svgEl("path", { class: `bar ${cls}`, d: vBarPath(cx - BAR_W / 2, BAR_W, yBase, yValue) }));

    if (i > 0) {
      const prev = steps[i - 1];
      const prevCx = M.left + band * (i - 1) + band / 2;
      g.append(svgEl("line", {
        class: "connector",
        x1: prevCx + BAR_W / 2, x2: cx - BAR_W / 2, y1: y(prev.to), y2: y(prev.to),
      }));
    }

    const vl = svgEl("text", {
      class: "value-label", x: cx, y: roundTop ? topY - 6 : botY + 14, "text-anchor": "middle",
    });
    vl.textContent = s.type === "total" ? fmt(s.value) : fmtSigned(s.value);
    g.append(vl);

    const cl = svgEl("text", { class: "cat-label", x: cx, y: H - 12, "text-anchor": "middle" });
    cl.textContent = s.label;
    g.append(cl);

    const hit = svgEl("rect", { class: "hit", x: M.left + band * i, y: M.top, width: band, height: plotH });
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

function renderChecks(checks) {
  const wrap = document.getElementById("checks");
  wrap.innerHTML = "";
  wrap.hidden = checks.length === 0;
  for (const c of checks) {
    wrap.append(el("div", { class: `check ${c.ok ? "ok" : "ng"}` },
      el("span", { class: "icon", text: c.ok ? "✓" : "!" }),
      el("span", { text: c.title }),
      el("span", { class: "detail", text: c.detail }),
    ));
  }
}

function renderMessages(errors, warnings) {
  const wrap = document.getElementById("messages");
  wrap.innerHTML = "";
  const MAX = 12;
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
 * データ(CSVプレビュー)
 * ======================================================= */

/**
 * CSVを表示用に分解する。会社名・四半期は解析時と同じく直前の行から
 * 引き継ぐので、絞り込みが実際の取り込み結果と一致する。
 */
function buildPreview(src) {
  if (state.previews.has(src.name)) return state.previews.get(src.name);

  const rows = parseDelimited(src.text, detectDelimiter(src.text));
  const layout = findHeader(rows) || inferLayout(rows);
  const cols = layout ? layout.cols : null;
  const header = layout && layout.headerRow >= 0 ? rows[layout.headerRow] : null;

  const out = [];
  let company = baseName(src.name);
  let period = NO_PERIOD.label;
  for (let i = layout ? layout.headerRow + 1 : 0; i < rows.length; i++) {
    if (cols && cols.company !== null) {
      const c = (rows[i][cols.company] || "").trim();
      if (c !== "") company = c;
    }
    if (cols && cols.period !== null) {
      const p = parsePeriod(rows[i][cols.period]);
      if (p) period = p.label;
    }
    out.push({ n: i + 1, cells: rows[i], company, period });
  }

  const width = Math.max(header ? header.length : 0, ...out.map((r) => r.cells.length), 1);
  const preview = { header, rows: out, cols, width };
  state.previews.set(src.name, preview);
  return preview;
}

function renderData() {
  const table = document.getElementById("data-table");
  table.innerHTML = "";
  if (state.sources.length === 0) return;

  const fileSelect = document.getElementById("data-file");
  if (fileSelect.options.length !== state.sources.length) {
    fileSelect.innerHTML = "";
    state.sources.forEach((s, i) => fileSelect.append(el("option", { value: String(i), text: s.name })));
  }
  fileSelect.value = String(state.dataFile);
  document.getElementById("data-file-field").hidden = state.sources.length <= 1;

  const src = state.sources[state.dataFile] || state.sources[0];
  const preview = buildPreview(src);
  const all = preview.rows;
  const filtered = state.dataFilter
    ? all.filter((r) => r.company === state.company && r.period === state.period)
    : all;
  const shown = filtered.slice(0, state.dataLimit);

  document.getElementById("data-count").textContent = `${all.length.toLocaleString("ja-JP")}行`;

  // --- 見出し(行番号 + CSVの列) ---
  const htr = el("tr");
  htr.append(el("th", { class: "rownum", scope: "col", text: "行" }));
  for (let c = 0; c < preview.width; c++) {
    const name = preview.header && preview.header[c] ? preview.header[c].trim() : `列${c + 1}`;
    htr.append(el("th", { scope: "col", text: name || `列${c + 1}` }));
  }
  table.append(el("thead", {}, htr));

  // --- 明細 ---
  const tbody = el("tbody");
  for (const row of shown) {
    const tr = el("tr");
    tr.append(el("th", { class: "rownum", scope: "row", text: String(row.n) }));
    for (let c = 0; c < preview.width; c++) {
      const raw = row.cells[c] === undefined ? "" : String(row.cells[c]).trim();
      tr.append(el("td", {
        class: raw === "" ? "empty" : isAmountLike(raw) ? "numeric" : "",
        text: raw === "" ? "—" : raw,
      }));
    }
    tbody.append(tr);
  }
  table.append(tbody);

  const scope = state.dataFilter ? `${state.company} / ${state.period} の` : "全";
  document.getElementById("data-shown").textContent = filtered.length === 0
    ? `${scope}行はありません。`
    : `${scope}${filtered.length.toLocaleString("ja-JP")}行のうち ${shown.length.toLocaleString("ja-JP")}行を表示中`;
  document.getElementById("data-more").hidden = shown.length >= filtered.length;
}

/* =========================================================
 * タブ
 * ======================================================= */

const TABS = [
  { id: "summary" },
  { id: "trend", needs: () => state.periods.length > 1 },
  { id: "cf" },
  { id: "overview", needs: () => state.companies.length > 1 },
  { id: "data" },
];

function visibleTabs() {
  return TABS.filter((t) => !t.needs || t.needs());
}

function selectTab(id) {
  if (!visibleTabs().some((t) => t.id === id)) id = "summary";
  state.tab = id;
  for (const t of TABS) {
    const btn = document.getElementById(`tab-${t.id}`);
    const panel = document.getElementById(`panel-${t.id}`);
    const active = t.id === id;
    btn.setAttribute("aria-selected", String(active));
    btn.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  // 表示された瞬間に最新の内容を描く(重い「データ」タブは開くまで作らない)
  if (id === "data") renderData();
  if (id === "trend") renderTrend();
  if (id === "overview") { renderOverviewChart(); renderOverviewTable(); }
}

function renderTabs() {
  const shown = visibleTabs().map((t) => t.id);
  for (const t of TABS) {
    document.getElementById(`tab-${t.id}`).hidden = !shown.includes(t.id);
  }
  selectTab(shown.includes(state.tab) ? state.tab : "summary");
}

/* =========================================================
 * 画面の組み立て
 * ======================================================= */

function selectCompany(name) {
  if (!state.byKey.has(keyOf(name, state.period))) return;
  state.company = name;
  state.dataLimit = 200;
  document.getElementById("company-select").value = name;
  renderAll();
  selectTab("summary");
  document.getElementById("tablist").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSelectors() {
  const companySelect = document.getElementById("company-select");
  companySelect.innerHTML = "";
  for (const name of state.companies) {
    companySelect.append(el("option", { value: name, text: name }));
  }
  companySelect.value = state.company;

  const periodSelect = document.getElementById("period-select");
  periodSelect.innerHTML = "";
  // 新しい四半期を上に出す
  for (const p of [...state.periods].reverse()) {
    periodSelect.append(el("option", { value: p.label, text: p.label }));
  }
  periodSelect.value = state.period;

  document.getElementById("company-field").hidden = state.companies.length <= 1;
  document.getElementById("period-field").hidden = state.periods.length <= 1;
  document.getElementById("selector-bar").hidden =
    state.companies.length <= 1 && state.periods.length <= 1;
}

function renderAll() {
  const dataset = currentDataset();
  const multi = state.companies.length > 1;

  document.getElementById("workspace").hidden = !dataset;
  document.getElementById("empty-state").hidden = !!dataset;
  document.getElementById("btn-clear").hidden = false;
  document.getElementById("btn-export").hidden = !dataset;
  if (!dataset) { renderChecks([]); return; }

  renderMetrics();
  renderChecks(dataset.checks);
  renderTrend();

  document.getElementById("statement-subject").textContent =
    `${dataset.company} / ${dataset.period.label}`;
  const hasCF = !!dataset.cf;
  document.getElementById("cf-body").hidden = !hasCF;
  document.getElementById("cf-unavailable").hidden = hasCF;
  if (hasCF) {
    renderStatement(dataset.cf);
    renderWaterfall(dataset.cf);
  }

  if (multi) {
    document.getElementById("overview-subject").textContent = state.period;
    document.getElementById("overview-count").textContent = `${overviewRows().length}社`;
    const picker = document.getElementById("measure-select");
    if (!picker.options.length) {
      for (const m of MEASURES) picker.append(el("option", { value: m.key, text: m.label }));
    }
    picker.value = state.measure;
    document.getElementById("chart-measure-label").textContent =
      MEASURES.find((m) => m.key === state.measure).label;
    renderOverviewChart();
    renderOverviewTable();
  }

  renderTabs();
}

function showEmptyState() {
  document.getElementById("selector-bar").hidden = true;
  document.getElementById("workspace").hidden = true;
  document.getElementById("empty-state").hidden = false;
  document.getElementById("btn-clear").hidden = true;
  document.getElementById("btn-export").hidden = true;
}

/* =========================================================
 * 読み込み
 * ======================================================= */

function baseName(filename) {
  return filename.replace(/\.[^.]+$/, "") || filename;
}

/** 会社×四半期のデータセットを組み立て、CF・チェック・指標を計算する */
function buildState(datasets, warnings) {
  state.datasets = datasets;
  state.byKey = new Map();
  state.byCompany = new Map();

  const companies = [];
  const periods = new Map();
  for (const d of datasets) {
    if (!state.byCompany.has(d.company)) { state.byCompany.set(d.company, []); companies.push(d.company); }
    state.byCompany.get(d.company).push(d);
    state.byKey.set(keyOf(d.company, d.period.label), d);
    periods.set(d.period.label, d.period);
  }
  state.companies = companies;
  state.periods = [...periods.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  let derived = 0, noPrev = 0;
  for (const [, series] of state.byCompany) {
    series.sort((a, b) => a.period.sortKey.localeCompare(b.period.sortKey));

    series.forEach((d, i) => {
      // 前期末が未入力なら、直前の四半期の当期末を期首として引き継ぐ
      if (!d.hasPrev && i > 0) {
        d.data.bs.prev = { ...series[i - 1].data.bs.curr };
        d.derivedPrev = true;
        derived++;
      }
      d.cfAvailable = d.hasPrev || !!d.derivedPrev;
      d.cf = d.cfAvailable ? computeCF(d.data) : null;
      d.checks = computeChecks(d.data, d.cf);
      d.metrics = computeBaseMetrics(d.data, d.cf);
      if (!d.cfAvailable) noPrev++;
    });
    finalizeROIC(series);
  }

  if (derived > 0) {
    warnings.push(`${derived}件の四半期は、前の四半期の期末残高を期首として計算しました。`);
  }
  if (noPrev > 0) {
    warnings.push(`${noPrev}件の四半期は期首のBSがないため、CF計算書を作成できません(前の四半期を追加するか「前期末」列を入力してください)。`);
  }

  // 既定は最新の四半期・最初の会社
  const latest = state.periods[state.periods.length - 1];
  state.period = latest ? latest.label : "";
  state.company = state.companies[0] || "";
  if (!state.byKey.has(keyOf(state.company, state.period))) {
    const fallback = state.companies.find((c) => state.byKey.has(keyOf(c, state.period)));
    if (fallback) state.company = fallback;
  }
  state.sort = { key: null, dir: 1 };
}

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

    for (const ds of result.datasets) {
      const key = keyOf(ds.company, ds.period.label);
      if (!merged.has(key)) { merged.set(key, ds); continue; }
      warnings.push(`「${ds.company} / ${ds.period.label}」のデータが複数の箇所にあります。合算して扱います。`);
      const acc = merged.get(key);
      for (const k of Object.keys(acc.data.bs.prev)) {
        acc.data.bs.prev[k] += ds.data.bs.prev[k];
        acc.data.bs.curr[k] += ds.data.bs.curr[k];
      }
      for (const section of ["pl", "sup", "ss"]) {
        for (const k of Object.keys(acc.data[section])) acc.data[section][k] += ds.data[section][k];
      }
      acc.hasPrev = acc.hasPrev || ds.hasPrev;
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
    state.datasets = [];
    showEmptyState();
    document.getElementById("btn-clear").hidden = false;
    return;
  }

  buildState([...merged.values()], warnings);
  state.sources = sources;
  state.previews = new Map();
  state.dataFile = 0;
  state.dataLimit = 200;
  document.getElementById("data-file").innerHTML = "";

  const periodText = state.periods.length > 1 ? ` / ${state.periods.length}四半期` : "";
  status.textContent = `${label} を読み込みました(${state.companies.length}社${periodText} / ${matched}件の科目を認識)`;
  status.className = "file-status ok";
  renderMessages(errors, warnings);
  renderSelectors();
  renderAll();

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
  state.datasets = [];
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
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (ev) => {
      if (!dropzone.contains(ev.target)) ev.preventDefault();
    });
  }

  document.getElementById("btn-sample-27")
    .addEventListener("click", () => applySources([{ name: "sample-27.csv", text: SAMPLE_27_CSV }]));
  document.getElementById("btn-sample")
    .addEventListener("click", () => applySources([{ name: "sample.csv", text: SAMPLE_CSV }]));
  document.getElementById("btn-template")
    .addEventListener("click", () => downloadText("cf-template.csv", buildTemplateCSV()));
  document.getElementById("btn-export")
    .addEventListener("click", () => {
      if (state.datasets.length) downloadText("cf-input.csv", buildTemplateCSV(state.datasets));
    });
  document.getElementById("btn-clear").addEventListener("click", clearAll);

  document.getElementById("company-select").addEventListener("change", (ev) => {
    state.company = ev.target.value;
    state.dataLimit = 200;
    renderAll();
    if (state.tab === "data") renderData();
  });
  document.getElementById("period-select").addEventListener("change", (ev) => {
    state.period = ev.target.value;
    state.dataLimit = 200;
    // 選んだ四半期にその会社のデータがなければ、ある会社へ寄せる
    if (!state.byKey.has(keyOf(state.company, state.period))) {
      const fallback = state.companies.find((c) => state.byKey.has(keyOf(c, state.period)));
      if (fallback) { state.company = fallback; document.getElementById("company-select").value = fallback; }
    }
    renderAll();
    if (state.tab === "data") renderData();
  });

  // --- タブ(クリックと矢印キー) ---
  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => selectTab(btn.dataset.tab));
    btn.addEventListener("keydown", (ev) => {
      // 起点は「選択中」ではなくフォーカス中のタブ(両者はずれることがある)
      const ids = visibleTabs().map((t) => t.id);
      const i = ids.indexOf(btn.dataset.tab);
      if (i < 0) return;
      let next = null;
      if (ev.key === "ArrowRight") next = ids[(i + 1) % ids.length];
      else if (ev.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length];
      else if (ev.key === "Home") next = ids[0];
      else if (ev.key === "End") next = ids[ids.length - 1];
      if (next) {
        ev.preventDefault();
        selectTab(next);
        document.getElementById(`tab-${next}`).focus();
      }
    });
  }

  // --- データタブ ---
  document.getElementById("data-file").addEventListener("change", (ev) => {
    state.dataFile = Number(ev.target.value);
    state.dataLimit = 200;
    renderData();
  });
  document.getElementById("data-filter").addEventListener("change", (ev) => {
    state.dataFilter = ev.target.checked;
    state.dataLimit = 200;
    renderData();
  });
  document.getElementById("data-more").addEventListener("click", () => {
    state.dataLimit += DATA_PAGE;
    renderData();
  });
  document.getElementById("measure-select").addEventListener("change", (ev) => {
    state.measure = ev.target.value;
    document.getElementById("chart-measure-label").textContent =
      MEASURES.find((m) => m.key === state.measure).label;
    renderOverviewChart();
  });
  for (const radio of document.querySelectorAll('input[name="trend-mode"]')) {
    radio.addEventListener("change", (ev) => {
      state.trendMode = ev.target.value;
      renderTrend();
    });
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved) && saved.length) applySources(saved);
  } catch (_) { /* 無視 */ }
});
