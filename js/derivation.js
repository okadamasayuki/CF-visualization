"use strict";

/* =========================================================
 * 「算定ロジック」タブの内容
 *
 * CF計算書の各行が、BS・PL・SS・補足・詳細情報のどこから算定されているかの対応表。
 *
 *  labels   … computeCF() が実際に出力しうる行名(条件で変わるものは複数)
 *  inputs   … { path, sign } の配列。path は data オブジェクトのパス。
 *              「その入力を +1 したとき、この行が sign だけ動く」ことを表す。
 *              計算が線形なので、テストで数値的に検証している。
 *  requires … その行が現れるために必要な詳細情報のキー
 *  computed … 他の行の合計(直接の入力を持たない)
 * ======================================================= */

const SOURCE_KINDS = {
  bs: { label: "BS", name: "貸借対照表" },
  pl: { label: "PL", name: "損益計算書" },
  ss: { label: "SS", name: "株主資本等変動計算書" },
  sup: { label: "補足", name: "補足情報" },
  detail: { label: "詳細", name: "詳細情報(任意入力)" },
  calc: { label: "計算", name: "他の行から計算" },
};

/** パスから {kind, label} を求める(表示用) */
function describePath(path) {
  const parts = path.split(".");
  if (parts[0] === "bs") {
    const f = SCHEMA.bs.find((x) => x.key === parts[2]);
    return { kind: "bs", text: `${f ? f.label : parts[2]}(${parts[1] === "curr" ? "期末" : "期首"})` };
  }
  const section = parts[0];
  const f = (SCHEMA[section] || []).find((x) => x.key === parts[1] && !x.aliasOnly);
  return { kind: section, text: f ? f.label : parts[1] };
}

