// 视频源获取（content script 环境运行，挂在 window.VSRAcquire）
//
// 取流策略（opts.quality，设置页可选，默认 480——与本地 Python 管线同源、去重最稳）：
//   480（默认，playurl qn=32）：主取且**强制游客视图**（credentials:omit——与 Python
//      无 cookie 请求同码流，屏蔽登录态差异；失败回退登录态重试）→ 仍败降级嗅探
//   720/1080（qn=64/80）：playurl 主取（登录态，AVC 优先）→ 失败降级播放器嗅探
//   player（跟随播放器）：嗅探主取（零 API、画质=正在观看的流）→ 失败 playurl(qn=80) 兜底
//   playurl port 自 src/video_scrap/bili/api.py，页面 cookie 默认自动携带（credentials:include）
//
// 下载分三层（fetchWithProgress）：
//   ① 页面源 fetch credentials:include —— 自带 Referer/cookie（首选）
//   ② 页面源 fetch credentials:omit  —— 绕过 CDN ACAO:* 与凭据冲突的 CORS 拒绝
//   ③ background SW 端口流式下载     —— 扩展源豁免 CORS/混合内容（最后兜底）
// 页面源 fetch 在 bilibili.com 发起：浏览器自动带 Referer/cookie；
// 是否免 CORS 取决于扩展 host_permissions 与 CDN 响应头，故保留三层兜底。
window.VSRAcquire = (function () {
  const API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
  const API_PLAYURL = 'https://api.bilibili.com/x/player/playurl';
  // 音频流 CDN 文件名标记（DASH 音频 30216/30232/30280），其余 .m4s 视为视频
  const AUDIO_MARK = /-(30216|30232|30280)\.m4s(\?|$)/;

  function parseUrl(url) {
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
    if (!m) throw new Error('无法从 URL 解析 bvid: ' + url);
    const q = new URL(url).searchParams;
    return { bvid: m[1], page: parseInt(q.get('p') || '1', 10) };
  }

  async function getJson(apiUrl, params, opts) {
    const u = new URL(apiUrl);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    const r = await fetch(u.toString(),
      { credentials: (opts && opts.omitCred) ? 'omit' : 'include' });
    if (!r.ok) throw new Error('B站 API HTTP ' + r.status);
    const j = await r.json();
    if (j.code !== 0) throw new Error('B站 API code=' + j.code + ' ' + (j.message || ''));
    return j.data;
  }

  async function getVideoInfo(bvid, page) {
    const data = await getJson(API_VIEW, { bvid });
    const pages = data.pages || [];
    let target = null;
    if (pages.length) {
      target = pages.find((p) => p.page === page) || null;
      if (!target) throw new Error('bvid=' + bvid + ' 没有分P ' + page);
    }
    return {
      title: data.title,
      part: target ? target.part : data.title,
      cid: target ? target.cid : data.cid,
      duration: target ? target.duration : data.duration,
    };
  }

  async function getPlayUrl(bvid, cid, qn = 80, opts) {
    const data = await getJson(API_PLAYURL, {
      bvid, cid, qn, fnval: 16, fnver: 0, fourk: 1,
    }, opts);
    const dash = data.dash;
    if (!dash || !dash.video || !dash.video.length) {
      throw new Error('该视频没有 DASH 流（可能需要登录）');
    }
    // AVC 优先、id 最大（同 Python pick_streams，但只取视频——拼谱不需要音频）
    const avc = dash.video.filter((v) => (v.codecs || '').startsWith('avc'));
    const pool = avc.length ? avc : dash.video;
    const best = pool.reduce((a, b) => ((b.id || 0) > (a.id || 0) ? b : a));
    const urls = [best.baseUrl].concat(best.backupUrl || []).filter(Boolean);
    return { urls, quality: best.id, width: best.width, height: best.height };
  }

  /** 通道①：嗅探播放器已请求的视频流 URL */
  function sniffUrls() {
    const names = performance.getEntriesByType('resource').map((e) => e.name);
    const vids = names.filter((n) =>
      /\.m4s(\?|$)/.test(n) && !AUDIO_MARK.test(n));
    if (vids.length) return vids.slice().reverse();   // 最近请求优先
    // 整片 mp4/flv 兜底
    const whole = names.filter((n) => /\.mp4(\?|$)|\.flv(\?|$)/.test(n));
    return whole.slice().reverse();
  }

  /** 读 Response 流为 ArrayBuffer（带进度） */
  async function readToBuffer(r, onProgress) {
    const total = parseInt(r.headers.get('Content-Length') || '0', 10);
    const reader = r.body.getReader();
    const chunks = [];
    let done = 0;
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      chunks.push(value);
      done += value.length;
      if (onProgress && total) onProgress(done / total, `下载 ${mb(done)}/${mb(total)}`);
    }
    if (done === 0) throw new Error('空响应');
    const buf = new Uint8Array(done);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return buf.buffer;
  }

  /** 层层①/②：页面源 fetch。cred=带凭据（含 Referer），nocred=免凭据（绕 ACAO:* 冲突） */
  async function pageFetchDownload(url, withCred, onProgress) {
    const r = await fetch(url, withCred ? { credentials: 'include' } : { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!r.body) throw new Error('无响应体');
    return readToBuffer(r, onProgress);
  }

  /**
   * 层③：background service worker 端口流式下载（扩展源豁免 CORS/混合内容）。
   * SW 无法设 Referer，故仅作前两层失败后的兜底。
   */
  function swDownload(url, onProgress) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime
          || typeof chrome.runtime.connect !== 'function') {
          throw new Error('无 background 通道');
        }
        port = chrome.runtime.connect({ name: 'vsr-download' });
      } catch (e) { reject(e); return; }

      const chunks = [];
      let done = 0, settled = false;
      let timer = null;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (e) { /* ignore */ }
        fn(arg);
      };
      // 断流保护：60s 无任何消息即判失败（chunk 持续到来会不断重置）
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => settle(reject, new Error('background 下载超时(60s无数据)')), 60000);
      };
      arm();

      port.onMessage.addListener((m) => {
        arm();
        if (m.type === 'progress') {
          if (onProgress && m.total) {
            onProgress(m.done / m.total, `下载 ${mb(m.done)}/${mb(m.total)}`);
          }
        } else if (m.type === 'chunk') {
          // SW 侧按 base64 发（扩展消息=JSON，ArrayBuffer 会丢）
          const u = typeof m.b64 === 'string' ? VSRB64.decode(m.b64)
            : new Uint8Array(m.buf || []);
          chunks.push(u);
          done += u.length;
        } else if (m.type === 'done') {
          if (!done) { settle(reject, new Error('空响应')); return; }
          const buf = new Uint8Array(done);
          let o = 0;
          for (const c of chunks) { buf.set(c, o); o += c.length; }
          settle(resolve, buf.buffer);
        } else if (m.type === 'error') {
          settle(reject, new Error(m.message || 'background 下载失败'));
        }
      });
      port.onDisconnect.addListener(() => {
        const err = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError)
          || {};
        settle(reject, new Error(err.message || 'background 断开'));
      });
      port.postMessage({ type: 'fetch', url });
    });
  }

  /**
   * 带进度的分层下载：每个 URL 依次 cred → nocred → background SW，全败换下一源
   * @param {string[]} urls 按序尝试的源
   * @param {(p:number,m:string)=>void} onProgress download 进度回调
   * @returns {Promise<{buffer:ArrayBuffer, url:string}>}
   */
  async function fetchWithProgress(urls, onProgress) {
    const errs = [];
    for (const url of urls) {
      for (const mode of ['cred', 'nocred', 'sw']) {
        try {
          const buffer = mode === 'sw'
            ? await swDownload(url, onProgress)
            : await pageFetchDownload(url, mode === 'cred', onProgress);
          return { buffer, url };
        } catch (e) {
          // 逐层记录 <host|层>: <原因>，便于定位缺权限/被拒的具体 CDN 域与成因
          errs.push(`[${hostOf(url)}|${mode}] ${e && e.message || e}`);
        }
      }
    }
    throw new Error('所有下载源均失败: ' + errs.join(' | '));
  }

  function mb(n) {
    return (n / 1048576).toFixed(1) + 'MB';
  }

  /** 档位 → playurl qn（480=32 与本地 Python 实得流一致；API 无该档时以实际返回为准） */
  const QN_BY_QUALITY = { '480': 32, '720': 64, '1080': 80 };

  /** 嗅探取流：performance 里播放器最近请求的视频 .m4s（无记录/取流失败抛错） */
  async function viaSniff(report) {
    const sniffed = sniffUrls();
    if (!sniffed.length) throw new Error('播放器无 .m4s 请求记录');
    report('download', 0.02, '嗅探到播放器视频流');
    const { buffer, url } = await fetchWithProgress(sniffed.slice(0, 3), (p, m) =>
      report('download', 0.02 + p * 0.96, m));
    return { buffer, channel: 'sniff', label: hostOf(url) };
  }

  /** playurl 取流（AVC 优先），label 用实际分辨率（qn 为请求档，实际可能被降档） */
  async function viaPlayurl(pageUrl, report, qn) {
    const { bvid, page } = parseUrl(pageUrl);
    const info = await getVideoInfo(bvid, page);
    report('download', 0.06, `视频: ${info.part || info.title}`);
    let r;
    if (qn === QN_BY_QUALITY['480']) {
      // 480 档强制游客视图（credentials:omit）：与本地 Python（无 cookie 游客
      // playurl）同一条请求语义、同码流，屏蔽登录态返回不同表示的变量；
      // 游客视图失败（如风控要求 cookie）再带登录态重试
      try {
        r = await getPlayUrl(bvid, info.cid, qn, { omitCred: true });
        report('download', 0.07, 'playurl 游客视图（与本地 Python 同源）');
      } catch (e) {
        report('download', 0.07, `游客视图失败（${e && e.message}），带登录态重试`);
        r = await getPlayUrl(bvid, info.cid, qn);
      }
    } else {
      r = await getPlayUrl(bvid, info.cid, qn);
    }
    report('download', 0.08, `画质 ${r.height}p ${r.width}x${r.height}`);
    const { buffer, url } = await fetchWithProgress(r.urls, (p, m) =>
      report('download', 0.08 + p * 0.9, m));
    return { buffer, channel: 'playurl', label: `${r.height}p ${hostOf(url)}` };
  }

  /**
   * 主入口：返回可解码的视频 ArrayBuffer
   * @param {string} pageUrl 当前 B 站页面 URL
   * @param {(stage:string,p:number,m:string)=>void} report 进度
   * @param {{quality?:string}} [opts] quality: '480'（默认）|'720'|'1080'|'player'
   * @returns {Promise<{buffer:ArrayBuffer, channel:string, label:string}>}
   */
  async function acquire(pageUrl, report, opts) {
    const quality = (opts && opts.quality) || '480';
    const qn = QN_BY_QUALITY[quality] || 32;

    if (quality !== 'player') {
      // 指定画质：playurl 主取 → 失败嗅探兜底（画质回到播放器档）
      report('download', 0.02, `画质策略 ${quality}P：playurl 取流`);
      let playErr = null;
      try {
        return await viaPlayurl(pageUrl, report, qn);
      } catch (e) {
        playErr = e;
        report('download', 0.02, `playurl 失败（${e && e.message}），嗅探兜底`);
      }
      try {
        return await viaSniff(report);
      } catch (e2) {
        throw new Error('所有下载源均失败: '
          + `playurl[${playErr && playErr.message}] | 嗅探[${e2 && e2.message}]`);
      }
    }

    // 跟随播放器：嗅探主取 → 失败 playurl(qn=80) 兜底
    let sniffErr = null;
    try {
      return await viaSniff(report);
    } catch (e) {
      sniffErr = e;
      report('download', 0.02, `嗅探不可用（${e && e.message}），playurl 兜底`);
    }
    try {
      return await viaPlayurl(pageUrl, report, 80);
    } catch (e2) {
      throw new Error('所有下载源均失败: '
        + `嗅探[${sniffErr && sniffErr.message}] | playurl[${e2 && e2.message}]`);
    }
  }

  function hostOf(u) {
    try { return new URL(u).hostname; } catch (e) { return u.slice(0, 40); }
  }

  return { acquire, parseUrl, sniffUrls, fetchWithProgress, getVideoInfo };
})();
