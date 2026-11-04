// 点击工具栏图标打开设置页
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
