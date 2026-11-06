// M4/M1.5 真站冒烟：加载 unpacked 扩展 → B 站视频页注入 → 面板 → 真实提取端到端
// 用法: node test/extension_smoke.mjs          （注入+面板+提取全流程）
//       NO_EXTRACT=1 node test/extension_smoke.mjs   （只测注入与面板）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');          // extension/ 根
// 扩展测试专用 Chrome for Testing 124（Chrome 137+ 移除 --load-extension 与
// headless 扩展注入，124 完整支持；WebCodecs/OffscreenCanvas 亦满足流水线需求）
const CFT124 = path.join(EXT,
  '.browsers/chrome/mac-124.0.6367.207/chrome-mac-x64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const CHROME = process.env.CHROME_PATH || CFT124;
// 默认用含滚动乐谱的视频（动态谱）：rickroll MV 检测必然 0 检出，曾误导排障
const BV = process.env.SMOKE_BV || 'BV1jW41117JQ';

const t0 = Date.now();
const stamp = () => `[t+${((Date.now() - t0) / 1000).toFixed(0)}s]`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADED === '1' ? false : 'new',
  protocolTimeout: 660000,
  args: [
    '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});
console.log(stamp(), '扩展已加载:', EXT, 'chrome=', CHROME);

const page = await browser.newPage();
page.on('pageerror', e => console.error(stamp(), '[pageerror]', (e && e.message) || String(e)));
page.on('console', m => { const t = m.text(); if (!/Download the React|favicon/.test(t)) console.log(stamp(), '[console]', t.slice(0, 200)); });

let exitCode = 1;
try {
  console.log(stamp(), 'goto', BV);
  await page.goto(`https://www.bilibili.com/video/${BV}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 1. content script 注入
  await page.waitForSelector('#score-ext-btn', { timeout: 45000 });
  console.log(stamp(), 'PASS 注入：#score-ext-btn 出现');

  // 2. 打开面板 + 本地引擎状态
  await page.click('#score-ext-btn');
  await page.waitForSelector('#score-ext-panel.se-open', { timeout: 10000 });
  await page.waitForFunction(
    () => (document.getElementById('se-status') || {}).textContent
      && document.getElementById('se-status').textContent.includes('本地引擎'),
    { timeout: 15000 });
  const status = await page.$eval('#se-status', el => el.textContent);
  console.log(stamp(), 'PASS 面板打开，状态:', JSON.stringify(status));

  if (process.env.NO_EXTRACT) {
    console.log('INJECT PASS (NO_EXTRACT)');
    exitCode = 0;
  } else {
    // 3. 真实提取端到端（下载 → worker → 结果）
    console.log(stamp(), '开始真实提取...');
    await page.click('#se-start-btn');
    await page.waitForFunction(
      () => {
        const s = (document.getElementById('se-status') || {}).textContent || '';
        return s.startsWith('✅ 完成') || s.startsWith('❌');
      },
      { timeout: 600000, polling: 1000 });
    const finalStatus = await page.$eval('#se-status', el => el.textContent);
    console.log(stamp(), '最终状态:', JSON.stringify(finalStatus));

    if (finalStatus.startsWith('✅')) {
      const info = await page.evaluate(() => {
        const img = document.getElementById('se-result-img');
        const links = Array.from(document.querySelectorAll('#se-downloads a'))
          .map(a => a.textContent);
        const visible = document.getElementById('se-result').classList.contains('se-visible');
        return { visible, imgSrc: img && img.src.slice(0, 5), links };
      });
      console.log(stamp(), 'result:', JSON.stringify(info));
      if (info.visible && info.imgSrc === 'blob:' && info.links.length) {
        // 编辑器入口回归：必须由 background tabs.create 打开
        // （网页/地址栏直导航 chrome-extension:// 会被 ERR_BLOCKED_BY_CLIENT 拦）
        let editorOk = false;
        try {
          const editBtn = await page.$('#se-edit-btn');
          if (!editBtn) throw new Error('入口按钮缺失');
          await editBtn.click();
          const t = await browser.waitForTarget(
            (x) => x.type() === 'page' && x.url().includes('/editor.html'), { timeout: 20000 });
          const epg = await t.page();
          // 缩略图字节完整性：全部解码成功且非空 blob（防 runtime 消息 JSON 化丢字节回归）
          await epg.waitForFunction(() => {
            const im = Array.from(document.querySelectorAll('.ed-card img'));
            return im.length > 0 && im.every((x) => x.complete && x.naturalWidth > 0);
          }, { timeout: 30000, polling: 500 });
          const cards = await epg.evaluate(async () => {
            const imgs = Array.from(document.querySelectorAll('.ed-card img'));
            const buf = await (await fetch(imgs[0].src)).arrayBuffer();
            return { n: imgs.length, firstW: imgs[0].naturalWidth, blobSize: buf.byteLength };
          });
          console.log(stamp(), 'editor 图片完整性:', JSON.stringify(cards));
          editorOk = cards.n > 0 && cards.firstW > 0 && cards.blobSize > 5000;
        } catch (e) {
          console.error(stamp(), 'EDITOR-ENTRY FAIL:', e.message);
        }
        if (editorOk) {
          console.log('E2E REAL-SITE PASS');
          exitCode = 0;
        }
      }
    }
  }
} catch (e) {
  console.error(stamp(), 'SMOKE FAIL:', e.message);
  const st = await page.$eval('#se-status', el => el.textContent).catch(() => '?');
  console.error(stamp(), '超时时面板状态:', JSON.stringify(st));
} finally {
  await browser.close().catch(() => {});
  setTimeout(() => process.exit(exitCode), 500).unref();
}
process.exitCode = exitCode;
