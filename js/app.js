"use strict";

const STORAGE_KEY = "cf-visualization-csv-v4";
// 以前の版で保存したデータは引き継がない(仕様が変わっているため)
const OBSOLETE_STORAGE_KEYS = [
  "cf-visualization-inputs-v1",
  "cf-visualization-csv-v1",
  "cf-visualization-csv-v2",
  "cf-visualization-csv-v3",
];
const TREND_QUARTERS = 8; // 推移グラフに表示する四半期数
// 算定ロジックの図。狭い画面では縮めず枠の中で横スクロールさせ、
// 広い画面では間延びしないよう上限で止めて中央に置く
const DIAGRAM_MIN_W = 560;
const DIAGRAM_MAX_W = 1040;
/**
 * 利息及び配当金の表示区分。日本基準では継続適用を条件に2方式の選択が認められている。
 *  operating          … 受取利息・受取配当金・支払利息を営業、支払配当金を財務
 *  investingFinancing … 受取利息・受取配当金を投資、支払利息・支払配当金を財務
 */
const INTEREST_POLICY_DEFAULT = "operating";
const INTEREST_POLICIES = [
  { key: "operating", label: "受取利息・配当金と支払利息を営業CFに表示(支払配当金は財務CF)" },
  { key: "investingFinancing", label: "受取利息・配当金は投資CF、支払利息は財務CFに表示" },
];


