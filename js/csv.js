"use strict";

/* =========================================================
 * CSVの読み込み・解析
 *
 * 対応:
 *  - 文字コード: UTF-8 (BOM有無どちらも) / Shift_JIS (Excel保存のCSV)
 *  - 区切り: カンマ / タブ (自動判定)
 *  - 引用符付きフィールド、CRLF、空行、# で始まるコメント行
 *  - 金額表記: 1,234 / ¥1,234 / △1,234 / ▲1,234 / (1,234) / -1,234 / 全角数字
 * ======================================================= */

/* ---------- 文字列の正規化 ---------- */

/** 科目名・見出しの照合用キー(全角半角・空白・括弧書きの揺れを吸収) */
function normalizeKey(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, "")      // 括弧書きの注記を除去
    .replace(/[\s　]/g, "")     // 空白を除去
    .replace(/[:：]$/, "")
    .toLowerCase();
}

/** さらに緩い照合用キー(助詞などの表記揺れを吸収) */
function looseKey(s) {
  return normalizeKey(s).replace(/(?:及び|による|に係る|の|等)/g, "");
}

/* ---------- 科目の別名テーブル ---------- */

const ITEM_EXACT = new Map();
const ITEM_LOOSE = new Map();

(function buildItemIndex() {
  const looseSeen = new Map(); // looseKey -> target(またはnull=あいまい)

  for (const [section, fields] of Object.entries(SCHEMA)) {
    for (const f of fields) {
      const target = {
        section, key: f.key, label: f.label,
        negate: !!f.negate, absolute: !!f.absolute,
      };
      const names = [f.label, ...(f.aliases || [])];
      for (const name of names) {
        const exact = normalizeKey(name);
        if (exact && !ITEM_EXACT.has(exact)) ITEM_EXACT.set(exact, target);

        const loose = looseKey(name);
        if (!loose) continue;
        const prior = looseSeen.get(loose);
        // 別の科目に緩く一致してしまう名前は、誤変換を防ぐため緩い照合から外す
        if (prior === undefined) looseSeen.set(loose, target);
        else if (prior && (prior.section !== section || prior.key !== f.key)) looseSeen.set(loose, null);
      }
    }
  }
  for (const [loose, target] of looseSeen) {
    if (target && !ITEM_EXACT.has(loose)) ITEM_LOOSE.set(loose, target);
  }
})();

/** 科目名から取り込み先を引く。見つからなければ null */
function lookupItem(name) {
  const exact = normalizeKey(name);
  if (!exact) return null;
  return ITEM_EXACT.get(exact) || ITEM_LOOSE.get(looseKey(name)) || null;
}

/* ---------- 見出し行の別名 ---------- */

const HEADER_ALIASES = {
  company: ["会社名", "会社", "企業名", "企業", "法人名", "社名", "銘柄", "銘柄名", "対象会社",
    "company", "companyname", "corporation", "entity", "firm", "ticker"],
  period: ["四半期", "期", "期間", "会計期間", "決算期", "年度", "対象期間", "決算期間",
    "quarter", "period", "term", "fy", "fiscalquarter", "yearquarter"],
  section: ["区分", "分類", "財務諸表", "表", "種別", "section", "category", "type", "sheet"],
  item: ["科目", "項目", "勘定科目", "名称", "内容", "変動事由", "item", "account", "name", "label"],
  prev: ["前期末", "前期", "前期末残高", "前期首", "期首", "期首残高", "前年度", "前事業年度", "前連結会計年度",
    "prev", "previous", "beginning", "opening", "priorperiod", "prior"],
  curr: ["当期末", "当期", "当期末残高", "期末", "期末残高", "当年度", "当事業年度", "当連結会計年度", "金額",
    "curr", "current", "ending", "closing", "amount", "value"],
};

const HEADER_INDEX = new Map();
for (const [role, names] of Object.entries(HEADER_ALIASES)) {
  for (const n of names) HEADER_INDEX.set(normalizeKey(n), role);
}

/* ---------- 四半期の解釈 ---------- */

const NO_PERIOD = { label: "通期", year: null, q: null, sortKey: "0" };

function makePeriod(year, q, label) {
  return { label, year, q, sortKey: `${String(year).padStart(4, "0")}${q}` };
}

