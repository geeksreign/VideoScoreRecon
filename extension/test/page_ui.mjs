// M4 UI 集成验证：普通页面 + chrome.* stub 加载 content.js，
// mock acquire → 真实 worker 全链 → 结果 DOM 断言（等价 content script 主体行为）
// 用法: node test/page_ui.mjs   （退出码 0=通过）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(REPO, urlPath);
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Connection': 'close' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 300000,
  args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', e.message));
page.on('console', m => { const t = m.text(); if (m.type() === 'error') console.error('[console]', t.slice(0, 200)); });

let exitCode = 1;
try {
  await page.goto(`http://127.0.0.1:${port}/extension/test/page_ui.html`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#out[data-done="1"]', { timeout: 260000 });
  const result = JSON.parse(await page.$eval('#out', el => el.textContent));
  if (result.error) console.error('ERROR:', result.error, '| status:', result.status);
  for (const l of (result.log || [])) {
    console.log(`${l.ok ? 'PASS' : 'FAIL'} ${l.name} ${l.detail}`);
  }
  if (result.pass) { console.log('PAGE-UI PASS'); exitCode = 0; }
} catch (e) {
  console.error('DRIVER FAIL:', e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  setTimeout(() => process.exit(exitCode), 500).unref();
}
process.exitCode = exitCode;