const state = {
  datasets: [],       // [{ company, period, data, hasPrev, derivedPrev, cfAvailable, cf, checks, metrics }]
  byKey: new Map(),   // "会社\u0000四半期" → dataset
  byCompany: new Map(), // 会社 → 四半期昇順のdataset配列
  companies: [],
  periods: [],        // 四半期(昇順)
  company: "",
  period: "",
  measure: "operatingCF",
  sort: { key: "name", dir: 1 },  // 会社別サマリーの並び順
  trendMode: "balance", // balance | delta
  sources: [],
  tab: "summary",
  // 共有フォルダ連携の状態(dir はディレクトリハンドル)
  share: { dir: null, auto: true, stamps: new Map(), busy: false, timer: null, suppress: false, scheme: null, saved: false, folderPath: "",
    savedName: "", bannerText: "", bannerDismissed: false },
  derivLine: 0,           // 算定ロジックで選択中のCF行
  detailPreviewLimit: 20, // 詳細テンプレートのプレビュー行数
  overrides: {},          // 画面で手入力した詳細情報(ファイルに残らないので別途保存)
  mappingText: "",        // 科目マッピングCSVの原文(保存・共有用)
  mapping: null,          // parseMappingCSV の結果(entries)
  unmatchedNames: [],     // 読み込みで認識できなかった科目(マッピング編集の候補)
  resolvedNames: [],      // 読み込みで各科目をどう解釈したかの記録(読み込み内訳)
  layoutNotes: [],        // 各ファイルをどう読んだか(読み取り方)の記録
  interestPolicy: INTEREST_POLICY_DEFAULT,
};



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

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadText(filename, text) {
  // ExcelでそのままUTF-8として開けるようBOMを付ける
  downloadBlob(filename, new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
}

const keyOf = (company, periodLabel) => `${company}\u0000${periodLabel}`;

function currentDataset() {
  return state.byKey.get(keyOf(state.company, state.period)) || null;
}

/* =========================================================
 * CF計算(間接法)
 * ======================================================= */

/**
 * 間接法によるCF計算。
 *
 * detail(詳細情報)が入力されている項目は、仮定をやめて実態に沿った表示に切り替える。
 * 区分間の振替なので各区分の合計は変わるが、増減額と期末残高は
 * BSと articulate する事実なので変わらない。
 * 例外は現金同等物の範囲(bs.cashExcluded)で、これは現金同等物そのものの
 * 定義を変えるため増減額も正しく変わる。
 *
 * @param {object} data    emptyData() と同じ形
 * @param {Set<string>} provided "detail:impairment" のように実際に入力があったキー
 */
function computeCF(data, provided = new Set(), policy = INTEREST_POLICY_DEFAULT) {
  const { bs, pl, sup, ss, detail } = data;
  const d = (key) => bs.curr[key] - bs.prev[key]; // 当期末 − 前期末
  const has = (k) => provided.has(`detail:${k}`);
  const val = (k) => (has(k) ? detail[k] : 0);
  const notes = [];
  const used = [];
  const interestInFinancing = policy === "investingFinancing";

  const impairment = val("impairment");
  const retirement = val("retirement");
  const lease = val("leaseAcquisition");
  const fx = val("fxEffect");
  for (const k of ["impairment", "retirement", "leaseAcquisition", "fxEffect"]) if (val(k)) used.push(k);

  // --- 実際の受払額(未入力ならPLの発生額で代用) ---
  const intReceived = has("interestReceived") ? detail.interestReceived : pl.interestIncome;
  const intPaid = has("interestPaid") ? detail.interestPaid : pl.interestExpense;
  const taxPaid = has("taxPaid") ? detail.taxPaid : pl.incomeTaxes;
  for (const k of ["interestReceived", "interestPaid", "taxPaid"]) if (has(k)) used.push(k);

  // 発生額と実際額の差(未収利息・未払利息・未払法人税等の増減)は
  // 運転資本の増減に含まれているため、二重計上を避けて取り除く
  const accruedReceivable = pl.interestIncome - intReceived;
  const accruedInterest = pl.interestExpense - intPaid;
  const accruedTax = pl.incomeTaxes - taxPaid;
  const otherCADelta = d("otherCA") - accruedReceivable;
  const otherCLDelta = d("otherCL") - accruedInterest - accruedTax;
  const carved = accruedReceivable !== 0 || accruedInterest !== 0 || accruedTax !== 0;

  // --- Ⅰ 営業活動 ---
  const operatingItems = [
    { label: "税引前当期純利益", value: pl.pretaxIncome, always: true },
    { label: "減価償却費", value: pl.depreciation },
    { label: "減損損失", value: impairment, detailed: true },
    { label: "除却損", value: retirement, detailed: true },
    // ここから4行は、投資・財務や非資金の損益を営業から取り除くための消去
    { label: "為替差損益", value: -fx, detailed: true },
    { label: pl.gainOnSale >= 0 ? "固定資産売却益" : "固定資産売却損", value: -pl.gainOnSale },
    { label: "受取利息及び受取配当金", value: -pl.interestIncome },
    { label: "支払利息", value: pl.interestExpense },
    { label: "営業債権の増減", value: -d("receivables") },
    { label: "棚卸資産の増減", value: -d("inventory") },
    { label: "その他流動資産の増減" + (carved ? "(未収利息を除く)" : ""), value: -otherCADelta, detailed: carved },
    { label: "営業債務の増減", value: d("payables") },
    { label: "その他流動負債の増減" + (carved ? "(未払利息・未払法人税等を除く)" : ""), value: otherCLDelta, detailed: carved },
    { label: "その他固定負債の増減", value: d("otherFixedLiab") },
    { label: "退職給付引当金の増減", value: d("retirementBenefits") },
    { label: "法人税等の支払額", value: -taxPaid, detailed: has("taxPaid") },
  ];
  // 利息及び配当金の表示区分は継続適用を前提に選択できる
  if (!interestInFinancing) {
    operatingItems.push(
      { label: "利息及び配当金の受取額", value: intReceived, detailed: has("interestReceived") },
      { label: "利息の支払額", value: -intPaid, detailed: has("interestPaid") },
    );
  }
  const operatingCF = operatingItems.reduce((s, i) => s + i.value, 0);

  // --- Ⅱ 投資活動 ---
  // Δ有形固定資産 = 現金取得 + リース取得 − 減価償却費 − 売却簿価 − 減損 − 除却
  const bookValueSold = sup.saleProceeds - pl.gainOnSale;
  const tangibleAcquired = d("tangible") + pl.depreciation + bookValueSold
    + impairment + retirement - lease;
  // 設備投資の実額(計画・実績)があればそれを使う。BSからの逆算との差は
  // 未払金による取得・非資金の取得などなので「その他の投資」に含め、
  // 投資CFの合計と増減額は変えない
  let capexOutflow = tangibleAcquired;
  let capexGap = 0;
  if (has("capex")) {
    used.push("capex");
    capexOutflow = val("capex");
    capexGap = tangibleAcquired - capexOutflow;
    if (Math.abs(capexGap) >= 0.5) {
      notes.push(`固定資産の取得による支出の実額 ${fmt(capexOutflow)} と、BSからの逆算 ${fmt(tangibleAcquired)} に差があります。差額 ${fmt(capexGap)} は「その他の投資」に含めています(未払金による取得・非資金の取得などが考えられます)。`);
    }
  }
  // その他の投資 = 投資その他の資産 + 預け金 + 現金同等物に含めない預金 の増減(すべて純額)
  const otherInvesting = -(d("investments") + d("deposits") + d("cashExcluded")) - capexGap;
  const investingItems = [
    { label: "固定資産の取得による支出", value: -capexOutflow, detailed: has("capex") },
    { label: "固定資産の売却による収入", value: sup.saleProceeds },
    { label: "その他の投資", value: otherInvesting },
  ];
  if (interestInFinancing) {
    investingItems.push({ label: "利息及び配当金の受取額", value: intReceived, detailed: true });
  }
  const investingCF = investingItems.reduce((s, i) => s + i.value, 0);
  const freeCF = operatingCF + investingCF;

  // --- Ⅲ 財務活動 ---
  const gross = (proceedsKey, repaymentKey, net, name) => {
    if (!has(proceedsKey) && !has(repaymentKey)) return null;
    const proceeds = val(proceedsKey), repayment = val(repaymentKey);
    if (Math.abs((proceeds - repayment) - net) >= 0.5) {
      notes.push(`${name}の総額(収入 ${fmt(proceeds)} − 支出 ${fmt(repayment)})がBSの増減 ${fmt(net)} と一致しないため、収支(純額)で表示しています。`);
      return null;
    }
    used.push(proceedsKey, repaymentKey);
    return { proceeds, repayment };
  };

  const shortNet = d("shortLoans");
  const longNet = d("longLoans") - lease; // リース債務は現金の借入れではない
  const shortGross = gross("shortLoanProceeds", "shortLoanRepayment", shortNet, "短期借入債務");
  const longGross = gross("longLoanProceeds", "longLoanRepayment", longNet, "長期借入債務");

  const financingItems = [];
  if (shortGross) {
    financingItems.push(
      { label: "短期借入れによる収入", value: shortGross.proceeds, detailed: true },
      { label: "短期借入金の返済による支出", value: -shortGross.repayment, detailed: true },
    );
  } else {
    financingItems.push({ label: "短期借入債務の収支", value: shortNet });
  }
  if (longGross) {
    financingItems.push(
      { label: "長期借入れによる収入", value: longGross.proceeds, detailed: true },
      { label: "長期借入金の返済による支出", value: -longGross.repayment, detailed: true },
    );
  } else {
    financingItems.push({ label: "長期借入債務の収支", value: longNet });
  }
  if (interestInFinancing) {
    financingItems.push({ label: "利息の支払額", value: -intPaid, detailed: true });
  }
  // その他の財務 = 株式の発行 − 自己株式の取得 + 自己株式の処分
  financingItems.push(
    { label: "その他の財務", value: ss.stockIssue - ss.treasuryBuy + ss.treasurySell },
    { label: "配当金の支払額", value: -ss.dividendsPaid },
  );
  const financingCF = financingItems.reduce((s, i) => s + i.value, 0);

  // --- 換算差額 / 増減額 ---
  const fxItems = fx !== 0 ? [{ label: "現金及び現金同等物に係る換算差額", value: fx, detailed: true }] : [];
  const netChange = operatingCF + investingCF + financingCF + fx;
  const beginningCash = bs.prev.cash - bs.prev.cashExcluded;

  return {
    operatingItems, operatingCF,
    investingItems, investingCF,
    freeCF,
    financingItems, financingCF,
    fxItems,
    netChange, beginningCash, endingCash: beginningCash + netChange,
    nonCash: lease ? [{ label: "ファイナンスリースによる資産取得額", value: lease }] : [],
    notes, usedDetail: [...new Set(used)],
  };
}

/* =========================================================
 * 整合性チェック
 * ======================================================= */

function computeChecks({ bs, pl, ss }, cf) {
  const assets = (p) => bs[p].cash + bs[p].deposits + bs[p].receivables + bs[p].inventory +
    bs[p].otherCA + bs[p].tangible + bs[p].investments;
  const liabilities = (p) => bs[p].payables + bs[p].shortLoans + bs[p].otherCL +
    bs[p].longLoans + bs[p].otherFixedLiab + bs[p].retirementBenefits;

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
    const cashEq = bs.curr.cash - bs.curr.cashExcluded;
    const cashLabel = bs.curr.cashExcluded !== 0
      ? `BSの現金及び預金 − 現金同等物に含めない預金 ${fmt(cashEq)}`
      : `BSの現金及び預金 ${fmt(cashEq)}`;
    const cashDiff = cf.endingCash - cashEq;
    checks.push({
      ok: Math.abs(cashDiff) < 0.5,
      title: "CF計算書とBSの現金残高の整合",
      detail: Math.abs(cashDiff) < 0.5
        ? `計算上の期末残高 ${fmt(cf.endingCash)} = ${cashLabel}`
        : `計算上の期末残高 ${fmt(cf.endingCash)} と ${cashLabel} に差額 ${fmt(cashDiff)} があります。`,
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

/**
 * コンテナ幅に合わせて等倍(1単位 = 1px)で描くための幅を決める。
 * viewBox で引き伸ばすと文字も線も一緒に拡大されてしまうため、
 * 幅そのものを測ってから描く。
 */
function chartWidth(svg, min, max) {
  const avail = (svg.parentElement && svg.parentElement.clientWidth) || min;
  return Math.min(Math.max(Math.round(avail), min), max);
}

/** SVGテキストのおおよその幅(全角は1em、半角は約0.55em として見積もる) */
function textWidth(text, fontSize) {
  let em = 0;
  for (const ch of String(text)) em += /[\x20-\x7E｡-ﾟ]/.test(ch) ? 0.55 : 1;
  return em * fontSize;
}

/**
 * 指定幅に収まらない文字列を切り詰める。
 * 末尾が「(期末)」のような括弧書きなら、そこは残して手前を詰める。
 */
function fitLabel(text, fontSize, maxWidth) {
  const s = String(text);
  if (maxWidth <= 0 || textWidth(s, fontSize) <= maxWidth) return s;
  const m = s.match(/^(.+?)([(（][^()（）]{1,6}[)）])$/);
  if (m) {
    const tail = m[2];
    const head = ellipsize(m[1], fontSize, maxWidth - textWidth(tail, fontSize));
    if (head.length > 1) return head + tail;
  }
  return ellipsize(s, fontSize, maxWidth);
}

/** 指定幅に収まらない文字列を末尾「…」で切り詰める */
function ellipsize(text, fontSize, maxWidth) {
  const s = String(text);
  if (maxWidth <= 0 || textWidth(s, fontSize) <= maxWidth) return s;
  const room = maxWidth - textWidth("…", fontSize);
  let out = "", w = 0;
  for (const ch of s) {
    const cw = textWidth(ch, fontSize);
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  return out + "…";
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

/* 表の行にかざしたときの説明ツールチップ(サマリーのCF計算書・財務指標で使う) */

/** ラベル → 算定ロジックの項目 の索引 */
const DERIVATION_BY_LABEL = new Map();
for (const sec of DERIVATION) {
  for (const item of sec.items) {
    for (const l of item.labels) DERIVATION_BY_LABEL.set(l, item);
  }
}

/** 行の直下にツールチップを出す(container は position:relative の要素) */
function showRowTooltip(tooltip, container, ev, content) {
  tooltip.innerHTML = "";
  tooltip.append(content);
  tooltip.hidden = false;
  const rect = container.getBoundingClientRect();
  const tx = Math.min(ev.clientX - rect.left + 14, rect.width - tooltip.offsetWidth - 8);
  tooltip.style.left = `${Math.max(8, tx)}px`;
  tooltip.style.top = `${ev.clientY - rect.top + 18}px`;
}

/** 行にホバー(スマホではタップ)で説明を出す */
function bindRowTooltip(tr, tooltip, container, buildContent) {
  const move = (ev) => {
    const content = buildContent();
    if (!content) return;
    showRowTooltip(tooltip, container, ev, content);
  };
  tr.classList.add("has-note");
  tr.addEventListener("mousemove", move);
  tr.addEventListener("click", move);
  tr.addEventListener("mouseleave", () => { tooltip.hidden = true; });
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
  { key: "deposits", label: "預け金", short: "預け金", cls: "s1" },
  { key: "interestBearingDebt", label: "借入金(有利子負債)", short: "借入金", cls: "s2" },
];

/**
 * 表示する四半期の窓。会社ごとの系列ではなく全体の四半期軸から取るので、
 * その会社にデータのない四半期も「—」の列として必ず並ぶ
 * (一部の四半期を消したとき、窓が縮んで直近だけにならないように)。
 */
function trendWindow() {
  const at = state.periods.findIndex((p) => p.label === state.period);
  const end = at >= 0 ? at + 1 : state.periods.length;
  return state.periods.slice(Math.max(0, end - TREND_QUARTERS), end);
}

function renderTrend() {
  const svg = document.getElementById("trend-chart");
  const tooltip = document.getElementById("tr-tooltip");
  svg.innerHTML = "";

  const delta = state.trendMode === "delta";
  const win = trendWindow();
  const enough = win.length >= 2;
  document.getElementById("trend-empty").hidden = enough;
  document.getElementById("trend-count").textContent = `直近${win.length}四半期`;
  if (!enough) return;

  const points = win.map((p) => {
    const gi = state.periods.indexOf(p);
    const ds = state.byKey.get(keyOf(state.company, p.label));
    const prev = gi > 0 ? state.byKey.get(keyOf(state.company, state.periods[gi - 1].label)) : null;
    return {
      period: p,
      values: TREND_SERIES.map((s) => {
        if (!ds) return null;
        if (!delta) return ds.metrics[s.key];
        return prev ? ds.metrics[s.key] - prev.metrics[s.key] : null;
      }),
    };
  });
  const all = points.flatMap((p) => p.values).filter((v) => v !== null);
  if (all.length === 0) {
    document.getElementById("trend-empty").hidden = false;
    return;
  }

  // 下に系列ごとの数値2行を、同じ座標系で描き込む(ズレようがない)
  const VROW = 17;
  const W = chartWidth(svg, 460, 1400), H = 300 + 2 * VROW + 6;
  const M = { top: 20, right: 16, bottom: 40 + 2 * VROW + 6, left: 84 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

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

  const catY = M.top + plotH + 26;
  points.forEach((p, i) => {
    const lbl = svgEl("text", { class: "cat-label", x: cx(i), y: catY, "text-anchor": "middle" });
    lbl.textContent = shortPeriod(p.period);
    svg.append(lbl);
  });

  // --- 各棒の真下に数値。行の左端に 色の四角 + 系列名 を置く ---
  TREND_SERIES.forEach((s2, si) => {
    const rowY = catY + 19 + si * VROW;
    svg.append(svgEl("rect", {
      class: `bar series-${s2.cls} trend-row-swatch`,
      x: 10, y: rowY - 8.5, width: 10, height: 10, rx: 2,
    }));
    const name = svgEl("text", { class: "trend-row-label", x: 25, y: rowY });
    name.textContent = s2.short || s2.label;
    svg.append(name);
    points.forEach((p, i) => {
      const v = p.values[si];
      const t = svgEl("text", {
        class: `trend-num${v === null || v === undefined ? " muted" : ""}`,
        x: cx(i), y: rowY, "text-anchor": "middle",
      });
      t.textContent = v === null || v === undefined ? "—" : delta ? fmtSigned(v) : fmt(v);
      svg.append(t);
    });
  });

  // 残高・前四半期差とも、0を基準にした縦棒で表す(2系列を隣り合わせる)
  const BAR_W = Math.min(24, (band - 8) / 2);
  points.forEach((p, i) => {
    p.values.forEach((v, si) => {
      if (v === null) return;
      const x = cx(i) - BAR_W - 1 + si * (BAR_W + 2); // 2pxの隙間で隣り合わせる
      svg.append(svgEl("path", {
        class: `bar series-${TREND_SERIES[si].cls}`,
        d: vBarPath(x, BAR_W, y(0), y(v)),
      }));
    });
  });

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
          el("span", { class: "tt-value",
            text: `${s.label}: ${p.values[si] == null ? "—" : delta ? fmtSigned(p.values[si]) : fmt(p.values[si])}` }),
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
    // 算式はかざしたときの補足として出す(常時は表示しない)
    const noteLines = [];
    if (row.note) noteLines.push(row.note);
    if (row.key === "roic" && dataset.metrics.roicBasis) {
      noteLines.push(`年換算: ${dataset.metrics.roicBasis}`);
    }

    const tr = el("tr", {}, label,
      el("td", { class: "num", text: fmtBy(row.kind, cur) }),
      el("td", { class: "num muted", text: fmtBy(row.kind, old) }),
    );
    if (noteLines.length) {
      bindRowTooltip(tr, document.getElementById("mt-tooltip"),
        document.getElementById("summary-card"), () => {
          const wrap = el("div", { class: "tt-formula" });
          wrap.append(el("div", { class: "tt-title", text: row.label }));
          for (const n of noteLines) wrap.append(el("div", { class: "tt-note", text: n }));
          return wrap;
        });
    }

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
  const W = chartWidth(svg, 640, 1200);
  const plotW = W - M.left - M.right;
  const plotH = items.length * ROW;
  const H = M.top + plotH + M.bottom;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
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
        el("div", { class: "tt-hint", text: "クリックで選択" }),
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

/* 会社別サマリーのカードに出す行。CF計算書と同じ並びにする */
const OVERVIEW_CF_ROWS = [
  { key: "operatingCF", label: "営業CF" },
  { key: "investingCF", label: "投資CF" },
  { key: "freeCF", label: "フリーCF" },
  { key: "financingCF", label: "財務CF" },
  { group: "現金及び現金同等物" },
  { key: "netChange", label: "増減額", indent: true },
  { key: "beginningCash", label: "期首残高", indent: true },
  { key: "endingCash", label: "期末残高", indent: true },
];

/** 並び替えの選択肢。数値は多い順、会社名は五十音順 */
const OVERVIEW_SORTS = [
  { key: "name", dir: 1, label: "会社名(五十音順)" },
  ...OVERVIEW_CF_ROWS.filter((r) => r.key).map((r) => ({
    key: r.key, dir: -1,
    label: `${r.group ? "" : ""}${r.indent ? `${r.label}(現金及び現金同等物)` : r.label}が多い順`,
  })),
  { key: "revenue", dir: -1, label: "売上高が多い順" },
  { key: "ebitda", dir: -1, label: "EBITDAが多い順" },
  { key: "ok", dir: 1, label: "整合しないものを先頭に" },
];

function renderOverviewSortPicker() {
  const select = document.getElementById("overview-sort");
  if (!select.options.length) {
    for (const o of OVERVIEW_SORTS) select.append(el("option", { value: o.key, text: o.label }));
    select.addEventListener("change", (ev) => {
      const picked = OVERVIEW_SORTS.find((o) => o.key === ev.target.value) || OVERVIEW_SORTS[0];
      state.sort = { key: picked.key, dir: picked.dir };
      renderOverviewCards();
    });
  }
  select.value = state.sort.key || "name";
}

function sortOverviewRows(rows) {
  const { key, dir } = state.sort;
  if (!key) return rows;
  return rows.sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name, "ja") * dir;
    if (key === "ok") return ((a.ok ? 1 : 0) - (b.ok ? 1 : 0)) * dir;
    const av = a[key], bv = b[key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av - bv) * dir;
  });
}

/**
 * 会社ごとに1枚のカード。CF計算書と同じ並びの行を縦に置き、
 * 各行を「今期 / 前年同期 / 増減」の3列で見せる。
 */
function renderOverviewCards() {
  const grid = document.getElementById("overview-cards");
  grid.innerHTML = "";
  renderOverviewSortPicker();
  const rows = sortOverviewRows(overviewRows());

  const card = (name, cur, old, { total = false, ok = null, selected = false } = {}) => {
    const box = el("div", { class: `company-card${total ? " is-total" : ""}${selected ? " is-selected" : ""}` });
    const head = el("div", { class: "company-card-head" });
    head.append(el("span", { class: "company-card-name", text: name }));
    if (ok !== null) {
      head.append(el("span", {
        class: `company-card-check ${ok ? "ok" : "ng"}`,
        text: ok ? "✓" : "!",
        title: ok ? "整合性チェックはすべてOK" : "整合しない項目があります",
      }));
    }
    box.append(head);

    const table = el("table", { class: "company-cf" });
    table.append(el("thead", {}, el("tr", {},
      el("th", { scope: "col", class: "label-col" }),
      el("th", { scope: "col", text: "今期" }),
      el("th", { scope: "col", text: "前年同期" }),
      el("th", { scope: "col", text: "増減" }),
    )));
    const tbody = el("tbody");
    for (const r of OVERVIEW_CF_ROWS) {
      if (r.group) {
        const tr = el("tr", { class: "group" });
        tr.append(el("th", { scope: "colgroup", colspan: "4", text: r.group }));
        tbody.append(tr);
        continue;
      }
      const a = cur(r.key), b = old ? old(r.key) : null;
      const diff = a !== null && a !== undefined && b !== null && b !== undefined ? a - b : null;
      const tr = el("tr", { class: r.indent ? "is-indent" : "" });
      tr.append(el("th", { scope: "row", text: r.label }));
      tr.append(el("td", { class: "num", text: fmt(a) }));
      tr.append(el("td", { class: "num muted", text: b === null || b === undefined ? "—" : fmt(b) }));
      // 増減の色は「増えた=良い」で付ける(投資CFは支出が多いほど小さくなる点に注意)
      const tone = diff === null || diff === 0 ? "" : diff > 0 ? "up" : "down";
      tr.append(el("td", { class: `num ${tone}`, text: diff === null ? "—" : fmtSigned(diff) }));
      tbody.append(tr);
    }
    table.append(tbody);
    box.append(table);
    return box;
  };

  for (const r of rows) {
    const ds = state.byKey.get(keyOf(r.name, state.period));
    const yoy = ds ? yoyDataset(ds) : null;
    const box = card(r.name, (k) => r[k], yoy ? (k) => yoy.metrics[k] : null,
      { ok: r.ok, selected: r.name === state.company });
    box.setAttribute("role", "button");
    box.setAttribute("tabindex", "0");
    box.setAttribute("aria-label", `${r.name}を選択`);
    box.addEventListener("click", () => selectCompany(r.name));
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCompany(r.name); }
    });
    grid.append(box);
  }

  // 合計のカード。前年同期は、全社そろっているときだけ出す
  // (一部の会社しか前年がないと、増減が実態とずれてしまうため)
  const yoyRows = rows
    .map((r) => {
      const ds = state.byKey.get(keyOf(r.name, state.period));
      const y = ds ? yoyDataset(ds) : null;
      return y ? y.metrics : null;
    })
    .filter(Boolean);
  const sum = (list, key) => {
    const vals = list.map((m) => m[key]).filter((v) => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  grid.append(card(`合計(${rows.length}社)`,
    (k) => sum(rows, k),
    yoyRows.length === rows.length && rows.length > 0 ? (k) => sum(yoyRows, k) : null,
    { total: true }));
}

/* =========================================================
 * CF計算書とウォーターフォール
 * ======================================================= */

/** CF計算書の行の説明(算定式 + 注記)。説明がない行は null */
function statementTooltipContent(label) {
  const bare = label.replace(/^[ⅠⅡⅢⅣⅤⅥⅦ]\s*/, "");
  const wrap = el("div", { class: "tt-formula" });
  wrap.append(el("div", { class: "tt-title", text: bare }));

  const totals = {
    "営業活動によるキャッシュ・フロー 合計": "Ⅰ 営業活動の各行をすべて足した合計です。",
    "投資活動によるキャッシュ・フロー 合計": "Ⅱ 投資活動の各行をすべて足した合計です。",
    "財務活動によるキャッシュ・フロー 合計": "Ⅲ 財務活動の各行をすべて足した合計です。",
  };
  if (totals[bare]) {
    wrap.append(el("div", { class: "tt-note", text: totals[bare] }));
    return wrap;
  }

  const item = DERIVATION_BY_LABEL.get(bare);
  if (!item) return null;
  const ds = currentDataset();
  const provided = ds ? ds.provided : new Set();
  wrap.append(formulaFor(activeInputs(item, provided), item.computed));
  if (item.note) wrap.append(el("div", { class: "tt-note", text: item.note }));
  if (item.assumption) wrap.append(el("div", { class: "tt-note", text: `簡便法の仮定: ${item.assumption}` }));
  return wrap;
}

function renderStatement(cf) {
  const table = document.getElementById("cf-statement");
  table.innerHTML = "";
  const tooltip = document.getElementById("st-tooltip");
  const container = document.getElementById("cf-body");
  tooltip.hidden = true;

  const row = (cls, label, value) => {
    const tr = el("tr", { class: cls });
    tr.append(el("td", { text: label }));
    const td = el("td", { class: "amount" });
    if (value !== null) td.textContent = fmt(value);
    tr.append(td);
    // かざすと算定式と説明が出る(説明のない見出し行などは何もしない)
    if (statementTooltipContent(label)) {
      bindRowTooltip(tr, tooltip, container, () => statementTooltipContent(label));
    }
    table.append(tr);
  };
  // 項目構成を確認できるよう、金額が0の行も省略せず表示する
  const items = (list) => {
    for (const i of list) {
      const tr = el("tr", { class: Math.abs(i.value) < 0.005 ? "item is-zero" : "item" });
      tr.append(el("td", { text: i.label }));
      tr.append(el("td", { class: "amount", text: fmt(i.value) }));
      if (statementTooltipContent(i.label)) {
        bindRowTooltip(tr, tooltip, container, () => statementTooltipContent(i.label));
      }
      table.append(tr);
    }
  };

  row("head", "Ⅰ 営業活動によるキャッシュ・フロー", null);
  items(cf.operatingItems);
  row("section-total", "営業活動によるキャッシュ・フロー 合計", cf.operatingCF);

  row("head", "Ⅱ 投資活動によるキャッシュ・フロー", null);
  items(cf.investingItems);
  row("section-total", "投資活動によるキャッシュ・フロー 合計", cf.investingCF);

  row("free", "フリー・キャッシュ・フロー", cf.freeCF);

  row("head", "Ⅲ 財務活動によるキャッシュ・フロー", null);
  items(cf.financingItems);
  row("section-total", "財務活動によるキャッシュ・フロー 合計", cf.financingCF);

  // 換算差額がある場合は3区分の外に置き、以降の番号を繰り下げる
  let n = 4;
  for (const i of cf.fxItems) { row("section-total", `Ⅳ ${i.label}`, i.value); n++; }
  const num = (offset) => ["Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ"][n - 4 + offset];
  row("grand", `${num(0)} 現金及び現金同等物の増減額`, cf.netChange);
  row("grand", `${num(1)} 現金及び現金同等物の期首残高`, cf.beginningCash);
  row("grand", `${num(2)} 現金及び現金同等物の期末残高`, cf.endingCash);

  if (cf.nonCash.length) {
    row("head", "(注記)重要な非資金取引", null);
    for (const i of cf.nonCash) row("item", i.label, i.value);
  }
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
 * 算定ロジック(選択した行の算定元を図示する)
 * ======================================================= */

/** すべてのCF行を、区分つきの一覧で返す */
function derivationLines() {
  return DERIVATION.flatMap((sec) => sec.items.map((item) => ({ sec, item })));
}

/** 選択中のデータでこの行が実際にいくらだったか(なければ null) */
function lineValue(labels) {
  const ds = currentDataset();
  if (!ds || !ds.cf) return null;
  const all = [
    ...ds.cf.operatingItems, ...ds.cf.investingItems, ...ds.cf.financingItems, ...ds.cf.fxItems,
    { label: "フリー・キャッシュ・フロー", value: ds.cf.freeCF },
    { label: "現金及び現金同等物の増減額", value: ds.cf.netChange },
    { label: "現金及び現金同等物の期首残高", value: ds.cf.beginningCash },
    { label: "現金及び現金同等物の期末残高", value: ds.cf.endingCash },
  ];
  const hit = all.find((i) => labels.includes(i.label));
  return hit ? hit.value : null;
}

/** data オブジェクトからパスで値を引く */
function valueAtPath(data, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data);
}

/** 詳細情報が入っていればそちらの入力定義を使う */
function activeInputs(item, provided) {
  const variants = item.detailVariants || (item.detailVariant ? [item.detailVariant] : []);
  for (const v of variants) {
    if (v.requires.every((k) => provided.has(`detail:${k}`))) return v.inputs;
  }
  return item.inputs || [];
}

function renderDerivationDiagram() {
  const svg = document.getElementById("deriv-diagram");
  svg.innerHTML = "";
  const lines = derivationLines();
  const picked = lines[state.derivLine] || lines[0];
  if (!picked) return;
  const { sec, item } = picked;

  const ds = currentDataset();
  const provided = ds ? ds.provided : new Set();
  const inputs = activeInputs(item, provided);

  document.getElementById("deriv-detail-note").hidden = inputs === (item.inputs || []);

  const rows = item.computed ? [] : inputs;
  const ROW = 44, TOP = 56;
  const H = TOP + Math.max(rows.length, 1) * ROW + 24;

  // 図はコンテナ幅にそのまま合わせて等倍で描く(viewBoxで拡大縮小しない)。
  // 狭いときだけ DIAGRAM_MIN_W まで詰め、それ以下は .chart-wrap が横スクロールする。
  const avail = svg.parentElement.clientWidth || DIAGRAM_MIN_W;
  const W = Math.min(Math.max(Math.round(avail), DIAGRAM_MIN_W), DIAGRAM_MAX_W);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  // 3列(算定に使う項目 / CF計算書の行 / 反映先)を幅に応じて配分する
  const PAD = 12, BADGE = 26;
  const GAP = Math.max(28, Math.round(W * 0.05));
  const inner = W - PAD * 2 - GAP * 2;
  const SW = Math.round(inner * 0.40);
  const CW = Math.round(inner * 0.33);
  const RW = inner - SW - CW;
  const SX = PAD;
  const CX = SX + SW + GAP;
  const RX = CX + CW + GAP;
  const midY = TOP + (Math.max(rows.length, 1) * ROW) / 2 - ROW / 2;

  const box = (x, y, w, h, cls, label, sub, value) => {
    const g = svgEl("g", {});
    g.append(svgEl("rect", { class: `flow-box ${cls}`, x, y, width: w, height: h, rx: 9 }));
    // 金額は2行目の右端に置くので、同じ行に来る補足だけ手前で切り上げる
    const valText = value !== undefined && value !== null ? fmt(value) : "";
    const reserve = valText ? textWidth(valText, 12) + 16 : 0;
    const twoLine = Boolean(sub) || Boolean(valText);
    // 枠の高さに合わせて2行を収める(下端に文字がぶつからないようにする)
    const line1 = y + (twoLine ? (h - 30) / 2 + 12 : h / 2 + 4);
    const line2 = y + (h - 30) / 2 + 26;
    const t = svgEl("text", { class: "flow-label", x: x + 12, y: line1 });
    t.textContent = fitLabel(label, 12, w - 24);
    // 枠に入りきらず省略したときは、ホバーで全文を読めるようにする
    if (t.textContent !== label) {
      const full = svgEl("title", {});
      full.textContent = label;
      g.append(full);
    }
    g.append(t);
    if (sub) {
      const e = svgEl("text", { class: "flow-sub", x: x + 12, y: line2 });
      e.textContent = fitLabel(sub, 11, w - 24 - reserve);
      g.append(e);
    }
    if (valText) {
      const v = svgEl("text", { class: "flow-value", x: x + w - 12, y: line2, "text-anchor": "end" });
      v.textContent = valText;
      g.append(v);
    }
    svg.append(g);
    return g;
  };

  // --- 入力側 ---
  if (rows.length === 0) {
    box(SX, midY, SW, 36, "sec", item.computed || "他の行から計算", null, undefined);
    svg.append(svgEl("path", {
      class: "flow-edge edge-calc",
      d: `M${SX + SW},${midY + 18} C${(SX + SW + CX) / 2},${midY + 18} ${(SX + SW + CX) / 2},${midY + 22} ${CX},${midY + 22}`,
    }));
  }
  rows.forEach((input, i) => {
    const y = TOP + i * ROW;
    const { kind, text } = describePath(input.path);
    const raw = ds ? valueAtPath(ds.data, input.path) : null;
    box(SX + 26, y, SW - 26, 36, `src-${kind}`, text, null, raw);

    // 足すか引くかを、線の手前のバッジで明示する
    const sign = svgEl("g", { class: `sign-badge ${input.sign > 0 ? "is-plus" : "is-minus"}` });
    sign.append(svgEl("circle", { cx: SX + 12, cy: y + 18, r: 11 }));
    const st = svgEl("text", { x: SX + 12, y: y + 22, "text-anchor": "middle" });
    st.textContent = input.sign > 0 ? "+" : "−";
    sign.append(st);
    svg.append(sign);

    const y1 = y + 18, y2 = midY + 22;
    svg.append(svgEl("path", {
      class: `flow-edge edge-${kind}`,
      d: `M${SX + SW},${y1} C${(SX + SW + CX) / 2},${y1} ${(SX + SW + CX) / 2},${y2} ${CX},${y2}`,
    }));
  });

  // --- 選択中の行 ---
  box(CX, midY, CW, 44, "result", item.labels[0], item.labels[1] ? `/ ${item.labels[1]}` : null,
    lineValue(item.labels));

  // --- 反映先 ---
  const secTotal = { operating: "営業CF", investing: "投資CF", financing: "財務CF", result: "現金及び現金同等物" }[sec.id];
  const secValue = ds && ds.cf
    ? { operating: ds.cf.operatingCF, investing: ds.cf.investingCF, financing: ds.cf.financingCF, result: ds.cf.endingCash }[sec.id]
    : null;
  svg.append(svgEl("path", {
    class: "flow-edge edge-calc",
    d: `M${CX + CW},${midY + 22} C${(CX + CW + RX) / 2},${midY + 22} ${(CX + CW + RX) / 2},${midY + 22} ${RX},${midY + 22}`,
  }));
  box(RX, midY, RW, 44, "sec", secTotal, sec.id === "result" ? null : "に合算", secValue);

  // --- 見出し ---
  for (const [x, w, label] of [[SX, SW, "算定に使う項目"], [CX, CW, "CF計算書の行"], [RX, RW, "反映先"]]) {
    const t = svgEl("text", { class: "flow-head", x: x + w / 2, y: 26, "text-anchor": "middle" });
    t.textContent = label;
    svg.append(t);
  }

  // 画面が狭くて図が枠に収まらないときだけ、横スクロールできることを伝える
  document.getElementById("deriv-scroll-hint").hidden = W <= svg.parentElement.clientWidth;
}

function renderDerivationPicker() {
  const select = document.getElementById("deriv-line-select");
  if (select.options.length) return;
  let index = 0;
  for (const sec of DERIVATION) {
    const group = el("optgroup", { label: sec.title });
    for (const item of sec.items) {
      group.append(el("option", { value: String(index), text: item.labels.join(" / ") }));
      index++;
    }
    select.append(group);
  }
  select.value = String(state.derivLine);
}

function renderDerivationText() {
  const wrap = document.getElementById("deriv-line-text");
  wrap.innerHTML = "";
  const picked = derivationLines()[state.derivLine];
  if (!picked) return;
  const { item } = picked;
  const ds = currentDataset();
  const provided = ds ? ds.provided : new Set();

  wrap.append(formulaFor(activeInputs(item, provided), item.computed));
  if (item.note) wrap.append(el("p", { class: "deriv-note", text: item.note }));
  if (item.assumption) {
    wrap.append(el("p", { class: "deriv-assumption" },
      el("span", { class: "icon", text: "!" }),
      el("span", { text: item.assumption })));
  }
  if (item.requires) {
    wrap.append(el("p", { class: "deriv-note", text:
      `この行は詳細情報(${item.requires.map((k) => DISPLAY_FIELDS.detail.find((f) => f.key === k).label).join("、")})を入力したときだけ表示されます。` }));
  }
}

function sourceChip(kind, text) {
  return el("span", { class: `deriv-chip chip-${kind}` },
    el("span", { class: "chip-dot", "aria-hidden": "true" }),
    el("span", { class: "chip-kind", text: SOURCE_KINDS[kind].label }),
    el("span", { class: "chip-text", text }));
}

/** inputs から算式を組み立てる */
function formulaFor(inputs, computed) {
  const wrap = el("div", { class: "deriv-formula" });
  if (computed) {
    wrap.append(el("span", { class: "deriv-chip chip-calc" },
      el("span", { class: "chip-dot", "aria-hidden": "true" }),
      el("span", { class: "chip-text", text: computed })));
  }
  (inputs || []).forEach((input, i) => {
    wrap.append(el("span", { class: "deriv-op", text: input.sign > 0 ? (i === 0 ? "" : "+") : "−" }));
    const { kind, text } = describePath(input.path);
    wrap.append(sourceChip(kind, text));
  });
  return wrap;
}

/** すべての行の算式を区分ごとに一覧表示する(静的) */
function renderDerivationList() {
  const wrap = document.getElementById("derivation-list");
  if (wrap.childElementCount > 0) return;

  for (const section of DERIVATION) {
    const card = el("div", { class: "card deriv-card" });
    card.append(el("h3", { text: section.title }));
    card.append(el("p", { class: "table-hint", text: section.lead }));

    for (const item of section.items) {
      const row = el("div", { class: `deriv-row${item.subtotal ? " is-subtotal" : ""}` });
      row.append(el("div", { class: "deriv-name", text: item.labels.join(" / ") }));
      row.append(formulaFor(item.inputs, item.computed));

      const variants = item.detailVariants || (item.detailVariant ? [item.detailVariant] : []);
      for (const v of variants) {
        row.append(el("p", { class: "deriv-note", text:
          `詳細情報(${v.requires.map((k) => DISPLAY_FIELDS.detail.find((f) => f.key === k).label).join("、")})を入力した場合:` }));
        const alt = formulaFor(v.inputs, null);
        alt.classList.add("is-variant");
        row.append(alt);
      }
      if (item.requires) {
        row.append(el("p", { class: "deriv-note", text:
          `詳細情報(${item.requires.map((k) => DISPLAY_FIELDS.detail.find((f) => f.key === k).label).join("、")})を入力したときだけ表示されます。` }));
      }
      if (item.note) row.append(el("p", { class: "deriv-note", text: item.note }));
      if (item.assumption) {
        row.append(el("p", { class: "deriv-assumption" },
          el("span", { class: "icon", text: "!" }),
          el("span", { text: item.assumption })));
      }
      card.append(row);
    }
    wrap.append(card);
  }
}

function renderAssumptions() {
  const wrap = document.getElementById("assumption-body");
  if (wrap.childElementCount > 0) return;

  for (const a of ASSUMPTIONS) {
    const div = el("div", { class: `assumption level-${a.level}` },
      el("div", { class: "assumption-head" },
        el("span", { class: "assumption-badge", text: a.level === "critical" ? "重要" : a.level === "high" ? "影響大" : "影響中" }),
        el("span", { class: "assumption-title", text: a.title }),
      ),
      el("p", { class: "assumption-body", text: a.body }),
    );
    if (a.fix) {
      div.append(el("p", { class: "assumption-fix" },
        el("span", { class: "icon", text: "→" }),
        el("span", { text: a.fix }),
      ));
    }
    wrap.append(div);
  }
}

function renderDerivation() {
  renderDerivationPicker();
  renderDerivationList();
  renderAssumptions();
  renderDerivationDiagram();
  renderDerivationText();
}

/* =========================================================
 * 詳細入力
 * ======================================================= */

/** 詳細情報だけのテンプレートCSV(読み込み済みの会社×四半期分) */
function buildDetailTemplate() {
  const lines = ["会社名,四半期,区分,科目,金額"];
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const targets = state.datasets.length
    ? state.datasets
    : [{ company: "A社", period: { label: "2025Q1" }, data: null, provided: new Set() }];
  for (const ds of targets) {
    for (const f of DISPLAY_FIELDS.detail) {
      const v = ds.data && ds.provided.has(`detail:${f.key}`) ? ds.data.detail[f.key] : "";
      lines.push(`${q(ds.company)},${q(ds.period.label)},詳細,${f.label},${v}`);
    }
    for (const f of DISPLAY_FIELDS.sup) {
      const v = ds.data && ds.data.sup[f.key] !== 0 ? ds.data.sup[f.key] : "";
      lines.push(`${q(ds.company)},${q(ds.period.label)},補足,${f.label},${v}`);
    }
  }
  return lines.join("\r\n") + "\r\n";
}

function renderPolicyPicker() {
  const wrap = document.getElementById("policy-form");
  if (wrap.childElementCount === 0) {
    for (const p of INTEREST_POLICIES) {
      const label = el("label", { class: "policy-option" });
      const radio = el("input", { type: "radio", name: "interest-policy", value: p.key });
      radio.addEventListener("change", () => {
        state.interestPolicy = p.key;
        for (const ds of state.datasets) recomputeDataset(ds);
        saveState();
        renderAll();
        renderDetailPanel();
      });
      label.append(radio, el("span", { text: p.label }));
      wrap.append(label);
    }
  }
  for (const r of wrap.querySelectorAll('input[name="interest-policy"]')) {
    r.checked = r.value === state.interestPolicy;
  }
}

function renderDetailPanel() {
  renderMissingNotice();
  const ds = currentDataset();
  document.getElementById("detail-subject").textContent = ds ? `${ds.company} / ${ds.period.label}` : "";
  renderPolicyPicker();

  // --- 入力フォーム ---
  const form = document.getElementById("detail-form");
  form.innerHTML = "";
  let lastGroup = null;
  for (const f of DISPLAY_FIELDS.detail) {
    if (f.group !== lastGroup) {
      lastGroup = f.group;
      const info = DETAIL_GROUPS.find((g) => g.group === f.group);
      const head = el("div", { class: "detail-group" });
      head.append(el("h4", { text: f.group }));
      if (info) {
        head.append(el("p", { class: "detail-lead", text: info.lead }));
        head.append(el("p", { class: "detail-effect", text: info.effect }));
      }
      form.append(head);
    }
    const has = ds && ds.provided.has(`detail:${f.key}`);
    const row = el("div", { class: `detail-row${has ? " is-set" : ""}` });
    const input = el("input", {
      type: "number", step: "any", inputmode: "decimal",
      id: `detail-${f.key}`, placeholder: "未入力", "aria-label": f.label,
    });
    if (has) input.value = String(ds.data.detail[f.key]);
    input.disabled = !ds;
    input.addEventListener("input", () => setDetailValue(f.key, input.value));
    row.append(
      el("label", { class: "detail-label", for: `detail-${f.key}`, text: f.label }),
      input,
      el("span", { class: "detail-state", text: has ? "反映中" : "" }),
    );
    form.append(row);
  }

  // --- 現金同等物に含めない預金(BSの2期分) ---
  const cashWrap = document.getElementById("cash-excluded-form");
  cashWrap.innerHTML = "";
  for (const [which, label] of [["prev", "期首"], ["curr", "期末"]]) {
    const row = el("div", { class: `detail-row${ds && ds.data.bs[which].cashExcluded ? " is-set" : ""}` });
    const input = el("input", {
      type: "number", step: "any", inputmode: "decimal",
      id: `cash-excluded-${which}`, placeholder: "0", "aria-label": `現金同等物に含めない預金(${label})`,
    });
    if (ds) input.value = ds.data.bs[which].cashExcluded ? String(ds.data.bs[which].cashExcluded) : "";
    input.disabled = !ds;
    input.addEventListener("input", () => setPathValue(`bs.${which}.cashExcluded`, input.value, `cash-excluded-${which}`));
    row.append(
      el("label", { class: "detail-label", for: `cash-excluded-${which}`, text: `現金同等物に含めない預金(${label})` }),
      input,
      el("span", { class: "detail-state", text: ds && ds.data.bs[which].cashExcluded ? "反映中" : "" }),
    );
    cashWrap.append(row);
  }

  // --- 固定資産の売却による収入(補足情報) ---
  const saleWrap = document.getElementById("sale-proceeds-form");
  saleWrap.innerHTML = "";
  {
    const set = ds && ds.data.sup.saleProceeds !== 0;
    const row = el("div", { class: `detail-row${set ? " is-set" : ""}` });
    const input = el("input", {
      type: "number", step: "any", min: "0", inputmode: "decimal",
      id: "sale-proceeds-input", placeholder: "未入力", "aria-label": "有形固定資産の売却による収入",
    });
    if (ds) input.value = set ? String(ds.data.sup.saleProceeds) : "";
    input.disabled = !ds;
    input.addEventListener("input", () => setPathValue("sup.saleProceeds", input.value, "sale-proceeds-input"));
    row.append(
      el("label", { class: "detail-label", for: "sale-proceeds-input", text: "有形固定資産の売却による収入" }),
      input,
      el("span", { class: "detail-state", text: set ? "反映中" : "" }),
    );
    saleWrap.append(row);
  }

  // --- 反映状況 ---
  const status = document.getElementById("detail-status");
  status.innerHTML = "";
  if (ds && ds.cf) {
    const used = ds.cf.usedDetail;
    status.append(el("span", {
      class: used.length ? "detail-applied" : "detail-none",
      text: used.length
        ? `${used.length}件の詳細情報を反映しています: ` +
          used.map((k) => DISPLAY_FIELDS.detail.find((f) => f.key === k).label).join("、")
        : "この会社・四半期には詳細情報が入力されていません(すべて簡便法の仮定で算定)。",
    }));
    for (const n of ds.cf.notes) {
      status.append(el("div", { class: "message warn" },
        el("span", { class: "icon", text: "!" }), el("span", { text: n })));
    }
  }

  // --- テンプレートのプレビュー ---
  renderDetailPreview();
}

function renderDetailPreview() {
  const table = document.getElementById("detail-preview");
  table.innerHTML = "";
  const rows = parseDelimited(buildDetailTemplate(), ",");
  const header = rows[0];
  const body = rows.slice(1, 1 + state.detailPreviewLimit);

  const htr = el("tr");
  htr.append(el("th", { class: "rownum", scope: "col", text: "行" }));
  for (const h of header) htr.append(el("th", { scope: "col", text: h }));
  table.append(el("thead", {}, htr));

  const tbody = el("tbody");
  body.forEach((r, i) => {
    const tr = el("tr");
    tr.append(el("th", { class: "rownum", scope: "row", text: String(i + 2) }));
    for (let c = 0; c < header.length; c++) {
      const raw = (r[c] || "").trim();
      tr.append(el("td", {
        class: raw === "" ? "empty" : isAmountLike(raw) ? "numeric" : "",
        text: raw === "" ? "(ここに記入)" : raw,
      }));
    }
    tbody.append(tr);
  });
  table.append(tbody);

  const total = rows.length - 1;
  document.getElementById("detail-preview-count").textContent =
    `${total.toLocaleString("ja-JP")}行(${body.length.toLocaleString("ja-JP")}行を表示)`;
  document.getElementById("detail-preview-more").hidden = body.length >= total;
}

/** BSの科目など、パスを指定して上書きする(手入力は overrides に記録して復元できるようにする) */
function setPathValue(path, raw, focusId) {
  const ds = currentDataset();
  if (!ds) return;
  const trimmed = String(raw).trim();
  const v = trimmed === "" ? 0 : Number(trimmed);
  if (trimmed !== "" && !Number.isFinite(v)) return;

  const keys = path.split(".");
  let target = ds.data;
  for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
  target[keys[keys.length - 1]] = v;

  const overrideKey = keyOf(ds.company, ds.period.label);
  const o = state.overrides[overrideKey] || (state.overrides[overrideKey] = {});
  if (trimmed === "") delete o[path]; else o[path] = v;
  if (Object.keys(o).length === 0) delete state.overrides[overrideKey];

  recomputeDataset(ds);
  saveState();
  renderAll();
  if (state.tab === "detail") {
    renderDetailPanel();
    const focus = focusId ? document.getElementById(focusId) : null;
    if (focus) focus.focus();
  }
}

/** フォームの入力を、選択中の会社・四半期に反映する */
function setDetailValue(key, raw) {
  const ds = currentDataset();
  if (!ds) return;
  const trimmed = String(raw).trim();
  const slot = `detail:${key}`;
  if (trimmed === "") {
    ds.provided.delete(slot);
    ds.data.detail[key] = 0;
  } else {
    const v = Number(trimmed);
    if (!Number.isFinite(v)) return;
    ds.data.detail[key] = Math.abs(v); // 詳細情報はすべて正の値で扱う
    ds.provided.add(slot);
  }
  // 手入力はファイルに残らないので、別途保存して復元できるようにする
  const overrideKey = keyOf(ds.company, ds.period.label);
  const o = state.overrides[overrideKey] || (state.overrides[overrideKey] = {});
  if (trimmed === "") delete o[`detail.${key}`]; else o[`detail.${key}`] = ds.data.detail[key];
  if (Object.keys(o).length === 0) delete state.overrides[overrideKey];

  recomputeDataset(ds);
  saveState();
  renderAll();
  if (state.tab === "detail") {
    document.getElementById("detail-status").innerHTML = "";
    renderDetailPanel();
    document.getElementById(`detail-${key}`).focus();
  }
}

/** 1件のデータセットだけ計算し直す(ROICは系列全体に影響するので再計算する) */
function recomputeDataset(ds) {
  ds.cf = ds.cfAvailable ? computeCF(ds.data, ds.provided, state.interestPolicy) : null;
  ds.checks = computeChecks(ds.data, ds.cf);
  ds.metrics = computeBaseMetrics(ds.data, ds.cf, ds.provided);
  const series = state.byCompany.get(ds.company);
  if (series) finalizeROIC(series);
}

/** 詳細情報CSVを既存データに上書きで取り込む */
async function handleDetailFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  const messages = [];
  let applied = 0;
  const unmatched = [];

  for (const f of files) {
    const text = await decodeFile(f);
    const result = parseFinancialCSV(text, baseName(f.name), state.mapping);
    for (const parsed of result.datasets) {
      const target = state.byKey.get(keyOf(parsed.company, parsed.period.label));
      if (!target) { unmatched.push(`${parsed.company} / ${parsed.period.label}`); continue; }
      let touched = false;
      for (const [section, fields] of [["detail", SCHEMA.detail], ["sup", SCHEMA.sup]]) {
        for (const field of fields) {
          const slot = `${section}:${field.key}`;
          if (!parsed.provided.has(slot)) continue;
          target.data[section][field.key] = parsed.data[section][field.key];
          target.provided.add(slot);
          const o = state.overrides[keyOf(target.company, target.period.label)]
            || (state.overrides[keyOf(target.company, target.period.label)] = {});
          o[`${section}.${field.key}`] = parsed.data[section][field.key];
          touched = true;
        }
      }
      if (touched) { recomputeDataset(target); applied++; }
    }
    messages.push(...result.errors, ...result.warnings);
  }

  const status = document.getElementById("detail-upload-status");
  status.hidden = false;
  if (applied === 0) {
    status.className = "file-status ng";
    status.textContent = "詳細情報を反映できませんでした。会社名と四半期が読み込み済みのデータと一致しているかご確認ください。";
  } else {
    status.className = "file-status ok";
    status.textContent = `${applied}件の会社・四半期に詳細情報を反映しました。`
      + (unmatched.length ? `(${unmatched.length}件は該当データがないため読み飛ばしました)` : "");
  }
  if (unmatched.length) messages.push(`該当するデータがない指定: ${unmatched.slice(0, 5).join("、")}${unmatched.length > 5 ? " ほか" : ""}`);
  if (messages.length) renderMessages([], messages);

  saveState();
  renderAll();
  renderDetailPanel();
}

/* =========================================================
 * タブ
 * ======================================================= */
/* =========================================================
 * タブ
 * ======================================================= */

const hasData = () => state.datasets.length > 0;

const TABS = [
  // CF計算書・財務指標・推移は1つの画面にまとめている
  { id: "summary", needs: hasData },
  { id: "overview", needs: () => hasData() && state.companies.length > 1 },
  { id: "detail", needs: hasData },
  { id: "logic", needs: hasData },
];

function visibleTabs() {
  return TABS.filter((t) => !t.needs || t.needs());
}

function selectTab(id) {
  if (!hasData()) return;
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
  document.getElementById("selector-bar").hidden = !hasData() ||
    (state.companies.length <= 1 && state.periods.length <= 1);
  // グラフは表示されてから幅を測る(隠れている間は幅が0のため)
  if (id === "summary") renderTrend();
  if (id === "overview") { renderOverviewChart(); renderOverviewCards(); }
  if (id === "logic") renderDerivation();
  if (id === "detail") renderDetailPanel();
}

function renderTabs() {
  const shown = visibleTabs().map((t) => t.id);
  document.getElementById("tablist").hidden = shown.length === 0;
  document.getElementById("empty-state").hidden = shown.length !== 0;
  for (const t of TABS) {
    document.getElementById(`tab-${t.id}`).hidden = !shown.includes(t.id);
    if (shown.length === 0) document.getElementById(`panel-${t.id}`).hidden = true;
  }
  if (shown.length === 0) return;
  selectTab(shown.includes(state.tab) ? state.tab : "summary");
}

/* =========================================================
 * 画面の組み立て
 * ======================================================= */

function selectCompany(name) {
  if (!state.byKey.has(keyOf(name, state.period))) return;
  state.company = name;
  document.getElementById("company-select").value = name;
  // タブは移動しない(全社比較で会社をクリックしても比較画面を見たままにする)。
  // 明細は上部の会社セレクタが切り替わっているので、サマリータブを開けば見られる
  renderAll();
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

/**
 * 選んだ会社にその四半期のデータがないときの案内。
 * 勝手に別の会社へ切り替えず、無いことをはっきり伝えて、
 * その会社が持っている四半期へ移れるようにする。
 */
function renderMissingNotice() {
  const missing = hasData() && !currentDataset();
  const labels = (state.byCompany.get(state.company) || []).map((d) => d.period.label);

  for (const id of ["summary-missing", "detail-missing"]) {
    const box = document.getElementById(id);
    box.hidden = !missing;
    if (!missing) continue;
    box.querySelector(".missing-title").textContent =
      `${state.company} の ${state.period} は読み込まれていないため、表示できません。`;
    const list = box.querySelector(".missing-list");
    list.innerHTML = "";
    if (labels.length === 0) { list.textContent = "なし"; continue; }
    for (const label of labels) {
      const chip = el("button", { type: "button", class: "period-chip", text: label });
      chip.addEventListener("click", () => {
        state.period = label;
        document.getElementById("period-select").value = label;
        renderAll();
      });
      list.append(chip);
    }
  }
  document.getElementById("summary-body").hidden = missing;
  document.getElementById("detail-card").hidden = missing;
  return missing;
}

function renderAll() {
  const dataset = currentDataset();
  const multi = state.companies.length > 1;

  document.getElementById("btn-clear").hidden = false;
  document.getElementById("btn-export").hidden = !hasData();
  renderMissingNotice();

  // 会社別の推移と全社比較は、選択の片方が欠けていても意味があるので描く
  if (hasData()) renderTrend();

  if (!dataset) {
    renderChecks([]);
    document.getElementById("cf-body").hidden = true;
    document.getElementById("cf-unavailable").hidden = true;
  } else {
    renderMetrics();
    renderChecks(dataset.checks);

    document.getElementById("statement-subject").textContent =
      `${dataset.company} / ${dataset.period.label}`;
    const hasCF = !!dataset.cf;
    document.getElementById("cf-body").hidden = !hasCF;
    document.getElementById("cf-unavailable").hidden = hasCF;
    if (hasCF) renderStatement(dataset.cf);
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
    renderOverviewCards();
  }

  if (state.tab === "logic") { renderDerivationDiagram(); renderDerivationText(); }
  if (state.tab === "detail") renderDetailPanel();
  renderTabs();
  renderShareBanner();
}

function showEmptyState() {
  document.getElementById("selector-bar").hidden = true;
  document.getElementById("btn-clear").hidden = true;
  document.getElementById("btn-export").hidden = true;
  renderTabs();
  renderShareBanner();
}

/* =========================================================
 * 読み込み
 * ======================================================= */

/** 読み込んだファイルと手入力の詳細情報をまとめて保存する */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sources: state.sources, overrides: state.overrides,
      interestPolicy: state.interestPolicy,
      mappingText: state.mappingText,
    }));
    document.getElementById("storage-warning").hidden = true;
  } catch (err) {
    // 黙って落とすと「保存されたつもり」になるので、はっきり伝える
    const warn = document.getElementById("storage-warning");
    warn.hidden = false;
    warn.querySelector(".text").textContent = state.share.dir
      ? "この端末のブラウザには保存できませんでした(容量上限)。共有フォルダには書き出しています。"
      : "この端末のブラウザに保存できませんでした(容量上限)。ページを閉じると読み込んだ内容は消えます。共有フォルダを指定するか、「読み込んだ内容をCSVで保存」で書き出してください。";
  }
  scheduleSharePush();
}

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
  // ファイル名の並びに左右されないよう、会社名の五十音順で並べる
  state.companies = companies.sort((a, b) => a.localeCompare(b, "ja"));
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
      d.cf = d.cfAvailable ? computeCF(d.data, d.provided, state.interestPolicy) : null;
      d.checks = computeChecks(d.data, d.cf);
      d.metrics = computeBaseMetrics(d.data, d.cf, d.provided);
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
  state.sort = { key: "name", dir: 1 };
}

