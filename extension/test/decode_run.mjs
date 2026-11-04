// M1 端到端：真 worker 解码本地 mp4 → 与 Python oracle 对比
// 用法: node test/decode_run.mjs   （退出码 0=通过；diff 全打印便于调容差）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');   // 服务根含 data/ 与 extension/
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const t0 = Date.now();
const stamp = () => `[t+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
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
console.log(stamp(), '[server] repo root on :' + port);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 360000,
  args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.error(stamp(), '[pageerror]', e.message));
page.on('console', m => console.log(stamp(), '[console]', m.text()));

let exitCode = 1;
try {
  await page.goto(`http://127.0.0.1:${port}/extension/test/decode.html`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#out[data-done="1"]', { timeout: 240000 });
  const result = JSON.parse(await page.$eval('#out', el => el.textContent));
  if (result.error) {
    console.error('RUNNER ERROR:', result.error);
    if (result.log) for (const l of result.log) console.error('  log:', l);
  } else {
    console.log('pass=', result.pass);
    console.log('got=', JSON.stringify(result.got));
    for (const d of (result.diff || [])) {
      console.error(`DIFF ${d.k}: got=${JSON.stringify(d.got)} exp=${JSON.stringify(d.exp)}`);
    }
    if (result.pass) { console.log('E2E PASS'); exitCode = 0; }
  }
} catch (e) {
  console.error(stamp(), 'DRIVER FAIL:', e.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  setTimeout(() => process.exit(exitCode), 500).unref();
}
process.exitCode = exitCode;
