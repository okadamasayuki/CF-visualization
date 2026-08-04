"use strict";

/* =========================================================
 * 共有フォルダ連携
 *
 * File System Access API でローカルのフォルダ(社内共有フォルダ、
 * OneDrive/Google ドライブの同期フォルダ、割り当てたネットワークドライブ等)を
 * 直接読み書きし、複数人で同じデータを使えるようにする。
 *
 * フォルダの中身:
 *   data/<元のファイル名>.csv          読み込んだCSVそのもの
 *   overrides/<会社>_<四半期>.json     詳細入力(その会社・四半期の上書き値)
 *   settings.json                      表示区分などの設定と最終更新の記録
 *
 * 競合について: ファイル単位の「最後に書いた人が勝つ」方式。
 * 自動書き出しでは既存ファイルを消さないので、他の人が置いたファイルは残る。
 * 会社×四半期ごとにCSVを分けておくと、同時に触ってもぶつかりにくい。
 * ======================================================= */

const SHARE_DB_NAME = "cf-visualization-share";
const SHARE_STORE = "handles";
const SHARE_HANDLE_KEY = "dir";
const SHARE_DATA_DIR = "data";
const SHARE_OVERRIDE_DIR = "overrides";
const SHARE_SETTINGS = "settings.json";
const SHARE_MAPPING = "mapping.csv"; // 科目マッピング(算定ロジックファイル)
const SHARE_PUSH_DELAY = 1200; // 連続した変更をまとめる待ち時間(ms)

/** この環境で共有フォルダ連携が使えるか(Chrome/Edge のデスクトップ + HTTPS) */
function shareSupported() {
  return typeof window.showDirectoryPicker === "function" && window.isSecureContext;
}

/* ---------- ハンドルの保管(IndexedDB) ---------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SHARE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRun(mode, fn) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_STORE, mode);
    const req = fn(tx.objectStore(SHARE_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

const idbGetHandle = () => idbRun("readonly", (s) => s.get(SHARE_HANDLE_KEY));
const idbPutHandle = (h) => idbRun("readwrite", (s) => s.put(h, SHARE_HANDLE_KEY));
const idbDelHandle = () => idbRun("readwrite", (s) => s.delete(SHARE_HANDLE_KEY));

/* ---------- ファイル操作の下ごしらえ ---------- */

/** Windows やネットワーク共有で使えない文字を落とす */
function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "untitled";
}

/* ---------- ファイル名の付け方 ----------
 * 日本語のファイル名を作れない置き場所(古いNAS、文字コードの合っていない共有など)が
 * あるため、フォルダごとに命名方式を決めて settings.json に書いておく。
 * 端末ごとに方式が変わると同じデータが二重に置かれてしまうので、
 * 最初に書いた人の方式に全員が従う。
 */

/** 非ASCII名が作れるフォルダかどうかを、一度だけ試して確かめる */
async function shareProbeNameScheme(dir) {
  const probe = "__テスト__.tmp";
  try {
    await dir.getFileHandle(probe, { create: true });
    await dir.removeEntry(probe);
    return "unicode";
  } catch (_) {
    return "ascii";
  }
}

/** 文字列から短い16進の識別子を作る(FNV-1a。名前の衝突を避けるためだけに使う) */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** ASCIIだけのファイル名にする(読める部分は残し、消えた部分は識別子で区別する) */
function asciiFileName(name) {
  const m = String(name).match(/^(.*?)(\.[A-Za-z0-9]+)?$/);
  const base = m[1] || String(name);
  const ext = m[2] || "";
  const kept = base.replace(/[^\x20-\x7E]+/g, "_").replace(/_{2,}/g, "_").replace(/^_|_$/g, "");
  return safeFileName(`${kept || "data"}-${shortHash(base)}${ext}`);
}

/** そのフォルダの命名方式に合わせたファイル名を返す */
function fileNameFor(name, scheme) {
  const safe = safeFileName(name);
  return scheme === "ascii" ? asciiFileName(safe) : safe;
}

async function getDir(dir, name, create) {
  try {
    return await dir.getDirectoryHandle(name, { create });
  } catch (err) {
    if (err.name === "NotFoundError" || err.name === "TypeMismatchError") return null;
    throw err;
  }
}

