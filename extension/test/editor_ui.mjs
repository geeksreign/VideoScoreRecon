// 片段微调页功能验证：合成 3 片段注入 → 删除/复制/排序/撤销 → 真实 worker 合并 →
// 下载链断言 + 二次合并（验证克隆发送、编辑态保留）
// 用法: node test/editor_ui.mjs   （退出码 0=通过）
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(REPO, urlPath);
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', (e && e.message) || String(e)));
page.on('console', (m) => {
  const t = m.text();
  if (/\[vsr\]|stitch cmd/.test(t)) console.log('[log]', t.slice(0, 200));
});

let code = 1;
const log = [];
const step = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`);
  if (!ok) code = 1;
};

try {
  await page.goto(`${base}/extension/editor.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.VSREditor && document.querySelectorAll('.ed-card').length >= 0);

  // 0. 无 chrome.runtime 环境（server 测试页）→ standby 提示，注入钩子可用
  const standby = await page.evaluate(() => document.getElementById('ed-status').textContent);
  step('standby_hint', standby.includes('VSREditor.load'), standby);

  // 1. 注入 3 张合成片段（帧 100/200/300）
  const loaded = await page.evaluate(async () => {
    const mk = async (frame, barY) => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 110;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 200, 110);
      x.fillStyle = '#000000'; x.fillRect(8, barY, 184, 12);   // 差异条：模拟不同谱行
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return { png: await blob.arrayBuffer(), width: 200, height: 110, frame };
    };
    window.VSREditor.load([await mk(100, 10), await mk(200, 45), await mk(300, 80)]);
    return {
      frames: window.VSREditor.getItems(),
      cards: document.querySelectorAll('.ed-card').length,
      undoDisabled: document.getElementById('ed-undo').disabled,
      mergeDisabled: document.getElementById('ed-merge').disabled,
      status: document.getElementById('ed-status').textContent,
    };
  });
  step('load_3', loaded.frames.join(',') === '100,200,300' && loaded.cards === 3, JSON.stringify(loaded));
  step('init_buttons', loaded.undoDisabled === true && loaded.mergeDisabled === false, '');

  // 2. 删除 idx1 → [100,300]
  await page.evaluate(() => document.querySelectorAll('.ed-card')[1].querySelector('[data-act=del]').click());
  let f = await page.evaluate(() => window.VSREditor.getItems());
  step('delete', f.join(',') === '100,300', f.join(','));

  // 3. 复制 idx0 → [100,100,300]
  await page.evaluate(() => document.querySelectorAll('.ed-card')[0].querySelector('[data-act=dup]').click());
  f = await page.evaluate(() => window.VSREditor.getItems());
  step('duplicate', f.join(',') === '100,100,300', f.join(','));

  // 4. idx2 上移 → [100,300,100]
  await page.evaluate(() => document.querySelectorAll('.ed-card')[2].querySelector('[data-act=up]').click());
  f = await page.evaluate(() => window.VSREditor.getItems());
  step('move_up', f.join(',') === '100,300,100', f.join(','));

  // 5. 撤销 ×3 逐步回退，最终撤销栈空、按钮禁用
  for (const expect of ['100,100,300', '100,300', '100,200,300']) {
    await page.evaluate(() => document.getElementById('ed-undo').click());
    f = await page.evaluate(() => window.VSREditor.getItems());
    step('undo_to_' + expect, f.join(',') === expect, f.join(','));
  }
  const undoDone = await page.evaluate(() => document.getElementById('ed-undo').disabled);
  step('undo_exhausted', undoDone === true, String(undoDone));

  // 6. 真实 worker 合并（opencv 首载 + Stitcher）
  await page.evaluate(() => document.getElementById('ed-merge').click());
  await page.waitForFunction(() => {
    const r = document.getElementById('ed-result');
    return r.classList.contains('ed-visible') ||
      (document.getElementById('ed-status').textContent || '').startsWith('❌');
  }, { timeout: 180000, polling: 500 });
  const merged = await page.evaluate(() => ({
    status: document.getElementById('ed-status').textContent,
    links: Array.from(document.querySelectorAll('#ed-downloads a')).map((a) => ({ text: a.textContent, href: a.href.slice(0, 5), download: a.download })),
    img: (document.getElementById('ed-result-img') || {}).src,
  }));
  step('merge_done', merged.status.startsWith('✅ 合并完成') && merged.links.length >= 1
    && (merged.img || '').startsWith('blob:'), JSON.stringify(merged).slice(0, 220));
  const firstHref = merged.links.length ? await page.evaluate(() => document.querySelector('#ed-downloads a').href) : '';

  // 7. 二次合并：克隆发送不消耗编辑态 → 新 objectURL 应不同
  await page.evaluate(() => document.getElementById('ed-merge').click());
  await page.waitForFunction(() =>
    (document.getElementById('ed-status').textContent || '').startsWith('✅ 合并完成')
    && !!document.querySelector('#ed-downloads a'), { timeout: 60000, polling: 500 });
  const secondHref = await page.evaluate(() => document.querySelector('#ed-downloads a').href);
  const itemsAfter = await page.evaluate(() => window.VSREditor.getItems());
  step('remerge', secondHref.startsWith('blob:') && secondHref !== firstHref
    && itemsAfter.join(',') === '100,200,300', `items=${itemsAfter.join(',')}`);

  code = code === 1 ? 1 : 0;
} catch (e) {
  console.error('DRIVER FAIL:', e.message);
  const st = await page.$eval('#ed-status', (el) => el.textContent).catch(() => '?');
  console.error('status:', JSON.stringify(st));
} finally {
  await browser.close().catch(() => {});
  server.close();
  setTimeout(() => process.exit(code), 300).unref();
}
process.exitCode = code;
