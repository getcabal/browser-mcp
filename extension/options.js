import DEFAULT_CONFIG from './config.js';

const portInput = document.getElementById('port');
const profileInput = document.getElementById('profile');
const saved = document.getElementById('saved');

if (DEFAULT_CONFIG.locked === true) {
  portInput.value = String(DEFAULT_CONFIG.port);
  profileInput.value = DEFAULT_CONFIG.profile ?? '';
  portInput.disabled = true;
  profileInput.disabled = true;
  document.querySelector('button[type="submit"]').disabled = true;
  saved.textContent = 'This fleet artifact is locked to its stamped profile and port.';
  saved.style.color = '#5ee6a8';
} else {
  chrome.storage.local.get(['port', 'profile'], (stored) => {
    portInput.value = String(Number.isInteger(stored.port) ? stored.port : DEFAULT_CONFIG.port);
    profileInput.value = typeof stored.profile === 'string' ? stored.profile : (DEFAULT_CONFIG.profile ?? '');
  });
}

document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (DEFAULT_CONFIG.locked === true) return;
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
