// 27社分のサンプルCSV(sample-27.csv)を生成する。
// 全社で「BS貸借一致」「CF計算書とBSの現金残高の整合」「SSと純資産増減の整合」が
// すべてパスするよう、現金と純資産を他の項目から逆算して構成している。
//
//   node scripts/gen-sample-27.js && node scripts/build-samples.js
//
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

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

const rows = [];
const summary = [];

for (const name of NAMES) {
  const scale = [0.4, 1, 1, 1, 2.5, 6][Math.floor(rnd() * 6)]; // 会社規模のばらつき
  const S = (v) => Math.round((v * scale) / 100) * 100;

  // --- 前期末BS(現金以外) ---
  const prev = {
    cash: S(pick(6000, 20000)),
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
  const assetsPrev = prev.cash + prev.receivables + prev.inventory + prev.otherCA + prev.tangible + prev.investments;
  const liabPrev = prev.payables + prev.shortLoans + prev.otherCL + prev.longLoans;
  prev.netAssets = assetsPrev - liabPrev; // 前期末の貸借を一致させる

  // --- PL・補足・SS ---
  const dep = S(pick(1500, 6000));
  const pretax = S(pick(-3000, 14000));               // 一部は赤字
  const taxes = pretax > 0 ? Math.round(pretax * 0.32 / 100) * 100 : 0;
  const intInc = S(pick(0, 400, 50));
  const intExp = S(pick(100, 1200, 50));
  const saleProceeds = rnd() < 0.45 ? S(pick(500, 4000)) : 0;
  const gain = saleProceeds > 0 ? S(pick(-600, 900, 50)) : 0;

  const ni = pretax - taxes;
  const issue = rnd() < 0.2 ? S(pick(1000, 6000)) : 0;
  const div = ni > 0 && rnd() < 0.65 ? Math.round(ni * (0.15 + rnd() * 0.3) / 100) * 100 : 0;
  const buy = rnd() < 0.15 ? S(pick(300, 2500)) : 0;
  const sell = rnd() < 0.08 ? S(pick(200, 1500)) : 0;

  // --- 当期末BS(現金・純資産以外) ---
  const curr = {
    receivables: Math.max(0, prev.receivables + S(pick(-4000, 6000))),
    inventory: Math.max(0, prev.inventory + S(pick(-2500, 3500))),
    otherCA: Math.max(0, prev.otherCA + S(pick(-800, 1200))),
    tangible: Math.max(0, prev.tangible + S(pick(-3000, 9000))),
    investments: Math.max(0, prev.investments + S(pick(-1500, 2500))),
    payables: Math.max(0, prev.payables + S(pick(-3000, 4500))),
    shortLoans: Math.max(0, prev.shortLoans + S(pick(-4000, 4000))),
    otherCL: Math.max(0, prev.otherCL + S(pick(-1200, 1800))),
    longLoans: Math.max(0, prev.longLoans + S(pick(-6000, 5000))),
  };
  // 純資産はSSの変動事由と一致させる
  curr.netAssets = prev.netAssets + ni + issue - div - buy + sell;
  // 現金は貸借一致から逆算する(間接法の構造上、CFの期末残高とも自動的に一致する)
  const nonCashCurr = curr.receivables + curr.inventory + curr.otherCA + curr.tangible + curr.investments;
  const liab = () => curr.payables + curr.shortLoans + curr.otherCL + curr.longLoans;
  curr.cash = liab() + curr.netAssets - nonCashCurr;

  if (curr.cash < 500) { // 現金が枯渇する組み合わせは短期借入で埋める
    curr.shortLoans += 500 - curr.cash;
    curr.cash = 500;
  }
  const liabCurr = liab();

  const bs = [
    ['現金及び預金', prev.cash, curr.cash],
    ['売上債権', prev.receivables, curr.receivables],
    ['棚卸資産', prev.inventory, curr.inventory],
    ['その他流動資産', prev.otherCA, curr.otherCA],
    ['有形固定資産(純額)', prev.tangible, curr.tangible],
    ['投資その他の資産', prev.investments, curr.investments],
    ['仕入債務', prev.payables, curr.payables],
    ['短期借入金', prev.shortLoans, curr.shortLoans],
    ['その他流動負債', prev.otherCL, curr.otherCL],
    ['長期借入金', prev.longLoans, curr.longLoans],
    ['純資産合計', prev.netAssets, curr.netAssets],
  ];
  for (const [label, p, c] of bs) rows.push(`${name},BS,${label},${p},${c}`);

  const pl = [
    ['税引前当期純利益', pretax], ['減価償却費', dep],
    ['受取利息及び受取配当金', intInc], ['支払利息', intExp],
    ['固定資産売却損益(益は+、損は−)', gain], ['法人税等', taxes],
  ];
  for (const [label, v] of pl) rows.push(`${name},PL,${label},,${v}`);
  rows.push(`${name},補足,有形固定資産の売却による収入,,${saleProceeds}`);

  const ss = [
    ['新株の発行(増資)', issue], ['剰余金の配当(配当金の支払額)', div],
    ['自己株式の取得', buy], ['自己株式の処分', sell],
  ];
  for (const [label, v] of ss) rows.push(`${name},SS,${label},,${v}`);

  // 検算(アプリと同じ間接法のロジック)
  const d = (k) => curr[k] - prev[k];
  const ocf = ni + dep - gain - d('receivables') - d('inventory') - d('otherCA') + d('payables') + d('otherCL');
  const icf = -d('tangible') - dep + gain - d('investments');
  const fcf = d('shortLoans') + d('longLoans') + issue - buy + sell - div;
  const ending = prev.cash + ocf + icf + fcf;
  if (ending !== curr.cash) throw new Error(`${name}: CF不一致 ${ending} != ${curr.cash}`);
  const aC = curr.cash + nonCashCurr;
  if (aC !== liabCurr + curr.netAssets) throw new Error(`${name}: BS不一致`);
  summary.push({ name, ocf, icf, fcf, ending });
}

const csv = '会社名,区分,科目,前期末,当期末\r\n' + rows.join('\r\n') + '\r\n';
fs.writeFileSync(path.join(ROOT, 'sample-27.csv'), csv);

console.log(`${NAMES.length}社 / ${rows.length}行 / ${csv.length}バイト`);
console.log('営業CFマイナスの会社:', summary.filter(s => s.ocf < 0).length);
console.log('投資CFプラスの会社:', summary.filter(s => s.icf > 0).length);
console.log('現金が減った会社:', summary.filter((s, i) => s.ocf + s.icf + s.fcf < 0).length);
console.log('営業CF範囲:', Math.min(...summary.map(s => s.ocf)), '〜', Math.max(...summary.map(s => s.ocf)));
