chrome.runtime.sendMessage({ type: 'local-mcp-status' }, (state) => {
  const el = document.getElementById('status');
  if (!state || chrome.runtime.lastError) { el.textContent = 'Service worker unavailable'; return; }
  el.textContent = state.connected ? 'Connected to the local bridge' : 'Waiting for the local bridge';
  el.style.color = state.connected ? '#5ee6a8' : '#f5c76d';
});
