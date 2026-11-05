// 隐藏 iframe 宿主（扩展源）：parent ↔ 本页 ↔ worker 双向消息转发。
//
// 为何需要：页面源 content script 执行 new Worker('chrome-extension://...') 会抛
// SecurityError（worker 脚本必须与创建者同源），即使该资源在 web_accessible_resources
// 中（fetch 可 200，Worker 构造不行）。本页与 src/worker.js 同源，构造不受限。
//
// 协议：parent → {cmd:'run',buffer,params} / {cmd:'cancel'}
//       parent ← worker 原样消息（progress/debug/error/done），done 的 segments 分块转移
(function () {
  console.log('[vsr] host page loaded');
  let worker = null;

  function sendToParent(msg, transfer) {
    // 跨源父页（bilibili.com），targetOrigin 用 '*'
    try { parent.postMessage(msg, '*', transfer || []); } catch (e) { console.log('[vsr] fwd THROW ' + e); }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;   // 只接受宿主页消息
    const m = e.data || {};
    if (m.cmd === 'run') {
      if (worker) { try { worker.terminate(); } catch (err) { /* ignore */ } }
      try {
        console.log('[vsr] host creating worker');
      worker = new Worker('src/worker.js');   // 相对本页解析 → 扩展源，同源 ✓
      } catch (err) {
        sendToParent({ type: 'error', message: '创建 worker 失败: ' + ((err && err.message) || err) });
        return;
      }
      worker.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.type === 'done') {
          sendToParent(d, (d.segments || []).map((s) => s.buffer));
        } else {
          sendToParent(d);
        }
      };
      worker.onerror = (ev) => {
        // 带上文件/行号便于定位（EvalError/CSP 类问题常需源文件坐标）
        const where = ev && ev.filename
          ? ` @${String(ev.filename).slice(-80)}:${ev.lineno}:${ev.colno}` : '';
        sendToParent({ type: 'error', message: ((ev && ev.message) || 'worker 运行错误') + where });
      };
      worker.postMessage({ cmd: 'run', buffer: m.buffer, params: m.params }, [m.buffer]);
    } else if (m.cmd === 'cancel' && worker) {
      worker.postMessage({ cmd: 'cancel' });
    }
  });

  // 本页（iframe）自身的未捕获错误/未处理拒绝也回传宿主，避免静默挂死
  window.addEventListener('error', (e) => {
    sendToParent({
      type: 'error',
      message: `iframe ${(e && e.message) || '错误'} @${String((e && e.filename) || '').slice(-80)}:${(e && e.lineno) || 0}`,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    sendToParent({ type: 'error', message: `iframe rejection: ${(e && e.reason) || ''}` });
  });
})();
