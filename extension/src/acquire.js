// 视频源获取（content script 环境运行，挂在 window.VSRAcquire）
//
// 双通道：
//   ① 嗅探：performance.getEntries 里播放器已请求的视频 .m4s —— 零 API 调用，
//      画质/登录态与用户正在观看的完全一致（首选）
//   ② 兜底：直调 B 站 playurl API（port 自 src/video_scrap/bili/api.py，
//      游客/环境 cookie 自动携带，credentials:include）
//
// fetch 都在页面源（bilibili.com）发起：浏览器自动带 Referer/cookie，
// 且扩展有 host_permissions 时 content script 请求免 CORS。
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

  async function getJson(apiUrl, params) {
    const u = new URL(apiUrl);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), { credentials: 'include' });
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

  async function getPlayUrl(bvid, cid) {
    const data = await getJson(API_PLAYURL, {
      bvid, cid, qn: 80, fnval: 16, fnver: 0, fourk: 1,
    });
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

  /**
   * 带进度的流式下载
   * @param {string[]} urls 按序尝试的源
   * @param {(p:number,m:string)=>void} onProgress download 进度回调
   * @returns {Promise<{buffer:ArrayBuffer, url:string}>}
   */
  async function fetchWithProgress(urls, onProgress) {
    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
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
        const buf = new Uint8Array(done);
        let o = 0;
        for (const c of chunks) { buf.set(c, o); o += c.length; }
        if (done === 0) throw new Error('空响应');
        return { buffer: buf.buffer, url };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('所有下载源均失败: ' + (lastErr && lastErr.message));
  }

  function mb(n) {
    return (n / 1048576).toFixed(1) + 'MB';
  }

  /**
   * 主入口：返回可解码的视频 ArrayBuffer
   * @param {string} pageUrl 当前 B 站页面 URL
   * @param {(stage:string,p:number,m:string)=>void} report 进度
   * @returns {Promise<{buffer:ArrayBuffer, channel:string, label:string}>}
   */
  async function acquire(pageUrl, report) {
    // 通道① 嗅探
    const sniffed = sniffUrls();
    if (sniffed.length) {
      report('download', 0.02, '通道① 嗅探到播放器视频流');
      const { buffer, url } = await fetchWithProgress(sniffed.slice(0, 3), (p, m) =>
        report('download', 0.02 + p * 0.96, m));
      return { buffer, channel: 'sniff', label: hostOf(url) };
    }
    // 通道② playurl API
    report('download', 0.02, '通道② 调用 playurl API');
    const { bvid, page } = parseUrl(pageUrl);
    const info = await getVideoInfo(bvid, page);
    report('download', 0.06, `视频: ${info.part || info.title}`);
    const { urls, quality, width, height } = await getPlayUrl(bvid, info.cid);
    report('download', 0.08, `画质 ${quality}p ${width}x${height}`);
    const { buffer, url } = await fetchWithProgress(urls, (p, m) =>
      report('download', 0.08 + p * 0.9, m));
    return { buffer, channel: 'playurl', label: `${quality}p ${hostOf(url)}` };
  }

  function hostOf(u) {
    try { return new URL(u).hostname; } catch (e) { return u.slice(0, 40); }
  }

  return { acquire, parseUrl, sniffUrls, fetchWithProgress };
})();
