let bridge = 'http://127.0.0.1:17637';
let current;
let targetId;
let state;
let freezingEnabled = true;
let settingReady = false;
let pendingSetting = false;

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
  const saved = await chrome.storage.local.get('tablineBridgeOrigin');
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(saved.tablineBridgeOrigin || '')) bridge = saved.tablineBridgeOrigin;
  let response;
  try {
    response = await fetch(`${bridge}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
  } catch {
    const error = new Error('Tabline is not connected. Start Tabline and launch or track this browser session, then retry.');
    error.code = 'TABLINE_OFFLINE';
    throw error;
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Tabline is not connected.');
  return value;
}

function info(tab, target) { return { tabId: tab.id, targetId: target, windowId: tab.windowId, url: tab.url, title: tab.title }; }

function showError(error) {
  if (error.code === 'TABLINE_OFFLINE') {
    state = null;
    $('status').textContent = 'Tabline is not connected. Start Tabline and launch or track this browser session, then retry. Your freezing preference is saved locally.';
    $('reconnect').hidden = false;
    for (const id of ['freeze', 'return', 'whitelist', 'close', 'freeze-all']) $(id).hidden = true;
    setBusy(false);
    return;
  }
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}

function setBusy(value) {
  document.querySelectorAll('button').forEach((button) => { button.disabled = value || (!state && button.id !== 'reconnect'); });
  $('disable-freezing').disabled = value || !settingReady;
  if (!value && !freezingEnabled) {
    $('freeze').disabled = true;
    $('freeze-all').disabled = true;
  }
}

async function update() {
  current = (await tabs({ active: true, currentWindow: true }))[0];
  if (!current) throw new Error('There is no active tab.');
  $('title').textContent = current.title || 'Current tab';
  $('url').textContent = current.url || '';
  const target = (await targets().catch(() => [])).find((item) => item.tabId === current.id);
  targetId = target?.targetId;
  state = await request('/extension/status', info(current, targetId));
  if (!pendingSetting && typeof state.freezingEnabled === 'boolean') {
    freezingEnabled = state.freezingEnabled;
    await chrome.storage.local.set({ freezingEnabled });
  }
  $('title').textContent = current.title || 'Current tab';
  $('url').textContent = current.url || '';
  $('status').textContent = state.frozen ? 'This tab is showing a saved screenshot.' : state.freezable ? state.whitelisted ? 'This tab is on the freezer whitelist.' : 'This tab can be frozen into a local snapshot.' : 'This browser page cannot be frozen.';
  if (!state.frozen && !freezingEnabled) $('status').textContent = pendingSetting ? 'Freezing preference saved. Waiting for Tabline to reconnect.' : 'Freezing is disabled. Your tabs will stay open normally.';
  $('disable-freezing').checked = !freezingEnabled;
  $('freeze').hidden = state.frozen || !state.freezable;
  $('return').hidden = !state.frozen;
  $('whitelist').hidden = state.frozen || !state.freezable;
  $('whitelist').textContent = state.whitelisted ? 'Remove from whitelist' : 'Whitelist this tab';
  $('close').hidden = false;
  $('freeze-all').hidden = false;
  $('reconnect').hidden = true;
  $('error').hidden = true;
  setBusy(false);
}

$('reconnect').addEventListener('click', async () => {
  try { setBusy(true); await update(); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
});

$('disable-freezing').addEventListener('change', async () => {
  try {
    setBusy(true);
    $('error').hidden = true;
    const enabled = !$('disable-freezing').checked;
    await chrome.storage.local.set({ freezingEnabled: enabled, freezingPending: true });
    freezingEnabled = enabled;
    pendingSetting = true;
    try {
      await request('/extension/freezing-settings', { enabled });
      await chrome.storage.local.set({ freezingPending: false });
      pendingSetting = false;
      $('status').textContent = enabled ? 'Freezing is enabled.' : 'Freezing is disabled. Your tabs will stay open normally.';
    } catch {
      $('status').textContent = 'Preference saved in this browser. It will apply when Tabline reconnects. If Tabline is already running, restart it to load the updated freezer controls.';
    }
  } catch (error) {
    $('disable-freezing').checked = !freezingEnabled;
    showError(error);
  } finally { setBusy(false); }
});

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

async function initialize() {
  try {
    const saved = await chrome.storage.local.get(['freezingEnabled', 'freezingPending']);
    freezingEnabled = saved.freezingEnabled !== false;
    pendingSetting = saved.freezingPending === true;
    settingReady = true;
    $('disable-freezing').checked = !freezingEnabled;
    setBusy(false);
  } catch (error) { showError(error); }
  await update().catch(showError);
}

initialize();
