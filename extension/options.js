const DEFAULT_BASE = '';   // 留空 = 内置本地引擎模式

function $(id) { return document.getElementById(id); }

chrome.storage.local.get(['baseUrl', 'token', 'cookie'], (cfg) => {
  $('baseUrl').value = cfg.baseUrl || DEFAULT_BASE;
  $('token').value = cfg.token || '';
  $('cookie').value = cfg.cookie || '';
});

$('save').addEventListener('click', () => {
  chrome.storage.local.set({
    baseUrl: $('baseUrl').value.trim() || DEFAULT_BASE,
    token: $('token').value.trim(),
    cookie: $('cookie').value.trim(),
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
