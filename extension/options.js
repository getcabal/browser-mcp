const portInput = document.getElementById('port');
const profileInput = document.getElementById('profile');
const saved = document.getElementById('saved');

chrome.storage.local.get(['port', 'profile'], (stored) => {
  if (Number.isInteger(stored.port)) portInput.value = String(stored.port);
  if (typeof stored.profile === 'string') profileInput.value = stored.profile;
});

document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const updates = {};
  const removals = [];
  const portText = portInput.value.trim();
  if (portText === '') {
    removals.push('port');
  } else {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      saved.textContent = 'Port must be an integer between 1024 and 65535.';
      saved.style.color = '#f5c76d';
      return;
    }
    updates.port = port;
  }
  const profileText = profileInput.value.trim();
  if (profileText === '') removals.push('profile');
  else updates.profile = profileText;

  const finish = () => {
    saved.textContent = 'Saved. Reconnecting to the local bridge…';
    saved.style.color = '#5ee6a8';
  };
  chrome.storage.local.remove(removals, () => {
    if (Object.keys(updates).length) chrome.storage.local.set(updates, finish);
    else {
      // Nothing stored changed keys via set; still nudge the worker to reconnect.
      chrome.runtime.sendMessage({ type: 'local-mcp-reconnect' }, () => void chrome.runtime.lastError);
      finish();
    }
  });
});
