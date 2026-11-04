// 内容脚本：在 B 站视频页注入“提取乐谱”按钮与面板
(() => {
  const DEFAULT_BASE = 'http://127.0.0.1:8000';

  function getCfg() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['baseUrl', 'token', 'cookie'], (cfg) => {
        resolve({
          baseUrl: cfg.baseUrl || DEFAULT_BASE,
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

  let polling = false;

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
        <label>抽帧间隔（秒，默认 2）</label>
        <input id="se-interval" type="text" value="2">
      </div>
      <div class="se-row">
        <label>去重阈值（差异占比，默认 0.01）</label>
        <input id="se-thresh" type="text" value="0.01">
      </div>
      <div class="se-row">
        <label>B 站 Cookie（SESSDATA，可空，提画质用）</label>
        <input id="se-cookie" type="text" placeholder="SESSDATA=...">
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
        <a id="se-download" href="#" download="score.jpg">下载拼接图</a>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#se-start-btn').addEventListener('click', startExtract);
    panel.querySelector('#se-close-btn').addEventListener('click', togglePanel);
    // 预填 cookie（来自设置）
    getCfg().then((cfg) => { panel.querySelector('#se-cookie').value = cfg.cookie || ''; });
    // 打开时探测服务状态
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
    const r = await api('/api/health').catch(() => ({ ok: false }));
    if (r.ok) {
      setStatus('✅ 本地服务已连接');
    } else {
      setStatus('⚠️ 本地服务未连接。请先在终端启动：\ncd src && uv run python -m server\n并在设置页填写 Token。');
    }
  }

  async function startExtract() {
    if (polling) return;
    const p = document.getElementById('score-ext-panel');
    const payload = {
      url: location.href,
      start_time: parseTime(p.querySelector('#se-start').value),
      end_time: parseTime(p.querySelector('#se-end').value),
      interval_sec: parseFloat(p.querySelector('#se-interval').value) || 2,
      dedup_threshold: parseFloat(p.querySelector('#se-thresh').value) || 0.01,
      cookie: p.querySelector('#se-cookie').value.trim() || undefined,
    };
    document.getElementById('se-result').classList.remove('se-visible');
    setStatus('提交任务...');
    const r = await api('/api/extract', { method: 'POST', body: JSON.stringify(payload) });
    if (!r.ok) {
      setStatus(`提交失败 (${r.status}): ${(r.data && r.data.detail) || '未知错误'}`);
      return;
    }
    setStatus(`已提交，任务 ${r.data.job_id}`);
    poll(r.data.job_id);
  }

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
    const resultEl = document.getElementById('se-result');
    resultEl.querySelector('#se-result-img').src = url;
    const a = resultEl.querySelector('#se-download');
    a.href = url;
    a.download = `score_${jobId}.jpg`;
    resultEl.classList.add('se-visible');
    setStatus('✅ 完成');
  }

  // 页面加载后注入
  buildUI();
})();
