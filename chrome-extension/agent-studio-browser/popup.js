const statusEl = document.getElementById('status')

chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
  if (!statusEl) return
  statusEl.textContent = response && response.connected === true ? '已连接' : '未连接'
})
