const bridgeOrigin = 'http://127.0.0.1:17637';
const bridgeUrl = `${bridgeOrigin}/tab-groups`;
let restoring = false;
let snapshotSequence = 0;
const snapshotSource = crypto.randomUUID();

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
  const sequence = ++snapshotSequence;
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
  await fetch(bridgeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabs: payload, focusedWindowId: [...focusedWindows][0] ?? null, sequence, source: snapshotSource }) }).catch(() => {});
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

let mirroring = false;
async function checkMirror() {
  if (mirroring || restoring) return;
  mirroring = true;
  let mappings = [];
  try {
    const response = await fetch(`${bridgeOrigin}/mirror`);
    if (response.status !== 200) return;
    const plan = await response.json();
    const saved = (await chrome.storage.session.get('mirror')).mirror;
    const state = saved?.source === plan.sourceSessionId ? saved : { source: plan.sourceSessionId, tabs: {}, windows: {}, focus: null };
    const persist = () => chrome.storage.session.set({ mirror: state });
    const currentTabs = await queryTabs();
    const currentWindows = await queryWindows();
    const existing = new Map(currentTabs.map((tab) => [tab.id, tab]));
    const used = new Set();
    for (const source of plan.windows) {
      let windowId = state.windows[source.sourceWindowId];
      if (!currentWindows.some((window) => window.id === windowId)) {
        // Reuse the launch window only before any source has been mapped.
        const initial = Object.keys(state.windows).length === 0 && currentWindows[0];
        const created = initial || await callChrome(chrome.windows.create.bind(chrome.windows), { url: 'about:blank', focused: false });
        windowId = created.id;
        state.windows[source.sourceWindowId] = windowId;
        await persist();
      }
      mappings.push({ sourceWindowId: source.sourceWindowId, extensionWindowId: windowId });
      for (let index = 0; index < source.tabs.length; index++) {
        const sourceTab = source.tabs[index];
        let tab = existing.get(state.tabs[sourceTab.sourceId]);
        if (!tab) {
          tab = await callChrome(chrome.tabs.create.bind(chrome.tabs), { windowId, url: sourceTab.url, pinned: sourceTab.pinned, active: false });
          state.tabs[sourceTab.sourceId] = tab.id;
          await persist();
        }
        const update = {};
        if (tab.url !== sourceTab.url && tab.pendingUrl !== sourceTab.url) update.url = sourceTab.url;
        if (tab.pinned !== sourceTab.pinned) update.pinned = sourceTab.pinned;
        if (Object.keys(update).length) await callChrome(chrome.tabs.update.bind(chrome.tabs), tab.id, update);
        if (tab.windowId !== windowId || tab.index !== index) await callChrome(chrome.tabs.move.bind(chrome.tabs), tab.id, { windowId, index });
        used.add(tab.id);
      }
      const active = source.tabs.find((tab) => tab.active);
      if (active) await callChrome(chrome.tabs.update.bind(chrome.tabs), state.tabs[active.sourceId], { active: true });
    }
    // Keep a blank parking tab when the source has no portable web tabs, so the
    // dedicated browser remains available for subsequent remote changes.
    if (!used.size) {
      const parking = currentTabs.find((tab) => tab.url === 'about:blank') || await callChrome(chrome.tabs.create.bind(chrome.tabs), { url: 'about:blank' });
      used.add(parking.id);
    }
    const unwanted = (await queryTabs()).filter((tab) => !used.has(tab.id)).map((tab) => tab.id);
    if (unwanted.length) await callChrome(chrome.tabs.remove.bind(chrome.tabs), unwanted);
    const wantedSources = new Set(plan.windows.map((window) => window.sourceWindowId));
    for (const key of Object.keys(state.windows)) if (!wantedSources.has(key)) delete state.windows[key];
    const wantedTabs = new Set(plan.windows.flatMap((window) => window.tabs.map((tab) => tab.sourceId)));
    for (const key of Object.keys(state.tabs)) if (!wantedTabs.has(key)) delete state.tabs[key];
    const focused = plan.windows.find((window) => window.focused);
    const focusKey = focused ? `${focused.sourceWindowId}:${focused.tabs.find((tab) => tab.active)?.sourceId}` : null;
    if (focused && focusKey !== state.focus) await callChrome(chrome.windows.update.bind(chrome.windows), state.windows[focused.sourceWindowId], { focused: true });
    state.focus = focusKey;
    await persist();
    await sendSnapshot();
    await fetch(`${bridgeOrigin}/mirror-result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows: mappings }) });
  } catch (error) {
    await fetch(`${bridgeOrigin}/mirror-result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows: mappings, error: error.message }) }).catch(() => {});
  } finally { mirroring = false; }
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
setInterval(() => { sendSnapshot(); checkRestore(); checkMirror(); }, 1000);
