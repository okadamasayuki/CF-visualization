"use strict";

/* =========================================================
 * ZIP の書き出し(配布用フォルダをまとめて渡すため)
 *
 * ツール本体のHTMLと読み込んだ元データ(数百ファイルになりうる)を
 * 1つのZIPにして、メールや共有ドライブで渡せるようにする。
 *
 *  - 圧縮はブラウザ内蔵の CompressionStream(deflate-raw)を使う。
 *    使えない環境では無圧縮で書く(展開はどのソフトでもできる)
 *  - ファイル名は UTF-8 で書き、UTF-8 フラグ(bit 11)を立てる。
 *    Windows のエクスプローラー・macOS の標準展開で日本語名が化けない
 *  - 64bit拡張は使わない(4GB・65,535ファイル未満が前提)
 * ======================================================= */

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** deflate-raw で圧縮する。使えない環境では null */
async function zipDeflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * ZIP を組み立てる。
 * @param {Array<{name: string, text?: string, bytes?: Uint8Array}>} files
 *        name はZIP内のパス("元データ/A社_202503.csv" のように / 区切り)
 * @param {{compress?: boolean, date?: Date}} opts
 * @returns {Promise<Uint8Array>}
 */
async function buildZip(files, { compress = true, date = new Date() } = {}) {
  if (files.length >= 0xffff) throw new Error("ZIPに入れられるファイル数(65,534)を超えています");
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const FLAG_UTF8 = 0x0800;

  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(String(f.name).replace(/\\/g, "/").replace(/^\/+/, ""));
    const data = f.bytes ? f.bytes : enc.encode(f.text || "");
    const crc = zipCrc32(data);
    let stored = data;
    let method = 0; // 0 = 無圧縮, 8 = deflate
    if (compress && data.length > 0) {
      const deflated = await zipDeflate(data);
      if (deflated && deflated.length < data.length) { stored = deflated; method = 8; }
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);                // 展開に必要なバージョン(2.0)
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, stored.length, true);    // 圧縮後
    local.setUint32(22, data.length, true);      // 元のサイズ
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);                // 拡張フィールドなし
    parts.push(new Uint8Array(local.buffer), name, stored);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);                  // 作成側バージョン
    dir.setUint16(6, 20, true);                  // 展開に必要なバージョン
    dir.setUint16(8, FLAG_UTF8, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, dosTime, true);
    dir.setUint16(14, dosDate, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, stored.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint16(30, 0, true);                  // 拡張フィールド
    dir.setUint16(32, 0, true);                  // コメント
    dir.setUint16(34, 0, true);                  // ディスク番号
    dir.setUint16(36, 0, true);                  // 内部属性
    dir.setUint32(38, 0, true);                  // 外部属性
    dir.setUint32(42, offset, true);             // ローカルヘッダの位置
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + stored.length;
  }

  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of all) { out.set(a, pos); pos += a.length; }
  return out;
}
