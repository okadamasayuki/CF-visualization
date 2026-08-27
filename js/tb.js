"use strict";

/* =========================================================
 * 残高試算表形式(会計システム出力)のサンプル生成
 *
 * 社内の会計システムが出力する残高試算表の構成:
 *   A: 科目コード(7桁) / B: 科目名 / C: 貸借(借方・貸方) /
 *   D: 前期末残高 / E: 当四半期末残高 / F: 摘要(ほぼ空)
 *   上部に「(単位:円) YYYY/MM 四半期データ(YYYYMM)」の期間行と
 *   「会社名(5桁コード)」の行があり、データは小計行や空白行を
 *   挟んでブロック状に並ぶ。
 *
 * サンプルもこの構成で生成し、実データと同じ経路(自動判別)で
 * 読み込ませることで、入力の全体を実運用と同じ形にそろえる。
 * ======================================================= */

/* 各項目を試算表に載せるときの科目コード・科目名・貸借。
 * 科目名は組み込みの別名で吸収できる実務寄りの名前を使う */
const TB_ACCOUNTS = {
  "bs:cash":               { code: "1110001", name: "現金及び預金", side: "借方" },
  "bs:cashExcluded":       { code: "1110002", name: "長期性預金", side: "借方" },
  "bs:deposits":           { code: "1120001", name: "預け金", side: "借方" },
  "bs:receivables":        { code: "1130001", name: "売掛金", side: "借方" },
  "bs:inventory":          { code: "1140001", name: "商品及び製品", side: "借方" },
  "bs:otherCA":            { code: "1150001", name: "その他流動資産", side: "借方" },
  "bs:tangible":           { code: "1210001", name: "建物", side: "借方" },
  "bs:investments":        { code: "1220001", name: "投資有価証券", side: "借方" },
  "bs:payables":           { code: "2110001", name: "買掛金", side: "貸方" },
  "bs:shortLoans":         { code: "2120001", name: "短期借入金", side: "貸方" },
  "bs:otherCL":            { code: "2130001", name: "その他流動負債", side: "貸方" },
  "bs:longLoans":          { code: "2210001", name: "長期借入金", side: "貸方" },
  "bs:otherFixedLiab":     { code: "2220001", name: "その他固定負債", side: "貸方" },
  "bs:retirementBenefits": { code: "2230001", name: "退職給付引当金", side: "貸方" },
  "bs:netAssets":          { code: "3110001", name: "純資産合計", side: "貸方" },
  "pl:revenue":            { code: "4110001", name: "売上高", side: "貸方" },
  "pl:operatingIncome":    { code: "4210001", name: "営業利益", side: "貸方" },
  "pl:pretaxIncome":       { code: "4220001", name: "税引前当期純利益", side: "貸方" },
  "pl:depreciation":       { code: "5110001", name: "減価償却費", side: "借方" },
  "pl:interestIncome":     { code: "5210001", name: "受取利息及び受取配当金", side: "貸方" },
  "pl:interestExpense":    { code: "5220001", name: "支払利息", side: "借方" },
  "pl:gainOnSale":         { code: "5230001", name: "固定資産売却損益", side: "貸方" },
  "pl:incomeTaxes":        { code: "5310001", name: "法人税等", side: "借方" },
  "sup:saleProceeds":      { code: "6110001", name: "固定資産売却収入", side: "貸方" },
  "ss:stockIssue":         { code: "7110001", name: "新株の発行", side: "貸方" },
  "ss:dividendsPaid":      { code: "7120001", name: "剰余金の配当", side: "借方" },
  "ss:treasuryBuy":        { code: "7130001", name: "自己株式の取得", side: "借方" },
  "ss:treasurySell":       { code: "7140001", name: "自己株式の処分", side: "貸方" },
};

/** 四半期(year, q)を試算表の期末月に直す(暦年四半期 → 3・6・9・12月) */
function tbMonthOf(q) {
  return q * 3;
}

/**
 * テンプレート形式のサンプルCSVを「会社 × 四半期」のグループに分ける。
 * 各グループが残高試算表1ファイル分に相当する。
 * @param {string} text テンプレート形式のCSV
 * @param {{company: string, year: number, month: number}|null} single
 *        会社名・四半期の列がないCSVに使う会社と期末月
 */