const DERIVATION = [
  {
    id: "operating",
    title: "Ⅰ 営業活動によるキャッシュ・フロー",
    lead: "税引前当期純利益から出発し、非資金項目・投資財務に属する損益・運転資本の増減を加減算します(間接法)。",
    items: [
      { labels: ["税引前当期純利益"], inputs: [{ path: "pl.pretaxIncome", sign: 1 }] },
      { labels: ["減価償却費"], inputs: [{ path: "pl.depreciation", sign: 1 }],
        note: "現金支出を伴わない費用なので足し戻します。" },
      { labels: ["減損損失"], requires: ["impairment"], inputs: [{ path: "detail.impairment", sign: 1 }],
        note: "非資金の費用を足し戻し、同額を固定資産の取得額から除きます。" },
      { labels: ["除却損"], requires: ["retirement"], inputs: [{ path: "detail.retirement", sign: 1 }],
        note: "同上。除却による簿価の減少を取得額と切り分けます。" },
      { labels: ["為替差損益"], requires: ["fxEffect"], inputs: [{ path: "detail.fxEffect", sign: -1 }],
        note: "換算差額は税引前当期純利益に含まれているため営業から消去し、同額を3区分の外に置きます。" },
      { labels: ["固定資産売却益", "固定資産売却損"], inputs: [{ path: "pl.gainOnSale", sign: -1 }],
        note: "投資活動に属する損益なので営業から除きます。" },
      { labels: ["受取利息及び受取配当金"], inputs: [{ path: "pl.interestIncome", sign: -1 }],
        note: "発生額をいったん消去し、実際の受取額として計上し直します。" },
      { labels: ["支払利息"], inputs: [{ path: "pl.interestExpense", sign: 1 }],
        note: "同上。実際の支払額として計上し直します。" },
      { labels: ["営業債権の増減"],
        inputs: [{ path: "bs.curr.receivables", sign: -1 }, { path: "bs.prev.receivables", sign: 1 }],
        note: "債権が増えるとその分だけ現金化が遅れるため、符号を反転します。" },
      { labels: ["棚卸資産の増減"],
        inputs: [{ path: "bs.curr.inventory", sign: -1 }, { path: "bs.prev.inventory", sign: 1 }] },
      { labels: ["その他流動資産の増減", "その他流動資産の増減(未収利息を除く)"],
        inputs: [{ path: "bs.curr.otherCA", sign: -1 }, { path: "bs.prev.otherCA", sign: 1 }],
        detailVariant: {
          requires: ["interestReceived"],
          inputs: [
            { path: "bs.curr.otherCA", sign: -1 }, { path: "bs.prev.otherCA", sign: 1 },
            { path: "pl.interestIncome", sign: 1 }, { path: "detail.interestReceived", sign: -1 },
          ],
        },
        note: "実際の受取額を入力すると、その差額(未収利息の増減)をこの行から取り除き、二重計上を防ぎます。" },
      { labels: ["営業債務の増減"],
        inputs: [{ path: "bs.curr.payables", sign: 1 }, { path: "bs.prev.payables", sign: -1 }],
        note: "債務が増えると支払いが後ろ倒しになるため、そのまま加算します。" },
      { labels: ["その他流動負債の増減", "その他流動負債の増減(未払利息・未払法人税等を除く)"],
        inputs: [{ path: "bs.curr.otherCL", sign: 1 }, { path: "bs.prev.otherCL", sign: -1 }],
        detailVariant: {
          requires: ["interestPaid", "taxPaid"],
          inputs: [
            { path: "bs.curr.otherCL", sign: 1 }, { path: "bs.prev.otherCL", sign: -1 },
            { path: "pl.interestExpense", sign: -1 }, { path: "detail.interestPaid", sign: 1 },
            { path: "pl.incomeTaxes", sign: -1 }, { path: "detail.taxPaid", sign: 1 },
          ],
        },
        note: "同上。未払利息・未払法人税等の増減をこの行から取り除きます。" },
      { labels: ["その他固定負債の増減"],
        inputs: [{ path: "bs.curr.otherFixedLiab", sign: 1 }, { path: "bs.prev.otherFixedLiab", sign: -1 }] },
      { labels: ["退職給付引当金の増減"],
        inputs: [{ path: "bs.curr.retirementBenefits", sign: 1 }, { path: "bs.prev.retirementBenefits", sign: -1 }],
        note: "引当金の繰入は現金支出を伴わないため、増加額を足し戻します。" },
      { labels: ["法人税等の支払額"], inputs: [{ path: "pl.incomeTaxes", sign: -1 }],
        assumption: "本来は未払法人税等の増減と中間納付を反映した実際の納付額です。詳細情報に実額を入れると置き換わります。",
        detailVariant: { requires: ["taxPaid"], inputs: [{ path: "detail.taxPaid", sign: -1 }] } },
      { labels: ["利息及び配当金の受取額"], inputs: [{ path: "pl.interestIncome", sign: 1 }],
        assumption: "本来は未収利息の増減を調整した実際の受取額です。詳細情報に実額を入れると置き換わります。",
        detailVariant: { requires: ["interestReceived"], inputs: [{ path: "detail.interestReceived", sign: 1 }] },
        note: "表示区分②を選ぶと投資活動に移ります。" },
      { labels: ["利息の支払額"], inputs: [{ path: "pl.interestExpense", sign: -1 }],
        assumption: "本来は未払利息の増減を調整した実際の支払額です。詳細情報に実額を入れると置き換わります。",
        detailVariant: { requires: ["interestPaid"], inputs: [{ path: "detail.interestPaid", sign: -1 }] },
        note: "表示区分②を選ぶと財務活動に移ります。" },
    ],
  },
  {
    id: "investing",
    title: "Ⅱ 投資活動によるキャッシュ・フロー",
    lead: "BSの残高差から逆算しています。総額や非資金の増減を分けるには詳細情報が必要です。",
    items: [
      {
        labels: ["固定資産の取得による支出"],
        inputs: [
          { path: "bs.curr.tangible", sign: -1 }, { path: "bs.prev.tangible", sign: 1 },
          { path: "pl.depreciation", sign: -1 },
          { path: "sup.saleProceeds", sign: -1 }, { path: "pl.gainOnSale", sign: 1 },
        ],
        note: "Δ有形固定資産 = 取得 − 減価償却費 − 売却簿価 の関係を取得について解いています(売却簿価 = 売却収入 − 売却損益)。",
        assumption: "残高差からの逆算なので、除却・減損・リース取得もこの行に混ざります。詳細情報を入れると分離できます。",
        detailVariant: {
          requires: ["impairment", "retirement", "leaseAcquisition"],
          inputs: [
            { path: "bs.curr.tangible", sign: -1 }, { path: "bs.prev.tangible", sign: 1 },
            { path: "pl.depreciation", sign: -1 },
            { path: "sup.saleProceeds", sign: -1 }, { path: "pl.gainOnSale", sign: 1 },
            { path: "detail.impairment", sign: -1 }, { path: "detail.retirement", sign: -1 },
            { path: "detail.leaseAcquisition", sign: 1 },
          ],
        },
      },
      { labels: ["固定資産の売却による収入"], inputs: [{ path: "sup.saleProceeds", sign: 1 }],
        note: "3表の外から受け取る入力です。この値を変えても3区分の合計は変わらず、取得支出との内訳表示だけが動きます。" },
      { labels: ["その他の投資"],
        inputs: [
          { path: "bs.curr.investments", sign: -1 }, { path: "bs.prev.investments", sign: 1 },
          { path: "bs.curr.deposits", sign: -1 }, { path: "bs.prev.deposits", sign: 1 },
          { path: "bs.curr.cashExcluded", sign: -1 }, { path: "bs.prev.cashExcluded", sign: 1 },
        ],
        note: "投資その他の資産・預け金・現金同等物に含めない預金の増減をまとめた行です。預け金の内訳は「推移」タブで確認できます。",
        assumption: "いずれも取得と売却を相殺した純額です。" },
    ],
  },
  {
    id: "financing",
    title: "Ⅲ 財務活動によるキャッシュ・フロー",
    lead: "借入金はBSの残高差(収支)、資本取引はSSの変動事由から算定します。詳細情報を入れると総額表示になります。",
    items: [
      { labels: ["短期借入債務の収支"],
        inputs: [{ path: "bs.curr.shortLoans", sign: 1 }, { path: "bs.prev.shortLoans", sign: -1 }],
        assumption: "借入れによる収入と返済による支出を相殺した純額です。詳細情報を入れると総額表示に切り替わります。" },
      { labels: ["短期借入れによる収入"], requires: ["shortLoanProceeds", "shortLoanRepayment"],
        inputs: [{ path: "detail.shortLoanProceeds", sign: 1 }],
        note: "「収入 − 支出」がBSの増減と一致するときだけ総額表示に切り替えます。" },
      { labels: ["短期借入金の返済による支出"], requires: ["shortLoanProceeds", "shortLoanRepayment"],
        inputs: [{ path: "detail.shortLoanRepayment", sign: -1 }] },
      { labels: ["長期借入債務の収支"],
        inputs: [{ path: "bs.curr.longLoans", sign: 1 }, { path: "bs.prev.longLoans", sign: -1 }],
        assumption: "同じく純額です。詳細情報を入れると総額表示に切り替わります。",
        detailVariant: {
          requires: ["leaseAcquisition"],
          inputs: [
            { path: "bs.curr.longLoans", sign: 1 }, { path: "bs.prev.longLoans", sign: -1 },
            { path: "detail.leaseAcquisition", sign: -1 },
          ],
        },
        note: "リース債務の増加は現金の借入れではないため、詳細情報があれば差し引きます。" },
      { labels: ["長期借入れによる収入"], requires: ["longLoanProceeds", "longLoanRepayment"],
        inputs: [{ path: "detail.longLoanProceeds", sign: 1 }] },
      { labels: ["長期借入金の返済による支出"], requires: ["longLoanProceeds", "longLoanRepayment"],
        inputs: [{ path: "detail.longLoanRepayment", sign: -1 }] },
      { labels: ["その他の財務"],
        inputs: [
          { path: "ss.stockIssue", sign: 1 },
          { path: "ss.treasuryBuy", sign: -1 },
          { path: "ss.treasurySell", sign: 1 },
        ],
        note: "株式の発行・自己株式の取得と処分をまとめた行です。" },
      { labels: ["配当金の支払額"], inputs: [{ path: "ss.dividendsPaid", sign: -1 }],
        assumption: "本来は未払配当金の増減を調整した実際の支払額です。" },
    ],
  },
  {
    id: "result",
    title: "フリーCF・現金及び現金同等物",
    lead: "区分の合計から、フリー・キャッシュ・フローと現金残高を求めます。",
    items: [
      { labels: ["フリー・キャッシュ・フロー"], computed: "営業CF + 投資CF" },
      { labels: ["現金及び現金同等物に係る換算差額", "Ⅳ 現金及び現金同等物に係る換算差額"],
        requires: ["fxEffect"], inputs: [{ path: "detail.fxEffect", sign: 1 }],
        note: "3区分の外に置く独立の行です。営業から消去した同額をここに戻すため、増減額は変わりません。" },
      { labels: ["現金及び現金同等物の増減額"], computed: "営業CF + 投資CF + 財務CF + 換算差額" },
      { labels: ["現金及び現金同等物の期首残高"],
        inputs: [{ path: "bs.prev.cash", sign: 1 }, { path: "bs.prev.cashExcluded", sign: -1 }],
        note: "現金同等物 = 現金及び預金 − 現金同等物に含めない預金。" },
      { labels: ["現金及び現金同等物の期末残高"], computed: "期首残高 + 増減額" },
    ],
  },
];