/** 画面で手入力した詳細情報を、読み込み直したデータに再適用する */
function applyOverrides() {
  let applied = 0;
  for (const [key, fields] of Object.entries(state.overrides)) {
    const ds = state.byKey.get(key);
    if (!ds) continue;
    for (const [path, v] of Object.entries(fields)) {
      const keys = path.split(".");
      let target = ds.data;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = v;
      if (keys[0] === "detail") ds.provided.add(`detail:${keys[1]}`);
    }
    recomputeDataset(ds);
    applied++;
  }
  return applied;
}

function applySources(sources, { keepModalOpen = false } = {}) {
  const errors = [], warnings = [];
  const merged = new Map();
  let matched = 0;
  // 認識できなかった科目を集める(マッピングの画面編集に候補として出すため)
  const unmatchedNames = new Map(); // mappingKey → 元の表記
  // 科目ごとの解釈の記録(読み込み内訳の表示用)
  const resolvedNames = new Map();
  // ファイルをどう読んだか(読み取り方)の記録。同じ判定はまとめる
  const layoutCounts = new Map();

  const layoutDebug = [];

  for (const src of sources) {
    const result = parseFinancialCSV(src.text, baseName(src.name), state.mapping);
    if (result.layoutInfo) {
      layoutCounts.set(result.layoutInfo, (layoutCounts.get(result.layoutInfo) || 0) + 1);
    }
    if (result.layoutRows && layoutDebug.length < 3) {
      const srcNote = Object.entries(result.nameSources || {})
        .map(([col, n]) => `${col}×${n}件`).join(" / ");
      layoutDebug.push({ file: src.name, lines: result.layoutRows,
        srcNote: srcNote ? `→ 認識できなかった科目名の出どころ: ${srcNote}` : "" });
    }
    // Excel読み込み時に「読めなかったセル」があった場合の説明(数式のまま等)
    if (src.note) warnings.push((sources.length > 1 ? `${src.name}: ` : "") + src.note);
    const prefix = sources.length > 1 ? `${src.name}: ` : "";
    errors.push(...result.errors.map((e) => prefix + e));
    warnings.push(...result.warnings.map((w) => prefix + w));
    matched += result.matched;
    for (const u of result.unmatched) {
      const k = mappingKey(u.name);
      if (!unmatchedNames.has(k)) unmatchedNames.set(k, u.name);
    }
    for (const r of result.resolved || []) {
      const k = mappingKey(r.name);
      if (!resolvedNames.has(k)) resolvedNames.set(k, r);
    }

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
      for (const k of ds.provided) acc.provided.add(k);
    }
  }

  state.unmatchedNames = [...unmatchedNames.values()];
  state.resolvedNames = [...resolvedNames.values()];
  state.layoutNotes = [...layoutCounts].map(([desc, n]) =>
    sources.length > 1 ? `${desc} × ${n}ファイル` : desc);
  state.layoutDebug = layoutDebug;
  renderResolveReport();

  const label = sources.length === 1 ? sources[0].name : `${sources.length}個のファイル`;
  const status = document.getElementById("file-status");
  status.hidden = false;

  if (merged.size === 0 || matched === 0) {
    status.textContent = `${label} を読み込めませんでした`;
    status.className = "file-status ng";
    if (errors.length === 0) errors.push("読み込めるデータがありませんでした。");
    renderMessages(errors, warnings);
    if (state.unmatchedNames.length) {
      // 全科目が社内独自名で取り込めなかったケース。ファイルは保持しておき、
      // マッピングを適用したら再読み込みなしでこのファイルを再解釈できるようにする
      state.sources = sources;
      saveState();
      mappingStatus(`認識できなかった${state.unmatchedNames.length}件の科目を「マッピングを画面で編集」に入れました。反映先を選んで適用してください。`, "");
    }
    state.datasets = [];
    showEmptyState();
    document.getElementById("btn-clear").hidden = false;
    return;
  }

  buildState([...merged.values()], warnings);
  applyOverrides();
  state.sources = sources;

  const periodText = state.periods.length > 1 ? ` / ${state.periods.length}四半期` : "";
  status.textContent = `${label} を読み込みました(${state.companies.length}社${periodText} / ${matched}件の科目を認識)`;
  status.className = "file-status ok";
  renderMessages(errors, warnings);
  if (state.unmatchedNames.length) {
    mappingStatus(`認識できなかった${state.unmatchedNames.length}件の科目を「マッピングを画面で編集」に入れました。反映先を選んで適用してください。`, "");
  }
  renderSelectors();
  renderAll();
  if (!keepModalOpen) closeSourceModal();

  saveState();
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > 20 * 1024 * 1024) {
    renderMessages(["ファイルサイズの合計が大きすぎます(20MBまで)。"], []);
    return;
  }
  const sources = [];
  const fileErrors = [];
  for (const f of files) {
    try {
      if (isXlsxName(f.name)) {
        const sheets = await readXlsxSheets(await f.arrayBuffer());
        if (sheets.length === 0) throw new Error("データの入ったシートがありません");
        const base = baseName(f.name);
        for (const sh of sheets) {
          const nm = sheets.length > 1 ? `${base}_${sh.name}.csv` : `${base}.csv`;
          // 読めなかったセルがある場合の説明(数式のまま保存されている等)を添える
          sources.push({ name: nm, text: xlsxRowsToCSV(sh.rows), note: xlsxSheetNote(sh.stats) });
        }
      } else if (/\.xls$/i.test(f.name)) {
        throw new Error("旧形式(.xls)は読み込めません。Excelで .xlsx として保存し直してください");
      } else {
        sources.push({ name: f.name, text: await decodeFile(f) });
      }
    } catch (err) {
      fileErrors.push(`${f.name}: ${err.message}`);
    }
  }
  if (sources.length === 0) {
    renderMessages(fileErrors.length ? fileErrors : ["読み込めるファイルがありませんでした。"], []);
    return;
  }
  applySources(sources);
  if (fileErrors.length) renderMessages(fileErrors, ["上記以外のファイルは読み込みました。"]);
}

