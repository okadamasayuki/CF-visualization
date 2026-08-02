// 27社 × 10四半期のサンプルCSV(sample-27.csv)を生成する。
//
// 全社・全四半期で「BS貸借一致」「CF計算書とBSの現金残高の整合」
// 「SSと純資産増減の整合」がパスするよう、純資産をSSの変動事由から、
// 現金を貸借一致から逆算して組み立てている(間接法の構造上、
// この作り方をすればCFの期末残高はBSの現金と自動的に一致する)。
//
//   node scripts/gen-sample-27.js && node scripts/build-samples.js
//
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const QUARTERS = 10;
const START = { year: 2023, q: 4 }; // ここから10四半期

// 決定的な擬似乱数(再現性のため)
let seed = 20260802;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick(lo, hi, unit = 100) { return Math.round((lo + rnd() * (hi - lo)) / unit) * unit; }

const NAMES = [
  'アルファ工業', 'ブライト電機', 'シーサイド物流', 'ダイワ精密', 'エイト食品',
  'フジミ化学', 'グリーンリーフ', 'ハヤブサ運輸', 'イズミ建設', 'ジュピター商事',
  'ケヤキ製作所', 'ルミナス光学', 'ミナト水産', 'ノースウッド', 'オリオン機械',
  'パシフィック紙業', 'クオリア医薬', 'リバーサイド不動産', 'サクラ繊維', 'トウヨウ金属',
  'ユニバース情報', 'ヴェルデ農産', 'ワカバ製薬', 'キセキ電子', 'ヤマト包装',
  'ゼニス計測', 'ホクト印刷',
];

const periods = [];
for (let i = 0, y = START.year, q = START.q; i < QUARTERS; i++) {
  periods.push(`${y}Q${q}`);
  if (++q > 4) { q = 1; y++; }
}

const BS_ITEMS = [
  ['cash', '現金及び預金'], ['deposits', '預け金'], ['receivables', '売上債権'],
  ['inventory', '棚卸資産'], ['otherCA', 'その他流動資産'], ['tangible', '有形固定資産(純額)'],
  ['investments', '投資その他の資産'], ['payables', '仕入債務'], ['shortLoans', '短期借入金'],
  ['otherCL', 'その他流動負債'], ['longLoans', '長期借入金'], ['netAssets', '純資産合計'],
];

const rows = [];
const stats = { negOCF: 0, cashDown: 0, ocf: [] };

