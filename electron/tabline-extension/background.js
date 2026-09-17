const bridgeUrl = 'http://127.0.0.1:17637/tab-groups';

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

async function sendSnapshot(tabIds = null) {
  if (!bridgeUrl) return;
  const targets = await targetMap();
  const tabs = await queryTabs();
  const fallbackColors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const payload = tabs.filter((tab) => tab.id !== undefined && (!tabIds || tabIds.has(tab.id))).map((tab) => ({
    targetId: targets.get(tab.id), tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, groupId: tab.groupId ?? -1,
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

chrome.tabs.onCreated.addListener(() => sendSnapshot());
chrome.tabs.onRemoved.addListener(() => sendSnapshot());
chrome.tabs.onAttached.addListener(() => sendSnapshot());
chrome.tabs.onDetached.addListener(() => sendSnapshot());
chrome.tabs.onUpdated.addListener(() => sendSnapshot());
chrome.tabs.onHighlighted.addListener(() => sendSnapshot());
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
setInterval(() => sendSnapshot(), 1000);