/** 行名 → その行が属する区分 */
const LINE_SECTION = new Map();
for (const s of DERIVATION) for (const i of s.items) for (const l of i.labels) LINE_SECTION.set(l, s);

/* ---------- 簡便法の仮定 ---------- */

const ASSUMPTIONS = [
  {
    title: "整合性チェックは金額の妥当性を保証しません",
    level: "critical",
    body: "「CF計算書とBSの現金残高の整合」は、BSが両期で貸借一致し、かつSSと純資産増減が整合していれば数学的に必ず成立します。CFをBSの差額から逆算して作っているためで、独立した検証にはなっていません。たとえば減価償却費を誤ると営業CFと投資CFの配分がずれますが、チェックはすべてOKのままです。",
    fix: null,
  },
  {
    title: "収入と支出を総額で表示できない",
    level: "high",
    body: "借入金はBSの残高差(純額)だけで表示しています。",
    fix: "「詳細入力」タブで借入れによる収入・返済による支出を入力すると、総額表示に切り替わります(収入 − 支出 がBSの増減と一致する場合)。",
  },
  {
    title: "経過勘定を無視している",
    level: "high",
    body: "利息及び配当金の受取額、利息の支払額、法人税等の支払額は、PLの発生額をそのまま用いています。",
    fix: "「詳細入力」タブで実際の受払額を入力すると置き換わります。発生額との差(未収利息・未払利息・未払法人税等の増減)は、その他流動資産／負債の増減の行から取り除くため、営業CFの合計は変わりません。",
  },
  {
    title: "有形固定資産の動きが1行に集約される",
    level: "high",
    body: "取得による支出は「期末純額 − 期首純額 + 減価償却費 + 売却簿価」で逆算しているため、除却・減損・リース取得も取得額に混ざります。",
    fix: "「詳細入力」タブで減損損失・除却損・ファイナンスリースによる取得額を入力すると、取得額から分離されます。",
  },
  {
    title: "連結範囲の変動を扱えない",
    level: "medium",
    body: "新規連結・連結除外に伴う現金及び現金同等物の増減は、本来3区分の外に独立の行として置きますが、入力項目がありません。現物出資・株式交換などの非資金取引、引当金の増減、持分法投資損益も同様です。",
    fix: null,
  },
  {
    title: "利息・配当金の表示区分は会計方針の選択",
    level: "medium",
    body: "日本基準では継続適用を条件に2方式の選択が認められており、どちらが正しいという性質のものではありません。既定は「受取利息・配当金と支払利息を営業CF」です。",
    fix: "「詳細入力」タブで方式を切り替えられます。区分間の振替なので増減額は変わりません。",
  },
];

