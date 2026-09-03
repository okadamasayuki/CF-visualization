"use strict";

/* =========================================================
 * 「科目対応」タブ
 *
 * 読み込んだファイルに出てきた科目を全部並べ、それぞれを
 * 「どの項目に、足す(+)か引く(−)か」で登録する画面。
 *
 *  - 名前から自動で判定できた科目も、ここで確定(登録)しておくと以後は
 *    名前の揺れに左右されず、必ず登録どおりに読み込む
 *  - 認識できなかった科目は反映先を選べばそのまま取り込める
 *  - 使わない科目(合計行など)は「使わない」にすると読み飛ばす
 *
 * 登録の中身は既存の科目マッピング(mapping.csv / state.mappingText)そのもの。
 * だから CF計算書・指標・全社比較・共有フォルダ・配布用ZIP・読み込み内訳は
 * すべて同じ対応表を見る(この画面だけの別ロジックは持たない)。
 * ======================================================= */

/** 表示のグループ(並び順・絞り込み)。確認してほしい順に並べる */
const ACCT_GROUPS = [
  ["none", "認識できず(読み飛ばし中)"],
  ["loose", "表記ゆれで判定"],
  ["auto", "自動判定(組み込みの対応)"],
  ["map", "登録済み"],
  ["skip", "使わない"],
];
const ACCT_GROUP_ORDER = new Map(ACCT_GROUPS.map(([k], i) => [k, i]));

/** 科目の同一性のキー。コードがあればコード、無ければ名前で見る */
function acctKeyOf(code, name) {
  return code ? `c:${mappingKey(code)}` : `n:${mappingKey(name)}`;
}

/**
 * 読み込み結果(ファイルごとの resolved / unmatched)から、科目の一覧を組み立てる。
 * applySources から呼ばれる。
 */
function collectAccounts(perFile) {
  const map = new Map();
  // 対応表は会社に依存しない(科目コード、無ければ科目名で同一視する)。
  // 会社ごとに使う科目が違っても、全社に出てきた科目の和集合が1つの表になる。
  for (const { file, resolved, unmatched, companies } of perFile) {
    const add = (rec, via, targets) => {
      const key = acctKeyOf(rec.code, rec.name);
      if (!map.has(key)) {
        map.set(key, { key, code: rec.code || "", name: rec.name, names: new Set([rec.name]),
          via, targets, files: new Set(), companies: new Set() });
      }
      const a = map.get(key);
      a.names.add(rec.name);
      a.files.add(file);
      for (const c of companies || []) a.companies.add(c);
    };
    for (const r of resolved || []) add(r, r.via, r.targets.map((t) => ({ ...t })));
    for (const u of unmatched || []) add(u, "none", []);
  }
  return [...map.values()];
}

/* ---------- 影響(この科目が CF計算書のどの行・どの指標に効くか) ---------- */

/** 入力項目 → CF計算書の行と符号(算定ロジックの対応表を逆引きしたもの) */
const ACCT_EFFECT_INDEX = (() => {
  const idx = new Map(); // "section:key" → [{ line, sign }]
  for (const sec of DERIVATION) {
    for (const it of sec.items) {
      if (it.requires || !it.inputs) continue; // 詳細情報があるときだけ現れる行は除く
      // BSは期末側の符号で表す。期首しか使わない行(期首残高)は期首側の符号で載せる
      const sorted = [...it.inputs].sort((a, b) => (a.path.includes(".prev.") ? 1 : 0) - (b.path.includes(".prev.") ? 1 : 0));
      for (const inp of sorted) {
        const p = inp.path.split(".");
        const k = p[0] === "bs" ? `bs:${p[2]}` : `${p[0]}:${p[1]}`;
        if (!idx.has(k)) idx.set(k, []);
        const list = idx.get(k);
        if (!list.some((x) => x.line === it.labels[0])) list.push({ line: it.labels[0], sign: inp.sign });
      }
    }
  }
  // 他の行から計算される行のうち、科目との関係が一意に決まるもの
  const extra = {
    "bs:cash": [{ line: "現金及び現金同等物の期末残高", sign: 1 }],
    "bs:cashExcluded": [{ line: "現金及び現金同等物の期末残高", sign: -1 }],
  };
  for (const [k, list] of Object.entries(extra)) {
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(...list);
  }
  return idx;
})();

