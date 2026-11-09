// 内容脚本：在 B 站视频页注入“提取乐谱”按钮与面板
//
// 纯浏览器本机处理：acquire 按设置画质取流（默认 480P）→ 扩展 Worker 全流水线
(() => {

  let ctxDead = false;   // 经验证的真失效（扩展被重载/禁用）

  /** 真失效：标记 + 状态提示 + 禁用按钮（幂等） */
  function markCtxDead() {
    if (ctxDead) return;
    ctxDead = true;
    const st = document.getElementById('se-status');
    if (st) st.textContent = '⚠️ 扩展已重载或更新，请刷新本页（当前页面的扩展已失效）';
    const btn = document.getElementById('se-start-btn');
    if (btn) btn.disabled = true;
  }

  /**
   * 断连检测（MV3 关键坑）：静默 keepalive port 会随 service worker 空闲停机
   * （~30s）而断开——这不等于扩展失效，直接判死会误禁用按钮（提取成功后再点
   * 「开始提取」无反应）。断开时先用一次轻量 API 往返定性：
   *   - 同步抛 context invalidated / lastError → 真失效 → markCtxDead()
   *   - 正常回调 → 仅 SW 停机 → 退避后静默重连（重连即唤醒 SW，不碰 UI）
   */
  function connectKeepalive() {
    let port;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime
        || typeof chrome.runtime.connect !== 'function') return;
      port = chrome.runtime.connect({ name: 'vsr-keepalive' });
    } catch (e) { markCtxDead(); return; }
    port.onDisconnect.addListener(() => {
      if (ctxDead) return;
      const verify = () => {
        try {
          if (typeof chrome.runtime.getPlatformInfo !== 'function') {
            setTimeout(reconnect, 1000);   // stub 环境：静默重连
            return;
          }
          chrome.runtime.getPlatformInfo(() => {
            if (chrome.runtime.lastError) { markCtxDead(); return; }
            setTimeout(reconnect, 1000);   // 扩展健在：SW 停机误断，静默重连
          });
        } catch (e2) { markCtxDead(); }    // 同步抛 = 上下文已死
      };
      const reconnect = () => {
        if (ctxDead) return;
        connectKeepalive();
      };
      verify();
    });
  }
  connectKeepalive();

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
        chrome.storage.local.get(['quality', 'interval'], (cfg) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(ctxErr(new Error(err.message))); return; }
          resolve({
            quality: cfg.quality || '480',   // 设置页「视频画质」，未设置=480P
            interval: cfg.interval || '',    // 设置页「抽帧间隔」，空=默认2.5s
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

  // 抽帧间隔解析：合法正数（秒，≥0.1）生效，空/非法回退默认 2.5
  function parseInterval(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0.1 ? n : 2.5;
  }

  let polling = false;
  const resultUrls = [];   // 本次展示占用的 Blob URL，下次运行前统一释放
  let lastKeptCrops = null;   // 最近一次提取的保留帧 PNG（编辑器微调数据源）

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
      <div class="se-row se-times">
        <div class="se-time">
          <label>开始时间</label>
          <input id="se-start" type="text" value="0:00">
        </div>
        <div class="se-time">
          <label>结束时间</label>
          <input id="se-end" type="text" placeholder="留空=到结尾">
        </div>
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
  }

  /** 秒 → `m:ss` / `h:mm:ss`（向上取整，保证自动值覆盖全片） */
  function fmtTime(sec) {
    const t = Math.ceil(sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  /**
   * 视频时长（秒）：优先取播放器 video 元数据（零请求），
   * 回退 acquire 的 B 站 view API；都拿不到返回 null（结束留空=到结尾）。
   */
  async function videoDurationSec() {
    try {
      const v = document.querySelector('video');
      if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
    } catch (e) { /* ignore */ }
    try {
      const A = window.VSRAcquire;
      if (A && typeof A.getVideoInfo === 'function') {
        const { bvid, page } = A.parseUrl(location.href);
        const info = await A.getVideoInfo(bvid, page);
        if (info && info.duration > 0) return info.duration;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * 自动填结束时间=视频时长（mm:ss）。
   * dataset.auto 守卫：用户手动改过的值重开面板不覆盖，仅空值/仍为上次自动值时刷新。
   */
  function fillEndTime() {
    videoDurationSec().then((sec) => {
      if (sec == null) return;
      const el = document.getElementById('se-end');
      if (!el || el.value && el.value !== el.dataset.auto) return;
      el.value = fmtTime(sec);
      el.dataset.auto = el.value;
    }).catch(() => { /* 时长取不到保持留空 */ });
  }

  function togglePanel() {
    const panel = document.getElementById('score-ext-panel');
    const open = panel.classList.toggle('se-open');
    if (open) fillEndTime();
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

  async function startExtract() {
    if (polling) {
      setStatus('⏳ 上一次提取仍在进行中…');
      return;
    }
    removeGrantBtn();
    setStatus('准备开始…');   // 首个 await 之前的即时反馈（任何异常都有前置状态）
    try {
      const cfg = await getCfg();
      document.getElementById('se-result').classList.remove('se-visible');
      releaseResultUrls();
      lastKeptCrops = null;
      document.getElementById('se-downloads').innerHTML = '';
      await localExtract(cfg);
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

  // ---------- 提取流水线 ----------
  async function localExtract(cfg) {
    polling = true;
    const p = document.getElementById('score-ext-panel');
    const params = {
      startTime: parseTime(p.querySelector('#se-start').value),
      endTime: parseTime(p.querySelector('#se-end').value),
      intervalSec: parseInterval(cfg.interval),   // 设置页 storage.interval，空=2.5
      dedupThreshold: 0.01,      // 去重阈值默认值（面板不再暴露）
    };
    try {
      setStatus('获取视频流...');
      const acq = await window.VSRAcquire.acquire(
        location.href,
        (stage, prog, msg) => setProgress(stage, prog, msg),
        { quality: (cfg && cfg.quality) || '480' });
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

  /**
   * 打开片段微调页：数据与打开都交给 background（MessagePort 存 crops →
   * tabs.create 新标签 → 编辑页回取）。两个关键点：
   * - 打开必须走扩展 API（直导航 chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦）
   * - 二进制必须走 port（runtime.sendMessage 是 JSON 化的，ArrayBuffer 会丢字节）
   * png 以 base64 过通道（扩展消息=JSON），本页数据不动、可重复打开。
   */
  function openEditor() {
    if (!lastKeptCrops || !lastKeptCrops.length) return;
    let settled = false;
    try {
      const port = chrome.runtime.connect({ name: 'vsr-editor-payload' });
      const finish = (m) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        if (m && m.ack) setStatus('已在新标签页打开微调页…');
        else setStatus('❌ 打开微调页失败: '
          + ((m && m.error) || 'background 无响应（端口断开）'));
      };
      port.onMessage.addListener(finish);
      port.onDisconnect.addListener(() => finish(null));
      // Port=JSON 序列化（transfer 不生效）→ png 编码 base64 过通道；
      // lastKeptCrops 原数据不动，可重复打开
      const crops64 = lastKeptCrops.map((c) => ({
        width: c.width, height: c.height, frame: c.frame,
        png: VSRB64.encode(new Uint8Array(c.png)),
      }));
      port.postMessage({ crops: crops64 });
    } catch (e) {
      setStatus('❌ ' + ctxErr(e).message);
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
        ? `下载 ${idx + 1}/${segs.length}`
        : '下载';
      dl.appendChild(a);
    });
    // 手动调整入口（keptCrops 非空时出现）
    if (result.keptCrops && result.keptCrops.length) {
      lastKeptCrops = result.keptCrops;
      const editBtn = document.createElement('button');
      editBtn.id = 'se-edit-btn';
      editBtn.textContent = `✂️ 手动调整片段（${result.keptCrops.length} 张）`;
      editBtn.addEventListener('click', openEditor);
      dl.appendChild(editBtn);
    } else {
      lastKeptCrops = null;
    }
    document.getElementById('se-result').classList.add('se-visible');
    setStatus(`✅ 完成：保留 ${result.saved} 张，去重 ${result.skipped} 张`
      + (segs.length > 1 ? `，分 ${segs.length} 段输出` : ''));
  }

  // 页面加载后注入
  buildUI();
})();
