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