function clearAll() {
  state.datasets = [];
  state.sources = [];
  state.overrides = {};
  state.unmatchedNames = [];
  state.resolvedNames = [];
  state.layoutNotes = [];
  state.layoutDebug = [];
  renderResolveReport();
  document.getElementById("file-input").value = "";
  document.getElementById("file-status").hidden = true;
  const messages = document.getElementById("messages");
  messages.hidden = true;
  messages.innerHTML = "";
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 無視 */ }
  showEmptyState();
}

/* =========================================================
 * 科目マッピング(算定ロジックファイル)
 * ======================================================= */

function renderMappingStatus() {
  const badge = document.getElementById("mapping-state");
  const active = !!state.mapping && state.mapping.entries.size > 0;
  badge.textContent = active
    ? `${state.mapping.entries.size}科目のマッピングを適用中`
    : "組み込みの対応を使用中";
  document.getElementById("btn-mapping-clear").hidden = !active;
}

function mappingStatus(text, kind = "") {
  const el2 = document.getElementById("mapping-status");
  el2.hidden = !text;
  el2.textContent = text;
  el2.className = `file-status ${kind}`;
}

/** マッピングを差し替えて、読み込み済みデータがあれば再計算する */
function setMapping(text, { quiet = false } = {}) {
  if (!text) {
    state.mappingText = "";
    state.mapping = null;
  } else {
    const parsed = parseMappingCSV(text);
    if (parsed.errors.length) {
      if (!quiet) {
        mappingStatus(`読み込めませんでした: ${parsed.errors.slice(0, 3).join(" / ")}` +
          (parsed.errors.length > 3 ? ` ほか${parsed.errors.length - 3}件` : ""), "ng");
      }
      return false;
    }
    state.mappingText = text;
    state.mapping = parsed;
    if (!quiet && parsed.warnings.length) renderMessages([], parsed.warnings);
  }
  renderMappingStatus();
  return true;
}

