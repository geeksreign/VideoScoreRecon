// 片段微调页（扩展源顶层页）：接收提取产出的保留帧 PNG，
// 支持 删除/就地复制/上下移/撤销 后「重新合并」——合并复用产线 VSR.Stitcher（worker cmd:'stitch'）。
//
// 数据链：content 把 crops 发 background 存储 → background 用 tabs.create 打开本页
// （直导航 chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦）→ 本页向 background
// 回取 crops。测试/独立使用：window.VSREditor.load(crops) 直接注入。
(() => {
  const state = {
    items: [],    // {png: ArrayBuffer, width, height, frame, uid}
    hist: [],     // 撤销栈（数组浅拷贝快照，元素不可变 → 零成本）
    urls: [],     // 卡片缩略图 objectURL（重渲染前统一释放）
    resultUrls: [],   // 合并结果 objectURL
    uid: 1,
    merging: false,
  };
  const $ = (id) => document.getElementById(id);

  function setStatus(msg) { $('ed-status').textContent = msg; }
  function revoke(list) { for (const u of list) URL.revokeObjectURL(u); list.length = 0; }

  function render() {
    const strip = $('ed-strip');
    revoke(state.urls);
    strip.innerHTML = '';
    state.items.forEach((it, idx) => {
      const url = URL.createObjectURL(new Blob([it.png], { type: 'image/png' }));
      state.urls.push(url);
      const card = document.createElement('div');
      card.className = 'ed-card';
      card.dataset.idx = String(idx);
      const head = document.createElement('div');
      head.className = 'ed-card-head';
      head.textContent = `#${idx + 1} · 帧 ${it.frame}`;
      const img = document.createElement('img');
      img.src = url;
      img.alt = `片段 ${idx + 1}`;
      const btns = document.createElement('div');
      btns.className = 'ed-card-btns';
      const mk = (act, text, cls) => {
        const b = document.createElement('button');
        b.dataset.act = act;
        b.textContent = text;
        if (cls) b.className = cls;
        b.addEventListener('click', () => onAction(act, idx));
        btns.appendChild(b);
      };
      mk('up', '↑');
      mk('down', '↓');
      mk('dup', '复制');
      mk('del', '删除', 'ed-danger');
      card.appendChild(head);
      card.appendChild(img);
      card.appendChild(btns);
      strip.appendChild(card);
    });
    $('ed-count').textContent = `(${state.items.length} 张)`;
    $('ed-undo').disabled = state.hist.length === 0;
    $('ed-merge').disabled = state.items.length === 0 || state.merging;
  }

  function snapshot() {
    state.hist.push(state.items.slice());
    if (state.hist.length > 50) state.hist.shift();
  }

  function onAction(act, idx) {
    const it = state.items[idx];
    if (!it) return;
    // 先校验再快照：无效操作（首位上移/末位下移）不污染撤销栈
    if ((act === 'up' && idx === 0) || (act === 'down' && idx === state.items.length - 1)) return;
    snapshot();
    if (act === 'del') state.items.splice(idx, 1);
    else if (act === 'dup') state.items.splice(idx + 1, 0, { ...it, uid: state.uid++ });
    else if (act === 'up') { state.items.splice(idx, 1); state.items.splice(idx - 1, 0, it); }
    else if (act === 'down') { state.items.splice(idx, 1); state.items.splice(idx + 1, 0, it); }
    render();
  }

  // ---------- 合并（worker cmd:'stitch'，与产线同语义） ----------
  let worker = null;

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('src/worker.js');   // 与本页同源（扩展源/测试服务器均成立）
    worker.onmessage = (e) => onWorkerMsg(e.data);
    worker.onerror = (e) => {
      state.merging = false;
      render();
      setStatus(`❌ worker: ${(e && e.message) || e}`);
    };
    return worker;
  }

  function onWorkerMsg(m) {
    if (m.type === 'progress') {
      setStatus(`${m.stage}: ${m.message} (${Math.round((m.progress || 0) * 100)}%)`);
      return;
    }
    if (m.type === 'error') {
      state.merging = false;
      render();
      setStatus('❌ ' + m.message);
      return;
    }
    if (m.type === 'done') {
      state.merging = false;
      showResult(m);
      render();
    }
    // 其余（debug 等）忽略
  }

  function showResult(m) {
    const segs = m.segments || [];
    if (!segs.length) {
      setStatus('❌ 合并结果为空');
      return;
    }
    revoke(state.resultUrls);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const dl = $('ed-downloads');
    dl.innerHTML = '';
    segs.forEach((s, idx) => {
      const url = URL.createObjectURL(new Blob([s.buffer], { type: 'image/png' }));
      state.resultUrls.push(url);
      if (idx === 0) $('ed-result-img').src = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = `score_${stamp}${segs.length > 1 ? `_p${idx + 1}` : ''}.png`;
      a.textContent = segs.length > 1
        ? `下载分段 ${idx + 1}/${segs.length}（${s.height}px，帧 ${s.from}-${s.to}）`
        : `下载拼接图（${s.width}x${s.height}）`;
      dl.appendChild(a);
    });
    $('ed-result').classList.add('ed-visible');
    setStatus(`✅ 合并完成：${segs.length} 段输出（基于当前 ${state.items.length} 个片段）`);
  }

  function merge() {
    if (state.merging || !state.items.length) return;
    state.merging = true;
    render();
    setStatus('合并中…（首次需加载引擎，约几秒）');
    ensureWorker().postMessage({
      cmd: 'stitch',
      // 不转移：克隆发送，state.items 保留可再次编辑/合并
      crops: state.items.map(({ png, width, height, frame }) => ({ png, width, height, frame })),
    });
  }

  // ---------- 数据载入 ----------
  function load(crops) {
    if (!crops || !crops.length) {
      setStatus('⚠️ 没有可编辑的片段数据（该次提取未保留任何片段）');
      return;
    }
    revoke(state.resultUrls);
    $('ed-result').classList.remove('ed-visible');
    $('ed-downloads').innerHTML = '';
    state.items = crops.map((c) => ({
      png: c.png, width: c.width, height: c.height, frame: c.frame, uid: state.uid++,
    }));
    state.hist = [];
    render();
    setStatus(`已载入 ${state.items.length} 个片段：可删除/复制/排序，点「重新合并」生成最终图`);
  }

  // ---------- 事件绑定 ----------
  $('ed-undo').addEventListener('click', () => {
    const prev = state.hist.pop();
    if (!prev) return;
    state.items = prev;
    render();
    setStatus('已撤销上一步');
  });
  $('ed-merge').addEventListener('click', merge);
  $('ed-close').addEventListener('click', () => window.close());

  // 自动化测试钩子
  window.VSREditor = { load, getItems: () => state.items.map(({ frame }) => frame) };

  render();
  // 扩展源启动：数据由 background 中转（content 先存、tabs.create 打开本页、本页回取）。
  // 网页/地址栏直导航 chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦，故不用 opener。
  if (typeof chrome !== 'undefined' && chrome.runtime
    && typeof chrome.runtime.sendMessage === 'function') {
    setStatus('正在载入片段…');
    try {
      chrome.runtime.sendMessage({ type: 'vsr-editor-get' }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) { setStatus('❌ 获取片段失败: ' + err.message); return; }
        if (resp && resp.crops && resp.crops.length) {
          load(resp.crops);
        } else {
          setStatus('没有待编辑的片段——请先在提取结果页完成一次提取，再点「✂️ 微调片段后合并」');
        }
      });
    } catch (e) { setStatus('❌ ' + ((e && e.message) || e)); }
  } else {
    setStatus('请在提取结果页点「✂️ 微调片段后合并」进入（测试可经 VSREditor.load 注入）');
  }
})();
