// 跨语言对齐测试驱动：本地静态服务 + headless Chrome 加载 runner.html
// 用法: node test/run.mjs   （退出码 0=全绿）
// 完成信号走 DOM（#out[data-done]），不依赖 window 全局（隔离世界兼容）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const t0 = Date.now();
const stamp = () => `[t+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const mime = MIME[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Connection': 'close' });
  fs.createReadStream(file).pipe(res);
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(stamp(), '[server] 127.0.0.1:' + port);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 360000,
  args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
});
console.log(stamp(), '[browser] launched');
browser.on('targetdestroyed', t => console.error(stamp(), '[browser] targetdestroyed', t.url()));

const page = await browser.newPage();
page.on('pageerror', e => console.error(stamp(), '[pageerror]', e.message));
page.on('console', m => console.log(stamp(), '[console]', m.text()));
page.on('error', e => console.error(stamp(), '[page-crash]', e.message));
page.on('requestfailed', r =>
  console.error(stamp(), '[requestfailed]', r.url(), r.failure() && r.failure().errorText));
page.on('response', r => {
  const u = r.url();
  if (u.includes('/test/') || r.status() >= 400) {
    console.log(stamp(), '[response]', r.status(), r.headers()['content-type'] || '-', u);
  }
});

let exitCode = 1;
try {
  const resp = await page.goto(`http://127.0.0.1:${port}/test/runner.html`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(stamp(), 'navigated:', resp && resp.status(), page.url());

  await page.waitForSelector('#out[data-done="1"]', { timeout: 300000 });
  const text = await page.$eval('#out', el => el.textContent);
  const result = JSON.parse(text);
  if (result.error) {
    console.error('RUNNER ERROR:', result.error);
  } else {
    console.log(`total=${result.total} failed=${result.failed}`);
    for (const f of result.failures) console.error(`FAIL ${f.name}: ${f.detail}`);
    if (result.failed === 0) { console.log('ALL PASS'); exitCode = 0; }
  }
} catch (e) {
  console.error(stamp(), 'DRIVER FAIL:', e.message);
  const info = await page.evaluate(async () => {
    // 现场探针：定时器/fetch/进度/资源加载状态
    const timers = await Promise.race([
      new Promise(r => setTimeout(() => r('alive'), 1500)),
      new Promise(r => setTimeout(() => r('?!'), 5000)),
    ]);
    let fetchProbe = 'pending';
    try {
      await Promise.race([
        fetch('/test/fixtures/cases.json').then(r => { fetchProbe = 'ok ' + r.status; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 3000)),
      ]);
    } catch (err) { fetchProbe = 'fail ' + err.message; }
    const res = performance.getEntriesByType('resource').slice(-6)
      .map(e => `${e.name.split('/').pop()}:${e.responseStatus || '?'}`);
    return {
      timers,
      fetchProbe,
      results: (window.__runnerResults || []).length,
      last: (window.__runnerResults || []).slice(-3).map(r => r.name),
      out: document.getElementById('out').textContent.slice(0, 120),
      ready: document.readyState,
      res,
    };
  }).catch(err => ({ evalErr: String(err) }));
  console.error('probe:', JSON.stringify(info, null, 1));
} finally {
  await browser.close().catch(() => {});
  server.close();
  // Chrome 子进程可能继承 stdout fd，主动退出避免管道挂死
  setTimeout(() => process.exit(exitCode), 500).unref();
}
process.exitCode = exitCode;
