function $(id) { return document.getElementById(id); }

chrome.storage.local.get(['quality', 'interval'], (cfg) => {
  $('quality').value = cfg.quality || '480';   // 未设置 = 默认 480P
  $('interval').value = cfg.interval || '';    // 未设置 = 空（用默认 2.5）
});

$('save').addEventListener('click', () => {
  chrome.storage.local.set({
    quality: $('quality').value || '480',
    interval: $('interval').value.trim(),
    // 兼容旧版本：清掉已移除的 HTTP 服务配置，避免残留 baseUrl 走到旧流程
    baseUrl: '', token: '', cookie: '',
  }, () => {
    $('status').textContent = '已保存 ✅';
    setTimeout(() => { $('status').textContent = ''; }, 2000);
  });
});

// ---- 可选宽权限（下载全败后的兜底授权入口，手势栈内调用）----
const BROAD = { origins: ['*://*/*'] };

function renderGrant(granted) {
  const b = $('grant');
  if (!b) return;
  b.textContent = granted ? '✅ 已授权全网访问' : '🔓 授权全网访问';
  b.disabled = !!granted;
}

if (chrome.permissions && chrome.permissions.contains) {
  chrome.permissions.contains(BROAD, renderGrant);
}

$('grant').addEventListener('click', () => {
  chrome.permissions.request(BROAD, (granted) => {
    renderGrant(granted);
    $('status').textContent = granted ? '已授权全网访问 ✅' : '未授权';
    setTimeout(() => { $('status').textContent = ''; }, 2000);
  });
});
