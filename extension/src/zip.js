// 极简 ZIP 打包（store 模式，不压缩）：把多个 PNG 合成一个 zip 供一次下载。
// 仅供编辑页「每页片段数」分页结果使用。无第三方依赖、无新权限。
self.VSRZip = (function () {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function le16(v) {
    return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
  }
  function le32(v) {
    return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  }
  function concat(list) {
    let n = 0;
    for (const a of list) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of list) { out.set(a, o); o += a.length; }
    return out;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5)
      | ((d.getSeconds() >> 1) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9)
      | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  /**
   * @param {Array<{name: string, buffer: ArrayBuffer}>} files
   * @returns {Blob} application/zip
   */
  function build(files) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = new Uint8Array(f.buffer);
      const crc = crc32(data);
      const local = concat([
        le32(0x04034B50), le16(20), le16(0x0800), le16(0), le16(time), le16(date),
        le32(crc), le32(data.length), le32(data.length), le16(name.length), le16(0),
        name, data,
      ]);
      chunks.push(local);
      central.push(concat([
        le32(0x02014B50), le16(20), le16(20), le16(0x0800), le16(0), le16(time), le16(date),
        le32(crc), le32(data.length), le32(data.length), le16(name.length),
        le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name,
      ]));
      offset += local.length;
    }
    const cd = concat(central);
    const eocd = concat([
      le32(0x06054B50), le16(0), le16(0), le16(files.length), le16(files.length),
      le32(cd.length), le32(offset), le16(0),
    ]);
    return new Blob([...chunks, cd, eocd], { type: 'application/zip' });
  }

  return { build };
})();

console.log('[load] zip.js');