/** 入力項目 → 使っている財務指標(js/metrics.js の定義に対応) */
const ACCT_METRIC_USES = {
  "pl:operatingIncome": ["EBITDA", "ROIC"],
  "pl:depreciation": ["EBITDA"],
  "pl:pretaxIncome": ["EBITDA・ROIC(営業利益が無いときの推計)", "ROIC(実効税率)"],
  "pl:interestExpense": ["EBITDA・ROIC(営業利益が無いときの推計)"],
  "pl:interestIncome": ["EBITDA・ROIC(営業利益が無いときの推計)"],
  "pl:incomeTaxes": ["ROIC(実効税率)"],
  "bs:receivables": ["運転資金"],
  "bs:inventory": ["運転資金"],
  "bs:payables": ["運転資金"],
  "bs:shortLoans": ["有利子負債", "ROIC(投下資本)", "推移グラフ"],
  "bs:longLoans": ["有利子負債", "ROIC(投下資本)", "推移グラフ"],
  "bs:netAssets": ["ROIC(投下資本)"],
  "bs:deposits": ["推移グラフ"],
};

/** 反映先の一覧から、影響のチップ([{text, sign|null, metric}])を作る */
function acctEffects(targets) {
  const out = [];
  const seen = new Set();
  for (const t of targets) {
    const k = `${t.section}:${t.key}`;
    for (const e of ACCT_EFFECT_INDEX.get(k) || []) {
      const sign = e.sign * t.sign;
      const id = `${e.line}${sign}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ text: e.line, sign });
    }
    for (const m of ACCT_METRIC_USES[k] || []) {
      if (seen.has(`m:${m}`)) continue;
      seen.add(`m:${m}`);
      out.push({ text: m, sign: null, metric: true });
    }
  }
  return out;
}

/* ---------- 編集状態 ---------- */

/** いまのマッピングから、その科目の編集状態を起こす */
function acctInitialEdit(a) {
  const m = state.mapping;
  if (m) {
    const kc = a.code ? mappingKey(a.code) : null;
    const kn = mappingKey(a.name);
    const hit = kc !== null && m.entries.has(kc) ? kc : m.entries.has(kn) ? kn : null;
    if (hit !== null) {
      if (m.skipKeys && m.skipKeys.has(hit)) return { mode: "skip", targets: [] };
      return { mode: "map", targets: m.entries.get(hit).map((t) => ({ section: t.section, key: t.key, sign: t.sign })) };
    }
  }
  return { mode: "auto", targets: a.via === "none" ? [] : a.targets.map((t) => ({ ...t })) };
}

function acctEdits() {
  if (!state.acctEdits) {
    state.acctEdits = new Map();
    state.acctInitial = new Map();
    for (const a of state.accounts || []) {
      const e = acctInitialEdit(a);
      state.acctEdits.set(a.key, e);
      state.acctInitial.set(a.key, JSON.stringify(e));
    }
  }
  return state.acctEdits;
}

function acctChanged(a) {
  return JSON.stringify(acctEdits().get(a.key)) !== state.acctInitial.get(a.key);
}

/** 表示グループ。e は編集状態(現在 or 直前の適用時点) */
function acctGroupOf(a, e) {
  if (e.mode === "skip") return "skip";
  if (e.mode === "map") return "map";
  if (a.via === "none") return "none";
  if (a.via === "loose") return "loose";
  return "auto";
}

/** いまの編集内容でのグループ(バッジの表示に使う) */
function acctGroup(a) {
  return acctGroupOf(a, acctEdits().get(a.key));
}

/**
 * 直前に適用した時点でのグループ。並び順・絞り込み・件数はこちらで決める。
 * 編集のたびに行が別のグループへ飛んでいくと、いま触っていた行を見失うため、
 * 「変更を適用」するまでは行の位置を動かさない。
 */
function acctBaseGroup(a) {
  acctEdits();
  return acctGroupOf(a, JSON.parse(state.acctInitial.get(a.key)));
}

function acctFieldLabel(section, key) {
  const f = SCHEMA[section] && SCHEMA[section].find((g) => g.key === key && !g.aliasOnly);
  return f ? f.label : key;
}

/* ---------- 描画 ---------- */

function acctStatus(text, kind = "") {
  const p = document.getElementById("acct-status");
  p.hidden = !text;
  p.textContent = text;
  p.className = `file-status ${kind}`;
}

function acctSorted() {
  const list = [...(state.accounts || [])];
  const codeNum = (c) => (/^\d+$/.test(c) ? Number(c) : Infinity);
  list.sort((a, b) => {
    const g = ACCT_GROUP_ORDER.get(acctBaseGroup(a)) - ACCT_GROUP_ORDER.get(acctBaseGroup(b));
    if (g !== 0) return g;
    const c = codeNum(a.code) - codeNum(b.code);
    if (c !== 0 && !Number.isNaN(c)) return c;
    return a.name.localeCompare(b.name, "ja");
  });
  return list;
}

function acctFilterFn() {
  const filter = document.getElementById("acct-filter").value;
  const q = mappingKey(document.getElementById("acct-search").value);
  return (a) => {
    if (filter === "changed" && !acctChanged(a)) return false;
    if (filter !== "all" && filter !== "changed" && acctBaseGroup(a) !== filter) return false;
    if (q && !mappingKey(a.code).includes(q) && ![...a.names].some((n) => mappingKey(n).includes(q))
      && ![...a.companies].some((c) => mappingKey(c).includes(q))) return false;
    return true;
  };
}

function renderAccountsPanel() {
  const table = document.getElementById("acct-table");
  if (!table) return;
  const edits = acctEdits();
  const all = acctSorted();
  renderAcctSummary(all);
  document.getElementById("acct-notice").hidden = hasData();

  // 本体
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  const keep = acctFilterFn();
  let shown = 0;
  for (const a of all) {
    if (!keep(a)) continue;
    shown++;
    tbody.append(...acctRows(a, edits.get(a.key)));
  }
  document.getElementById("acct-empty").hidden = shown > 0;
}

/**
 * 1科目分の行だけをその場で書き換える(表全体は作り直さない)。
 * 行の位置・スクロール位置を保ち、操作していた選択欄にフォーカスを戻す。
 */
function acctRefreshRow(a, focus) {
  const tbody = document.querySelector("#acct-table tbody");
  const old = tbody ? [...tbody.querySelectorAll(`tr[data-key="${CSS.escape(a.key)}"]`)] : [];
  if (!tbody || old.length === 0) { renderAccountsPanel(); return; }
  const fresh = acctRows(a, acctEdits().get(a.key));
  old[0].before(...fresh);
  for (const tr of old) tr.remove();
  renderAcctSummary(acctSorted());
  if (focus) {
    const row = fresh[Math.min(focus.i, fresh.length - 1)];
    const target = row && row.querySelector(`.${focus.cls}`);
    if (target) target.focus({ preventScroll: true });
  }
}

/** 件数のまとめ(押すと絞り込み)とボタンの状態 */
function renderAcctSummary(all) {
  const counts = new Map(ACCT_GROUPS.map(([k]) => [k, 0]));
  let changed = 0;
  for (const a of all) {
    const g = acctBaseGroup(a);
    counts.set(g, counts.get(g) + 1);
    if (acctChanged(a)) changed++;
  }
  document.getElementById("acct-count").textContent = `${all.length}科目`;
  const summary = document.getElementById("acct-summary");
  summary.innerHTML = "";
  const filterSel = document.getElementById("acct-filter");
  for (const [k, label] of ACCT_GROUPS) {
    const b = el("button", { type: "button", class: `acct-chip acct-chip-${k}${filterSel.value === k ? " on" : ""}`,
      text: `${label} ${counts.get(k)}` });
    b.addEventListener("click", () => { filterSel.value = filterSel.value === k ? "all" : k; renderAccountsPanel(); });
    summary.appendChild(b);
  }
  if (changed) {
    const b = el("button", { type: "button", class: `acct-chip acct-chip-changed${filterSel.value === "changed" ? " on" : ""}`,
      text: `未適用の変更 ${changed}` });
    b.addEventListener("click", () => { filterSel.value = filterSel.value === "changed" ? "all" : "changed"; renderAccountsPanel(); });
    summary.appendChild(b);
  }

  const autoLeft = all.filter((a) => acctGroup(a) === "auto" || acctGroup(a) === "loose").length;
  const confirmBtn = document.getElementById("btn-acct-confirm-all");
  confirmBtn.disabled = autoLeft === 0;
  confirmBtn.textContent = autoLeft
    ? `自動判定をすべて確定して登録(${autoLeft}科目)`
    : "自動判定の科目はありません(すべて登録済み)";
  document.getElementById("btn-acct-apply").disabled = changed === 0;
  document.getElementById("btn-acct-revert").hidden = changed === 0;
  document.getElementById("btn-acct-clear").hidden = !(state.mapping && state.mapping.entries.size);
}

/** 1科目分の行(反映先が複数なら複数行) */
function acctRows(a, e) {
  const group = acctGroup(a);
  const n = Math.max(1, e.mode === "map" ? e.targets.length : 1);
  const rows = [];
  const changed = acctChanged(a);

  for (let i = 0; i < n; i++) {
    const tr = el("tr", { class: `acct-${group}${changed ? " acct-changed" : ""}` });
    tr.dataset.key = a.key;
    if (i === 0) {
      const extra = a.names.size > 1 ? ` ほか${a.names.size - 1}表記` : "";
      tr.append(
        el("td", { class: "code", rowspan: n, text: a.code || "—" }),
        el("td", { class: "name", rowspan: n },
          el("span", { text: a.name }),
          extra ? el("span", { class: "acct-sub", text: extra }) : ""),
        el("td", { class: "num", rowspan: n, text: `${a.companies.size}社`,
          title: `${[...a.companies].slice(0, 40).join("、")}${a.companies.size > 40 ? " ほか" : ""}(${a.files.size}ファイル)` }),
        el("td", { rowspan: n }, acctStateBadge(a, e)),
      );
    }
    tr.append(acctTargetCell(a, e, i));
    if (i === 0) tr.append(el("td", { class: "acct-effects-cell", rowspan: n }, acctEffectChips(a, e)));
    rows.push(tr);
  }
  return rows;
}

function acctStateBadge(a, e) {
  const map = {
    none: ["認識できず", "via-none"],
    loose: ["表記ゆれ", "via-loose"],
    auto: [a.via === "alias" ? "自動(別名)" : "自動(正式名)", "via-exact"],
    map: ["登録済み", "via-mapping"],
    skip: ["使わない", "via-mapping"],
  };
  const g = acctGroup(a);
  const [text, cls] = map[g];
  const wrap = el("div", { class: "acct-state" }, el("span", { class: `via-badge ${cls}`, text }));
  if (acctChanged(a)) wrap.append(el("span", { class: "acct-sub acct-pending", text: "未適用の変更" }));
  // 登録済みでも、もとは自動判定だった場合はその根拠を小さく添える
  if ((g === "map" || g === "skip") && a.via && a.via !== "mapping" && a.via !== "skip" && a.via !== "none") {
    wrap.append(el("span", { class: "acct-sub", text: a.via === "loose" ? "元は表記ゆれ判定" : "元は自動判定" }));
  }
  if (g === "none") wrap.append(el("span", { class: "acct-sub", text: "反映先を選ぶと取り込みます" }));
  return wrap;
}

/** 反映先の選択(区分・科目・符号)。i 行目 */
function acctTargetCell(a, e, i) {
  const td = el("td", { class: "acct-target-cell" });
  const row = el("div", { class: "acct-target" });
  const hasAuto = a.via !== "none" && a.via !== "mapping" && a.via !== "skip" && a.targets.length > 0;
  const t = e.mode === "map" ? e.targets[i] : (e.mode === "auto" ? a.targets[i] : null);

  // 区分
  const sec = el("select", { class: "acct-section", "aria-label": "反映先の区分" });
  if (i === 0) {
    sec.appendChild(el("option", { value: "auto",
      text: hasAuto ? "自動判定のまま" : "未設定(読み飛ばし)" }));
  }
  for (const s of MAPPING_EDIT_SECTIONS) {
    if (s === MAPPING_SKIP && i > 0) continue;
    sec.appendChild(el("option", { value: s, text: s === MAPPING_SKIP ? MAPPING_SKIP_LABEL : SECTION_LABELS[s] }));
  }
  sec.value = e.mode === "map" ? t.section : e.mode === "skip" ? MAPPING_SKIP : "auto";

  // 科目
  const item = el("select", { class: "acct-item", "aria-label": "反映先の科目" });
  const fill = (section, selectedKey) => {
    item.innerHTML = "";
    if (!SCHEMA[section]) { item.appendChild(el("option", { value: "", text: "—" })); item.disabled = true; return; }
    for (const f of SCHEMA[section]) {
      if (f.aliasOnly) continue;
      item.appendChild(el("option", { value: f.key, text: f.label }));
    }
    item.value = selectedKey || SCHEMA[section][0].key;
  };
  if (t) fill(t.section, t.key); else fill("", "");
  item.disabled = e.mode !== "map";

  // 符号
  const sign = el("select", { class: "acct-sign", "aria-label": "符号" });
  sign.appendChild(el("option", { value: "1", text: "+ 足す" }));
  sign.appendChild(el("option", { value: "-1", text: "− 引く" }));
  sign.value = t && t.sign < 0 ? "-1" : "1";
  sign.disabled = e.mode !== "map";

  // 行の削除(反映先が2つ以上のときだけ)
  const del = el("button", { type: "button", class: "map-del", text: "×", title: "この反映先を外す" });
  del.hidden = !(e.mode === "map" && e.targets.length > 1);
  del.addEventListener("click", () => { e.targets.splice(i, 1); acctRefreshRow(a, { cls: "acct-section", i: Math.max(0, i - 1) }); });

  sec.addEventListener("change", () => {
    const v = sec.value;
    if (v === "auto") { e.mode = "auto"; e.targets = a.via === "none" ? [] : a.targets.map((x) => ({ ...x })); }
    else if (v === MAPPING_SKIP) { e.mode = "skip"; e.targets = []; }
    else if (e.mode !== "map") {
      // 自動判定と同じ区分ならその科目を初期値に、違えばその区分の先頭
      const base = a.targets.find((x) => x.section === v);
      e.mode = "map";
      e.targets = [{ section: v, key: base ? base.key : SCHEMA[v][0].key, sign: base ? base.sign : 1 }];
    } else {
      const base = a.targets.find((x) => x.section === v);
      e.targets[i] = { section: v, key: base ? base.key : SCHEMA[v][0].key, sign: e.targets[i].sign };
    }
    // 区分を選んだら、次に選ぶ「科目」へフォーカスを移す(自動・使わないのときは区分のまま)
    acctRefreshRow(a, { cls: e.mode === "map" ? "acct-item" : "acct-section", i });
  });
  item.addEventListener("change", () => { e.targets[i].key = item.value; acctRefreshRow(a, { cls: "acct-item", i }); });
  sign.addEventListener("change", () => { e.targets[i].sign = Number(sign.value); acctRefreshRow(a, { cls: "acct-sign", i }); });

  row.append(sec, item, sign, del);
  td.append(row);

  // 反映先の追加(登録モードの最終行の下)
  if (e.mode === "map" && i === e.targets.length - 1) {
    const add = el("button", { type: "button", class: "btn-link acct-add", text: "+ 反映先を追加(同じ科目を別の項目にも)" });
    add.addEventListener("click", () => {
      const last = e.targets[e.targets.length - 1];
      e.targets.push({ section: last.section, key: last.key, sign: 1 });
      acctRefreshRow(a, { cls: "acct-section", i: e.targets.length - 1 });
    });
    td.append(add);
  }
  return td;
}

function acctEffectChips(a, e) {
  const wrap = el("div", { class: "acct-effects" });
  if (e.mode === "skip") { wrap.append(el("span", { class: "effect", text: "読み飛ばす(どこにも反映しない)" })); return wrap; }
  const targets = e.mode === "map" ? e.targets : (a.via === "none" ? [] : a.targets);
  if (targets.length === 0) { wrap.append(el("span", { class: "effect", text: "反映先なし(読み飛ばし中)" })); return wrap; }
  const effects = acctEffects(targets);
  if (effects.length === 0) {
    wrap.append(el("span", { class: "effect", text: "CF計算書の行には直接は出ません(詳細入力がある場合に使用)" }));
  }
  for (const f of effects) {
    const cls = f.metric ? "effect metric" : f.sign > 0 ? "effect plus" : "effect minus";
    const text = f.metric ? `指標: ${f.text}` : `${f.text} ${f.sign > 0 ? "+" : "−"}`;
    wrap.append(el("span", { class: cls, text, title: f.metric ? "この科目を使う財務指標" : "この科目の金額が増えると、CF計算書のこの行が増える(+)/減る(−)" }));
  }
  return wrap;
}

/* ---------- 適用 ---------- */

/**
 * 編集内容をマッピングCSVにして適用する。
 * 読み込んだデータに出てこない科目のマッピング行はそのまま残す。
 */
function acctApply({ confirmAll = false } = {}) {
  const edits = acctEdits();
  let confirmed = 0;
  if (confirmAll) {
    for (const a of state.accounts) {
      const e = edits.get(a.key);
      if (e.mode === "auto" && e.targets.length) { e.mode = "map"; confirmed++; }
    }
  }
  const rows = [];
  const covered = new Set();
  let registered = 0;
  let skipped = 0;
  for (const a of state.accounts) {
    const e = edits.get(a.key);
    if (a.code) covered.add(mappingKey(a.code));
    covered.add(mappingKey(a.name));
    const name = a.code || a.name;
    const memo = a.code ? a.name : "";
    if (e.mode === "skip") { rows.push({ name, section: MAPPING_SKIP, memo }); skipped++; }
    else if (e.mode === "map") {
      for (const t of e.targets) rows.push({ name, section: t.section, key: t.key, sign: t.sign, memo });
      registered++;
    }
  }
  // 読み込んだデータに無い科目の行は、いまのマッピングから引き継ぐ
  let kept = 0;
  if (state.mapping) {
    for (const [k, list] of state.mapping.entries) {
      if (covered.has(k)) continue;
      const name = state.mapping.names.get(k) || k;
      const memo = state.mapping.memos.get(k) || "";
      if (state.mapping.skipKeys.has(k)) rows.push({ name, section: MAPPING_SKIP, memo });
      else for (const t of list) rows.push({ name, section: t.section, key: t.key, sign: t.sign, memo });
      kept++;
    }
  }
  const text = rows.length ? buildMappingCSV(rows) : "";
  if (!setMapping(text, { quiet: true })) {
    acctStatus("登録内容をマッピングに変換できませんでした。", "ng");
    return;
  }
  state.acctEdits = null;
  applySources(state.sources, { keepModalOpen: true });
  saveState();
  const parts = [];
  if (confirmed) parts.push(`自動判定の${confirmed}科目を確定`);
  parts.push(`登録 ${registered}科目`);
  if (skipped) parts.push(`使わない ${skipped}科目`);
  if (kept) parts.push(`データに無い科目の登録 ${kept}件はそのまま`);
  acctStatus(`${parts.join(" / ")}。読み込み済みのデータを再計算しました。`, "ok");
}

function bindAccountsUI() {
  if (!document.getElementById("acct-table")) return;
  const filterSel = document.getElementById("acct-filter");
  filterSel.innerHTML = "";
  filterSel.appendChild(el("option", { value: "all", text: "すべて" }));
  for (const [k, label] of ACCT_GROUPS) filterSel.appendChild(el("option", { value: k, text: label }));
  filterSel.appendChild(el("option", { value: "changed", text: "未適用の変更" }));
  filterSel.addEventListener("change", renderAccountsPanel);
  let timer = null;
  document.getElementById("acct-search").addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderAccountsPanel, 150);
  });
  document.getElementById("btn-acct-confirm-all").addEventListener("click", () => acctApply({ confirmAll: true }));
  // 対応表のCSVでの出し入れ(手で作る・他の環境から持ってくる・Tableau などの変換表に使う)
  document.getElementById("btn-acct-export").addEventListener("click", () => {
    downloadText("cf-mapping.csv", state.mappingText || buildMappingTemplate());
    acctStatus(state.mappingText
      ? "いまの対応表を cf-mapping.csv として保存しました。"
      : "まだ登録がないため、組み込みの対応(全別名)を cf-mapping.csv として保存しました。書き替えて読み込めます。", "ok");
  });
  const fileInput = document.getElementById("acct-file-input");
  document.getElementById("btn-acct-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleMappingFile(fileInput.files));
  document.getElementById("btn-acct-apply").addEventListener("click", () => acctApply());
  document.getElementById("btn-acct-revert").addEventListener("click", () => {
    state.acctEdits = null;
    acctStatus("変更を取り消しました。", "");
    renderAccountsPanel();
  });
  document.getElementById("btn-acct-clear").addEventListener("click", () => {
    setMapping("");
    state.acctEdits = null;
    if (state.sources.length) applySources(state.sources, { keepModalOpen: true });
    saveState();
    acctStatus("登録をすべて解除し、組み込みの自動判定に戻しました。", "");
  });
}