/**
 * 「2025Q1」「FY2025Q1」「2025年度第1四半期」「2025年1Q」「1Q2025」「2025-03」などを解釈する。
 * 解釈できない表記はそのまま表示名として使い、並び順は文字列順になる。
 */
function parsePeriod(raw) {
  const s = String(raw == null ? "" : raw).normalize("NFKC").trim();
  if (s === "") return null;
  const t = s.replace(/[\s　]/g, "").toUpperCase();
  let m;

  // 2025Q1 / FY2025Q1 / 2025-Q1 / 2025年度第1四半期
  if ((m = t.match(/^(?:FY)?(\d{4})\D{0,4}Q?([1-4])(?:期|四半期)?$/))) return makePeriod(+m[1], +m[2], s);
  // 2025年1Q / 20251Q
  if ((m = t.match(/^(?:FY)?(\d{4})\D{0,4}([1-4])Q$/))) return makePeriod(+m[1], +m[2], s);
  // Q1 2025 / 1Q2025
  if ((m = t.match(/^Q?([1-4])Q?(?:FY)?(\d{4})$/))) return makePeriod(+m[2], +m[1], s);
  // FY25Q1
  if ((m = t.match(/^FY(\d{2})Q?([1-4])$/))) return makePeriod(2000 + +m[1], +m[2], s);
  // 2025-03 / 2025/3(暦年の月から四半期を求める)
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})$/)) && +m[2] >= 1 && +m[2] <= 12) {
    return makePeriod(+m[1], Math.ceil(+m[2] / 3), s);
  }
  return { label: s, year: null, q: null, sortKey: `zz${s}` };
}

/* ---------- 文字コードの判定とデコード ---------- */

async function decodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    // UTF-8として不正 → Excelが出力するShift_JISとみなす
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/* ---------- CSV本体の解析 ---------- */

/** 最初の非空行からカンマ/タブを判定する */
function detectDelimiter(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const commas = (line.match(/,/g) || []).length;
    const tabs = (line.match(/\t/g) || []).length;
    return tabs > commas ? "\t" : ",";
  }
  return ",";
}

/** RFC 4180 準拠の分解。戻り値は行×列の二次元配列(空行は除去) */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = "", inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  row.push(field);
  rows.push(row);

  return rows.filter((r) => r.some((f) => f.trim() !== "") && !r[0].trim().startsWith("#"));
}

/* ---------- 金額の解析 ---------- */

/** 金額文字列を数値に。空欄は null、解釈できない場合は NaN */
function parseAmount(raw) {
  let s = String(raw == null ? "" : raw).normalize("NFKC").trim();
  if (s === "" || s === "-" || s === "―" || s === "‐") return null;

  let negative = false;
  if (/^[△▲]/.test(s)) { negative = true; s = s.slice(1); }
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }

  s = s.replace(/[¥￥$,、\s　]/g, "").replace(/[−–—―‐]/g, "-");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (s === "") return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return NaN;
  return negative ? -value : value;
}

function isAmountLike(raw) {
  const v = parseAmount(raw);
  return v !== null && !Number.isNaN(v);
}

/* ---------- 列レイアウトの判定 ---------- */

/**
 * 見出し行を探す。見つかれば {headerRow, cols} を返す。
 * cols は {section, item, prev, curr} の列番号(未検出は null)。
 */
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cols = { company: null, period: null, section: null, item: null, prev: null, curr: null };
    let amountCols = 0;
    rows[r].forEach((cell, c) => {
      const role = HEADER_INDEX.get(normalizeKey(cell));
      if (!role || cols[role] !== null) return;
      cols[role] = c;
      if (role === "prev" || role === "curr") amountCols++;
    });
    if (cols.item !== null && amountCols > 0) return { headerRow: r, cols };
  }
  return null;
}

/** 見出し行がない場合に、科目名が並ぶ列と金額列を推定する */
function inferLayout(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const hits = new Array(width).fill(0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) if (lookupItem(row[c])) hits[c]++;
  }
  const itemCol = hits.indexOf(Math.max(...hits));
  if (hits[itemCol] === 0) return null;

  const amountCols = [];
  for (let c = itemCol + 1; c < width && amountCols.length < 2; c++) {
    if (rows.some((row) => isAmountLike(row[c]))) amountCols.push(c);
  }
  if (amountCols.length === 0) return null;

  return {
    headerRow: -1,
    cols: {
      company: null,
      period: null,
      section: null,
      item: itemCol,
      prev: amountCols.length >= 2 ? amountCols[0] : null,
      curr: amountCols.length >= 2 ? amountCols[1] : amountCols[0],
    },
  };
}

