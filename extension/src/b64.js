// ArrayBuffer/Uint8Array ↔ base64
// 扩展 runtime.sendMessage 与 runtime.Port 消息均按 JSON 序列化（postMessage 的
// transfer 参数不生效）——二进制必须以 base64 字符串过通道，否则会变 {} 丢字节
// （曾致微调页缩略图全部空白、vsr-download 层③分块隐患）。
// 引用方：content.js（crops 交接）、editor.js（回取解码）、background.js（层③分块）、
// acquire.js（层③收包）；manifest content_scripts / editor.html / importScripts 加载。
(function (g) {
  function encode(bytes) {
    let s = '';
    const CH = 0x8000;   // 分块避免超长参数栈
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function decode(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  g.VSRB64 = { encode, decode };
})(typeof self !== 'undefined' ? self : globalThis);
