// 点击工具栏图标打开设置页
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ---- 片段微调页：数据中转 + 由扩展 API 发起打开 ----
// 网页发起/地址栏直导航 chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦截
// （实测连地址栏都拦），而 openOptionsPage/tabs.create 这类 API 发起的页面创建
// 不受影响（设置页正常）——故打开与片段数据都收进 background。
// 协议：content → {type:'vsr-editor-payload', crops}（存+建标+回执）
//       editor  → {type:'vsr-editor-get'} （同步取回 crops）
let editorPayload = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'vsr-editor-payload') {
    editorPayload = Array.isArray(msg.crops) ? msg.crops : null;
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') }, (tab) => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, error: err.message }
        : { ok: true, tabId: tab && tab.id });
    });
    return true;   // 异步回执
  }
  if (msg.type === 'vsr-editor-get') {
    sendResponse({ crops: editorPayload });
    // 同步回执
  }
});

// 端口流式下载（content.js/acquire.js 层③兜底）：扩展源 + host_permissions 豁免 CORS，
// 不受页面源/混合内容限制；分块回传同时保持 MV3 SW 不被 idle 回收。
// 协议：content → {type:'fetch',url}；SW → progress(节流)/chunk(转移)/done/error
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
        // Uint8Array 视图未必覆盖整个 buffer，精确等长才转移，否则复制
        const exact = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength;
        const buf = exact ? value.buffer : new Uint8Array(value).buffer;
        if (!post({ type: 'chunk', buf }, [buf])) { reader.cancel(); return; }
      }
      post({ type: 'progress', done, total });
      post({ type: 'done' });
    } catch (e) {
      post({ type: 'error', message: (e && e.message) || String(e) });
    }
  });
});