async function readFile(dir, name) {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return { text: await decodeFile(file), modified: file.lastModified };
  } catch (err) {
    if (err.name === "NotFoundError" || err.name === "TypeMismatchError") return null;
    throw err;
  }
}

/** BOM付きUTF-8で書く(Excelでそのまま開けるようにするため。JSONだけBOMなし) */
async function writeFile(dir, name, text, { bom = true } = {}) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([(bom ? "﻿" : "") + text],
    { type: bom ? "text/csv;charset=utf-8" : "application/json" }));
  await writable.close();
}

async function listFiles(dir, filter) {
  const out = [];
  if (!dir) return out;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file") continue;
    if (filter && !filter(name)) continue;
    out.push({ name, handle });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return out;
}

/* ---------- 接続 ---------- */

/** フォルダを選んでもらう。キャンセルされたら null */
async function sharePick() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "cf-share", mode: "readwrite" });
  } catch (err) {
    if (err.name === "AbortError") return null;
    throw err;
  }
  if (!(await shareEnsurePermission(handle, true))) return null;
  await idbPutHandle(handle);
  return handle;
}

/** 前回のフォルダを取り出す。許可が切れていれば interactive のときだけ再要求する */
async function shareRestore(interactive) {
  let handle = null;
  try {
    handle = await idbGetHandle();
  } catch (_) { return null; }
  if (!handle) return null;
  if (!(await shareEnsurePermission(handle, interactive))) return interactive ? null : "needs-permission";
  return handle;
}

async function shareEnsurePermission(handle, interactive) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (!interactive) return false;
  return (await handle.requestPermission(opts)) === "granted";
}

/* ---------- 読み込み ---------- */

/**
 * フォルダの中身をまるごと読む。
 * @returns {{sources, overrides, interestPolicy, stamps, settings}}
 */
async function shareRead(dir) {
  const stamps = new Map();
  const sources = [];
  const dataDir = await getDir(dir, SHARE_DATA_DIR, false);
  for (const { name, handle } of await listFiles(dataDir, (n) => /\.(csv|tsv|txt)$/i.test(n))) {
    const file = await handle.getFile();
    sources.push({ name, text: await decodeFile(file) });
    stamps.set(`${SHARE_DATA_DIR}/${name}`, file.lastModified);
  }

  const overrides = {};
  const ovDir = await getDir(dir, SHARE_OVERRIDE_DIR, false);
  for (const { name, handle } of await listFiles(ovDir, (n) => /\.json$/i.test(n))) {
    const file = await handle.getFile();
    stamps.set(`${SHARE_OVERRIDE_DIR}/${name}`, file.lastModified);
    try {
      const body = JSON.parse((await file.text()).replace(/^﻿/, ""));
      if (body && body.company && body.period && body.values) {
        overrides[keyOf(body.company, body.period)] = body.values;
      }
    } catch (_) { /* 壊れたファイルは無視する */ }
  }

  let settings = null;
  const raw = await readFile(dir, SHARE_SETTINGS);
  if (raw) {
    stamps.set(SHARE_SETTINGS, raw.modified);
    try { settings = JSON.parse(raw.text.replace(/^﻿/, "")); } catch (_) { /* 無視 */ }
  }

  // 科目マッピング(あれば)
  let mappingText = "";
  const mapRaw = await readFile(dir, SHARE_MAPPING);
  if (mapRaw) {
    stamps.set(SHARE_MAPPING, mapRaw.modified);
    mappingText = mapRaw.text.replace(/^\ufeff/, "");
  }

  const scheme = settings && settings.nameScheme === "ascii" ? "ascii" : settings ? "unicode" : null;
  return { sources, overrides, settings, stamps, scheme, mappingText };
}

/* ---------- 書き出し ---------- */

/**
 * いまのデータをフォルダへ書く。
 * @param prune true なら、こちらに無いファイルをフォルダから消す(明示操作のときだけ)
 */
