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
 * 科目名の代わりに勘定科目コード(数字の羅列)を書いてもよい。
 * コードはExcelの書式で変わりやすいので、先頭の0と「.0」は無視して照合する
 * (「0010」と「10」、「1010.0」と「1010」は同じコード)。
 */
function mappingKey(s) {
  const k = String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/[\s　\u200B-\u200D\uFEFF\u00AD]/g, "")
    .toLowerCase();
  const m = k.match(/^0*(\d+)(?:\.0+)?$/);
  return m ? m[1] : k;
}

/** 「この科目は使わない(読み飛ばす)」を表す区分。反映先の科目は書かない */
const MAPPING_SKIP = "skip";
const MAPPING_SKIP_LABEL = "使わない";

/** 反映先に指定できる区分(表記ゆれも受け付ける) */
const MAPPING_SECTIONS = new Map([
  ["bs", "bs"], ["貸借対照表", "bs"],
  ["pl", "pl"], ["損益計算書", "pl"],
  ["ss", "ss"], ["株主資本等変動計算書", "ss"],
  ["補足", "sup"], ["sup", "sup"], ["補足情報", "sup"],
  ["詳細", "detail"], ["detail", "detail"], ["詳細情報", "detail"],
  ["使わない", MAPPING_SKIP], ["対象外", MAPPING_SKIP], ["読み飛ばす", MAPPING_SKIP],
  ["読み飛ばし", MAPPING_SKIP], ["無視", MAPPING_SKIP], ["skip", MAPPING_SKIP], ["ignore", MAPPING_SKIP],
]);

/** 反映先の科目名(区分ごと) → フィールド定義。「使わない」は { section: "skip", key: null } */
function resolveMappingTarget(sectionRaw, itemRaw) {
  const section = MAPPING_SECTIONS.get(mappingKey(sectionRaw));
  if (!section) return null;
  if (section === MAPPING_SKIP) return { section: MAPPING_SKIP, key: null };
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
 *   科目,反映先の区分,反映先の科目,符号[,メモ]
 * 5列目のメモは任意(科目コードで書いたときに科目名を控えておく用途)。読み込みには使わない。
 * 区分に「使わない」と書いた科目は、金額があっても読み飛ばす(警告も出さない)。
 * @returns {{ entries: Map, skipKeys: Set, names: Map, memos: Map, count: number, errors: string[], warnings: string[] }}
 *   entries: mappingKey(科目) → [{ section, key, sign, name }](「使わない」は空の配列)
 *   skipKeys: 「使わない」にした科目のキー
 *   names / memos: キー → CSVに書かれていた科目の表記 / メモ
 */
function parseMappingCSV(text) {
  const errors = [];
  const warnings = [];
  const entries = new Map();
  const skipKeys = new Set();
  const names = new Map();
  const memos = new Map();

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
    const k = mappingKey(name);
    if (!names.has(k)) names.set(k, name);
    const memo = (row[4] || "").trim();
    if (memo && !memos.has(k)) memos.set(k, memo);

    if (target.section === MAPPING_SKIP) {
      // 「使わない」は他の反映先より優先する(同じ科目に両方書かれていたら読み飛ばし)
      if (entries.has(k) && entries.get(k).length) {
        warnings.push(`${lineNo}行目「${name}」: 反映先と「使わない」の両方が書かれています。使わない(読み飛ばす)として扱います。`);
      }
      entries.set(k, []);
      skipKeys.add(k);
      continue;
    }
    if (skipKeys.has(k)) {
      warnings.push(`${lineNo}行目「${name}」: 「使わない」と指定済みのため、この反映先は無視します。`);
      continue;
    }
    const sign = parseMappingSign(row[3]);
    if (sign === null) {
      errors.push(`${lineNo}行目「${name}」: 符号「${String(row[3]).trim()}」は + か - で指定してください。`);
      continue;
    }
    if (!entries.has(k)) entries.set(k, []);
    const list = entries.get(k);
    if (list.some((t) => t.section === target.section && t.key === target.key && t.sign === sign)) {
      warnings.push(`${lineNo}行目「${name}」: 同じ反映先が重複しています(1件として扱います)。`);
      continue;
    }
    list.push({ section: target.section, key: target.key, sign, name });
  }

  return { entries, skipKeys, names, memos, count: entries.size, errors, warnings };
}

/**
 * マッピングの行をCSVの本文にする(画面編集・科目対応タブの共通の書き出し口)。
 * @param {Array<{name: string, section: string, key?: string, sign?: number, memo?: string}>} rows
 *        section が "skip" の行は「使わない」として書く
 */
function buildMappingCSV(rows) {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["科目,反映先の区分,反映先の科目,符号,メモ"];
  for (const r of rows) {
    const memo = r.memo || "";
    if (r.section === MAPPING_SKIP) {
      lines.push(`${q(r.name)},${MAPPING_SKIP_LABEL},,,${q(memo)}`);
      continue;
    }
    const f = SCHEMA[r.section].find((g) => g.key === r.key && !g.aliasOnly);
    lines.push(`${q(r.name)},${SECTION_LABELS[r.section]},${q(f ? f.label : r.key)},${r.sign < 0 ? "-" : "+"},${q(memo)}`);
  }
  return lines.join("\r\n") + "\r\n";
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
  const lines = ["科目,反映先の区分,反映先の科目,符号,メモ"];
  // 「#」で始まる行はコメントとして読み飛ばされる
  lines.push(
    "# 科目には社内の科目名のほか、勘定科目コード(数字の羅列)もそのまま書けます。",
    "# 例: 11010001,BS,現金及び預金,+,現金及び預金 (先頭の0は無視して照合します。5列目のメモは任意)",
    "# 反映先の区分に「使わない」と書くと、その科目は読み飛ばします。例: 9990001,使わない,,,合計行",
  );
  // 同じ科目を複数行書くと複数の項目へ同時に反映される、の記入例。
  // 「(記入例)」で始まる科目名は実データに現れないので、消し忘れても無害
  lines.push(
    "(記入例)受取利息及び割引料(営業外),PL,受取利息及び受取配当金,+",
    "(記入例)受取利息及び割引料(営業外),PL,税引前当期純利益,+",
    "(記入例)人件費・従業員給与,PL,税引前当期純利益,-",
    "(記入例)減価償却累計額(建物),BS,有形固定資産(純額),-",
  );
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