async function handleMappingFile(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  try {
    let text;
    if (isXlsxName(files[0].name)) {
      // Excelのマッピング表は先頭のデータ入りシートを使う
      const sheets = await readXlsxSheets(await files[0].arrayBuffer());
      if (sheets.length === 0) throw new Error("データの入ったシートがありません");
      text = xlsxRowsToCSV(sheets[0].rows);
    } else {
      text = await decodeFile(files[0]);
    }
    if (!setMapping(text)) return;
    const n = state.mapping.entries.size;
    if (state.sources.length) {
      applySources(state.sources, { keepModalOpen: true });
      mappingStatus(`${n}科目のマッピングを読み込み、読み込み済みのデータを再計算しました。`, "ok");
    } else {
      mappingStatus(`${n}科目のマッピングを読み込みました。次にCSVを読み込むと適用されます。`, "ok");
    }
    saveState();
  } catch (err) {
    mappingStatus(`読み込めませんでした: ${err.message}`, "ng");
  }
  document.getElementById("mapping-file-input").value = "";
}

/* ---- 読み込み内訳(各科目をどの項目として読んだかの一覧) ---- */

const RESOLVE_VIA = {
  label: { text: "組み込み(正式名)", cls: "via-exact" },
  alias: { text: "組み込み(別名)", cls: "via-exact" },
  loose: { text: "表記ゆれを吸収", cls: "via-loose" },
  mapping: { text: "マッピング", cls: "via-mapping" },
  none: { text: "認識できず", cls: "via-none" },
};