/** 詳細情報を入れると何が変わるかの説明(詳細入力タブで使う) */
const DETAIL_GROUPS = [
  {
    group: "総額表示",
    lead: "借入金の増減を、収入と支出に分けて表示します。",
    effect: "「短期/長期借入金の純増減額」の1行が、「借入れによる収入」と「返済による支出」の2行に分かれます。収入 − 支出 がBSの増減と一致しない場合は純額のままにし、警告を出します。",
  },
  {
    group: "非資金項目",
    lead: "現金の動きを伴わない固定資産の増減を、取得額から切り分けます。",
    effect: "減損損失・除却損は営業CFで足し戻し、同額を取得額から除きます(営業CFと投資CFの間で振り替わります)。ファイナンスリースは取得額と長期借入れの双方から除き、注記として別掲します(投資CFと財務CFの間で振り替わります)。区分の合計は変わりますが、増減額と期末残高は変わりません。",
  },
  {
    group: "その他",
    lead: "外貨建ての現金がある場合の換算差額です。",
    effect: "税引前当期純利益に含まれる為替差損益を営業CFから消去し、同額を3区分の外に「現金及び現金同等物に係る換算差額」として置きます。会計基準どおりの表示になります。",
  },
  {
    group: "実際の受払額",
    lead: "利息・配当金・法人税等について、発生額ではなく実際の受払額を表示します。",
    effect: "該当行が実額に置き換わります。発生額との差(未収利息・未払利息・未払法人税等の増減)は、その他流動資産／負債の増減の行から取り除いて二重計上を防ぎます。営業CFの合計は変わりません。",
  },
];