/* ---------- メイン: CSVテキスト → 入力データ ---------- */

/**
 * @param {string} text CSV本文
 * @param {string} defaultCompany 会社名の列がない場合に使う名前(通常はファイル名)
 * @returns {{datasets: {company, period, data, hasPrev}[], ok, errors[], warnings[], matched, recognized, unmatched[]}}
 */
function parseFinancialCSV(text, defaultCompany = "対象会社", mapping = null) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => ({
    datasets: [], ok: false, errors: [msg], warnings, matched: 0, recognized: 0, unmatched: [],
  });

  const rows = parseDelimited(text, detectDelimiter(text));
  if (rows.length === 0) return fail("ファイルが空です。");

  const layout = findHeader(rows) || inferLayout(rows);
  if (!layout) {
    return fail("科目名の列を判別できませんでした。1行目に「会社名,区分,科目,前期末,当期末」の見出しを入れてください(テンプレートCSVをご利用ください)。");
  }
  const { cols } = layout;
  if (cols.curr === null && cols.prev !== null) { cols.curr = cols.prev; cols.prev = null; }
  if (cols.prev === null) {
    warnings.push("金額の列が1つしかありません。BSは前期末・当期末の2列が必要です(この列は当期末として読み込みます)。");
  }

  // 同じ科目に複数行あれば合算する(例:受取手形 + 売掛金 → 営業債権)
  const seen = new Map();
  const unmatched = [];
  let matched = 0;    // 金額まで取り込めた科目の行数
  let recognized = 0; // 科目名を認識できた行数(金額が空の行も含む)

  // 「会社 × 四半期」ごとにデータを持つ。列がなければ1社・通期として扱う
  const datasets = new Map();
  let lastCompany = "";
  let lastPeriod = null;
  const datasetFor = (company, period) => {
    const key = `${company}\u0000${period.label}`;
    if (!datasets.has(key)) {
      // provided は「CSVに実際に値があったか」の記録。実額0と未入力を区別するために使う
      datasets.set(key, { company, period, data: emptyData(), hasPrev: false, provided: new Set() });
    }
    return datasets.get(key);
  };

  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const lineNo = r + 1;
    const rawName = (row[cols.item] || "").trim();
    if (rawName === "") continue;

    // 会社名・四半期が空のセルは直前の行から引き継ぐ(先頭行にだけ書く表に対応)
    if (cols.company !== null) {
      const c = (row[cols.company] || "").trim();
      if (c !== "") lastCompany = c;
    }
    if (cols.period !== null) {
      const p = parsePeriod(row[cols.period]);
      if (p) lastPeriod = p;
    }
    const companyName = cols.company !== null ? (lastCompany || defaultCompany) : defaultCompany;
    const period = (cols.period !== null && lastPeriod) ? lastPeriod : NO_PERIOD;
    const dataset = datasetFor(companyName, period);
    const data = dataset.data;

    // 読み込んだ科目マッピングがあれば、組み込みの対応より優先する。
    // 1つの科目を複数の項目へ同時に反映できる(符号はマッピングの指定どおり)
    const mapped = mappingLookup(mapping, rawName);
    if (mapped) {
      recognized++;
      let usedM = false;
      for (const t of mapped) {
        const putM = (which, raw) => {
          let v = parseAmount(raw);
          if (v === null) return false;
          if (Number.isNaN(v)) {
            warnings.push(`${lineNo}行目「${rawName}」の金額「${String(raw).trim()}」を数値として読み取れませんでした。0として扱います。`);
            return false;
          }
          v *= t.sign;
          const bucket = t.section === "bs" ? data.bs[which] : data[t.section];
          const slot = `${companyName}\u0000${period.label}\u0000${t.section}:${t.key}:${which}`;
          bucket[t.key] = (seen.has(slot) ? bucket[t.key] : 0) + v;
          seen.set(slot, true);
          dataset.provided.add(`${t.section}:${t.key}`);
          return true;
        };
        if (t.section === "bs") {
          if (cols.prev !== null && putM("prev", row[cols.prev])) { usedM = true; dataset.hasPrev = true; }
          if (cols.curr !== null) usedM = putM("curr", row[cols.curr]) || usedM;
        } else {
          const raw = cols.curr !== null && parseAmount(row[cols.curr]) !== null
            ? row[cols.curr]
            : (cols.prev !== null ? row[cols.prev] : "");
          usedM = putM("curr", raw) || usedM;
        }
      }
      if (usedM) matched++;
      continue;
    }

    const target = lookupItem(rawName);
    if (!target) {
      // 合計行など、金額のない見出し行はそっと無視する
      const hasAmount = [cols.prev, cols.curr].some((c) => c !== null && isAmountLike(row[c]));
      if (hasAmount) unmatched.push({ line: lineNo, name: rawName });
      continue;
    }
    recognized++;

    const put = (which, raw) => {
      let v = parseAmount(raw);
      if (v === null) return false;
      if (Number.isNaN(v)) {
        warnings.push(`${lineNo}行目「${rawName}」の金額「${String(raw).trim()}」を数値として読み取れませんでした。0として扱います。`);
        return false;
      }
      if (target.negate) v = -v;
      if (target.absolute && v < 0) {
        warnings.push(`${lineNo}行目「${rawName}」は正の値で入力する科目です。${v} を ${Math.abs(v)} として扱います。`);
        v = Math.abs(v);
      }
      const bucket = target.section === "bs" ? data.bs[which] : data[target.section];
      const slot = `${companyName}\u0000${period.label}\u0000${target.section}:${target.key}:${which}`;
      bucket[target.key] = (seen.has(slot) ? bucket[target.key] : 0) + v;
      seen.set(slot, true);
      dataset.provided.add(`${target.section}:${target.key}`);
      return true;
    };

    let used = false;
    if (target.section === "bs") {
      if (cols.prev !== null && put("prev", row[cols.prev])) { used = true; dataset.hasPrev = true; }
      if (cols.curr !== null) used = put("curr", row[cols.curr]) || used;
    } else {
      // BS以外は1つの金額。当期列が空なら前期列の値を使う
      const raw = cols.curr !== null && parseAmount(row[cols.curr]) !== null
        ? row[cols.curr]
        : (cols.prev !== null ? row[cols.prev] : "");
      used = put("curr", raw);
    }
    if (used) matched++;
  }

  if (matched === 0) {
    errors.push(recognized > 0
      ? `科目は${recognized}件認識できましたが、金額が1件も入力されていません。金額の列をご確認ください。`
      : "認識できる科目が1件もありませんでした。テンプレートCSVの科目名をご確認ください。");
  }
  if (unmatched.length > 0) {
    warnings.push(
      `次の${unmatched.length}件の科目は認識できなかったため読み飛ばしました: ` +
      unmatched.slice(0, 8).map((u) => `${u.line}行目「${u.name}」`).join("、") +
      (unmatched.length > 8 ? " ほか" : "")
    );
  }

  return {
    datasets: [...datasets.values()],
    ok: errors.length === 0, errors, warnings, matched, recognized, unmatched,
  };
}