function renderResolveReport() {
  const box = document.getElementById("resolve-report");
  const body = document.getElementById("resolve-body");
  if (!box || !body) return;
  const items = state.resolvedNames || [];
  const un = state.unmatchedNames || [];
  if (items.length === 0 && un.length === 0) { box.hidden = true; return; }
  box.hidden = false;
  document.getElementById("resolve-summary").textContent =
    `科目の読み込み内訳を確認(${items.length + un.length}科目` +
    (un.length ? ` / うち認識できず ${un.length}件` : "") + ")";
  // どの列をどう読んだか(問い合わせ時にこの行を伝えてもらうと原因を特定できる)
  const layouts = document.getElementById("resolve-layouts");
  if (layouts) {
    const notes = state.layoutNotes || [];
    layouts.hidden = notes.length === 0;
    layouts.textContent = notes.length ? `読み取り方: ${notes.join(" / ")}` : "";
  }
  // セル種類の診断(科目名・金額は含まない)
  const dbg = document.getElementById("resolve-debug");
  if (dbg) {
    const files = state.layoutDebug || [];
    dbg.hidden = files.length === 0;
    document.getElementById("resolve-debug-pre").textContent = debugReportText();
  }

  const fieldLabel = (t) => {
    const f = SCHEMA[t.section].find((g) => g.key === t.key && !g.aliasOnly);
    return `${SECTION_LABELS[t.section]} ${f ? f.label : t.key}`;
  };
  body.innerHTML = "";
  const addRow = (name, targetText, sign, via, dim) => {
    const v = RESOLVE_VIA[via] || RESOLVE_VIA.label;
    body.appendChild(el("tr", { class: via === "none" ? "rv-unmatched" : "" },
      el("td", { class: `rv-name${dim ? " rv-dim" : ""}`, text: name }),
      el("td", { text: targetText }),
      el("td", { class: "rv-sign", text: sign }),
      el("td", {}, el("span", { class: `via-badge ${v.cls}`, text: v.text }))));
  };
  // 確認してほしい順に並べる: 認識できず → 表記ゆれ → マッピング → 組み込み
  for (const nm of un) addRow(nm, "—(読み飛ばしました)", "", "none");
  const order = { loose: 0, mapping: 1, label: 2, alias: 2 };
  const sorted = [...items].sort((a, b) => (order[a.via] ?? 2) - (order[b.via] ?? 2));
  for (const it of sorted) {
    it.targets.forEach((t, i) => {
      addRow(i === 0 ? it.name : "〃", fieldLabel(t), t.sign < 0 ? "−" : "+", it.via, i > 0);
    });
  }
}

/** 読み取りの診断の本文(読み取り方 + セル種類 + 名前の出どころ)。コピー共有用 */
function debugReportText() {
  const parts = [];
  if (state.layoutNotes && state.layoutNotes.length) {
    parts.push(`読み取り方: ${state.layoutNotes.join(" / ")}`);
  }
  for (const f of state.layoutDebug || []) {
    parts.push(`【${f.file}】`);
    parts.push(...f.lines);
    if (f.srcNote) parts.push(f.srcNote);
    parts.push("");
  }
  return parts.join("\n").trim();
}

/* ---- マッピングの画面編集(書き間違い防止のプルダウン形式) ---- */

const MAPPING_EDIT_SECTIONS = ["bs", "pl", "sup", "ss", "detail"];

function mappingTargetsFor(section) {
  return SCHEMA[section].filter((f) => !f.aliasOnly).map((f) => f.label);
}

function addMappingEditorRow(vals) {
  const v = vals || { name: "", section: "bs", target: "", sign: 1 };
  const rows = document.getElementById("mapping-editor-rows");
  const row = el("div", { class: "map-row" });

  const name = el("input", { type: "text", class: "map-name", placeholder: "例: 買掛金(損益分) / 11010001" });
  name.value = v.name;

  const sec = el("select", { class: "map-section", "aria-label": "反映先の区分" });
  for (const s of MAPPING_EDIT_SECTIONS) sec.appendChild(el("option", { value: s, text: SECTION_LABELS[s] }));
  sec.value = v.section;

  const target = el("select", { class: "map-target", "aria-label": "反映先の科目" });
  const fillTargets = (section, selected) => {
    target.innerHTML = "";
    target.appendChild(el("option", { value: "", text: "科目を選択…" }));
    for (const label of mappingTargetsFor(section)) {
      target.appendChild(el("option", { value: label, text: label }));
    }
    target.value = selected || "";
  };
  fillTargets(v.section, v.target);
  sec.addEventListener("change", () => fillTargets(sec.value, ""));

  const sign = el("select", { class: "map-sign", "aria-label": "符号" });
  sign.appendChild(el("option", { value: "+", text: "+(足す)" }));
  sign.appendChild(el("option", { value: "-", text: "−(引く)" }));
  sign.value = v.sign < 0 ? "-" : "+";

  const del = el("button", { type: "button", class: "map-del", text: "×", title: "この行を削除" });
  del.addEventListener("click", () => row.remove());

  row.append(name, sec, target, sign, del);
  // 読み込んだデータから拾った候補の行。反映先が未選択のままなら適用時に読み飛ばす
  if (v.suggested) { row.classList.add("map-suggested"); row.dataset.suggested = "1"; }
  rows.appendChild(row);
  return row;
}

/** いまのマッピング + 読み込みで認識できなかった科目を行として並べる */
function openMappingEditor() {
  const rows = document.getElementById("mapping-editor-rows");
  rows.innerHTML = "";
  if (state.mapping) {
    for (const targets of state.mapping.entries.values()) {
      for (const t of targets) {
        const field = SCHEMA[t.section].find((f) => f.key === t.key && !f.aliasOnly);
        addMappingEditorRow({ name: t.name, section: t.section, target: field ? field.label : "", sign: t.sign });
      }
    }
  }
  // 読み込んだデータで認識できなかった科目を、名前入り・反映先未選択の行として追加する
  let suggested = 0;
  for (const nm of state.unmatchedNames) {
    if (mappingLookup(state.mapping, nm)) continue; // すでにマッピング済み
    addMappingEditorRow({ name: nm, section: "bs", target: "", sign: 1, suggested: true });
    suggested++;
  }
  const note = document.getElementById("mapping-editor-note");
  note.hidden = suggested === 0;
  if (suggested > 0) {
    note.textContent = `色付きの${suggested}行は、読み込んだデータで認識できなかった科目です。` +
      "反映先を選んで適用してください(反映先が未選択のままの行は適用されず、不要なら×で削除できます)。";
  }
  if (!rows.children.length) addMappingEditorRow();
  document.getElementById("mapping-editor").hidden = false;
}

/** 編集内容をCSVにして、ファイル読み込みと同じ経路で適用する */
function applyMappingEditor() {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["科目,反映先の区分,反映先の科目,符号"];
  const problems = [];
  let skipped = 0;
  document.querySelectorAll("#mapping-editor-rows .map-row").forEach((row, i) => {
    const name = row.querySelector(".map-name").value.trim();
    const target = row.querySelector(".map-target").value;
    if (name === "" && target === "") return; // 何も入れていない行は無視
    if (name === "") { problems.push(`${i + 1}行目: 科目名が空です。`); return; }
    if (target === "") {
      // データから拾った候補の行は、反映先を選んでいなければ「まだ決めていない」として読み飛ばす
      if (row.dataset.suggested) { skipped++; return; }
      problems.push(`${i + 1}行目「${name}」: 反映先の科目を選んでください。`);
      return;
    }
    const section = row.querySelector(".map-section").value;
    const sign = row.querySelector(".map-sign").value;
    lines.push(`${q(name)},${SECTION_LABELS[section]},${q(target)},${sign}`);
  });
  if (problems.length) { mappingStatus(`適用できません: ${problems.join(" ")}`, "ng"); return; }
  if (lines.length === 1) {
    mappingStatus(skipped > 0
      ? "反映先が選ばれた行がありません。候補の行の反映先を選んでから適用してください。"
      : "行がありません。科目を1行以上入力してください。", "ng");
    return;
  }
  if (!setMapping(lines.join("\r\n") + "\r\n")) return;
  const n = state.mapping.entries.size;
  const skipNote = skipped > 0 ? `(反映先が未選択の${skipped}行は適用していません)` : "";
  if (state.sources.length) {
    applySources(state.sources, { keepModalOpen: true });
    mappingStatus(`${n}科目のマッピングを適用し、読み込み済みのデータを再計算しました。${skipNote}`, "ok");
  } else {
    mappingStatus(`${n}科目のマッピングを適用しました。次にCSVを読み込むと適用されます。${skipNote}`, "ok");
  }
  saveState();
}

function bindMappingUI() {
  document.getElementById("btn-mapping-edit").addEventListener("click", () => {
    const ed = document.getElementById("mapping-editor");
    if (ed.hidden) openMappingEditor(); else ed.hidden = true;
  });
  document.getElementById("btn-mapping-row-add").addEventListener("click", () => addMappingEditorRow());
  document.getElementById("btn-mapping-apply").addEventListener("click", applyMappingEditor);
  document.getElementById("btn-mapping-edit-close").addEventListener("click", () => {
    document.getElementById("mapping-editor").hidden = true;
  });
  document.getElementById("btn-mapping-template").addEventListener("click", () => {
    downloadText("cf-mapping.csv", state.mappingText || buildMappingTemplate());
  });
  const input = document.getElementById("mapping-file-input");
  document.getElementById("btn-mapping-upload").addEventListener("click", () => input.click());
  input.addEventListener("change", () => handleMappingFile(input.files));
  document.getElementById("btn-mapping-clear").addEventListener("click", () => {
    setMapping("");
    if (state.sources.length) applySources(state.sources, { keepModalOpen: true });
    mappingStatus("マッピングを解除し、組み込みの対応に戻しました。", "");
    saveState();
  });
  renderMappingStatus();
}

/* =========================================================
 * 読み込みモーダル
 * ======================================================= */

function openSourceModal() {
  document.getElementById("source-modal").hidden = false;
  document.body.style.overflow = "hidden"; // 背面のページは動かさない
}

function closeSourceModal() {
  document.getElementById("source-modal").hidden = true;
  document.body.style.overflow = "";
}

function bindSourceModal() {
  const backdrop = document.getElementById("source-modal");
  document.getElementById("btn-open-source").addEventListener("click", openSourceModal);
  document.getElementById("btn-open-source-empty").addEventListener("click", openSourceModal);
  document.getElementById("btn-close-source").addEventListener("click", closeSourceModal);
  // 外側(背景)をクリックしたら閉じる
  backdrop.addEventListener("mousedown", (ev) => {
    if (ev.target === backdrop) closeSourceModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !backdrop.hidden) closeSourceModal();
  });
}

/* =========================================================
 * 共有フォルダ連携(画面側の制御)
 *
 * 実際のファイル読み書きは js/share.js が担当する。
 * ここでは「いつ読むか・いつ書くか」と、状態の表示だけを扱う。
 * ======================================================= */

const SHARE_AUTO_KEY = "cf-visualization-share-auto";

function shareEl(id) { return document.getElementById(id); }

function shareStatus(text, kind = "") {
  const p = shareEl("share-status");
  p.hidden = !text;
  p.textContent = text;
  p.className = `file-status ${kind}`;
}

