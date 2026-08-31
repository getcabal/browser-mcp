const statusEl = document.getElementById('status');
const fatalEl = document.getElementById('fatal');
const reconnectButton = document.getElementById('reconnect');

function refresh() {
  chrome.runtime.sendMessage({ type: 'local-mcp-status' }, (state) => {
    if (!state || chrome.runtime.lastError) {
      statusEl.textContent = 'Service worker unavailable';
      return;
    }
    document.getElementById('port').textContent = String(state.port);
    document.getElementById('profile').textContent = state.profile === null ? '(none)' : state.profile;
    document.getElementById('version').textContent = state.version;
    document.getElementById('route-note').textContent = state.locked
      ? 'Fleet route locked by the stamped artifact. No hosted relay, account, token, or remote-control mode exists.'
      : 'Development route; configure port/profile in Options. No hosted relay, account, token, or remote-control mode exists.';
    if (state.fatal) {
      statusEl.textContent = 'Handshake rejected — reconnect disabled';
      statusEl.style.color = '#ff8484';
      fatalEl.textContent = `Server rejected this extension (code ${state.fatal.code}): ${state.fatal.reason}`;
      fatalEl.hidden = false;
      reconnectButton.hidden = false;
      return;
    }
    fatalEl.hidden = true;
    reconnectButton.hidden = true;
    statusEl.textContent = state.connected ? 'Connected to the local bridge' : 'Waiting for the local bridge';
    statusEl.style.color = state.connected ? '#5ee6a8' : '#f5c76d';
  });
}

reconnectButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'local-mcp-reconnect' }, () => {
    void chrome.runtime.lastError;
    setTimeout(refresh, 400);
  });
});

refresh();
setInterval(refresh, 2000);
