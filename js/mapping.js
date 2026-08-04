"use strict";

/* =========================================================
 * 科目マッピング(算定ロジックファイル)
 *
 * 「社内の科目名 → アプリのどの項目に + / − で反映するか」だけを
 * 定義したCSV。金額・会社・会計期間は持たない。
 *
 *   科目,反映先の区分,反映先の科目,符号
 *   現金・預金(3ヶ月以下),BS,現金及び預金,+
 *   減価償却累計額(建物),BS,有形固定資産(純額),-
 *   受取利息及び割引料(営業外),PL,受取利息及び受取配当金,+
 *   受取利息及び割引料(営業外),PL,税引前当期純利益,+
 *
 * 同じ科目を複数行書けば、複数の項目へ同時に反映される
 * (例: 収益・費用の各行を「税引前当期純利益」へも集計する)。
 * 読み込むと、組み込みの科目対応(schema.jsの別名)より優先される。
 * ======================================================= */

/**
 * マッピング用の正規化。normalizeKey と違い括弧書きは残す
 * (「減価償却累計額(建物)」と「(構築物)」を別の科目として扱うため)。
 */
function mappingKey(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

/** 反映先に指定できる区分(表記ゆれも受け付ける) */
const MAPPING_SECTIONS = new Map([
  ["bs", "bs"], ["貸借対照表", "bs"],
  ["pl", "pl"], ["損益計算書", "pl"],
  ["ss", "ss"], ["株主資本等変動計算書", "ss"],
  ["補足", "sup"], ["sup", "sup"], ["補足情報", "sup"],
  ["詳細", "detail"], ["detail", "detail"], ["詳細情報", "detail"],
]);

/** 反映先の科目名(区分ごと) → フィールド定義 */
function resolveMappingTarget(sectionRaw, itemRaw) {
  const section = MAPPING_SECTIONS.get(mappingKey(sectionRaw));
  if (!section) return null;
  const want = mappingKey(itemRaw);
  for (const f of SCHEMA[section]) {
    if (f.aliasOnly) continue;
    if (mappingKey(f.label) === want || mappingKey(f.key) === want) {
      return { section, key: f.key };
    }
  }
  return null;
}

/** 符号の解釈。「+」「-」「−」「△」「+1」「-1」など。空欄は + */
function parseMappingSign(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (s === "" || s === "+" || s === "+1" || s === "1" || s === "加算" || s === "足す") return 1;
  if (s === "-" || s === "−" || s === "-1" || s === "△" || s === "▲" || s === "減算" || s === "引く") return -1;
  return null;
}

/**
 * マッピングCSVを読む。
 * @returns {{ entries: Map, count: number, errors: string[], warnings: string[] }}
 *   entries: mappingKey(科目) → [{ section, key, sign, name }]
 */
function parseMappingCSV(text) {
  const errors = [];
  const warnings = [];
  const entries = new Map();

  const rows = parseDelimited(text, detectDelimiter(text));
  if (rows.length === 0) return { entries, count: 0, errors: ["ファイルが空です。"], warnings };

  // 見出し行(「科目」と「反映先」を含む行)を探す。無ければ1行目からデータとみなす
  let start = 0;
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const joined = rows[r].map((c) => mappingKey(c)).join("|");
    if (joined.includes("科目") && joined.includes("反映先")) { start = r + 1; break; }
  }

  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[0] || "").trim();
    if (name === "") continue;
    const lineNo = r + 1;
    const target = resolveMappingTarget(row[1], row[2]);
    if (!target) {
      errors.push(`${lineNo}行目「${name}」: 反映先「${(row[1] || "").trim()} / ${(row[2] || "").trim()}」を解釈できません。`);
      continue;
    }
    const sign = parseMappingSign(row[3]);
    if (sign === null) {
      errors.push(`${lineNo}行目「${name}」: 符号「${String(row[3]).trim()}」は + か - で指定してください。`);
      continue;
    }
    const k = mappingKey(name);
    if (!entries.has(k)) entries.set(k, []);
    const list = entries.get(k);
    if (list.some((t) => t.section === target.section && t.key === target.key && t.sign === sign)) {
      warnings.push(`${lineNo}行目「${name}」: 同じ反映先が重複しています(1件として扱います)。`);
      continue;
    }
    list.push({ section: target.section, key: target.key, sign, name });
  }

  return { entries, count: entries.size, errors, warnings };
}

/** 科目名からマッピングを引く(なければ null) */
function mappingLookup(mapping, name) {
  if (!mapping || !mapping.entries) return null;
  return mapping.entries.get(mappingKey(name)) || null;
}

/**
 * いま組み込まれている科目対応を、同じ形式のCSVとして書き出す。
 * これをダウンロード → 社内の科目名に書き替えてアップロードする、が基本の流れ。
 */
function buildMappingTemplate() {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["科目,反映先の区分,反映先の科目,符号"];
  for (const [section, label] of Object.entries(SECTION_LABELS)) {
    for (const f of SCHEMA[section]) {
      // aliasOnly の行(固定資産売却損など)は、その符号ごと別名として書き出す
      const targetField = SCHEMA[section].find((g) => g.key === f.key && !g.aliasOnly) || f;
      const sign = f.negate ? "-" : "+";
      const names = f.aliasOnly ? f.aliases : [f.label, ...(f.aliases || [])];
      for (const name of names) {
        lines.push(`${q(name)},${label},${q(targetField.label)},${sign}`);
      }
    }
  }
  return lines.join("\r\n") + "\r\n";
}