function renderShare() {
  const supported = shareSupported();
  shareEl("share-unsupported").hidden = supported;
  shareEl("share-controls").hidden = !supported;
  if (!supported) {
    shareEl("share-unsupported-text").textContent = window.isSecureContext
      ? "このブラウザは共有フォルダの直接読み書きに対応していません(パソコンの Chrome / Edge が必要です。iPhone・iPad・Android・Safari・Firefox は非対応)。共有フォルダに置いたCSVを上のドラッグ&ドロップで読み込み、「読み込んだ内容をCSVで保存」で書き戻す使い方はできます。"
      : "フォルダの直接読み書きには HTTPS でのアクセスが必要です。GitHub Pages の URL から開くか、「ツール本体をHTMLで保存」で保存したファイルをダブルクリックで開いてください(保存したファイルなら使えます)。";
    shareEl("share-state").textContent = "使えません";
    renderShareBanner();
    return;
  }

  const connected = !!state.share.dir;
  shareEl("share-state").textContent = connected ? "接続中" : "未接続";
  shareEl("share-path").hidden = !connected;
  shareEl("share-locate").hidden = !connected;
  if (connected) {
    const fp = state.share.folderPath || "";
    shareEl("share-path").textContent = fp
      ? `フォルダ:${state.share.dir.name}(${fp})`
      : `フォルダ:${state.share.dir.name}(ブラウザの仕様で、完全なパスは自動では取得できません)`;
    shareEl("btn-share-copy-path").hidden = !fp;
    shareEl("btn-share-path-edit").textContent = fp ? "フォルダの場所を変更" : "フォルダの場所を登録";
  }
  shareEl("btn-share-pick").textContent = connected ? "別のフォルダを選ぶ" : "共有フォルダを選ぶ";
  for (const [id, show] of [
    ["btn-share-pull", connected],
    ["btn-share-push", connected],
    ["btn-share-migrate", connected && state.sources.length > 0],
    ["btn-share-sync", connected && state.sources.length > 0],
    ["btn-share-disconnect", connected],
    ["share-auto-field", connected],
  ]) shareEl(id).hidden = !show;
  shareEl("share-auto").checked = state.share.auto;
  shareEl("btn-share-reconnect").hidden = connected || !state.share.saved;
  renderShareBanner();
}

/**
 * 前回のフォルダに、ワンクリックで戻れる案内。
 * ページ上部(データが表示されているとき)と読み込み画面(まだ何もないとき)の両方に出す。
 * ブラウザの安全上の仕組みで、フォルダの再読み込みには利用者の操作が1回必要なため、
 * その1回を目立つ場所に置いておく。
 */
function renderShareBanner() {
  const sh = state.share;
  // reconnect: 前回のフォルダに戻る / pick: 配布されたZIPを展開して初めて開いた人向け(フォルダを選ぶ)
  let mode = "";
  if (shareSupported() && !sh.dir && !sh.bannerDismissed) {
    if (sh.saved) mode = "reconnect";
    else if (isStandaloneBuild() && !hasData()) mode = "pick";
  }
  for (const banner of document.querySelectorAll(".share-banner")) {
    banner.hidden = !mode;
    if (!mode) continue;
    banner.querySelector(".btn-reconnect").hidden = mode !== "reconnect";
    banner.querySelector(".btn-pick").hidden = mode !== "pick";
    let text = sh.bannerText;
    if (!text && mode === "reconnect") {
      text = sh.savedName
        ? `前回使ったフォルダ「${sh.savedName}」があります。再接続すると、フォルダにあるデータ(あとから置いたファイルも)を読み込みます。`
        : "前回使ったフォルダがあります。再接続すると、フォルダにあるデータ(あとから置いたファイルも)を読み込みます。";
    }
    if (!text && mode === "pick") {
      text = "このHTMLを置いたフォルダに元データ(CSV・Excel)があれば、そのフォルダを選ぶとまとめて読み込みます。次からは開くだけで表示されます。";
    }
    banner.querySelector(".text").textContent = text;
  }
}

/** 変更のたびに呼ばれる。自動書き出しが有効なら、少し待ってからまとめて書く */
function scheduleSharePush() {
  const sh = state.share;
  if (!sh.dir || !sh.auto || sh.suppress) return;
  if (sh.timer) clearTimeout(sh.timer);
  sh.timer = setTimeout(() => { sh.timer = null; sharePush({ silent: true }); }, SHARE_PUSH_DELAY);
}

function sharePayload() {
  return {
    sources: state.sources,
    overrides: state.overrides,
    interestPolicy: state.interestPolicy,
    mappingText: state.mappingText,
    folderPath: state.share.folderPath,
  };
}

async function sharePush({ prune = false, silent = false } = {}) {
  const sh = state.share;
  if (!sh.dir || sh.busy) return false;
  sh.busy = true;
  try {
    if (!silent) shareStatus("共有フォルダへ書き出しています…");
    const res = await shareWrite(sh.dir, sharePayload(), { prune, scheme: sh.scheme });
    sh.stamps = res.stamps;
    sh.scheme = res.scheme;
    shareEl("share-update").hidden = true;
    const note = res.scheme === "ascii"
      ? " ※この置き場所は日本語のファイル名を作れないため、英数字のファイル名で保存しています"
      : "";
    shareStatus(`共有フォルダへ書き出しました(${state.sources.length}ファイル / ${new Date().toLocaleTimeString("ja-JP")})${note}`, "ok");
    return true;
  } catch (err) {
    shareStatus(`共有フォルダへ書き出せませんでした: ${err.message}`, "ng");
    return false;
  } finally {
    sh.busy = false;
  }
}

async function sharePull() {
  const sh = state.share;
  if (!sh.dir || sh.busy) return false;
  sh.busy = true;
  try {
    shareStatus("共有フォルダから読み込んでいます…");
    const read = await shareRead(sh.dir);
    sh.stamps = read.stamps;
    if (read.scheme) sh.scheme = read.scheme;
    shareEl("share-update").hidden = true;
    if (read.sources.length === 0) {
      // データファイルはまだ無いが、科目マッピングだけ置いてあるフォルダにも対応する
      if (read.mappingText) {
        sh.suppress = true;
        const okM = setMapping(read.mappingText, { quiet: true });
        if (okM) {
          if (state.sources.length) applySources(state.sources, { keepModalOpen: true });
          else saveState();
        }
        sh.suppress = false;
        if (okM) {
          shareStatus(`共有フォルダから科目マッピング(${state.mapping.entries.size}科目)を読み込みました。データファイルはまだありません。`, "ok");
          return true;
        }
      }
      shareStatus("共有フォルダにデータがありません。", "");
      return false;
    }
    // 読み込んだ直後に書き戻さないよう、いったん自動書き出しを止める
    sh.suppress = true;
    setMapping(read.mappingText || "", { quiet: true });
    state.overrides = read.overrides || {};
    if (read.settings && INTEREST_POLICIES.some((p) => p.key === read.settings.interestPolicy)) {
      state.interestPolicy = read.settings.interestPolicy;
    }
    if (read.settings && typeof read.settings.folderPath === "string" && read.settings.folderPath) {
      state.share.folderPath = read.settings.folderPath;
    }
    applySources(read.sources);
    sh.suppress = false;
    const when = read.settings && read.settings.updatedAt
      ? `(最終更新 ${new Date(read.settings.updatedAt).toLocaleString("ja-JP")})` : "";
    shareStatus(`共有フォルダから ${read.sources.length}ファイルを読み込みました${when}`, "ok");
    return true;
  } catch (err) {
    shareStatus(`共有フォルダから読み込めませんでした: ${err.message}`, "ng");
    return false;
  } finally {
    sh.busy = false;
    renderShare();
  }
}

/**
 * フォルダに接続したときの初期動作を決める。
 * @param restored 前回のフォルダに戻ってきた場合 true(新しく選んだ場合は false)
 */
async function shareAfterConnect({ restored = false } = {}) {
  const sh = state.share;
  renderShare();
  let peek;
  try {
    peek = await shareRead(sh.dir);
  } catch (err) {
    shareStatus(`共有フォルダを読めませんでした: ${err.message}`, "ng");
    return;
  }
  sh.stamps = peek.stamps;
  if (peek.scheme) sh.scheme = peek.scheme;
  if (peek.settings && typeof peek.settings.folderPath === "string" && peek.settings.folderPath) {
    sh.folderPath = peek.settings.folderPath;
  }

  // フォルダに科目マッピングがあり、この端末に無ければ先に取り込む。
  // (取り込まずに書き出すと、フォルダの mapping.csv を消してしまうため)
  let adoptedMapping = false;
  if (peek.mappingText && !state.mappingText) {
    sh.suppress = true;
    if (setMapping(peek.mappingText, { quiet: true })) {
      adoptedMapping = true;
      if (state.sources.length) applySources(state.sources, { keepModalOpen: true });
      else saveState();
    }
    sh.suppress = false;
  }

  const folderHas = peek.sources.length > 0;
  const localHas = state.sources.length > 0;

  if (folderHas && !localHas) { await sharePull(); return; }
  if (!folderHas && localHas) {
    // 端末内のデータを、そのまま共有フォルダ管理へ移す
    if (await sharePush({ prune: true })) {
      shareStatus(`この端末のデータ(${state.sources.length}ファイル)を共有フォルダへ移しました。以後はこのフォルダが元データになります。`, "ok");
    }
    return;
  }
  if (folderHas && localHas) {
    // 前回と同じフォルダに戻ってきて、この端末にあるファイルがすべてフォルダにもあるなら、
    // フォルダのほうが新しい(他の人の更新や、あとから置いたファイルを含む)ので、そのまま読み込む。
    // こうすると「HTMLをダブルクリック → 再接続」だけで最新の状態になる
    const folderNames = new Set(peek.sources.map((s) => s.name));
    if (restored && state.sources.every((s) => folderNames.has(s.name))) { await sharePull(); return; }
    shareStatus(`共有フォルダに ${peek.sources.length}ファイル、この端末に ${state.sources.length}ファイルあります。どちらを使うか、下のボタンで選んでください。`, "");
    return;
  }
  shareStatus(adoptedMapping
    ? `共有フォルダに接続し、科目マッピング(${state.mapping.entries.size}科目)を読み込みました。CSVを読み込むと、このフォルダに保存されます。`
    : "共有フォルダに接続しました。CSVを読み込むと、このフォルダに保存されます。", "ok");
}

async function shareConnect() {
  try {
    const handle = await sharePick();
    if (!handle) return;
    state.share.dir = handle;
    state.share.saved = true;
    await shareAfterConnect();
  } catch (err) {
    shareStatus(`フォルダを開けませんでした: ${err.message}`, "ng");
  }
  renderShare();
}

async function shareReconnect() {
  try {
    const handle = await shareRestore(true);
    if (!handle || handle === "needs-permission") {
      shareStatus("フォルダへのアクセスが許可されませんでした。", "ng");
      renderShare();
      return;
    }
    state.share.dir = handle;
    await shareAfterConnect({ restored: true });
  } catch (err) {
    shareStatus(`再接続できませんでした: ${err.message}`, "ng");
  }
  renderShare();
}

async function shareDisconnect() {
  if (state.share.timer) clearTimeout(state.share.timer);
  state.share = { dir: null, auto: state.share.auto, stamps: new Map(), busy: false,
    timer: null, suppress: false, scheme: null, saved: false, folderPath: "",
    savedName: "", bannerText: "", bannerDismissed: false };
  try { await idbDelHandle(); } catch (_) { /* 無視 */ }
  shareStatus("接続を解除しました。この端末のデータはそのまま残ります。", "");
  renderShare();
}

/** 他の人がフォルダを更新していないか調べる(タブに戻ったときなど) */
async function shareCheckUpdates() {
  const sh = state.share;
  if (!sh.dir || sh.busy) return;
  try {
    const now = await shareStamps(sh.dir);
    const changed = shareDiff(sh.stamps, now);
    if (changed.length === 0) return;
    shareEl("share-update").hidden = false;
    shareEl("share-update-text").textContent =
      `共有フォルダが更新されています(${changed.length}件)。`;
  } catch (_) { /* 権限切れなどは次の操作で気づける */ }
}

