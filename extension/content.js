// 内容脚本：在 B 站视频页注入“提取乐谱”按钮与面板
//
// 双模式（options 页 baseUrl 决定）：
//   - baseUrl 留空（默认）= 纯浏览器本地：acquire 双通道取流 → 扩展 Worker 全流水线
//   - baseUrl 非空 = 高级：交给本地 Python 服务（老流程）
(() => {
  const DEFAULT_BASE = '';   // '' = 本地模式

  function getCfg() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['baseUrl', 'token', 'cookie'], (cfg) => {
        resolve({
          baseUrl: (cfg.baseUrl || DEFAULT_BASE).trim(),
          token: cfg.token || '',
          cookie: cfg.cookie || '',
        });
      });
    });
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
    getCfg().then((cfg) => { panel.querySelector('#se-cookie').value = cfg.cookie || ''; });
    checkHealth();
  }

  function togglePanel() {
    const panel = document.getElementById('score-ext-panel');
    const open = panel.classList.toggle('se-open');
    if (open) {
      panel.querySelector('#se-url').value = location.href;
      checkHealth();
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
    poll(r.data.job_id);
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

      const worker = new Worker(chrome.runtime.getURL('src/worker.js'));
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('处理超时(10分钟)')), 600000);
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') setProgress(m.stage, m.progress, m.message);
          else if (m.type === 'done') { clearTimeout(timer); resolve(m); }
          else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(`worker: ${e.message || e}`));
        };
        worker.postMessage(
          { cmd: 'run', buffer: acq.buffer, params },
          [acq.buffer]);
      });
      worker.terminate();
      showLocalResult(result, params);
    } catch (e) {
      setProgress('error', 0, '');
      setStatus(`❌ 失败: ${e && e.message || e}`);
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
