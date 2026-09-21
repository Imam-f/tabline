const bridgeOrigin = 'http://127.0.0.1:17637';
const bridgeUrl = `${bridgeOrigin}/tab-groups`;
let restoring = false;

async function targetMap() {
  try {
    if (!chrome.debugger?.getTargets) return new Map();
    const targets = await new Promise((resolve) => chrome.debugger.getTargets(resolve));
    return new Map(targets.filter((target) => target.type === 'page' && target.tabId !== undefined).map((target) => [target.tabId, target.targetId]));
  } catch { return new Map(); }
}

function queryTabs() {
  try {
    const result = chrome.tabs.query({});
    if (result?.then) return result;
  } catch {}
  return new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve(tabs || [])));
}

function queryWindows() {
  try {
    const result = chrome.windows.getAll({ populate: false });
    if (result?.then) return result;
  } catch {}
  return new Promise((resolve) => chrome.windows.getAll({ populate: false }, (windows) => resolve(windows || [])));
}

async function sendSnapshot(tabIds = null) {
  if (!bridgeUrl) return;
  const targets = await targetMap();
  const tabs = await queryTabs();
  const windows = await queryWindows();
  const focusedWindows = new Set(windows.filter((window) => window.focused).map((window) => window.id));
  const fallbackColors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const payload = tabs.filter((tab) => tab.id !== undefined && (!tabIds || tabIds.has(tab.id))).map((tab) => ({
    targetId: targets.get(tab.id), tabId: tab.id, windowId: tab.windowId, index: tab.index, pinned: !!tab.pinned, active: !!tab.active, focused: focusedWindows.has(tab.windowId), url: tab.url, title: tab.title, groupId: tab.groupId ?? -1,
    groupTitle: tab.groupId > -1 ? `Group ${tab.groupId}` : null,
    groupColor: tab.groupId > -1 ? fallbackColors[tab.groupId % fallbackColors.length] : null,
    groupCollapsed: false,
  }));
  for (const item of payload) {
    if (item.groupId > -1 && chrome.tabGroups?.get) {
      try { const group = await new Promise((resolve, reject) => chrome.tabGroups.get(item.groupId, (value) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(value))); Object.assign(item, { groupTitle: group.title || null, groupColor: group.color || null, groupCollapsed: !!group.collapsed }); } catch {}
    }
  }
  fetch(bridgeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabs: payload }) }).catch(() => {});
}

function callChrome(method, ...args) {
  return new Promise((resolve, reject) => method(...args, (value) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(value)));
}

async function executeRestore(plan) {
  const created = new Map();
  const restoredWindows = [];
  const errors = [];
  let opened = 0;
  for (let windowIndex = 0; windowIndex < plan.windows.length; windowIndex++) {
    const sourceWindow = plan.windows[windowIndex];
    let windowId;
    let firstTab;
    try {
      if (windowIndex === 0) {
        const current = await callChrome(chrome.windows.getCurrent.bind(chrome.windows), { populate: true });
        windowId = current.id;
        firstTab = current.tabs.find((tab) => tab.active) || current.tabs[0];
        await callChrome(chrome.tabs.update.bind(chrome.tabs), firstTab.id, { url: sourceWindow.tabs[0].url, pinned: sourceWindow.tabs[0].pinned, active: false });
      } else {
        const browserWindow = await callChrome(chrome.windows.create.bind(chrome.windows), { url: sourceWindow.tabs[0].url, focused: false });
        windowId = browserWindow.id;
        firstTab = browserWindow.tabs[0];
        if (sourceWindow.tabs[0].pinned) await callChrome(chrome.tabs.update.bind(chrome.tabs), firstTab.id, { pinned: true });
      }
      created.set(sourceWindow.tabs[0].sourceId, { id: firstTab.id, windowId });
      restoredWindows.push({ sourceWindowId: sourceWindow.sourceWindowId, extensionWindowId: windowId });
      opened++;
    } catch (error) { errors.push(error.message); continue; }

    for (const sourceTab of sourceWindow.tabs.slice(1)) {
      try {
        const opener = created.get(sourceTab.openerSourceId);
        const tab = await callChrome(chrome.tabs.create.bind(chrome.tabs), { windowId, index: Math.min(sourceTab.index, 10000), url: sourceTab.url, pinned: sourceTab.pinned, active: false, ...(opener?.windowId === windowId ? { openerTabId: opener.id } : {}) });
        created.set(sourceTab.sourceId, { id: tab.id, windowId });
        opened++;
      } catch (error) { errors.push(error.message); }
    }

    const grouped = new Map();
    for (const sourceTab of sourceWindow.tabs) {
      if (sourceTab.groupId === null || !created.has(sourceTab.sourceId)) continue;
      const key = String(sourceTab.groupId);
      if (!grouped.has(key)) grouped.set(key, { sourceTab, tabIds: [] });
      grouped.get(key).tabIds.push(created.get(sourceTab.sourceId).id);
    }
    for (const { sourceTab, tabIds } of grouped.values()) {
      try {
        const groupId = await callChrome(chrome.tabs.group.bind(chrome.tabs), { tabIds, createProperties: { windowId } });
        await callChrome(chrome.tabGroups.update.bind(chrome.tabGroups), groupId, { title: sourceTab.groupTitle || '', color: sourceTab.groupColor || 'grey', collapsed: sourceTab.groupCollapsed });
      } catch (error) { errors.push(error.message); }
    }
    const active = sourceWindow.tabs.find((tab) => tab.active && created.has(tab.sourceId)) || sourceWindow.tabs.find((tab) => created.has(tab.sourceId));
    if (active) await callChrome(chrome.tabs.update.bind(chrome.tabs), created.get(active.sourceId).id, { active: true }).catch((error) => errors.push(error.message));
  }
  await fetch(`${bridgeOrigin}/restore-result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opened, failed: errors.length, groupsRestored: true, windows: restoredWindows, warnings: errors }) });
  sendSnapshot();
}

async function checkRestore() {
  if (restoring) return;
  try {
    const response = await fetch(`${bridgeOrigin}/restore`);
    if (response.status !== 200) return;
    restoring = true;
    await executeRestore(await response.json());
  } catch {} finally { restoring = false; }
}

chrome.tabs.onCreated.addListener(() => sendSnapshot());
chrome.tabs.onRemoved.addListener(() => sendSnapshot());
chrome.tabs.onAttached.addListener(() => sendSnapshot());
chrome.tabs.onDetached.addListener(() => sendSnapshot());
chrome.tabs.onUpdated.addListener(() => sendSnapshot());
chrome.tabs.onActivated.addListener(() => sendSnapshot());
chrome.tabs.onHighlighted.addListener(() => sendSnapshot());
chrome.windows.onFocusChanged.addListener(() => sendSnapshot());
chrome.tabs.onMoved.addListener(() => sendSnapshot());
chrome.tabs.onReplaced.addListener(() => sendSnapshot());
chrome.tabGroups?.onCreated?.addListener(() => sendSnapshot());
chrome.tabGroups?.onUpdated?.addListener(() => sendSnapshot());
chrome.tabGroups?.onRemoved?.addListener(() => sendSnapshot());
chrome.runtime.onInstalled.addListener(() => sendSnapshot());
chrome.runtime.onStartup.addListener(() => sendSnapshot());
chrome.alarms?.onAlarm?.addListener((alarm) => { if (alarm.name === 'tabline-group-refresh') sendSnapshot(); });
chrome.alarms?.create?.('tabline-group-refresh', { periodInMinutes: 1 });
sendSnapshot();
checkRestore();
setInterval(() => { sendSnapshot(); checkRestore(); }, 1000);