function tbGroups(text, single = null) {
  const rows = parseDelimited(text, detectDelimiter(text));
  const layout = findHeader(rows);
  if (!layout) return [];
  const { cols } = layout;

  const groups = [];
  const index = new Map();          // 会社\0期間 → グループ
  const companyCodes = new Map();   // 会社 → 5桁コード(出現順に採番)
  let lastCompany = single ? single.company : "対象会社";
  let lastQ = single
    ? { year: single.year, month: single.month, sortKey: `${single.year}${single.month}` }
    : null;

  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const item = (row[cols.item] || "").trim();
    if (item === "") continue;
    if (cols.company !== null) {
      const c = (row[cols.company] || "").trim();
      if (c !== "") lastCompany = c;
    }
    if (cols.period !== null) {
      const p = parsePeriod(row[cols.period]);
      if (p && p.year !== null) {
        lastQ = { year: p.year, month: tbMonthOf(p.q), sortKey: p.sortKey };
      }
    }
    const target = lookupItem(item);
    if (!target || !lastQ) continue;
    const acct = TB_ACCOUNTS[`${target.section}:${target.key}`];
    if (!acct) continue;

    if (!companyCodes.has(lastCompany)) {
      companyCodes.set(lastCompany, String(10001 + companyCodes.size));
    }
    const gkey = `${lastCompany}\u0000${lastQ.sortKey}`;
    if (!index.has(gkey)) {
      const g = {
        company: lastCompany,
        companyCode: companyCodes.get(lastCompany),
        year: lastQ.year, month: lastQ.month, sortKey: lastQ.sortKey,
        rows: [],
      };
      index.set(gkey, g);
      groups.push(g);
    }
    index.get(gkey).rows.push({
      section: target.section, key: target.key,
      code: acct.code, name: acct.name, side: acct.side,
      prev: (cols.prev !== null ? (row[cols.prev] || "").trim() : ""),
      curr: (cols.curr !== null ? (row[cols.curr] || "").trim() : ""),
    });
  }

  // 会社ごとに四半期順へ並べ、BSの前期末が空なら前の四半期の当期末で埋める
  // (実際の残高試算表には前期末残高が常に印字されるため、その形に合わせる)
  const byCompany = new Map();
  for (const g of groups) {
    if (!byCompany.has(g.company)) byCompany.set(g.company, []);
    byCompany.get(g.company).push(g);
  }
  for (const [, list] of byCompany) {
    list.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const carry = new Map(); // bsのkey → 直前の四半期の当期末
    for (const g of list) {
      for (const row of g.rows) {
        if (row.section !== "bs") continue;
        if (row.prev === "" && carry.has(row.key)) row.prev = carry.get(row.key);
      }
      for (const row of g.rows) {
        if (row.section === "bs" && row.curr !== "") carry.set(row.key, row.curr);
      }
      // 科目コード順に並べる(資産→負債→純資産→損益→補足→SS)
      g.rows.sort((a, b) => a.code.localeCompare(b.code));
    }
  }
  return groups;
}

/** グループ内の小計(資産、負債・純資産)を計算する。全行空なら "" */
function tbSubtotal(rows, which) {
  let sum = 0;
  let any = false;
  for (const row of rows) {
    const v = parseAmount(row[which]);
    if (v === null || Number.isNaN(v)) continue;
    sum += v;
    any = true;
  }
  return any ? String(sum) : "";
}

/** グループを、小計行・上部の会社/期間行の入った残高試算表CSVにする */
function tbGroupToCSV(g) {
  const yyyymm = `${g.year}${String(g.month).padStart(2, "0")}`;
  const label = `${g.year}/${String(g.month).padStart(2, "0")}`;
  const lines = [
    "残高試算表",
    `(単位:円) ${label} 四半期データ(${yyyymm})`,
    `${g.company}(${g.companyCode})`,
  ];
  const push = (row) => lines.push(`${row.code},${row.name},${row.side},${row.prev},${row.curr},`);
  const subtotal = (name, rows) =>
    lines.push(`,${name},,${tbSubtotal(rows, "prev")},${tbSubtotal(rows, "curr")},`);

  const assets = g.rows.filter((r) => r.section === "bs" && r.code < "2");
  const liabNet = g.rows.filter((r) => r.section === "bs" && r.code >= "2");
  const rest = g.rows.filter((r) => r.section !== "bs");

  assets.forEach(push);
  if (assets.length) subtotal("資産合計", assets);
  liabNet.forEach(push);
  if (liabNet.length) subtotal("負債・純資産合計", liabNet);
  rest.forEach(push);

  return { name: `${g.company}_${yyyymm}.csv`.replace(/[\\/:*?"<>|]/g, "_"),
    text: lines.join("\r\n") + "\r\n" };
}

/**
 * テンプレート形式のサンプルCSVを、残高試算表形式のファイル群に変換する。
 * @returns {{name: string, text: string}[]} 会社 × 四半期ごとに1ファイル
 */
function templateToTrialBalance(text, single = null) {
  return tbGroups(text, single).map(tbGroupToCSV);
}

/* =========================================================
 * 残高試算表サンプルの Excel(.xlsx)生成
 *
 * 依存ライブラリなしで最小構成の xlsx(無圧縮ZIP + シートXML)を
 * 組み立てる。実際のシステム出力と同じく、5行目に期間・6行目に
 * 会社名の結合セルを置き、9行目からデータをブロック状に並べる。
 * ======================================================= */

const TB_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function tbCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TB_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ファイル名とテキストの一覧から、無圧縮ZIP(=xlsxの器)を作る */
function tbZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const date = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026/01/01(内容には影響しない)

  for (const f of files) {
    const name = encoder.encode(f.name);
    const data = encoder.encode(f.text);
    const crc = tbCrc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);            // version needed
    local.setUint16(10, 0, true);            // time
    local.setUint16(12, date, true);         // date
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);  // 圧縮なし: サイズは同じ
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(12, 0, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + data.length;
  }

  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of all) { out.set(a, pos); pos += a.length; }
  return out;
}

function tbXmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 0始まりの列番号 → "A"・"F" などの列参照 */
function tbColRef(c) {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * シートXMLを作る。
 * @param {Map<number, (string|number|null)[]>} rowMap 行番号(1始まり) → セルの値
 * @param {string[]} merges 結合セル(例: "A5:F5")
 */
function tbSheetXml(rowMap, merges) {
  const rowsXml = [...rowMap.keys()].sort((a, b) => a - b).map((r) => {
    const cells = rowMap.get(r).map((v, c) => {
      if (v === null || v === "") return "";
      const ref = `${tbColRef(c)}${r}`;
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${tbXmlEscape(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r}">${cells}</row>`;
  }).join("");
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml}</sheetData>${mergeXml}</worksheet>`;
}

/** シート1枚のxlsxバイナリを組み立てる */
function tbBuildXlsx(sheetName, rowMap, merges) {
  const sheet = tbSheetXml(rowMap, merges);
  return tbZip([
    { name: "[Content_Types].xml", text:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>` },
    { name: "_rels/.rels", text:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>` },
    { name: "xl/workbook.xml", text:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${tbXmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>` },
    { name: "xl/styles.xml", text:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="1"><font><sz val="11"/><name val="游ゴシック"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border/></borders>` +
      `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
      `<cellXfs count="1"><xf/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", text: sheet },
  ]);
}

/**
 * 残高試算表サンプルのExcelを作る(1社・2026/03、社内構成の再現)。
 * 5行目: 期間の結合セル / 6行目: 会社名の結合セル / 9行目〜: ブロック状のデータ
 * @returns {{name: string, bytes: Uint8Array}}
 */
function buildTrialBalanceSampleXlsx() {
  const g = tbGroups(SAMPLE_CSV, { company: "サンプル製作所", year: 2026, month: 3 })[0];
  if (!g) throw new Error("サンプルデータを変換できませんでした");
  const yyyymm = `${g.year}${String(g.month).padStart(2, "0")}`;

  const rows = new Map();
  rows.set(1, ["残高試算表"]);
  rows.set(5, [`自 ${g.year - 1}/04/01  至 ${g.year}/03/31 (単位:円) ${g.year}/${String(g.month).padStart(2, "0")} 四半期データ(${yyyymm})`]);
  rows.set(6, [`${g.company}(${g.companyCode})`]);

  const num = (raw) => {
    const v = parseAmount(raw);
    return v === null || Number.isNaN(v) ? "" : v;
  };
  let r = 9; // 実際のシステム出力と同じく、データは9行目から
  const putRow = (row, note = "") =>
    rows.set(r++, [Number(row.code), row.name, row.side, num(row.prev), num(row.curr), note]);
  const putSubtotal = (name, list) =>
    rows.set(r++, [null, name, null, num(tbSubtotal(list, "prev")), num(tbSubtotal(list, "curr")), ""]);

  const assets = g.rows.filter((x) => x.section === "bs" && x.code < "2");
  const liabNet = g.rows.filter((x) => x.section === "bs" && x.code >= "2");
  const pl = g.rows.filter((x) => x.section === "pl");
  const supSs = g.rows.filter((x) => x.section === "sup" || x.section === "ss");

  assets.forEach((row) => putRow(row, row.key === "cash" ? "四半期末残高" : ""));
  putSubtotal("資産合計", assets);
  r += 2; // ブロックの間の空行
  liabNet.forEach((row) => putRow(row));
  putSubtotal("負債・純資産合計", liabNet);
  r += 2;
  // PLの前期末列には前年度の累計が印字される(読み込みでは当期末の列だけを使う)
  pl.forEach((row) => {
    const annual = parseAmount(row.curr);
    rows.set(r++, [Number(row.code), row.name, row.side,
      annual === null || Number.isNaN(annual) ? "" : annual * 4, num(row.curr), ""]);
  });
  r += 2;
  supSs.forEach((row) => putRow(row, row.key === "stockIssue" ? "第三者割当増資" : ""));

  return {
    name: `試算表サンプル_${yyyymm}.xlsx`,
    bytes: tbBuildXlsx("残高試算表", rows, ["A5:F5", "A6:F6"]),
  };
}