for (const name of NAMES) {
  const scale = [0.4, 1, 1, 1, 2.5, 6][Math.floor(rnd() * 6)]; // 会社規模のばらつき
  const S = (v) => Math.round((v * scale) / 100) * 100;
  const growth = 0.97 + rnd() * 0.08; // 四半期ごとの基調

  // --- 最初の四半期の期首BS ---
  let prev = {
    cash: S(pick(6000, 20000)),
    deposits: S(pick(0, 12000)),
    receivables: S(pick(10000, 26000)),
    inventory: S(pick(4000, 14000)),
    otherCA: S(pick(1000, 4000)),
    tangible: S(pick(20000, 60000)),
    investments: S(pick(1000, 9000)),
    payables: S(pick(6000, 18000)),
    shortLoans: S(pick(0, 12000)),
    otherCL: S(pick(1500, 6000)),
    longLoans: S(pick(4000, 30000)),
  };
  const assets0 = prev.cash + prev.deposits + prev.receivables + prev.inventory +
    prev.otherCA + prev.tangible + prev.investments;
  const liab0 = prev.payables + prev.shortLoans + prev.otherCL + prev.longLoans;
  prev.netAssets = assets0 - liab0;

  let baseRevenue = S(pick(30000, 90000));

  periods.forEach((period, qi) => {
    // --- PL(四半期) ---
    baseRevenue = Math.round(baseRevenue * (growth + (rnd() - 0.5) * 0.06) / 100) * 100;
    const revenue = Math.max(1000, baseRevenue);
    const opMargin = -0.02 + rnd() * 0.18;
    const operatingIncome = Math.round(revenue * opMargin / 100) * 100;
    const dep = S(pick(1500, 6000));
    const intInc = S(pick(0, 400, 50));
    const intExp = S(pick(100, 1200, 50));
    const saleProceeds = rnd() < 0.35 ? S(pick(500, 4000)) : 0;
    const gain = saleProceeds > 0 ? S(pick(-600, 900, 50)) : 0;
    const pretax = operatingIncome + intInc - intExp + gain;
    const taxes = pretax > 0 ? Math.round(pretax * 0.32 / 100) * 100 : 0;
    const ni = pretax - taxes;

    // --- SS(四半期) ---
    const issue = rnd() < 0.06 ? S(pick(1000, 6000)) : 0;
    const div = ni > 0 && qi % 2 === 1 && rnd() < 0.6 ? Math.round(ni * (0.15 + rnd() * 0.3) / 100) * 100 : 0;
    const buy = rnd() < 0.08 ? S(pick(300, 2500)) : 0;
    const sell = rnd() < 0.04 ? S(pick(200, 1500)) : 0;

    // --- 期末BS(現金・純資産以外) ---
    const curr = {
      deposits: Math.max(0, prev.deposits + S(pick(-2500, 3000))),
      receivables: Math.max(0, prev.receivables + S(pick(-3000, 4000))),
      inventory: Math.max(0, prev.inventory + S(pick(-2000, 2500))),
      otherCA: Math.max(0, prev.otherCA + S(pick(-600, 900))),
      tangible: Math.max(0, prev.tangible + S(pick(-2000, 5000))),
      investments: Math.max(0, prev.investments + S(pick(-1000, 1500))),
      payables: Math.max(0, prev.payables + S(pick(-2500, 3000))),
      shortLoans: Math.max(0, prev.shortLoans + S(pick(-3000, 3000))),
      otherCL: Math.max(0, prev.otherCL + S(pick(-900, 1200))),
      longLoans: Math.max(0, prev.longLoans + S(pick(-4000, 3500))),
    };
    // 純資産はSSの変動事由と一致させる
    curr.netAssets = prev.netAssets + ni + issue - div - buy + sell;

    // 現金は貸借一致から逆算する
    const nonCash = curr.deposits + curr.receivables + curr.inventory +
      curr.otherCA + curr.tangible + curr.investments;
    const liab = () => curr.payables + curr.shortLoans + curr.otherCL + curr.longLoans;
    curr.cash = liab() + curr.netAssets - nonCash;
    if (curr.cash < 500) { // 現金が枯渇する組み合わせは短期借入で埋める
      curr.shortLoans += 500 - curr.cash;
      curr.cash = 500;
    }

    // --- 検算(アプリと同じ間接法のロジック) ---
    const d = (k) => curr[k] - prev[k];
    const ocf = ni + dep - gain - d('receivables') - d('inventory') - d('otherCA') +
      d('payables') + d('otherCL');
    const icf = -d('tangible') - dep + gain - d('investments') - d('deposits');
    const fcf = d('shortLoans') + d('longLoans') + issue - buy + sell - div;
    if (prev.cash + ocf + icf + fcf !== curr.cash) throw new Error(`${name} ${period}: CF不一致`);
    const assets = curr.cash + nonCash;
    if (assets !== liab() + curr.netAssets) throw new Error(`${name} ${period}: BS不一致`);
    stats.ocf.push(ocf);
    if (ocf < 0) stats.negOCF++;
    if (ocf + icf + fcf < 0) stats.cashDown++;

    // --- 行の書き出し ---
    // 前期末は最初の四半期だけ入れる(以降はアプリが前四半期から引き継ぐ)
    const head = `${name},${period}`;
    for (const [key, label] of BS_ITEMS) {
      const p = qi === 0 ? prev[key] : '';
      rows.push(`${head},BS,${label},${p},${curr[key]}`);
    }
    const pl = [
      ['売上高', revenue], ['営業利益', operatingIncome], ['税引前当期純利益', pretax],
      ['減価償却費', dep], ['受取利息及び受取配当金', intInc], ['支払利息', intExp],
      ['固定資産売却損益(益は+、損は−)', gain], ['法人税等', taxes],
    ];
    for (const [label, v] of pl) if (v !== 0) rows.push(`${head},PL,${label},,${v}`);
    if (saleProceeds !== 0) rows.push(`${head},補足,有形固定資産の売却による収入,,${saleProceeds}`);
    const ss = [
      ['新株の発行(増資)', issue], ['剰余金の配当(配当金の支払額)', div],
      ['自己株式の取得', buy], ['自己株式の処分', sell],
    ];
    for (const [label, v] of ss) if (v !== 0) rows.push(`${head},SS,${label},,${v}`);

    prev = { ...curr };
  });
}

const csv = '会社名,四半期,区分,科目,前期末,当期末\r\n' + rows.join('\r\n') + '\r\n';
fs.writeFileSync(path.join(ROOT, 'sample-27.csv'), csv);

console.log(`${NAMES.length}社 × ${QUARTERS}四半期 / ${rows.length}行 / ${(csv.length / 1024).toFixed(0)}KB`);
console.log(`期間: ${periods[0]} 〜 ${periods[periods.length - 1]}`);
console.log(`営業CFマイナス: ${stats.negOCF}件 / 現金が減った四半期: ${stats.cashDown}件`);
console.log(`営業CF範囲: ${Math.min(...stats.ocf)} 〜 ${Math.max(...stats.ocf)}`);
