"use strict";

/* =========================================================
 * 財務指標の計算
 *
 * 定義は日本の実務でよく使われるものを採用し、画面にも併記する。
 *  EBITDA        = 営業利益 + 減価償却費
 *  運転資金       = 売上債権 + 棚卸資産 − 仕入債務
 *  有利子負債     = 短期借入金 + 長期借入金
 *  ネット有利子負債 = 有利子負債 − (現金及び預金 + 預け金)
 *  投下資本       = 有利子負債 + 純資産
 *  ROIC          = NOPAT(年換算) ÷ 投下資本(期首期末平均)
 * ======================================================= */

/**
 * 表示する指標の一覧。
 *  kind … amount(金額) / pct(比率)
 *  good … 増減を色付けする向き。up=増加が良い、down=減少が良い、
 *         省略した指標は良し悪しが一概に言えないため色を付けない
 */
const METRIC_ROWS = [
  { key: "revenue", label: "売上高", kind: "amount", good: "up" },
  { key: "operatingIncome", label: "営業利益", kind: "amount", good: "up" },
  { key: "ebitda", label: "EBITDA", kind: "amount", good: "up", note: "営業利益 + 減価償却費" },
  { key: "ebitdaMargin", label: "EBITDAマージン", kind: "pct", good: "up", note: "EBITDA ÷ 売上高" },
  { key: "roic", label: "ROIC", kind: "pct", good: "up", note: "NOPAT(年換算) ÷ 投下資本(期首期末平均)" },
  { key: "workingCapital", label: "運転資金", kind: "amount", note: "売上債権 + 棚卸資産 − 仕入債務" },
  { key: "interestBearingDebt", label: "有利子負債", kind: "amount", good: "down", note: "短期借入金 + 長期借入金" },
  { key: "deposits", label: "預け金", kind: "amount" },
  { key: "cashAndDeposits", label: "現金及び預金 + 預け金", kind: "amount", good: "up" },
  { key: "netDebt", label: "ネット有利子負債", kind: "amount", good: "down", note: "有利子負債 − (現金及び預金 + 預け金)" },
  { key: "equityRatio", label: "自己資本比率", kind: "pct", good: "up", note: "純資産 ÷ 総資産" },
  { key: "operatingCF", label: "営業CF", kind: "amount", good: "up", cf: true },
  { key: "freeCF", label: "フリーCF", kind: "amount", good: "up", cf: true, note: "営業CF + 投資CF" },
];

const DEFAULT_TAX_RATE = 0.3;

function totalAssets(side) {
  return side.cash + side.deposits + side.receivables + side.inventory +
    side.otherCA + side.tangible + side.investments;
}

function interestBearingDebt(side) {
  return side.shortLoans + side.longLoans;
}

function workingCapital(side) {
  return side.receivables + side.inventory - side.payables;
}

/**
 * 1期分の指標を計算する。ROICの年換算は期をまたぐ情報が要るため、
 * ここでは NOPAT と投下資本までを求め、roic は finalizeROIC で埋める。
 */
function computeBaseMetrics(data, cf, provided = new Set()) {
  const { bs, pl } = data;
  const curr = bs.curr, prev = bs.prev;

  // 営業利益が未入力のCSVでも使えるよう、税引前利益と金融損益から推計する
  const hasOperatingIncome = provided.has("pl:operatingIncome");
  const operatingIncome = hasOperatingIncome
    ? pl.operatingIncome
    : pl.pretaxIncome + pl.interestExpense - pl.interestIncome;
  const operatingIncomeEstimated = !hasOperatingIncome;

  const ebitda = operatingIncome + pl.depreciation;

  // 実効税率は実績から。異常値のときは既定値に落とす
  const rawRate = pl.pretaxIncome > 0 ? pl.incomeTaxes / pl.pretaxIncome : NaN;
  const taxRate = Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 0.6 ? rawRate : DEFAULT_TAX_RATE;

  const debtCurr = interestBearingDebt(curr);
  const investedCapitalEnd = debtCurr + curr.netAssets;
  const investedCapitalBeg = interestBearingDebt(prev) + prev.netAssets;
  const assets = totalAssets(curr);

  return {
    revenue: pl.revenue,
    operatingIncome,
    operatingIncomeEstimated,
    ebitda,
    ebitdaMargin: pl.revenue !== 0 ? ebitda / pl.revenue : null,
    workingCapital: workingCapital(curr),
    interestBearingDebt: debtCurr,
    deposits: curr.deposits,
    cashAndDeposits: curr.cash + curr.deposits,
    netDebt: debtCurr - (curr.cash + curr.deposits),
    equityRatio: assets !== 0 ? curr.netAssets / assets : null,
    // CF計算書の数値も同じオブジェクトから引けるようにまとめておく
    operatingCF: cf ? cf.operatingCF : null,
    investingCF: cf ? cf.investingCF : null,
    financingCF: cf ? cf.financingCF : null,
    freeCF: cf ? cf.freeCF : null,
    netChange: cf ? cf.netChange : null,
    beginningCash: cf ? cf.beginningCash : null,
    endingCash: cf ? cf.endingCash : null,

    // ROICの計算材料
    nopat: operatingIncome * (1 - taxRate),
    taxRate,
    investedCapital: investedCapitalBeg !== 0
      ? (investedCapitalBeg + investedCapitalEnd) / 2
      : investedCapitalEnd,
    roic: null,
    roicBasis: null,
  };
}

/**
 * 1社分の時系列(四半期の昇順)を受け取り、ROICを埋める。
 * 四半期データなら直近4四半期(TTM)、揃わなければ当四半期の4倍で年換算する。
 * 年次データはそのまま用いる。
 */
function finalizeROIC(series) {
  series.forEach((d, i) => {
    const m = d.metrics;
    if (!m.investedCapital) { m.roic = null; return; }

    if (d.period.q === null) {                 // 四半期ではない(通期・年度)
      m.roic = m.nopat / m.investedCapital;
      m.roicBasis = "通期";
      return;
    }
    const window = series.slice(Math.max(0, i - 3), i + 1);
    if (window.length === 4) {
      const ttm = window.reduce((s, x) => s + x.metrics.nopat, 0);
      m.roic = ttm / m.investedCapital;
      m.roicBasis = "直近4四半期";
    } else {
      m.roic = (m.nopat * 4) / m.investedCapital;
      m.roicBasis = "当四半期×4";
    }
  });
}
