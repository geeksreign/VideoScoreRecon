// acquire.js 分层下载单测：stub window/chrome/fetch，验证
// 层序 cred → nocred → sw、进度回调与错误聚合（不依赖扩展环境）
// 用法: node test/acquire_fallback.mjs   （退出码 0=通过）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '../src/acquire.js'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`);
  if (!ok) failures++;
}

function makeSandbox(opts = {}) {
  const sandbox = {
    URL, Promise, Date, setTimeout, clearTimeout, queueMicrotask,
    performance: opts.performance || { getEntriesByType: () => [] },
    fetch: opts.fetch,
  };
  sandbox.window = sandbox;
  if ('chrome' in opts) sandbox.chrome = opts.chrome;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'acquire.js' });
  return sandbox;
}

function okResponse(bytes, len) {
  const body = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  });
  return {
    ok: true,
    headers: { get: (k) => (k === 'Content-Length' ? String(len) : null) },
    body,
  };
}

/** chrome.runtime.connect 端口桩：收到 fetch 后按脚本回放消息 */
function makeChrome(connectScript) {
  const calls = [];
  const chrome = {
    runtime: {
      connect({ name }) {
        calls.push(name);
        const msgListeners = [];
        const discListeners = [];
        const port = {
          onMessage: { addListener: (f) => msgListeners.push(f) },
          onDisconnect: { addListener: (f) => discListeners.push(f) },
          postMessage(msg) {
            if (msg && msg.type === 'fetch') {
              queueMicrotask(() => connectScript(msg, (m) =>
                msgListeners.forEach((f) => f(m)), () =>
                discListeners.forEach((f) => f({}))));
            }
          },
          disconnect() {},
        };
        return port;
      },
    },
  };
  return { chrome, calls };
}

// ---- 0. 导出完整性（content 时长回退依赖 getVideoInfo） ----
{
  const sb = makeSandbox({ fetch: async () => { throw new TypeError('x'); } });
  const keys = Object.keys(sb.VSRAcquire).sort();
  check('exports', JSON.stringify(keys) ===
    JSON.stringify(['acquire', 'fetchWithProgress', 'getVideoInfo', 'parseUrl', 'sniffUrls']),
  keys.join(','));
  check('getVideoInfo_is_fn', typeof sb.VSRAcquire.getVideoInfo === 'function', '');
}

// ---- 1. 层②成功：include 抛错 → omit 成功，记录 credentials 顺序与进度 ----
{
  const calls = [];
  const sb = makeSandbox({
    fetch: async (url, init) => {
      calls.push(init && init.credentials);
      if (init && init.credentials === 'include') throw new TypeError('Failed to fetch');
      return okResponse([9, 7, 5], 3);
    },
  });
  const progress = [];
  const r = await sb.VSRAcquire.fetchWithProgress(
    ['https://cdn.example/a.m4s'], (p, m) => progress.push([p, m]));
  const bytes = Array.from(new Uint8Array(r.buffer));
  check('layer_creds_order', JSON.stringify(calls) === '["include","omit"]',
    JSON.stringify(calls));
  check('layer_nocred_bytes', JSON.stringify(bytes) === '[9,7,5]', JSON.stringify(bytes));
  check('layer_progress_reported', progress.length > 0, `calls=${progress.length}`);
}

