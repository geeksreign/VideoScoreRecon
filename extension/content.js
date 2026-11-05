// 内容脚本：在 B 站视频页注入“提取乐谱”按钮与面板
//
// 双模式（options 页 baseUrl 决定）：
//   - baseUrl 留空（默认）= 纯浏览器本地：acquire 双通道取流 → 扩展 Worker 全流水线
//   - baseUrl 非空 = 高级：交给本地 Python 服务（老流程）
(() => {
  const DEFAULT_BASE = '';   // '' = 本地模式

  let ctxDead = false;   // 扩展被重载/禁用后为 true（keepalive port 断开）

  // 断连检测：扩展重载/更新/禁用时 Chrome 主动断开该 port —— 这是 content
  // script 侧唯一可靠的上下文失效信号，早于任何 chrome.* API 抛错。
  (function keepalive() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime
        || typeof chrome.runtime.connect !== 'function') return;
      const port = chrome.runtime.connect({ name: 'vsr-keepalive' });
      port.onDisconnect.addListener(() => {
        ctxDead = true;
        const st = document.getElementById('se-status');
        if (st) st.textContent = '⚠️ 扩展已重载或更新，请刷新本页（当前页面的扩展已失效）';
        const btn = document.getElementById('se-start-btn');
        if (btn) btn.disabled = true;
      });
    } catch (e) { /* stub/旧环境无 port：忽略 */ }
  })();

  /** chrome.* 抛「Extension context invalidated」时转成可读错误 */
  function ctxErr(e) {
    const m = (e && e.message) || String(e);
    if (/context invalidated/i.test(m) || ctxDead) {
      return new Error('扩展上下文已失效，请刷新本页（扩展可能刚被重载/更新）');
    }
    return e instanceof Error ? e : new Error(m);
  }

  function getCfg() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(['baseUrl', 'token', 'cookie'], (cfg) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(ctxErr(new Error(err.message))); return; }
          resolve({
            baseUrl: (cfg.baseUrl || DEFAULT_BASE).trim(),
            token: cfg.token || '',
            cookie: cfg.cookie || '',
          });
        });
      } catch (e) { reject(ctxErr(e)); }
    });
  }

  // ---------- 可选宽权限（optional_host_permissions *://*/*）----------
  // 平时不申请；仅当下载全部失败且未持全网权限时，面板出「授权并重试」按钮。
  // chrome.permissions.request 必须在用户手势栈内同步调用（按钮 click 首段）。
  const BROAD = { origins: ['*://*/*'] };

  function hasPermApi() {
    return typeof chrome !== 'undefined' && chrome.permissions
      && typeof chrome.permissions.request === 'function'
      && typeof chrome.permissions.contains === 'function';
  }

  function removeGrantBtn() {
    const b = document.getElementById('se-grant-btn');
    if (b) b.remove();
  }

  /** @returns {Promise<boolean>} 是否展示了授权重试按钮 */
  async function offerGrantRetry() {
    if (!hasPermApi()) return false;
    let granted = false;
    try { granted = await chrome.permissions.contains(BROAD); } catch (e) { /* ignore */ }
    if (granted) return false;
    if (document.getElementById('se-grant-btn')) return true;
    const btn = document.createElement('button');
    btn.id = 'se-grant-btn';
    btn.textContent = '🔓 授权全网访问并重试';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      let ok = false;
      try { ok = await chrome.permissions.request(BROAD); } catch (e) { /* ignore */ }
      removeGrantBtn();
      if (ok) {
        setStatus('已授权，重新开始…');
        startExtract();
      } else {
        setStatus('未授权：仍只能访问已授权的 CDN 域名，可修改设置页授权后重试');
      }
    });
    document.querySelector('#score-ext-panel .se-actions').appendChild(btn);
    return true;
  }

  async function api(path, opts = {}) {
    const cfg = await getCfg();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (cfg.token) headers['X-Auth-Token'] = cfg.token;
    const r = await fetch(cfg.baseUrl + path, Object.assign({ headers }, opts));
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  }

  function parseTime(v) {
    const s = String(v).trim();
    if (!s) return undefined;
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return parseFloat(s);
  }

  // 数值解析：合法数字（含 0）生效，空/非法回退默认值
  function num(v, def) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  }

  let polling = false;
  const resultUrls = [];   // 本次展示占用的 Blob URL，下次运行前统一释放

  function releaseResultUrls() {
    for (const u of resultUrls) URL.revokeObjectURL(u);
    resultUrls.length = 0;
  }

  function buildUI() {
    if (document.getElementById('score-ext-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'score-ext-btn';
    btn.textContent = '🎼 提取乐谱';
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'score-ext-panel';
    panel.innerHTML = `
      <h3>🎼 视频乐谱提取器</h3>
      <div class="se-row">
        <label>当前视频 URL</label>
        <input id="se-url" type="text" readonly value="${location.href}">
      </div>
      <div class="se-row">
        <label>开始时间（秒或 mm:ss，可空）</label>
        <input id="se-start" type="text" placeholder="例如 30 或 0:30">
      </div>
      <div class="se-row">
        <label>结束时间（秒或 mm:ss，可空）</label>
        <input id="se-end" type="text" placeholder="例如 60 或 1:00">
      </div>
      <div class="se-row">
        <label>抽帧间隔（秒，默认 2.5）</label>
        <input id="se-interval" type="text" value="2.5">
      </div>
      <div class="se-row">
        <label>去重阈值（差异占比，默认 0.01）</label>
        <input id="se-thresh" type="text" value="0.01">
      </div>
      <div class="se-row">
        <label>B 站 Cookie（SESSDATA，可空，提画质用）</label>
        <input id="se-cookie" type="text" placeholder="SESSDATA 值（可带或不带 SESSDATA= 前缀）">
      </div>
      <div class="se-status" id="se-status"></div>
      <div class="se-bar-wrap" id="se-bar-wrap">
        <div class="se-bar" id="se-bar"></div>
      </div>
      <div class="se-actions">
        <button id="se-start-btn">开始提取</button>
        <button id="se-close-btn">关闭</button>
      </div>
      <div id="se-result">
        <img id="se-result-img" alt="提取结果">
        <div id="se-downloads"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#se-start-btn').addEventListener('click', startExtract);
    panel.querySelector('#se-close-btn').addEventListener('click', togglePanel);
    getCfg()
      .then((cfg) => { panel.querySelector('#se-cookie').value = cfg.cookie || ''; })
      .catch((e) => setStatus('⚠️ ' + ctxErr(e).message));
    checkHealth().catch((e) => setStatus('⚠️ ' + ctxErr(e).message));
  }

  function togglePanel() {
    const panel = document.getElementById('score-ext-panel');
    const open = panel.classList.toggle('se-open');
    if (open) {
      panel.querySelector('#se-url').value = location.href;
      checkHealth().catch((e) => setStatus('⚠️ ' + ctxErr(e).message));
    }
  }

  function setStatus(msg) {
    document.getElementById('se-status').textContent = msg;
  }

  function setProgress(stage, progress, message) {
    const wrap = document.getElementById('se-bar-wrap');
    const bar = document.getElementById('se-bar');
    if (stage === 'done' || stage === 'error') {
      wrap.classList.remove('se-visible');
    } else {
      wrap.classList.add('se-visible');
      bar.style.width = `${Math.round(progress * 100)}%`;
    }
    setStatus(`${stage}: ${message || ''} (${Math.round(progress * 100)}%)`);
  }

  async function checkHealth() {
    const cfg = await getCfg();
    if (!cfg.baseUrl) {
      setStatus('✅ 本地引擎模式（全部处理在本机浏览器完成）');
      return;
    }
    const r = await api('/api/health').catch(() => ({ ok: false }));
    if (r.ok) {
      setStatus('✅ 本地服务已连接（高级 HTTP 模式）');
    } else {
      setStatus('⚠️ 本地服务未连接。请先在终端启动：\ncd src && uv run python -m server\n并在设置页填写 Token。');
    }
  }

  async function startExtract() {
    if (polling) return;
    removeGrantBtn();
    try {
      const cfg = await getCfg();
      document.getElementById('se-result').classList.remove('se-visible');
      releaseResultUrls();
      document.getElementById('se-downloads').innerHTML = '';
      if (!cfg.baseUrl) {
        await localExtract();
        return;
      }
      // ---- 高级 HTTP 模式（老流程）----
      const p = document.getElementById('score-ext-panel');
      const payload = {
        url: location.href,
        start_time: parseTime(p.querySelector('#se-start').value),
        end_time: parseTime(p.querySelector('#se-end').value),
        interval_sec: num(p.querySelector('#se-interval').value, 2.5),
        dedup_threshold: num(p.querySelector('#se-thresh').value, 0.01),
        cookie: p.querySelector('#se-cookie').value.trim() || undefined,
      };
      setStatus('提交任务...');
      const r = await api('/api/extract', { method: 'POST', body: JSON.stringify(payload) });
      if (!r.ok) {
        setStatus(`提交失败 (${r.status}): ${(r.data && r.data.detail) || '未知错误'}`);
        return;
      }
      setStatus(`已提交，任务 ${r.data.job_id}`);
      poll(r.data.job_id).catch((e) => setStatus('❌ 失败: ' + ctxErr(e).message));
    } catch (e) {
      // chrome.* API 在扩展被重载后会抛 Extension context invalidated
      setProgress('error', 0, '');
      setStatus('❌ 失败: ' + ctxErr(e).message);
    }
  }

  /**
   * 在隐藏扩展 iframe（worker_host.html，扩展源）里跑流水线 worker。
   * 页面源 content script 直接 new Worker('chrome-extension://...') 会被同源策略拒绝
   * （SecurityError），故经 iframe 中转：content → iframe → worker，消息原路回传。
   * @param {ArrayBuffer} buffer 视频字节（转移给 iframe）
   * @param {object} params 流水线参数
   * @param {(m:object)=>void} onProgressMsg progress 消息回调
   * @returns {Promise<object>} worker done 消息
   */
  function runWorker(buffer, params, onProgressMsg) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'display:none;width:0;height:0;border:0';
      iframe.src = chrome.runtime.getURL('worker_host.html');
      let settled = false;
      const timer = setTimeout(() => finish(reject, new Error('处理超时(10分钟)')), 600000);
      // 看门狗：首条消息前放宽到 240s（iframe 加载 + worker 启动 + opencv/wasm
      // 冷启动，高负载环境可慢至数分钟）；之后 60s 无消息即判死
      let idle = null;
      let gotMsg = false;
      const armIdle = () => {
        clearTimeout(idle);
        const limit = gotMsg ? 60000 : 240000;
        idle = setTimeout(() => finish(reject,
          new Error(`worker ${limit / 1000}秒无响应（可能初始化失败）`)), limit);
      };
      armIdle();
      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(idle);
        window.removeEventListener('message', onMsg);
        iframe.remove();
        fn(arg);
      }
      function onMsg(e) {
        if (e.source !== iframe.contentWindow) return;
        gotMsg = true;
        armIdle();
        const m = e.data || {};
        if (m.type === 'debugimg') {
          // 诊断帧（排查检测问题）：isolated world 的 window 主世界读不到，
          // 挂到共享 DOM 供测试脚本取用
          const el = document.createElement('img');
          el.setAttribute('data-vsr-dbg', String(m.i));
          el.src = m.dataUrl;
          el.style.display = 'none';
          document.documentElement.appendChild(el);
        }
        if (m.type === 'progress') onProgressMsg(m);
        else if (m.type === 'done') finish(resolve, m);
        else if (m.type === 'error') finish(reject, new Error(m.message || 'worker 错误'));
      }
      window.addEventListener('message', onMsg);
      iframe.addEventListener('error', () =>
        finish(reject, new Error('worker 宿主页加载失败')));
      iframe.addEventListener('load', () => {
        console.log('[vsr] iframe load, sending run');
        iframe.contentWindow.postMessage({ cmd: 'run', buffer, params }, '*', [buffer]);
      });
      console.log('[vsr] iframe appended');
      document.body.appendChild(iframe);
    });
  }

  // ---------- 本地模式 ----------
  async function localExtract() {
    polling = true;
    const p = document.getElementById('score-ext-panel');
    const params = {
      startTime: parseTime(p.querySelector('#se-start').value),
      endTime: parseTime(p.querySelector('#se-end').value),
      intervalSec: num(p.querySelector('#se-interval').value, 2.5),
      dedupThreshold: num(p.querySelector('#se-thresh').value, 0.01),
    };
    try {
      setStatus('获取视频流...');
      const acq = await window.VSRAcquire.acquire(location.href, (stage, prog, msg) =>
        setProgress(stage, prog, msg));
      setProgress('download', 1, `视频就绪（${acq.channel}: ${acq.label}）`);

      const result = await runWorker(acq.buffer, params, (m) =>
        setProgress(m.stage, m.progress, m.message));
      showLocalResult(result, params);
    } catch (e) {
      setProgress('error', 0, '');
      const msg = ctxErr(e).message;
      let hint = '';
      if (msg.includes('所有下载源均失败')) {
        if (await offerGrantRetry()) {
          hint = '\n可点下方「🔓 授权全网访问并重试」';
        } else if (!hasPermApi()) {
          hint = '\n提示：可在扩展设置页授权「全网访问」后重试';
        }
      }
      setStatus(`❌ 失败: ${msg}${hint}`);
    } finally {
      polling = false;
    }
  }

  function showLocalResult(result, params) {
    const segs = result.segments || [];
    if (!segs.length) {
      setStatus('❌ 未检测到任何乐谱区域');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const dl = document.getElementById('se-downloads');
    dl.innerHTML = '';
    segs.forEach((s, idx) => {
      const blob = new Blob([s.buffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      resultUrls.push(url);
      if (idx === 0) {
        document.getElementById('se-result-img').src = url;
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = `score_${stamp}${segs.length > 1 ? `_p${idx + 1}` : ''}.png`;
      a.textContent = segs.length > 1
        ? `下载分段 ${idx + 1}/${segs.length}（${s.height}px，帧 ${s.from}-${s.to}）`
        : `下载拼接图（${s.width}x${s.height}）`;
      dl.appendChild(a);
    });
    document.getElementById('se-result').classList.add('se-visible');
    setStatus(`✅ 完成：保留 ${result.saved} 张，去重 ${result.skipped} 张`
      + (segs.length > 1 ? `，分 ${segs.length} 段输出` : ''));
  }

  // ---------- 高级 HTTP 模式 ----------
  async function poll(jobId) {
    polling = true;
    try {
      for (;;) {
        const r = await api(`/api/progress/${jobId}`);
        if (!r.ok) {
          setStatus(`查询失败 (${r.status})`);
          break;
        }
        const d = r.data;
        setProgress(d.stage, d.progress, d.message);
        if (d.done) {
          if (d.stage === 'error') {
            setStatus(`❌ 失败: ${d.error}`);
          } else {
            setStatus('✅ 完成，正在加载结果...');
            await showResult(jobId);
          }
          break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    } finally {
      polling = false;
    }
  }

  async function showResult(jobId) {
    const cfg = await getCfg();
    const r = await fetch(cfg.baseUrl + '/api/result/' + jobId, {
      headers: cfg.token ? { 'X-Auth-Token': cfg.token } : {},
    });
    if (!r.ok) {
      setStatus(`获取结果失败 (${r.status})`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    resultUrls.push(url);
    const resultEl = document.getElementById('se-result');
    resultEl.querySelector('#se-result-img').src = url;
    const dl = document.getElementById('se-downloads');
    dl.innerHTML = '';
    const a = document.createElement('a');
    a.href = url;
    a.download = `score_${jobId}.png`;
    a.textContent = '下载拼接图';
    dl.appendChild(a);
    resultEl.classList.add('se-visible');
    setStatus('✅ 完成');
  }

  // 页面加载后注入
  buildUI();
})();
