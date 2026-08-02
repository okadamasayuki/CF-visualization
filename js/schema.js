"use strict";

/* =========================================================
 * 財務諸表の科目定義
 *
 * key      : 内部キー(計算ロジックで使用)
 * label    : 画面・テンプレートCSVでの表示名
 * aliases  : CSVで受け付ける別名(表示名も自動的に別名に含まれる)
 * negate   : CSVの金額の符号を反転して取り込む(例:「固定資産売却損」)
 * absolute : 絶対値で取り込む(支出項目など、正の値で入力する前提の科目)
 * ======================================================= */

const SCHEMA = {
  // BS: 前期末(prev)・当期末(curr)の2期分
  bs: [
    { key: "cash", label: "現金及び預金", group: "資産",
      aliases: ["現金", "現金預金", "現金・預金", "現金及び現金同等物", "現預金"] },
    { key: "deposits", label: "預け金", group: "資産",
      aliases: ["預け金勘定", "関係会社預け金", "CMS預け金", "親会社預け金"] },
    { key: "receivables", label: "売上債権", group: "資産",
      aliases: ["売掛金", "受取手形", "受取手形及び売掛金", "売掛金及び受取手形", "売上債権(純額)"] },
    { key: "inventory", label: "棚卸資産", group: "資産",
      aliases: ["商品", "製品", "商品及び製品", "仕掛品", "原材料", "在庫"] },
    { key: "otherCA", label: "その他流動資産", group: "資産",
      aliases: ["その他の流動資産", "前払費用", "未収入金"] },
    { key: "tangible", label: "有形固定資産(純額)", group: "資産",
      aliases: ["有形固定資産", "建物", "機械装置", "土地", "有形固定資産純額"] },
    { key: "investments", label: "投資その他の資産", group: "資産",
      aliases: ["投資等", "投資有価証券", "その他の投資"] },
    { key: "payables", label: "仕入債務", group: "負債",
      aliases: ["買掛金", "支払手形", "支払手形及び買掛金", "買掛金及び支払手形"] },
    { key: "shortLoans", label: "短期借入金", group: "負債",
      aliases: ["短期借入", "1年内返済予定の長期借入金"] },
    { key: "otherCL", label: "その他流動負債", group: "負債",
      aliases: ["その他の流動負債", "未払金", "未払費用", "未払法人税等"] },
    { key: "longLoans", label: "長期借入金", group: "負債",
      aliases: ["長期借入", "社債"] },
    { key: "netAssets", label: "純資産合計", group: "純資産",
      aliases: ["純資産", "株主資本", "株主資本合計", "資本合計"] },
  ],

  // PL: 当期のみ
  pl: [
    { key: "revenue", label: "売上高",
      aliases: ["営業収益", "売上収益", "収益", "売上"] },
    { key: "operatingIncome", label: "営業利益",
      aliases: ["営業損益", "事業利益"] },
    { key: "pretaxIncome", label: "税引前当期純利益",
      aliases: ["税金等調整前当期純利益", "税引前利益", "税引前当期利益"] },
    { key: "depreciation", label: "減価償却費",
      aliases: ["減価償却費及びのれん償却額", "償却費"] },
    { key: "interestIncome", label: "受取利息及び受取配当金",
      aliases: ["受取利息", "受取配当金", "受取利息配当金", "受取利息及び配当金"] },
    { key: "interestExpense", label: "支払利息",
      aliases: ["支払利息割引料", "金融費用"] },
    { key: "gainOnSale", label: "固定資産売却損益(益は+、損は−)",
      aliases: ["固定資産売却損益", "固定資産売却益", "有形固定資産売却損益", "有形固定資産売却益"] },
    { key: "gainOnSale", label: "固定資産売却損", negate: true, aliasOnly: true,
      aliases: ["固定資産売却損", "有形固定資産売却損"] },
    { key: "incomeTaxes", label: "法人税等",
      aliases: ["法人税、住民税及び事業税", "法人税等合計", "法人税住民税及び事業税"] },
  ],

  // 補足情報: 当期のみ
  sup: [
    { key: "saleProceeds", label: "有形固定資産の売却による収入", absolute: true,
      aliases: ["固定資産売却収入", "有形固定資産売却収入", "固定資産の売却による収入", "売却収入"] },
  ],

  // 詳細情報: 入力すると簡便法の仮定を減らせる。すべて任意・正の値
  detail: [
    { key: "shortLoanProceeds", label: "短期借入れによる収入", absolute: true, group: "総額表示",
      aliases: ["短期借入による収入", "短期借入金の借入による収入"] },
    { key: "shortLoanRepayment", label: "短期借入金の返済による支出", absolute: true, group: "総額表示",
      aliases: ["短期借入の返済による支出"] },
    { key: "longLoanProceeds", label: "長期借入れによる収入", absolute: true, group: "総額表示",
      aliases: ["長期借入による収入", "長期借入金の借入による収入"] },
    { key: "longLoanRepayment", label: "長期借入金の返済による支出", absolute: true, group: "総額表示",
      aliases: ["長期借入の返済による支出"] },
    { key: "impairment", label: "減損損失", absolute: true, group: "非資金項目",
      aliases: ["減損損失額", "固定資産減損損失"] },
    { key: "retirement", label: "固定資産除却損(除却簿価)", absolute: true, group: "非資金項目",
      aliases: ["固定資産除却損", "除却損", "固定資産除却額"] },
    { key: "leaseAcquisition", label: "ファイナンスリースによる資産取得額", absolute: true, group: "非資金項目",
      aliases: ["リース資産の取得額", "ファイナンスリース取引による資産取得"] },
    { key: "interestReceived", label: "利息及び配当金の受取額(実額)", absolute: true, group: "実際の受払額",
      aliases: ["利息の受取額", "利息及び配当金の受取額実績"] },
    { key: "interestPaid", label: "利息の支払額(実額)", absolute: true, group: "実際の受払額",
      aliases: ["利息の支払額実績"] },
    { key: "taxPaid", label: "法人税等の支払額(実額)", absolute: true, group: "実際の受払額",
      aliases: ["法人税等の納付額", "法人税等の支払額実績"] },
  ],

  // SS: 当期のみ(すべて正の値で入力)
  ss: [
    { key: "stockIssue", label: "新株の発行(増資)", absolute: true,
      aliases: ["新株の発行", "増資", "株式の発行", "株式の発行による収入", "新株発行"] },
    { key: "dividendsPaid", label: "剰余金の配当(配当金の支払額)", absolute: true,
      aliases: ["剰余金の配当", "配当金の支払額", "配当金", "配当", "剰余金の配当額"] },
    { key: "treasuryBuy", label: "自己株式の取得", absolute: true,
      aliases: ["自己株式の取得による支出", "自己株式取得"] },
    { key: "treasurySell", label: "自己株式の処分", absolute: true,
      aliases: ["自己株式の処分による収入", "自己株式処分"] },
  ],
};