// ---- 2. 层③成功：页面两层全败 → background SW 端口下载 ----
{
  const { chrome, calls } = makeChrome((msg, send) => {
    send({ type: 'progress', done: 3, total: 3 });
    send({ type: 'chunk', buf: new Uint8Array([1, 2, 3]).buffer });
    send({ type: 'done' });
  });
  const sb = makeSandbox({
    chrome,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  const r = await sb.VSRAcquire.fetchWithProgress(
    ['https://cdn.example/b.m4s'], () => {});
  const bytes = Array.from(new Uint8Array(r.buffer));
  check('layer_sw_port_name', JSON.stringify(calls) === '["vsr-download"]',
    JSON.stringify(calls));
  check('layer_sw_bytes', JSON.stringify(bytes) === '[1,2,3]', JSON.stringify(bytes));
}

// ---- 3. 全败：错误聚合含三层标签；无 chrome 时 sw 层记为无通道 ----
{
  const sb = makeSandbox({
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  let err = null;
  try {
    await sb.VSRAcquire.fetchWithProgress(['https://cdn.example/c.m4s'], () => {});
  } catch (e) { err = e; }
  const msg = err && err.message || '';
  check('all_fail_msg', !!err && msg.startsWith('所有下载源均失败:'), msg.slice(0, 60));
  for (const layer of ['cred', 'nocred', 'sw']) {
    check(`all_fail_layer_${layer}`, msg.includes(`[cdn.example|${layer}]`),
      msg.includes(`|${layer}]`) ? '' : msg);
  }
  check('all_fail_no_chrome_detail', msg.includes('无 background 通道'), '');
}

// ---- 4. HTTP 非 2xx：状态码原样进聚合错误，且不阻断后续层 ----
{
  const sb = makeSandbox({
    fetch: async (url, init) => {
      if (init && init.credentials === 'include') {
        return { ok: false, status: 403, headers: { get: () => null }, body: null };
      }
      throw new TypeError('Failed to fetch');
    },
  });
  let err = null;
  try {
    await sb.VSRAcquire.fetchWithProgress(['https://cdn.example/d.m4s'], () => {});
  } catch (e) { err = e; }
  const msg = (err && err.message) || '';
  check('http_403_recorded', msg.includes('[cdn.example|cred] HTTP 403'), msg.slice(0, 80));
  check('http_403_continues_layers', msg.includes('[cdn.example|nocred]'), '');
}

// ---- 5. 画质策略 acquire 编排（默认480=playurl主取 / player=嗅探优先 / 兜底 / 前缀守护） ----
const PAGE_URL = 'https://www.bilibili.com/video/BV1test1234/';
const SNIFF_ENTRY = { performance: { getEntriesByType: () => [{ name: 'https://sniff.example/a.m4s' }] } };

function viewOk() {
  return { ok: true, json: async () => ({ code: 0, data: { cid: 7, title: 'T', duration: 10 } }) };
}
function playurlOk() {
  return { ok: true, json: async () => ({ code: 0, data: { dash: { video: [{
    id: 32, codecs: 'avc1.640033', baseUrl: 'https://cdn.example/play.m4s',
    backupUrl: [], width: 640, height: 480 }] } } }) };
}

// 5.1 默认（不传 opts）= 480P：playurl 请求 qn=32，嗅探 URL 不被取用
{
  const log = [];
  const sb = makeSandbox(Object.assign({
    fetch: async (url) => {
      log.push(url);
      if (url.includes('/x/web-interface/view')) return viewOk();
      if (url.includes('/x/player/playurl')) return playurlOk();
      if (url === 'https://cdn.example/play.m4s') return okResponse([1, 2, 3], 3);
      throw new TypeError('unexpected ' + url);
    },
  }, SNIFF_ENTRY));
  const r = await sb.VSRAcquire.acquire(PAGE_URL, () => {});
  check('q_default_channel_playurl', r.channel === 'playurl', r.channel);
  check('q_default_label_480p', r.label.startsWith('480p'), r.label);
  check('q_default_qn32', log.some((u) => u.includes('/playurl') && u.includes('qn=32')),
    log.filter((u) => u.includes('/playurl')).join());
  check('q_default_sniff_untouched', !log.some((u) => u.includes('sniff.example')), log.join(' , '));
}

// 5.2 quality='player'：嗅探优先，playurl 不被调用
{
  const log = [];
  const sb = makeSandbox(Object.assign({
    fetch: async (url) => {
      log.push(url);
      if (url === 'https://sniff.example/a.m4s') return okResponse([7], 1);
      throw new TypeError('unexpected ' + url);
    },
  }, SNIFF_ENTRY));
  const r = await sb.VSRAcquire.acquire(PAGE_URL, () => {}, { quality: 'player' });
  check('q_player_channel_sniff', r.channel === 'sniff', r.channel);
  check('q_player_sniff_used', log.some((u) => u.includes('sniff.example')), log.join(','));
  check('q_player_no_playurl', !log.some((u) => u.includes('/playurl')), log.join(','));
}

// 5.3 quality='480' 且 playurl 网络失败 → 嗅探兜底成功
{
  const log = [];
  const sb = makeSandbox(Object.assign({
    fetch: async (url) => {
      log.push(url);
      if (url.includes('/x/web-interface/view')) return viewOk();
      if (url.includes('/x/player/playurl')) throw new TypeError('Failed to fetch');
      if (url === 'https://sniff.example/a.m4s') return okResponse([9], 1);
      throw new TypeError('unexpected ' + url);
    },
  }, SNIFF_ENTRY));
  const r = await sb.VSRAcquire.acquire(PAGE_URL, () => {}, { quality: '480' });
  check('q_fallback_sniff_channel', r.channel === 'sniff', r.channel);
  check('q_fallback_playurl_tried', log.some((u) => u.includes('/playurl')), '');
}

// 5.4 全败：消息仍以「所有下载源均失败」开头（授权重试按钮契约）并聚合两通道原因
{
  const sb = makeSandbox(Object.assign({
    fetch: async (url) => {
      if (url.includes('/x/web-interface/view')) return viewOk();
      if (url.includes('/x/player/playurl')) throw new TypeError('Failed to fetch');
      throw new TypeError('unexpected ' + url);
    },
  }, { performance: { getEntriesByType: () => [] } }));   // 无嗅探记录
  let err = null;
  try { await sb.VSRAcquire.acquire(PAGE_URL, () => {}); } catch (e) { err = e; }
  const msg = (err && err.message) || '';
  check('q_allfail_prefix', msg.startsWith('所有下载源均失败:'), msg.slice(0, 60));
  check('q_allfail_both_channels', msg.includes('playurl[') && msg.includes('嗅探['), msg);
}

if (failures) {
  console.error(`ACQUIRE FALLBACK FAIL (${failures})`);
  process.exit(1);
}
console.log('ACQUIRE FALLBACK PASS');