/* ---------- テンプレートCSVの生成 ---------- */

/**
 * @param {{company, period, data}[]|null} datasets 省略すると空欄のひな形を出力する
 */
function buildTemplateCSV(datasets = null) {
  const lines = ["会社名,四半期,区分,科目,前期末,当期末"];
  const cell = (v) => (v === null || v === undefined ? "" : String(v));
  // カンマや引用符を含む名前をCSVとして正しく書き出す
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  const targets = datasets && datasets.length ? datasets : [
    { company: "A社", period: { label: "2025Q1" }, data: null },
    { company: "A社", period: { label: "2025Q2" }, data: null },
    { company: "B社", period: { label: "2025Q1" }, data: null },
  ];

  for (const { company, period, data } of targets) {
    const head = `${q(company)},${q(period.label)}`;
    for (const f of DISPLAY_FIELDS.bs) {
      const prev = data ? cell(data.bs.prev[f.key]) : "";
      const curr = data ? cell(data.bs.curr[f.key]) : "";
      lines.push(`${head},BS,${f.label},${prev},${curr}`);
    }
    for (const section of ["pl", "sup", "ss"]) {
      for (const f of DISPLAY_FIELDS[section]) {
        const curr = data ? cell(data[section][f.key]) : "";
        lines.push(`${head},${SECTION_LABELS[section]},${f.label},,${curr}`);
      }
    }
  }
  return lines.join("\r\n") + "\r\n";
}
