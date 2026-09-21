const bridge = 'http://127.0.0.1:17637';
let current;
let targetId;
let state;

const $ = (id) => document.getElementById(id);

function chromeCall(method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      const result = method(...args, (value) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(value));
      if (result?.then) result.then(resolve, reject);
    } catch (error) { reject(error); }
  });
}

async function targets() {
  return chromeCall(chrome.debugger.getTargets.bind(chrome.debugger));
}

async function tabs(query) {
  return chromeCall(chrome.tabs.query.bind(chrome.tabs), query);
}

async function request(path, body) {
  const response = await fetch(`${bridge}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Tabline is not connected.');
  return value;
}

function info(tab, target) { return { tabId: tab.id, targetId: target, windowId: tab.windowId, url: tab.url, title: tab.title }; }

function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}

function setBusy(value) { document.querySelectorAll('button').forEach((button) => { button.disabled = value; }); }

async function update() {
  current = (await tabs({ active: true, currentWindow: true }))[0];
  if (!current) throw new Error('There is no active tab.');
  const target = (await targets()).find((item) => item.tabId === current.id);
  targetId = target?.targetId;
  state = await request('/extension/status', info(current, targetId));
  $('title').textContent = current.title || 'Current tab';
  $('url').textContent = current.url || '';
  $('status').textContent = state.frozen ? 'This tab is showing a saved screenshot.' : state.freezable ? state.whitelisted ? 'This tab is on the freezer whitelist.' : 'This tab can be frozen into a local snapshot.' : 'This browser page cannot be frozen.';
  $('freeze').hidden = state.frozen || !state.freezable;
  $('return').hidden = !state.frozen;
  $('whitelist').hidden = state.frozen || !state.freezable;
  $('whitelist').textContent = state.whitelisted ? 'Remove from whitelist' : 'Whitelist this tab';
  $('close').hidden = false;
  $('freeze-all').hidden = false;
}

$('freeze').addEventListener('click', async () => {
  try { setBusy(true); const result = await request('/extension/freeze', info(current, targetId)); if (!result.shortUrl) throw new Error(result.skipped || 'This tab could not be frozen.'); await chromeCall(chrome.tabs.update.bind(chrome.tabs), current.id, { url: result.shortUrl }); window.close(); } catch (error) { setBusy(false); showError(error); }
});

$('return').addEventListener('click', async () => {
  try { setBusy(true); const result = await request('/extension/unfreeze', info(current, targetId)); await chromeCall(chrome.tabs.update.bind(chrome.tabs), current.id, { url: result.originalUrl }); window.close(); } catch (error) { setBusy(false); showError(error); }
});

$('whitelist').addEventListener('click', async () => {
  try { setBusy(true); await request('/extension/whitelist', { ...info(current, targetId), enabled: !state.whitelisted }); await update(); setBusy(false); } catch (error) { setBusy(false); showError(error); }
});

$('close').addEventListener('click', async () => {
  try { setBusy(true); await request('/extension/close', info(current, targetId)); window.close(); } catch (error) { setBusy(false); showError(error); }
});

$('freeze-all').addEventListener('click', async () => {
  try {
    setBusy(true);
    const allTabs = await tabs({});
    const allTargets = new Map((await targets()).filter((item) => item.tabId !== undefined).map((item) => [item.tabId, item.targetId]));
    const remainingTabs = allTabs.filter((tab) => tab.id !== current.id);
    const result = await request('/extension/freeze-all', { tabs: remainingTabs.map((tab) => info(tab, allTargets.get(tab.id))), exclude: info(current, targetId) });
    for (const item of result.items || []) { const tab = allTabs.find((candidate) => candidate.id === item.tabId); if (tab) await chromeCall(chrome.tabs.update.bind(chrome.tabs), tab.id, { url: item.shortUrl }); }
    $('status').textContent = `Frozen ${result.items?.length || 0} other tabs across ${result.windows || 0} windows. This tab was left alone.`;
    setBusy(false);
  } catch (error) { setBusy(false); showError(error); }
});

update().catch(showError);
