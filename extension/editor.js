// 片段微调页（扩展源顶层页）：接收提取产出的保留帧 PNG，
// 支持 删除/就地复制/上下移/撤销 后「重新合并」——合并复用产线 VSR.Stitcher（worker cmd:'stitch'）。
//
// 数据链：content 经 MessagePort 把 crops 交 background 存储（runtime.sendMessage 是
// JSON 化的会丢 ArrayBuffer 字节）→ background 用 tabs.create 打开本页（直导航
// chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦）→ 本页经 MessagePort 回取。
// 测试/独立使用：window.VSREditor.load(crops) 直接注入。
(() => {
  const state = {
    items: [],    // {png: ArrayBuffer, width, height, frame, uid}
    hist: [],     // 撤销栈（数组浅拷贝快照，元素不可变 → 零成本）
    urls: [],     // 卡片缩略图 objectURL（重渲染前统一释放）
    resultUrls: [],   // 合并结果 objectURL
    uid: 1,
    merging: false,
    confirmedPageSize: null,   // 上次成功合并使用的每页片段数（null=全部一页）
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
      render();
      showResult(m).catch((e) => setStatus('❌ ' + ((e && e.message) || e)));
    }
    // 其余（debug 等）忽略
  }

  async function showResult(m) {
    const segs = m.segments || [];
    if (!segs.length) {
      setStatus('❌ 合并结果为空');
      return;
    }
    revoke(state.resultUrls);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const dl = $('ed-downloads');
    dl.innerHTML = '';
    // 预览始终用第 1 页
    const firstUrl = URL.createObjectURL(new Blob([segs[0].buffer], { type: 'image/png' }));
    state.resultUrls.push(firstUrl);
    $('ed-result-img').src = firstUrl;
    if (segs.length === 1) {
      const a = document.createElement('a');
      a.href = firstUrl;
      a.download = `score_${stamp}.png`;
      a.textContent = '下载';
      dl.appendChild(a);
    } else {
      // 多页 → 一个 zip 一次下载全部页
      const files = segs.map((s, idx) => ({
        name: `score_${stamp}_p${idx + 1}.png`, buffer: s.buffer,
      }));
      const zipUrl = URL.createObjectURL(VSRZip.build(files));
      state.resultUrls.push(zipUrl);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `score_${stamp}.zip`;
      a.textContent = `下载（${segs.length} 页）`;
      dl.appendChild(a);
    }
    const total = state.items.length;
    state.confirmedPageSize = m.pageSize || null;
    const confirmed = state.confirmedPageSize || null;
    const cur = readPageSize();
    $('ed-result').classList.add('ed-visible');
    const body = $('ed-result-body');
    if (cur === confirmed) {
      body.classList.add('ed-visible');
      setStatus(m.pageSize
        ? `✅ 合并完成：${segs.length} 页（每页 ${m.pageSize} 个片段，共 ${total} 个）`
        : `✅ 合并完成：${segs.length} 段输出（基于当前 ${total} 个片段）`);
    } else {
      // 合并期间输入被改动：结果先不展示，等确认
      body.classList.remove('ed-visible');
      $('ed-downloads').innerHTML = '';
      setStatus('已修改每页片段数，点「确认」后重新分页');
    }
  }

  function readPageSize() {
    const n = parseInt(($('ed-page-size').value || '').trim(), 10);
    if (!(Number.isInteger(n) && n > 0)) return null;
    // 填 n >= 总片段数 = 全部一页（worker 侧语义一致，null 即单页）
    if (state.items.length && n >= state.items.length) return null;
    return n;
  }

  function merge() {
    if (state.merging || !state.items.length) return;
    state.merging = true;
    render();
    setStatus('合并中…（首次需加载引擎，约几秒）');
    ensureWorker().postMessage({
      cmd: 'stitch',
      pageSize: readPageSize(),
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
    $('ed-page-size').value = '';
    state.confirmedPageSize = null;
    $('ed-result-body').classList.remove('ed-visible');
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
  // 每页片段数变化：不自动合并；隐藏旧结果，点「确认」后才重新分页并展示
  $('ed-page-size').addEventListener('input', () => {
    if (!state.items.length || state.merging) return;
    if (!$('ed-result').classList.contains('ed-visible')) return;
    revoke(state.resultUrls);
    $('ed-result-body').classList.remove('ed-visible');
    $('ed-downloads').innerHTML = '';
    setStatus('已修改每页片段数，点「确认」后重新分页');
  });
  $('ed-page-confirm').addEventListener('click', () => {
    if (state.merging || !state.items.length) return;
    merge();
  });
  $('ed-close').addEventListener('click', () => window.close());

  // 自动化测试钩子
  window.VSREditor = { load, getItems: () => state.items.map(({ frame }) => frame) };

  render();
  // 扩展源启动：经 MessagePort 回取（结构化克隆保字节；connect 即唤醒 SW）
  if (typeof chrome !== 'undefined' && chrome.runtime
    && typeof chrome.runtime.connect === 'function') {
    setStatus('正在载入片段…');
    let settled = false;
    try {
      const port = chrome.runtime.connect({ name: 'vsr-editor' });
      const done = (crops) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        if (crops && crops.length) load(crops);
        else setStatus('没有待编辑的片段——请先在提取结果页完成一次提取，再点「✂️ 手动调整片段」');
      };
      const fail = (why) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        setStatus('❌ 获取片段失败: ' + why);
      };
      port.onMessage.addListener((m) => {
        // 通道载荷是 b64 形态 → 解码回字节（load 对裸 ArrayBuffer 也兼容）
        const crops = (m && m.crops)
          ? m.crops.map((c) => ({
            width: c.width, height: c.height, frame: c.frame,
            png: typeof c.png === 'string' ? VSRB64.decode(c.png) : c.png,
          }))
          : null;
        done(crops);
      });
      port.onDisconnect.addListener(() => fail('background 无响应（端口断开）'));
      setTimeout(() => fail('回取超时(10s)'), 10000);
      port.postMessage({ type: 'get' });
    } catch (e) { setStatus('❌ ' + ((e && e.message) || e)); }
  } else {
    setStatus('请在提取结果页点「✂️ 手动调整片段」进入（测试可经 VSREditor.load 注入）');
  }
})();