async function shareWrite(dir, payload, { prune = false, by = "", scheme = null } = {}) {
  const stamps = new Map();
  // 命名方式は、そのフォルダで最初に決まったものに従う
  if (!scheme) {
    const current = await readFile(dir, SHARE_SETTINGS);
    let saved = null;
    if (current) {
      try { saved = JSON.parse(current.text.replace(/^\uFEFF/, "")).nameScheme; } catch (_) { /* 無視 */ }
    }
    scheme = saved === "ascii" || saved === "unicode" ? saved : await shareProbeNameScheme(dir);
  }

  // --- data/ ---
  const dataDir = await dir.getDirectoryHandle(SHARE_DATA_DIR, { create: true });
  const wantData = new Set();
  for (const src of payload.sources) {
    let name = fileNameFor(src.name, scheme);
    if (!/\.(csv|tsv|txt)$/i.test(name)) name += ".csv";
    wantData.add(name);
    await writeFile(dataDir, name, src.text);
  }
  if (prune) {
    for (const { name } of await listFiles(dataDir)) {
      if (!wantData.has(name)) await dataDir.removeEntry(name);
    }
  }
  for (const { name, handle } of await listFiles(dataDir)) {
    stamps.set(`${SHARE_DATA_DIR}/${name}`, (await handle.getFile()).lastModified);
  }

  // --- overrides/ ---
  const ovDir = await dir.getDirectoryHandle(SHARE_OVERRIDE_DIR, { create: true });
  const wantOv = new Set();
  for (const [key, values] of Object.entries(payload.overrides || {})) {
    if (!values || Object.keys(values).length === 0) continue;
    const [company, period] = key.split("\u0000");
    const name = fileNameFor(`${company}_${period}.json`, scheme);
    wantOv.add(name);
    await writeFile(ovDir, name, JSON.stringify({ company, period, values }, null, 2), { bom: false });
  }
  // 詳細入力を消した分は、こちらのファイルも消す(pruneでなくても追随させる)
  for (const { name } of await listFiles(ovDir, (n) => /\.json$/i.test(n))) {
    if (!wantOv.has(name)) await ovDir.removeEntry(name);
  }
  for (const { name, handle } of await listFiles(ovDir, (n) => /\.json$/i.test(n))) {
    stamps.set(`${SHARE_OVERRIDE_DIR}/${name}`, (await handle.getFile()).lastModified);
  }

  // --- mapping.csv(科目マッピング) ---
  if (payload.mappingText) {
    await writeFile(dir, SHARE_MAPPING, payload.mappingText);
    const m = await readFile(dir, SHARE_MAPPING);
    if (m) stamps.set(SHARE_MAPPING, m.modified);
  } else if (await readFile(dir, SHARE_MAPPING)) {
    // マッピングを解除した状態を共有するため、ファイルも消す
    await dir.removeEntry(SHARE_MAPPING);
  }

  // --- settings.json ---
  await writeFile(dir, SHARE_SETTINGS, JSON.stringify({
    app: "CF-visualization",
    nameScheme: scheme,
    interestPolicy: payload.interestPolicy,
    folderPath: payload.folderPath || "",
    updatedAt: new Date().toISOString(),
    updatedBy: by || "",
    files: payload.sources.length,
  }, null, 2), { bom: false });
  const s = await readFile(dir, SHARE_SETTINGS);
  if (s) stamps.set(SHARE_SETTINGS, s.modified);

  return { stamps, scheme };
}

/* ---------- 更新の検知 ---------- */

/** フォルダの現在の更新時刻を一覧する(中身は読まない) */
async function shareStamps(dir) {
  const stamps = new Map();
  for (const [sub, filter] of [[SHARE_DATA_DIR, (n) => /\.(csv|tsv|txt)$/i.test(n)],
                               [SHARE_OVERRIDE_DIR, (n) => /\.json$/i.test(n)]]) {
    const d = await getDir(dir, sub, false);
    for (const { name, handle } of await listFiles(d, filter)) {
      stamps.set(`${sub}/${name}`, (await handle.getFile()).lastModified);
    }
  }
  const s = await readFile(dir, SHARE_SETTINGS);
  if (s) stamps.set(SHARE_SETTINGS, s.modified);
  const m = await readFile(dir, SHARE_MAPPING);
  if (m) stamps.set(SHARE_MAPPING, m.modified);
  return stamps;
}

/** 2つの更新時刻一覧を比べて、増えた/変わった/消えたファイル名を返す */
function shareDiff(before, after) {
  const changed = [];
  for (const [name, at] of after) {
    if (!before.has(name)) changed.push(`+ ${name}`);
    else if (before.get(name) !== at) changed.push(`~ ${name}`);
  }
  for (const name of before.keys()) if (!after.has(name)) changed.push(`- ${name}`);
  return changed;
}