function bindShareUI() {
  renderShare();
  if (!shareSupported()) return;

  shareEl("btn-share-pick").addEventListener("click", shareConnect);
  shareEl("btn-share-reconnect").addEventListener("click", shareReconnect);
  // ページ上部・読み込み画面の案内からの再接続
  for (const btn of document.querySelectorAll(".share-banner .btn-reconnect")) {
    btn.addEventListener("click", async () => {
      state.share.bannerText = "フォルダに再接続しています…";
      renderShareBanner();
      await shareReconnect();
      // つながらなかったときは、理由を案内のほうにも出す(読み込み画面が閉じていても分かるように)
      state.share.bannerText = state.share.dir ? "" : shareEl("share-status").textContent;
      renderShareBanner();
    });
  }
  for (const btn of document.querySelectorAll(".share-banner .btn-pick")) {
    btn.addEventListener("click", async () => {
      await shareConnect();
      state.share.bannerText = state.share.dir ? "" : shareEl("share-status").textContent;
      renderShareBanner();
    });
  }
  for (const btn of document.querySelectorAll(".share-banner .btn-dismiss")) {
    btn.addEventListener("click", () => { state.share.bannerDismissed = true; renderShareBanner(); });
  }
  shareEl("btn-share-pull").addEventListener("click", () => sharePull());
  shareEl("btn-share-reload").addEventListener("click", () => sharePull());
  shareEl("btn-share-push").addEventListener("click", () => sharePush());
  shareEl("btn-share-migrate").addEventListener("click", async () => {
    if (await sharePush({ prune: true })) {
      shareStatus(`この端末のデータ(${state.sources.length}ファイル)を共有フォルダへ移しました。`, "ok");
    }
  });
  shareEl("btn-share-sync").addEventListener("click", () => sharePush({ prune: true }));
  shareEl("btn-share-disconnect").addEventListener("click", shareDisconnect);
  shareEl("btn-share-copy-path").addEventListener("click", async () => {
    const fp = state.share.folderPath;
    if (!fp) return;
    try {
      await navigator.clipboard.writeText(fp);
      shareStatus("フォルダの場所をコピーしました。エクスプローラー(Win+E)のアドレス欄に貼り付けて Enter を押すと開きます。", "ok");
    } catch (_) {
      // クリップボードが使えない環境では、手動でコピーしてもらう
      window.prompt("この場所をコピーして、エクスプローラーのアドレス欄に貼り付けてください:", fp);
    }
  });
  shareEl("btn-share-path-edit").addEventListener("click", () => {
    const ed = shareEl("share-path-editor");
    ed.hidden = !ed.hidden;
    if (!ed.hidden) {
      shareEl("share-path-input").value = state.share.folderPath || "";
      shareEl("share-path-input").focus();
    }
  });
  const savePath = () => {
    state.share.folderPath = shareEl("share-path-input").value.trim();
    shareEl("share-path-editor").hidden = true;
    renderShare();
    scheduleSharePush();
    shareStatus(state.share.folderPath
      ? "フォルダの場所を登録しました。settings.json に保存され、同じフォルダを使う全員が「フォルダの場所をコピー」を使えます。"
      : "フォルダの場所の登録を消しました。", "ok");
  };
  shareEl("btn-share-path-save").addEventListener("click", savePath);
  shareEl("share-path-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); savePath(); }
  });
  shareEl("share-auto").addEventListener("change", (ev) => {
    state.share.auto = ev.target.checked;
    try { localStorage.setItem(SHARE_AUTO_KEY, ev.target.checked ? "1" : "0"); } catch (_) { /* 無視 */ }
    if (state.share.auto) scheduleSharePush();
  });

  // 他の人の更新に気づけるよう、戻ってきたタイミングで確認する
  window.addEventListener("focus", () => shareCheckUpdates());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) shareCheckUpdates();
  });

  try { state.share.auto = localStorage.getItem(SHARE_AUTO_KEY) !== "0"; } catch (_) { /* 無視 */ }

  // 前回のフォルダがあれば、押すだけで戻れるようにしておく(再許可には操作が要る)
  // (ブラウザが「今後も許可」を覚えている場合は、操作なしでそのままつながる)
  shareRestore(false).then(async (handle) => {
    if (!handle) return;
    state.share.saved = true;
    if (handle === "needs-permission") {
      state.share.savedName = (await shareSavedName()) || "";
      shareStatus("前回の共有フォルダがあります。「共有フォルダに再接続」を押すと、選び直さずに使えます。", "");
      renderShare();
      return;
    }
    state.share.dir = handle;
    shareAfterConnect({ restored: true }).then(renderShare);
  }).catch(() => { /* 無視 */ });
}

/* =========================================================
 * ツール本体の保存(単一HTML化)
 *
 * 実際の組み立ては js/standalone.js が担当する。
 * ======================================================= */

/** 保存版(単一HTML)の中身を用意する。すでに保存版ならそのまま */
async function standaloneHtml() {
  if (isStandaloneBuild()) return PRISTINE_HTML;
  // 部品(CSS・JS)を取りに行って1つのHTMLにまとめる。file:// で開いた
  // フォルダ版(git clone など)ではブラウザが取得を許さないので、呼び出し側でエラー案内になる
  return buildStandaloneHtml(PRISTINE_HTML, async (path) => {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path} を取得できませんでした(${res.status})`);
    return res.text();
  });
}

function saveToolError(err) {
  return location.protocol === "file:" && !isStandaloneBuild()
    ? "この開き方(フォルダ版を file:// で開いている状態)では部品ファイルを集められません。GitHub Pages の URL から開いて保存してください。"
    : `保存用のファイルを作れませんでした: ${err.message}`;
}

async function saveToolHtml() {
  const status = document.getElementById("save-tool-status");
  status.textContent = "保存用のファイルを作っています…";
  try {
    const html = await standaloneHtml();
    downloadBlob(STANDALONE_FILE_NAME, new Blob([html], { type: "text/html;charset=utf-8" }));
    status.textContent = `「${STANDALONE_FILE_NAME}」を保存しました。ダウンロードフォルダから使いたいフォルダへ移し、ダブルクリックで開けます。`;
  } catch (err) {
    status.textContent = saveToolError(err);
  }
}

const DISTRIBUTION_ZIP_NAME = "CF-visualization.zip";
const DISTRIBUTION_DATA_DIR = "元データ";
const DISTRIBUTION_README = "はじめにお読みください.txt";

/** 配布用ZIPに同梱する説明文 */
function distributionReadme(fileCount) {
  return [
    "CF計算書ジェネレーター 配布用フォルダ",
    "",
    "【使い方】",
    "1. このZIPを展開(右クリック →「すべて展開」)し、できたフォルダを好きな場所に置く",
    "   ※ デスクトップやダウンロードのフォルダそのものではなく、その中のフォルダとして置いてください",
    "2. フォルダ内の「CF計算書ジェネレーター.html」をダブルクリックで開く(パソコンの Chrome / Edge)",
    "3. 開いた画面の上部の案内「フォルダを選んで読み込む」から、このフォルダを選び、ブラウザの確認で「許可」を押す",
    `   → 元データ/ の中のファイル(${fileCount}件)がまとめて読み込まれます。次からは開くだけで前回の内容が表示されます`,
    "",
    "【フォルダの中身】",
    "CF計算書ジェネレーター.html  ツール本体(この1ファイルだけで動きます。インターネット接続は不要)",
    `${DISTRIBUTION_DATA_DIR}/                   読み込んだ元データ(会社×四半期のCSV)。ここにファイルを足すと、次に開いたとき(再接続時)に反映されます`,
    "overrides/                  詳細入力(入力してあった場合のみ)",
    "mapping.csv                 科目マッピング(使っていた場合のみ)",
    "settings.json               表示区分などの設定",
    "",
    "【注意】",
    "- iPhone / iPad / Android / Safari / Firefox ではフォルダの自動読み込みは使えません。元データ/ のCSVをドラッグ&ドロップで読み込んでください。",
    "- データは外部に送信されません。すべてお使いのパソコンの中だけで処理します。",
    `- 作成日時: ${new Date().toLocaleString("ja-JP")}`,
    "",
  ].join("\r\n");
}

/** いまの状態(ツール本体 + データ + 設定)を、配布用フォルダの構成で並べる */
async function buildDistributionFiles() {
  const files = [{ name: STANDALONE_FILE_NAME, text: await standaloneHtml() }];
  const used = new Set();
  const unique = (n) => {
    let k = n;
    for (let i = 2; used.has(k); i++) k = n.replace(/(\.[^.]+)?$/, `_${i}$1`);
    used.add(k);
    return k;
  };
  for (const src of state.sources) {
    // フォルダから直接読んだファイルは、元のサブフォルダの位置を保つ(名前はCSV化後のもの)
    const dir = src.external && src.path && src.path.includes("/")
      ? src.path.slice(0, src.path.lastIndexOf("/") + 1) : "";
    let rel = dir + safeFileName(src.name);
    if (!/\.(csv|tsv|txt)$/i.test(rel)) rel += ".csv";
    if (!rel.startsWith(`${DISTRIBUTION_DATA_DIR}/`)) rel = `${DISTRIBUTION_DATA_DIR}/${rel}`;
    files.push({ name: unique(rel), text: "﻿" + src.text });
  }
  for (const [key, values] of Object.entries(state.overrides || {})) {
    if (!values || Object.keys(values).length === 0) continue;
    const [company, period] = key.split("\u0000");
    files.push({ name: `${SHARE_OVERRIDE_DIR}/${safeFileName(`${company}_${period}.json`)}`,
      text: JSON.stringify({ company, period, values }, null, 2) });
  }
  if (state.mappingText) files.push({ name: SHARE_MAPPING, text: "﻿" + state.mappingText });
  files.push({ name: SHARE_SETTINGS, text: JSON.stringify({
    app: "CF-visualization",
    nameScheme: "unicode",
    interestPolicy: state.interestPolicy,
    folderPath: "",
    updatedAt: new Date().toISOString(),
    updatedBy: "",
    files: state.sources.length,
  }, null, 2) });
  files.push({ name: DISTRIBUTION_README, text: "﻿" + distributionReadme(state.sources.length) });
  return files;
}

async function saveDistributionZip() {
  const status = document.getElementById("save-tool-status");
  status.textContent = `配布用のZIPを作っています(${state.sources.length}ファイル)…`;
  try {
    const files = await buildDistributionFiles();
    const bytes = await buildZip(files);
    downloadBlob(DISTRIBUTION_ZIP_NAME, new Blob([bytes], { type: "application/zip" }));
    const mb = bytes.length / 1024 / 1024;
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes.length / 1024)} KB`;
    status.textContent = `「${DISTRIBUTION_ZIP_NAME}」を保存しました(${files.length}ファイル / ${size})。`
      + (state.sources.length ? "" : " データを読み込んでいないため、ツール本体と説明だけが入っています。")
      + " 受け取った人は、展開 → HTMLをダブルクリック → 案内からフォルダを選ぶ、で使えます。";
  } catch (err) {
    status.textContent = saveToolError(err);
  }
}

function bindStandaloneUI() {
  document.getElementById("btn-save-tool").addEventListener("click", saveToolHtml);
  document.getElementById("btn-save-zip").addEventListener("click", saveDistributionZip);
  const badge = document.getElementById("local-state");
  if (isStandaloneBuild()) {
    const stamp = document.querySelector(`meta[name="${STANDALONE_META}"]`).getAttribute("content") || "";
    badge.textContent = `いま開いているのは保存版です${stamp ? `(${stamp} 作成)` : ""}`;
    const build = document.querySelector(".build-id");
    if (build) build.textContent += ` / 保存版${stamp ? ` ${stamp}` : ""}`;
  } else {
    badge.hidden = true;
  }
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
      const dz = document.getElementById("detail-dropzone");
      if (!dropzone.contains(ev.target) && !(dz && dz.contains(ev.target))) ev.preventDefault();
    });
  }

  // サンプルは、社内の会計システムと同じ残高試算表形式に変換して読み込む
  document.getElementById("btn-sample-27")
    .addEventListener("click", () => applySources(templateToTrialBalance(SAMPLE_27_CSV)));
  document.getElementById("btn-sample")
    .addEventListener("click", () => applySources(
      templateToTrialBalance(SAMPLE_CSV, { company: "サンプル製作所", year: 2026, month: 3 })));
  document.getElementById("btn-sample-xlsx")
    .addEventListener("click", () => {
      const f = buildTrialBalanceSampleXlsx();
      downloadBlob(f.name, new Blob([f.bytes],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    });
  document.getElementById("btn-template")
    .addEventListener("click", () => downloadText("cf-template.csv", buildTemplateCSV()));
  // 読み取りの診断をコピー(科目名・金額を含まないので、そのまま問い合わせに貼れる)
  document.getElementById("btn-debug-copy")
    .addEventListener("click", async () => {
      const text = debugReportText();
      if (!text) return;
      const status = document.getElementById("debug-copy-status");
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = "コピーしました。そのまま貼り付けて共有できます。";
      } catch (_) {
        window.prompt("この内容をコピーしてください:", text);
        status.textContent = "";
      }
    });
  document.getElementById("btn-export")
    .addEventListener("click", () => {
      if (state.datasets.length) downloadText("cf-input.csv", buildTemplateCSV(state.datasets));
    });
  document.getElementById("btn-clear").addEventListener("click", clearAll);

  document.getElementById("company-select").addEventListener("change", (ev) => {
    state.company = ev.target.value;
    renderAll();
  });
  document.getElementById("period-select").addEventListener("change", (ev) => {
    state.period = ev.target.value;
    // その会社にデータがない四半期でも、勝手に別の会社へ切り替えない。
    // 代わりに renderAll が「このデータは入っていません」と案内する。
    renderAll();
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

  // --- 算定ロジックタブ ---
  document.getElementById("deriv-line-select").addEventListener("change", (ev) => {
    state.derivLine = Number(ev.target.value);
    renderDerivationDiagram();
    renderDerivationText();
  });
  // 図はコンテナ幅に合わせて等倍で描くので、幅が変わったら描き直す
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // グラフはコンテナ幅に合わせて等倍で描いているので、幅が変わったら描き直す
      if (!document.getElementById("panel-logic").hidden) renderDerivationDiagram();
      if (!document.getElementById("panel-summary").hidden) renderTrend();
      if (!document.getElementById("panel-overview").hidden) renderOverviewChart();
    }, 120);
  });

  // --- 詳細入力タブ ---
  document.getElementById("btn-detail-template")
    .addEventListener("click", () => downloadText("cf-detail-template.csv", buildDetailTemplate()));
  document.getElementById("detail-preview-more").addEventListener("click", () => {
    state.detailPreviewLimit += 50;
    renderDetailPreview();
  });
  const detailInput = document.getElementById("detail-file-input");
  detailInput.addEventListener("change", () => handleDetailFiles(detailInput.files));
  const detailZone = document.getElementById("detail-dropzone");
  for (const type of ["dragenter", "dragover"]) {
    detailZone.addEventListener(type, (ev) => { ev.preventDefault(); detailZone.classList.add("is-over"); });
  }
  for (const type of ["dragleave", "dragend"]) {
    detailZone.addEventListener(type, () => detailZone.classList.remove("is-over"));
  }
  detailZone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    detailZone.classList.remove("is-over");
    handleDetailFiles(ev.dataTransfer.files);
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
    for (const k of OBSOLETE_STORAGE_KEYS) localStorage.removeItem(k);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved.mappingText === "string" && saved.mappingText) {
      setMapping(saved.mappingText, { quiet: true });
    }
    if (saved && Array.isArray(saved.sources) && saved.sources.length) {
      state.overrides = saved.overrides && typeof saved.overrides === "object" ? saved.overrides : {};
      if (INTEREST_POLICIES.some((p) => p.key === saved.interestPolicy)) state.interestPolicy = saved.interestPolicy;
      applySources(saved.sources);
    }
  } catch (_) { /* 無視 */ }

  renderTabs();
  bindSourceModal();
  bindMappingUI();
  bindShareUI();
  bindStandaloneUI();
  // まだ何も読み込まれていなければ、読み込み画面を開いた状態で始める
  if (!hasData()) openSourceModal();
});
