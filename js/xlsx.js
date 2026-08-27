"use strict";

/* =========================================================
 * Excel(.xlsx / .xlsm)の読み込み
 *
 * xlsx は「ZIP圧縮された XML の束」なので、外部ライブラリを使わず
 * ブラウザ内蔵の DecompressionStream で展開して自前で読む。
 * すべて端末内で完結し、データを外部へ送ることはない。
 *
 * 対応: 文字列(共有文字列・インライン)・数値・真偽値。
 * 日付はExcel内部のシリアル値(数値)のまま読むため、四半期などの
 * 期間はセルの書式ではなく文字列(例: 2025Q1)で入れておくこと。
 * ======================================================= */

/** deflate-raw を展開する(ZIPの標準圧縮) */
async function xlsxInflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIPの中央ディレクトリを読んで、ファイル名 → エントリ情報の表を作る */
function xlsxZipEntries(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // 末尾から End of Central Directory(署名 0x06054b50)を探す
  let eocd = -1;
  const stop = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Excelファイル(ZIP形式)として読めません");
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = utf8.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, bytes, view };
}

/** ZIP内の1ファイルをテキストとして取り出す(無ければ null) */
async function xlsxZipText(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const nameLen = zip.view.getUint16(e.localOff + 26, true);
  const extraLen = zip.view.getUint16(e.localOff + 28, true);
  const start = e.localOff + 30 + nameLen + extraLen;
  const data = zip.bytes.subarray(start, start + e.compSize);
  const raw = e.method === 0 ? data : await xlsxInflateRaw(data);
  return new TextDecoder().decode(raw);
}

/** 名前空間に関わらず localName で子孫要素を集める */
function xlsxTags(node, name) {
  return [...node.getElementsByTagNameNS("*", name)];
}

/** <is>や<si>の中の <t> を連結する(リッチテキスト対応) */
function xlsxTextOf(node) {
  return xlsxTags(node, "t").map((t) => t.textContent).join("");
}

/** "AB12" → 列番号 27(0始まり)。列参照がない場合は null */
function xlsxColIndex(ref) {
  const m = /^([A-Z]+)\d+$/.exec(ref || "");
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

/** シートXML → 行×列の二次元配列(文字列) */
function xlsxParseSheet(xml, shared) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rows = [];
  for (const rowEl of xlsxTags(doc, "row")) {
    const r = [];
    for (const c of xlsxTags(rowEl, "c")) {
      const col = xlsxColIndex(c.getAttribute("r"));
      const at = col === null ? r.length : col;
      const t = c.getAttribute("t") || "n";
      let val = "";
      if (t === "inlineStr") {
        const is = xlsxTags(c, "is")[0];
        val = is ? xlsxTextOf(is) : "";
      } else {
        const v = xlsxTags(c, "v")[0];
        const raw = v ? v.textContent : "";
        if (t === "s") val = shared[Number(raw)] ?? "";
        else if (t === "b") val = raw === "1" ? "TRUE" : "FALSE";
        else val = raw;
      }
      while (r.length < at) r.push("");
      r[at] = val;
    }
    rows.push(r);
  }
  return rows;
}

/**
 * xlsx のバイナリからシートを読む。
 * @returns {Promise<{name: string, rows: string[][]}[]>} データのあるシートだけ
 */
async function readXlsxSheets(arrayBuffer) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("このブラウザはExcelの直接読み込みに対応していません。CSV(UTF-8)で保存して読み込んでください");
  }
  const zip = xlsxZipEntries(arrayBuffer);

  const sharedXml = await xlsxZipText(zip, "xl/sharedStrings.xml");
  const shared = [];
  if (sharedXml) {
    const doc = new DOMParser().parseFromString(sharedXml, "application/xml");
    for (const si of xlsxTags(doc, "si")) shared.push(xlsxTextOf(si));
  }

  // workbook.xml のシート一覧(表示順)と、rels の rId → ファイルパス
  const wbXml = await xlsxZipText(zip, "xl/workbook.xml");
  const relXml = await xlsxZipText(zip, "xl/_rels/workbook.xml.rels");
  if (!wbXml) throw new Error("Excelのブック情報(workbook.xml)が見つかりません");
  const relMap = new Map();
  if (relXml) {
    const relDoc = new DOMParser().parseFromString(relXml, "application/xml");
    for (const rel of xlsxTags(relDoc, "Relationship")) {
      let target = rel.getAttribute("Target") || "";
      if (target.startsWith("/")) target = target.slice(1);
      else target = "xl/" + target.replace(/^\.\//, "");
      relMap.set(rel.getAttribute("Id"), target);
    }
  }
  const wbDoc = new DOMParser().parseFromString(wbXml, "application/xml");
  const defs = [];
  let i = 0;
  for (const sheet of xlsxTags(wbDoc, "sheet")) {
    i++;
    const rid = sheet.getAttribute("r:id")
      || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    defs.push({
      name: sheet.getAttribute("name") || `Sheet${i}`,
      path: (rid && relMap.get(rid)) || `xl/worksheets/sheet${i}.xml`,
    });
  }

  const sheets = [];
  for (const def of defs) {
    const xml = await xlsxZipText(zip, def.path);
    if (!xml) continue;
    const rows = xlsxParseSheet(xml, shared);
    if (rows.some((r) => r.some((c) => String(c).trim() !== ""))) {
      sheets.push({ name: def.name, rows });
    }
  }
  return sheets;
}

/** 行×列の配列を、既存の取り込み経路に流せるCSVテキストにする */
function xlsxRowsToCSV(rows) {
  const q = (s) => {
    const v = String(s == null ? "" : s);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
}

/** ファイル名がExcelかどうか */
function isXlsxName(name) {
  return /\.(xlsx|xlsm)$/i.test(String(name || ""));
}
