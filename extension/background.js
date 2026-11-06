importScripts('src/b64.js');   // base64 工具（扩展消息=JSON，二进制必须编码）

// 点击工具栏图标打开设置页
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ---- 片段微调页：数据中转 + 由扩展 API 发起打开 ----
// 网页/地址栏直导航 chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦截（实测连地址栏
// 都拦），而 openOptionsPage/tabs.create 这类 API 发起的页面创建不受影响 → 打开走 tabs.create。
// 二进制载荷必须 base64：扩展 runtime/Port 消息按 JSON 序列化（postMessage 的
// transfer 参数不生效，实测 ArrayBuffer 到 SW 即变 {} → 缩略图空白）。
// 协议：content →(port vsr-editor-payload){crops: b64形态}→ 存+建标+{ack}
//       editor  →(port vsr-editor){type:'get'}→ {crops: b64形态}（字符串可反复回取）
let editorPayload = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'vsr-editor-payload') {
    port.onMessage.addListener((m) => {
      editorPayload = (m && Array.isArray(m.crops)) ? m.crops : null;
      chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') }, (tab) => {
        const err = chrome.runtime.lastError;
        port.postMessage(err ? { error: err.message } : { ack: true, tabId: tab && tab.id });
      });
    });
    return;
  }
  if (port.name === 'vsr-editor') {
    port.onMessage.addListener((m) => {
      if (m && m.type === 'get') port.postMessage({ crops: editorPayload });
    });
  }
});

// 端口流式下载（content.js/acquire.js 层③兜底）：扩展源 + host_permissions 豁免 CORS，
// 不受页面源/混合内容限制；分块回传同时保持 MV3 SW 不被 idle 回收。
// 协议：content → {type:'fetch',url}；SW → progress(节流)/chunk(base64)/done/error
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vsr-download') return;
  let alive = true;
  port.onDisconnect.addListener(() => { alive = false; });

  port.onMessage.addListener(async (m) => {
    if (!m || m.type !== 'fetch' || !alive) return;
    const post = (msg, transfer) => {
      if (!alive) return false;
      try { port.postMessage(msg, transfer || []); return true; }
      catch (e) { alive = false; return false; }
    };
    try {
      const r = await fetch(m.url, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!r.body) throw new Error('无响应体');
      const total = parseInt(r.headers.get('Content-Length') || '0', 10);
      const reader = r.body.getReader();
      let done = 0;
      let lastReport = 0;
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        done += value.length;
        const now = Date.now();
        if (now - lastReport >= 200) {
          lastReport = now;
          if (!post({ type: 'progress', done, total })) { reader.cancel(); return; }
        }
        // Port=JSON 序列化（transfer 不生效）→ 分块 base64 传输（修层③真实二进制通路）
        if (!post({ type: 'chunk', b64: VSRB64.encode(value) })) { reader.cancel(); return; }
      }
      post({ type: 'progress', done, total });
      post({ type: 'done' });
    } catch (e) {
      post({ type: 'error', message: (e && e.message) || String(e) });
    }
  });
});
