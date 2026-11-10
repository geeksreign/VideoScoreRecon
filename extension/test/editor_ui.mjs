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

  // 0.5 布局：片段卡竖排（flex-direction: column）
  const dir = await page.evaluate(() => getComputedStyle(document.getElementById('ed-strip')).flexDirection);
  step('layout_vertical', dir === 'column', dir);

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

  const formState = await page.evaluate(() => ({
    confirm: !!document.getElementById('ed-page-confirm'),
    preview: (document.querySelector('.ed-preview-label') || {}).textContent,
    body: document.getElementById('ed-result-body').classList.contains('ed-visible'),
    links: document.querySelectorAll('#ed-downloads a').length,
  }));
  step('page_ui_init', formState.confirm && formState.preview === '首页预览：'
    && formState.body && formState.links === 1, JSON.stringify(formState));

  // 8. 每页 2 个片段 → 输入后需确认 → 2 页 zip
  const setPageSize = (v) => page.evaluate((val) => {
    const el = document.getElementById('ed-page-size');
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const clickConfirm = () => page.evaluate(() => document.getElementById('ed-page-confirm').click());
  await setPageSize('2');
  const pending2 = await page.evaluate(() => ({
    body: document.getElementById('ed-result-body').classList.contains('ed-visible'),
    links: document.querySelectorAll('#ed-downloads a').length,
    status: document.getElementById('ed-status').textContent,
  }));
  step('page_pending_confirm', !pending2.body && pending2.links === 0
    && pending2.status.includes('确认'), JSON.stringify(pending2));
  await clickConfirm();
  await page.waitForFunction(() => {
    const a = document.querySelector('#ed-downloads a');
    return a && /\.zip$/.test(a.download) && /2 页/.test(a.textContent);
  }, { timeout: 60000, polling: 300 });
  const paged2 = await page.evaluate(async () => {
    const a = document.querySelector('#ed-downloads a');
    const buf = await (await fetch(a.href)).arrayBuffer();
    const u = new Uint8Array(buf, 0, 4);
    const dv = new DataView(buf);
    return {
      download: a.download, text: a.textContent,
      links: document.querySelectorAll('#ed-downloads a').length,
      pk: u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04,
      entries: dv.getUint16(buf.byteLength - 12, true),
    };
  });
  step('page_2_zip', paged2.links === 1 && /\.zip$/.test(paged2.download)
    && paged2.pk && paged2.entries === 2 && /2 页/.test(paged2.text),
  JSON.stringify(paged2).slice(0, 240));

  // 9. 每页 1 个片段 → 需确认 → 3 页 zip
  await setPageSize('1');
  const pending1 = await page.evaluate(() => ({
    body: document.getElementById('ed-result-body').classList.contains('ed-visible'),
    links: document.querySelectorAll('#ed-downloads a').length,
  }));
  step('page_pending_confirm_1', !pending1.body && pending1.links === 0, JSON.stringify(pending1));
  await clickConfirm();
  await page.waitForFunction(() => {
    const a = document.querySelector('#ed-downloads a');
    return a && /\.zip$/.test(a.download) && /3 页/.test(a.textContent);
  }, { timeout: 60000, polling: 300 });
  const paged1 = await page.evaluate(async () => {
    const a = document.querySelector('#ed-downloads a');
    const buf = await (await fetch(a.href)).arrayBuffer();
    const dv = new DataView(buf);
    return { entries: dv.getUint16(buf.byteLength - 12, true), text: a.textContent };
  });
  step('page_1_zip_3', paged1.entries === 3 && /3 页/.test(paged1.text), JSON.stringify(paged1));

  // 10. 清空 → 需确认 → 回到单页 PNG
  await setPageSize('');
  const pending0 = await page.evaluate(() => ({
    body: document.getElementById('ed-result-body').classList.contains('ed-visible'),
    links: document.querySelectorAll('#ed-downloads a').length,
  }));
  step('page_pending_confirm_empty', !pending0.body && pending0.links === 0, JSON.stringify(pending0));
  await clickConfirm();
  await page.waitForFunction(() => {
    const a = document.querySelector('#ed-downloads a');
    return a && /\.png$/.test(a.download) && a.textContent === '下载';
  }, { timeout: 60000, polling: 300 });
  const back = await page.evaluate(() => {
    const a = document.querySelector('#ed-downloads a');
    return {
      download: a.download, text: a.textContent,
      links: document.querySelectorAll('#ed-downloads a').length,
    };
  });
  step('page_empty_png', back.links === 1 && /\.png$/.test(back.download)
    && back.text === '下载', JSON.stringify(back));

  // 11. 填 = 总数（3 ≥ 3）→ 等价全部一页：确认后直接出单张 PNG，不再卡在待确认
  await setPageSize('3');
  await clickConfirm();
  await page.waitForFunction(() => {
    const a = document.querySelector('#ed-downloads a');
    return a && /\.png$/.test(a.download);
  }, { timeout: 60000, polling: 300 });
  const eqAll = await page.evaluate(() => {
    const a = document.querySelector('#ed-downloads a');
    return {
      body: document.getElementById('ed-result-body').classList.contains('ed-visible'),
      status: document.getElementById('ed-status').textContent,
      download: a.download, links: document.querySelectorAll('#ed-downloads a').length,
    };
  });
  step('page_eq_total_single', eqAll.body && eqAll.links === 1 && /\.png$/.test(eqAll.download)
    && /1 段输出/.test(eqAll.status), JSON.stringify(eqAll));

  // 12. 填 > 总数（5）→ 同样全部一页
  await setPageSize('5');
  await clickConfirm();
  await page.waitForFunction(() => {
    const a = document.querySelector('#ed-downloads a');
    return a && /\.png$/.test(a.download);
  }, { timeout: 60000, polling: 300 });
  const gtAll = await page.evaluate(() => ({
    body: document.getElementById('ed-result-body').classList.contains('ed-visible'),
    status: document.getElementById('ed-status').textContent,
    links: document.querySelectorAll('#ed-downloads a').length,
  }));
  step('page_gt_total_single', gtAll.body && gtAll.links === 1
    && /1 段输出/.test(gtAll.status), JSON.stringify(gtAll));

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