// 画面に表示する科目(aliasOnly の行はテンプレート・表には出さない)
const DISPLAY_FIELDS = {
  bs: SCHEMA.bs.filter((f) => !f.aliasOnly),
  pl: SCHEMA.pl.filter((f) => !f.aliasOnly),
  sup: SCHEMA.sup.filter((f) => !f.aliasOnly),
  ss: SCHEMA.ss.filter((f) => !f.aliasOnly),
  detail: SCHEMA.detail.filter((f) => !f.aliasOnly),
};

const SECTION_LABELS = {
  bs: "BS",
  pl: "PL",
  sup: "補足",
  ss: "SS",
  detail: "詳細",
};

/** 空の入力データ(すべて0)を作る */
function emptyData() {
  const data = { bs: { prev: {}, curr: {} }, pl: {}, sup: {}, ss: {}, detail: {} };
  for (const f of SCHEMA.bs) { data.bs.prev[f.key] = 0; data.bs.curr[f.key] = 0; }
  for (const f of SCHEMA.pl) data.pl[f.key] = 0;
  for (const f of SCHEMA.sup) data.sup[f.key] = 0;
  for (const f of SCHEMA.ss) data.ss[f.key] = 0;
  for (const f of SCHEMA.detail) data.detail[f.key] = 0;
  return data;
}
