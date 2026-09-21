const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { CDP } = require('./cdp.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bridgeOrigin = 'http://127.0.0.1:17637';
const inactivityScreenshotAfter = 5 * 60 * 1000;
const inactivityFreezeAfter = 10 * 60 * 1000;

function freezableUrl(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin !== bridgeOrigin; } catch { return false; }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function browserCandidates(platform = process.platform, env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pf = env.PROGRAMFILES || 'C:\\Program Files';
  const pfx = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  if (platform === 'win32') return {
    helium: [path.join(local, 'Helium', 'Application', 'helium.exe'), path.join(local, 'Helium', 'helium.exe'), path.join(pf, 'Helium', 'Application', 'helium.exe'), path.join(pf, 'Helium', 'helium.exe')],
    chrome: [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  };
  if (platform === 'darwin') return {
    helium: ['/Applications/Helium.app/Contents/MacOS/Helium', path.join(os.homedir(), 'Applications/Helium.app/Contents/MacOS/Helium')],
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
  };
  return {
    helium: ['/usr/bin/helium', '/usr/local/bin/helium', '/opt/helium/helium', path.join(os.homedir(), '.local/bin/helium')],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  };
}

function detectBrowsers() {
  return Object.entries(browserCandidates()).map(([id, candidates]) => ({ id, name: id === 'helium' ? 'Helium' : 'Google Chrome', path: candidates.find((candidate) => fs.existsSync(candidate)) || null }));
}

function validStartUrl(input) {
  if (!input || input === 'about:blank') return 'about:blank';
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a full URL, such as https://example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http:// or https:// starting URL.');
  return url.href;
}

function upsertTarget(session, info, now = Date.now()) {
  if (info.type !== 'page') return null;
  if (info.url?.startsWith('chrome-extension://')) {
    const extensionTab = session.tabs.findIndex((item) => item.id === info.targetId);
    if (extensionTab >= 0) session.tabs.splice(extensionTab, 1);
    return null;
  }
  let tab = session.tabs.find((item) => item.id === info.targetId);
  if (!tab) {
    tab = { id: info.targetId, title: info.title || 'New tab', url: info.url || 'about:blank', openedAt: now, closedAt: null, openAtEnd: true, openerId: info.openerId || null, windowId: info.windowId || null, desktopId: info.desktopId || 'unknown', windowHistory: [], extensionTabId: null, extensionWindowId: null, tabIndex: null, pinned: false, active: false, focused: false, lastActiveAt: null, inactiveScreenshotAt: null, frozen: false, frozenSlug: null, originalUrl: null, orderHistory: [], groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [], thumbnail: null, thumbnailAt: null, navigations: [] };
    session.tabs.push(tab);
  }
  if (info.openerId) tab.openerId = info.openerId;
  if (info.windowId) tab.windowId = info.windowId;
  if (info.desktopId) tab.desktopId = info.desktopId;
  if (info.url && (tab.navigations.length === 0 || tab.url !== info.url)) {
    tab.navigations.push({ url: info.url, title: info.title || info.url, at: now });
  } else if (info.title && tab.navigations.length) {
    tab.navigations[tab.navigations.length - 1].title = info.title;
  }
  tab.title = info.title || tab.title;
  tab.url = info.url || tab.url;
  return tab;
}

function restoreUrl(input) {
  if (input === 'about:blank') return input;
  try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function buildRestorePlan(session, at = null) {
  const hasOpenSnapshot = session.tabs.some((tab) => typeof tab.openAtEnd === 'boolean');
  let candidates = Number.isFinite(at)
    ? session.tabs.filter((tab) => tab.openedAt <= at && (!tab.closedAt || tab.closedAt > at || (at >= session.endedAt && tab.openAtEnd !== false)))
    : hasOpenSnapshot
    ? session.tabs.filter((tab) => tab.openAtEnd)
    : session.tabs.filter((tab) => session.endedAt && tab.closedAt && Math.abs(tab.closedAt - session.endedAt) < 2000);
  if (!candidates.length && !hasOpenSnapshot) candidates = session.tabs;
  const windows = new Map();
  let skipped = 0;
  for (const tab of candidates.slice(0, 250)) {
    const url = restoreUrl(tab.url);
    if (!url) { skipped++; continue; }
    const sourceWindowId = String(tab.extensionWindowId ?? tab.windowId ?? 'default');
    if (!windows.has(sourceWindowId)) windows.set(sourceWindowId, { sourceWindowId, desktopId: tab.desktopId || 'unknown', bounds: tab.windowBounds || null, tabs: [] });
    windows.get(sourceWindowId).tabs.push({ sourceId: tab.id, url, title: tab.title, index: Number.isInteger(tab.tabIndex) ? tab.tabIndex : Number.MAX_SAFE_INTEGER, pinned: !!tab.pinned, active: !!tab.active, openerSourceId: tab.openerId || null, groupId: tab.groupId, groupTitle: tab.groupTitle, groupColor: tab.groupColor, groupCollapsed: !!tab.groupCollapsed, openedAt: tab.openedAt });
  }
  for (const window of windows.values()) window.tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index || a.openedAt - b.openedAt);
  return { sourceSessionId: session.id, windows: [...windows.values()].filter((window) => window.tabs.length), requested: candidates.length, skipped };
}

function compareSavedSessions(a, b) {
  const aOrder = Number.isInteger(a.order) ? a.order : null;
  const bOrder = Number.isInteger(b.order) ? b.order : null;
  if (aOrder === null && bOrder !== null) return -1;
  if (aOrder !== null && bOrder === null) return 1;
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
  return b.startedAt - a.startedAt;
}

class BrowserController extends EventEmitter {
  constructor(dataDir, extensionPath = path.join(__dirname, 'tabline-extension')) {
    super();
    this.dataDir = dataDir;
    this.freezerFile = path.join(dataDir, 'freezer.json');
    this.freezer = this.readFreezer();
    this.status = 'idle';
    this.session = null;
    this.client = null;
    this.process = null;
    this.captureBusy = false;
    this.captureTimers = new Map();
    this.inactivityInterval = null;
    this.inactivityBusy = false;
    this.debugPort = null;
    this.lastError = null;
    this.persistTimer = null;
    this.extensionPath = extensionPath;
    this.groupBridge = null;
    this.groupToken = null;
    this.pendingRestore = null;
    this.restoreResolve = null;
    this.closingBrowser = false;
    fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  }

  snapshot() { return { status: this.status, session: this.session, debugPort: this.debugPort, error: this.lastError }; }
  publish() {
    this.emit('change', this.snapshot());
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 1200);
  }
  persist() {
    if (!this.session) return;
    const destination = path.join(this.dataDir, 'sessions', `${this.session.id}.json`);
    try {
      fs.writeFileSync(`${destination}.tmp`, JSON.stringify(this.session));
      fs.renameSync(`${destination}.tmp`, destination);
    } catch (error) { this.emit('storage-error', error.message); }
  }

  readFreezer() {
    try {
      const value = JSON.parse(fs.readFileSync(this.freezerFile, 'utf8'));
      return { entries: Array.isArray(value.entries) ? value.entries : [], whitelist: Array.isArray(value.whitelist) ? value.whitelist : [] };
    } catch { return { entries: [], whitelist: [] }; }
  }

  persistFreezer() {
    try {
      fs.writeFileSync(`${this.freezerFile}.tmp`, JSON.stringify(this.freezer));
      fs.renameSync(`${this.freezerFile}.tmp`, this.freezerFile);
    } catch (error) { this.emit('storage-error', error.message); }
  }

  freezerUrl(slug) { return `${bridgeOrigin}/s/${encodeURIComponent(slug)}`; }
  entryForSlug(slug) { return this.freezer.entries.find((entry) => entry.slug === slug) || null; }
  entryForUrl(url) {
    return this.freezer.entries.find((entry) => entry.active && this.freezerUrl(entry.slug) === url) || null;
  }
  entryForTab(tab) {
    if (!tab) return null;
    return (tab.frozenSlug && this.entryForSlug(tab.frozenSlug)) || this.freezer.entries.find((entry) => entry.active && entry.targetId === tab.id) || null;
  }
  tabForExtensionInfo(info = {}) {
    const tabs = this.session?.tabs || [];
    return tabs.find((tab) => info.targetId && tab.id === info.targetId)
      || tabs.find((tab) => Number.isInteger(info.tabId) && tab.extensionTabId === info.tabId && (!Number.isInteger(info.windowId) || tab.extensionWindowId === info.windowId))
      || tabs.find((tab) => tab.windowId === String(info.windowId) && tab.url === info.url && tab.title === info.title)
      || null;
  }
  isWhitelisted(url) { return this.freezer.whitelist.includes(url); }

  listSessions() {
    return fs.readdirSync(path.join(this.dataDir, 'sessions')).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'sessions', name), 'utf8'));
        return [{ id: session.id, name: session.name, startedAt: session.startedAt, endedAt: session.endedAt, browser: session.browser, tabCount: session.tabs.length, folderId: session.folderId || null, order: Number.isInteger(session.order) ? session.order : null }];
      } catch { return []; }
    }).sort((a, b) => a.folderId === b.folderId ? compareSavedSessions(a, b) : b.startedAt - a.startedAt);
  }

  foldersFile() { return path.join(this.dataDir, 'folders.json'); }
  readFolders() { try { const items = JSON.parse(fs.readFileSync(this.foldersFile(), 'utf8')); return Array.isArray(items) ? items : []; } catch { return []; } }
  writeFolders(folders) { const file = this.foldersFile(); fs.writeFileSync(`${file}.tmp`, JSON.stringify(folders)); fs.renameSync(`${file}.tmp`, file); }
  listFolders() { return this.readFolders().sort((a, b) => a.createdAt - b.createdAt); }
  createFolder(name, parentId = null) {
    const trimmed = String(name || '').trim().slice(0, 60);
    if (!trimmed) throw new Error('Enter a folder name.');
    if (parentId && !/^[a-f0-9-]{36}$/.test(parentId)) throw new Error('Invalid folder ID');
    const folders = this.readFolders();
    if (parentId && !folders.some((folder) => folder.id === parentId)) throw new Error('Folder not found.');
    const parentKey = parentId || null;
    if (folders.some((folder) => (folder.parentId || null) === parentKey && folder.name.toLowerCase() === trimmed.toLowerCase())) throw new Error('A folder with that name already exists here.');
    const folder = { id: randomUUID(), name: trimmed, createdAt: Date.now(), parentId: parentKey };
    folders.push(folder);
    this.writeFolders(folders);
    return folder;
  }
  renameFolder(id, name) {
    const trimmed = String(name || '').trim().slice(0, 60);
    if (!trimmed) throw new Error('Enter a folder name.');
    const folders = this.readFolders();
    const folder = folders.find((item) => item.id === id);
    if (!folder) throw new Error('Folder not found.');
    if (folders.some((item) => item.id !== id && (item.parentId || null) === (folder.parentId || null) && item.name.toLowerCase() === trimmed.toLowerCase())) throw new Error('A folder with that name already exists here.');
    folder.name = trimmed;
    this.writeFolders(folders);
    return folder;
  }
  setFolderParent(id, parentId) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid folder ID');
    if (parentId && !/^[a-f0-9-]{36}$/.test(parentId)) throw new Error('Invalid folder ID');
    const folders = this.readFolders();
    const folder = folders.find((item) => item.id === id);
    if (!folder) throw new Error('Folder not found.');
    if (parentId) {
      if (parentId === id) throw new Error('A folder cannot be inside itself.');
      if (!folders.some((item) => item.id === parentId)) throw new Error('Folder not found.');
      let current = folders.find((item) => item.id === parentId);
      while (current && current.parentId) {
        if (current.parentId === id) throw new Error('A folder cannot be moved inside one of its own subfolders.');
        current = folders.find((item) => item.id === current.parentId);
      }
    }
    folder.parentId = parentId || null;
    this.writeFolders(folders);
    return folder;
  }
  deleteFolder(id) {
    const folders = this.readFolders();
    const toDelete = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of folders) {
        if (item.parentId && toDelete.has(item.parentId) && !toDelete.has(item.id)) { toDelete.add(item.id); grew = true; }
      }
    }
    this.writeFolders(folders.filter((item) => !toDelete.has(item.id)));
    const dir = path.join(this.dataDir, 'sessions');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const session = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (session.folderId && toDelete.has(session.folderId)) { session.folderId = null; fs.writeFileSync(full, JSON.stringify(session)); }
      } catch {}
    }
  }
  setSessionFolder(sessionId, folderId) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('Invalid session ID');
    if (folderId && !/^[a-f0-9-]{36}$/.test(folderId)) throw new Error('Invalid folder ID');
    const full = path.join(this.dataDir, 'sessions', `${sessionId}.json`);
    const session = JSON.parse(fs.readFileSync(full, 'utf8'));
    const nextFolderId = folderId || null;
    if ((session.folderId || null) !== nextFolderId) session.order = null;
    session.folderId = nextFolderId;
    fs.writeFileSync(full, JSON.stringify(session));
  }

  reorderSession(sessionId, targetSessionId, before) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId) || !/^[a-f0-9-]{36}$/.test(targetSessionId)) throw new Error('Invalid session ID');
    if (sessionId === targetSessionId) return;
    const dir = path.join(this.dataDir, 'sessions');
    const records = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const file = path.join(dir, name);
        return [{ file, session: JSON.parse(fs.readFileSync(file, 'utf8')) }];
      } catch { return []; }
    });
    const source = records.find((record) => record.session.id === sessionId);
    const target = records.find((record) => record.session.id === targetSessionId);
    if (!source || !target) throw new Error('Session not found.');

    const sourceFolderId = source.session.folderId || null;
    const targetFolderId = target.session.folderId || null;
    source.session.folderId = targetFolderId;
    const targetItems = records.filter((record) => (record.session.folderId || null) === targetFolderId && record.session.id !== sessionId).sort((a, b) => compareSavedSessions(a.session, b.session));
    const targetIndex = targetItems.findIndex((record) => record.session.id === targetSessionId);
    targetItems.splice(Math.max(0, targetIndex + (before ? 0 : 1)), 0, source);
    targetItems.forEach((record, index) => { record.session.order = index; });

    if (sourceFolderId !== targetFolderId) {
      records.filter((record) => (record.session.folderId || null) === sourceFolderId && record.session.id !== sessionId).sort((a, b) => compareSavedSessions(a.session, b.session)).forEach((record, index) => { record.session.order = index; });
    }
    const changed = new Set(sourceFolderId === targetFolderId ? targetItems : [...targetItems, ...records.filter((record) => (record.session.folderId || null) === sourceFolderId && record.session.id !== sessionId)]);
    for (const record of changed) {
      fs.writeFileSync(`${record.file}.tmp`, JSON.stringify(record.session));
      fs.renameSync(`${record.file}.tmp`, record.file);
    }
  }

  renameSession(id, name) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
    const trimmed = String(name || '').trim().slice(0, 80);
    if (!trimmed) throw new Error('Enter a session name.');
    const full = path.join(this.dataDir, 'sessions', `${id}.json`);
    const session = JSON.parse(fs.readFileSync(full, 'utf8'));
    session.name = trimmed;
    fs.writeFileSync(full, JSON.stringify(session));
  }

  deleteSession(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
    fs.rmSync(path.join(this.dataDir, 'sessions', `${id}.json`), { force: true });
  }

  loadSession(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
    const session = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'sessions', `${id}.json`), 'utf8'));
    session.tabs.forEach((tab) => { tab.windowHistory ||= []; tab.desktopId ||= 'unknown'; tab.windowId ||= null; tab.extensionTabId ??= null; tab.extensionWindowId ??= null; tab.tabIndex ??= null; tab.pinned ||= false; tab.active ||= false; tab.focused ||= false; tab.lastActiveAt ??= null; tab.inactiveScreenshotAt ??= null; tab.frozen ||= false; tab.frozenSlug ??= null; tab.originalUrl ??= null; tab.orderHistory ||= []; tab.groupId ??= null; tab.groupTitle ??= null; tab.groupColor ??= null; tab.groupCollapsed ||= false; tab.groupHistory ||= []; });
    // A session interrupted by an app/process crash has no explicit end time.
    if (!session.endedAt && session.id !== this.session?.id) {
      session.endedAt = Math.max(session.startedAt, ...session.tabs.flatMap((tab) => [tab.openedAt, tab.closedAt || 0, tab.thumbnailAt || 0, ...tab.navigations.map((nav) => nav.at)]));
      session.tabs.forEach((tab) => { tab.closedAt ||= session.endedAt; });
    }
    return session;
  }

  async launch(options = {}) {
    if (this.status === 'live' || this.status === 'launching' || this.status === 'stopping') throw new Error('A browser session is already running.');
    const browser = options.browser === 'chrome' ? 'chrome' : 'helium';
    const executable = options.executable || detectBrowsers().find((item) => item.id === browser)?.path;
    if (!executable || !fs.existsSync(executable)) throw new Error(`${browser === 'helium' ? 'Helium' : 'Chrome'} was not found. Choose its executable in the launch settings.`);
    const url = validStartUrl(options.url);
    this.lastError = null;
    this.closingBrowser = false;
    this.status = 'launching';
    this.publish();
    const profile = path.join(this.dataDir, 'profiles', browser);
    fs.mkdirSync(profile, { recursive: true });
    const runtimeExtensionPath = path.join(profile, 'tabline-companion');
    fs.rmSync(runtimeExtensionPath, { recursive: true, force: true });
    fs.cpSync(this.extensionPath, runtimeExtensionPath, { recursive: true });
    const portFile = path.join(profile, 'DevToolsActivePort');
    try { fs.unlinkSync(portFile); } catch {}
    let launchError;
    let exited = false;
    try {
      await this.startGroupBridge();
      const child = spawn(executable, [
        '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--enable-automation',
        `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-background-mode', '--new-window',
        '--enable-extensions', `--load-extension=${runtimeExtensionPath}`,
        ...(process.env.TABLINE_BROWSER_LOG ? ['--enable-logging=stderr', '--vmodule=extensions*=2'] : []),
        url,
      ], { stdio: process.env.TABLINE_BROWSER_LOG ? 'inherit' : 'ignore', windowsHide: false });
      this.process = child;
      child.once('error', (error) => { launchError = error; });
      child.once('exit', () => { exited = true; if (this.process === child && (this.status === 'live' || this.status === 'stopping')) this.finish(); });
      let endpoint;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        if (exited) throw new Error('The browser exited before debugging was ready. Check the executable and close any browser using the Tabline profile.');
        try {
          const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
          if (/^\d+$/.test(port) && wsPath?.startsWith('/devtools/browser/')) {
            this.debugPort = Number(port);
            endpoint = `ws://127.0.0.1:${port}${wsPath}`;
            break;
          }
        } catch {}
        await delay(150);
      }
      if (!endpoint) throw new Error('The browser did not expose a debug connection within 15 seconds.');
      this.client = new CDP(endpoint);
      await this.client.connect();
      this.session = { id: randomUUID(), name: options.name?.trim().slice(0, 80) || 'Untitled session', browser, startedAt: Date.now(), endedAt: null, tabs: [] };
      this.client.on('Target.targetCreated', ({ targetInfo }) => this.onTarget(targetInfo));
      this.client.on('Target.targetInfoChanged', ({ targetInfo }) => this.onTarget(targetInfo));
      this.client.on('Target.targetDestroyed', ({ targetId }) => {
        const tab = this.session?.tabs.find((item) => item.id === targetId);
        if (tab && !tab.closedAt) { tab.closedAt = Date.now(); if (!this.closingBrowser) tab.openAtEnd = false; this.publish(); }
        clearTimeout(this.captureTimers.get(targetId));
        this.captureTimers.delete(targetId);
      });
      this.client.on('disconnect', () => this.finish());
      this.status = 'live';
      await this.client.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await this.client.send('Target.getTargets');
      targetInfos.forEach((info) => this.onTarget(info));
      this.interval = setInterval(() => this.captureAll(), 60000);
      this.locationInterval = setInterval(() => this.refreshAllTargetLocations().catch(() => {}), 1000);
      this.inactivityInterval = setInterval(() => this.checkInactiveTabs().catch(() => {}), 1000);
      await this.refreshAllTargetLocations();
      this.publish();
      return this.snapshot();
    } catch (error) {
      this.client?.close();
      this.process?.kill();
      this.finish();
      this.status = 'error';
      this.lastError = error.message;
      this.publish();
      throw error;
    }
  }

  onTarget(info) {
    if (!this.session) return;
    if (info.type === 'page' && info.url?.startsWith('chrome-extension://')) {
      const index = this.session.tabs.findIndex((item) => item.id === info.targetId);
      if (index >= 0) { this.session.tabs.splice(index, 1); this.publish(); }
      return;
    }
    const previous = this.session.tabs.find((tab) => tab.id === info.targetId);
    const frozenEntry = this.entryForUrl(info.url);
    const previousFrozenEntry = this.entryForTab(previous);
    const shouldCapture = !frozenEntry && (!previous || previous.url !== info.url || previous.title !== info.title) && !previous?.inactiveScreenshotAt;
    const tab = upsertTarget(this.session, info);
    if (!tab) return;
    if (frozenEntry) {
      tab.frozen = true;
      tab.frozenSlug = frozenEntry.slug;
      tab.originalUrl = frozenEntry.originalUrl;
      tab.title = frozenEntry.title || tab.title;
      if (frozenEntry.screenshot) {
        tab.thumbnail = frozenEntry.screenshot;
        tab.thumbnailAt = frozenEntry.updatedAt || frozenEntry.createdAt;
      }
    } else if (previousFrozenEntry && previous?.frozen && info.url !== this.freezerUrl(previousFrozenEntry.slug)) {
      previousFrozenEntry.active = false;
      tab.frozen = false;
      tab.frozenSlug = null;
      tab.originalUrl = null;
      this.persistFreezer();
    }
    this.refreshTargetLocation(tab).then(() => this.publish()).catch(() => {});
    this.publish();
    // Avoid repainting the page the user is currently viewing.
    if (shouldCapture && !tab.active) {
      clearTimeout(this.captureTimers.get(tab.id));
      this.captureTimers.set(tab.id, setTimeout(() => {
        this.captureTimers.delete(tab.id);
        this.capture(tab.id).catch(() => {});
      }, 1600));
    }
  }

  frozenPage(entry) {
    const screenshot = typeof entry.screenshot === 'string' && entry.screenshot.startsWith('data:image/') ? entry.screenshot : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(entry.title || 'Frozen tab')}</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#f5f1ea;color:#2b302f;font-family:Inter,Segoe UI,Arial,sans-serif}body{padding:40px 28px 130px}.shell{max-width:1120px;margin:auto}.eyebrow{font-size:11px;letter-spacing:2px;color:#887968;font-weight:700}.heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin:10px 0 26px}.heading h1{font-size:clamp(22px,4vw,42px);line-height:1.08;letter-spacing:-1.5px;margin:0;max-width:800px}.url{color:#887968;font-size:13px;word-break:break-all;margin-top:10px}.preview{background:#fff;border:1px solid #e2d9cd;border-radius:16px;padding:12px;box-shadow:0 20px 55px #654d3317}.preview img{display:block;width:100%;height:auto;border-radius:9px}.empty{min-height:300px;display:grid;place-items:center;color:#887968}.return{position:fixed;z-index:2;left:50%;bottom:24px;transform:translateX(-50%);border:1px solid #3f554c;background:#314840;color:#f6f4ed;border-radius:999px;padding:15px 24px;font:600 15px Segoe UI,Arial,sans-serif;box-shadow:0 12px 30px #31484042;cursor:pointer}.return:hover{background:#253a33}.return:disabled{opacity:.6;cursor:wait}@media(max-width:600px){body{padding:24px 14px 112px}.heading{display:block}.url{font-size:11px}.return{width:calc(100% - 28px);bottom:14px}}</style></head><body><main class="shell"><div class="eyebrow">TABLINE SNAPSHOT</div><div class="heading"><div><h1>${escapeHtml(entry.title || 'Frozen tab')}</h1><div class="url">${escapeHtml(entry.originalUrl)}</div></div></div><div class="preview">${screenshot ? `<img src="${screenshot}" alt="Screenshot of ${escapeHtml(entry.title || 'the frozen tab')}">` : '<div class="empty">No screenshot was available for this tab.</div>'}</div></main><button class="return" id="return">Return to original page</button><script>const button=document.getElementById('return');button.addEventListener('click',async()=>{button.disabled=true;button.textContent='Returning...';try{const response=await fetch('/unfreeze/${encodeURIComponent(entry.slug)}',{method:'POST'});if(!response.ok)throw new Error('Unable to restore this tab');const result=await response.json();location.href=result.originalUrl}catch(error){button.disabled=false;button.textContent=error.message}});</script></body></html>`;
  }

  async startGroupBridge() {
    this.groupToken = randomUUID();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    const sendJson = (response, status, value) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const readJson = (request) => new Promise((resolve, reject) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) reject(new Error('Request too large')); });
      request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
      request.on('error', reject);
    });
    this.groupBridge = http.createServer(async (request, response) => {
      if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
      try {
        if (request.method === 'GET' && request.url === '/restore') {
          if (!this.pendingRestore || this.pendingRestore.delivered) { response.writeHead(204, headers); response.end(); return; }
          this.pendingRestore.delivered = true;
          sendJson(response, 200, this.pendingRestore.plan);
          return;
        }
        const frozenMatch = request.url?.match(/^\/s\/([^/?#]+)$/);
        if (request.method === 'GET' && frozenMatch) {
          const entry = this.entryForSlug(decodeURIComponent(frozenMatch[1]));
          if (!entry) { response.writeHead(404, headers); response.end('Frozen page not found'); return; }
          response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(this.frozenPage(entry));
          return;
        }
        const unfreezeMatch = request.url?.match(/^\/unfreeze\/([^/?#]+)$/);
        if (request.method === 'POST' && unfreezeMatch) { sendJson(response, 200, this.unfreezeSlug(decodeURIComponent(unfreezeMatch[1]))); return; }
        if (request.method !== 'POST') { response.writeHead(404, headers); response.end(); return; }
        const message = await readJson(request);
        if (request.url === '/restore-result') {
          this.restoreResolve?.(message);
          this.restoreResolve = null;
          response.writeHead(204, headers); response.end();
        } else if (request.url === '/tab-groups') {
          for (const groupTab of Array.isArray(message.tabs) ? message.tabs : []) this.onGroupInfo(groupTab);
          response.writeHead(204, headers); response.end();
        } else if (request.url === '/extension/status') {
          sendJson(response, 200, this.freezerStatus(message));
        } else if (request.url === '/extension/freeze') {
          sendJson(response, 200, await this.freezeTab(message));
        } else if (request.url === '/extension/freeze-all') {
          sendJson(response, 200, await this.freezeAllTabs(Array.isArray(message.tabs) ? message.tabs : [], message.exclude));
        } else if (request.url === '/extension/close') {
          await this.closeTabByInfo(message);
          sendJson(response, 200, { closed: true });
        } else if (request.url === '/extension/whitelist') {
          sendJson(response, 200, this.setWhitelist(message, message.enabled !== false));
        } else if (request.url === '/extension/unfreeze') {
          sendJson(response, 200, this.unfreezeTab(message));
        } else {
          response.writeHead(404, headers); response.end();
        }
      } catch (error) { sendJson(response, 400, { error: error.message || 'Request failed' }); }
    });
    await new Promise((resolve, reject) => { this.groupBridge.once('error', reject); this.groupBridge.listen(17637, '127.0.0.1', resolve); });
  }

  onGroupInfo(info) {
    const tabs = this.session?.tabs || [];
    const unique = (candidates) => candidates.length === 1 ? candidates[0] : null;
    const tab = tabs.find((item) => item.id === info.targetId)
      || unique(tabs.filter((item) => item.windowId === String(info.windowId) && item.url === info.url && item.title === info.title))
      || unique(tabs.filter((item) => item.windowId === String(info.windowId) && item.url === info.url))
      || unique(tabs.filter((item) => item.url === info.url && item.title === info.title))
      || unique(tabs.filter((item) => item.url === info.url));
    if (!tab) return;
    const groupId = Number.isInteger(info.groupId) && info.groupId >= 0 ? info.groupId : null;
    const changed = tab.groupId !== groupId || tab.groupTitle !== (info.groupTitle || null) || tab.groupColor !== (info.groupColor || null) || tab.groupCollapsed !== (info.groupCollapsed || false);
    const orderChanged = Number.isInteger(info.index) && (tab.tabIndex !== info.index || tab.extensionWindowId !== info.windowId);
    const now = Date.now();
    const wasActive = tab.active === true;
    const nextActive = typeof info.active === 'boolean' ? info.active : wasActive;
    tab.extensionTabId = Number.isInteger(info.tabId) ? info.tabId : tab.extensionTabId ?? null;
    tab.extensionWindowId = Number.isInteger(info.windowId) ? info.windowId : tab.extensionWindowId ?? null;
    tab.tabIndex = Number.isInteger(info.index) ? info.index : tab.tabIndex ?? null;
    tab.pinned = typeof info.pinned === 'boolean' ? info.pinned : !!tab.pinned;
    tab.active = nextActive;
    tab.focused = typeof info.focused === 'boolean' ? info.focused : !!tab.focused;
    if (nextActive && (!wasActive || !tab.lastActiveAt)) {
      tab.lastActiveAt = now;
      tab.inactiveScreenshotAt = null;
    } else if (!nextActive && !tab.lastActiveAt) tab.lastActiveAt = now;
    if (!tab.orderHistory) tab.orderHistory = [];
    if (orderChanged) tab.orderHistory.push({ windowId: tab.extensionWindowId, index: tab.tabIndex, at: Date.now() });
    tab.groupId = groupId;
    tab.groupTitle = groupId === null ? null : info.groupTitle || null;
    tab.groupColor = groupId === null ? null : info.groupColor || null;
    tab.groupCollapsed = groupId === null ? false : !!info.groupCollapsed;
    if (!tab.groupHistory) tab.groupHistory = [];
    if (changed) {
      tab.groupHistory.push({ groupId, title: tab.groupTitle, color: tab.groupColor, at: Date.now() });
    }
    this.publish();
  }

  async freezeTab(tabInfo, options = {}) {
    if (this.status !== 'live' || !this.session) throw new Error('Start a browser session before freezing tabs.');
    const tab = this.tabForExtensionInfo(tabInfo);
    if (!tab || tab.closedAt) throw new Error('This tab is no longer open.');
    const currentEntry = this.entryForTab(tab);
    if (currentEntry && currentEntry.active && tab.url === this.freezerUrl(currentEntry.slug)) return { tabId: tab.extensionTabId, targetId: tab.id, shortUrl: this.freezerUrl(currentEntry.slug), slug: currentEntry.slug, frozen: true };
    const originalUrl = currentEntry?.originalUrl || tab.originalUrl || tab.url;
    if (!freezableUrl(originalUrl)) return { tabId: tab.extensionTabId, targetId: tab.id, skipped: 'This tab does not contain a web page.' };
    if (this.isWhitelisted(originalUrl)) return { tabId: tab.extensionTabId, targetId: tab.id, skipped: 'This tab is whitelisted.' };
    clearTimeout(this.captureTimers.get(tab.id));
    this.captureTimers.delete(tab.id);
    const screenshot = options.capture === false ? tab.thumbnail || null : await this.capture(tab.id).catch(() => tab.thumbnail || null);
    let entry = currentEntry || this.freezer.entries.find((item) => !item.active && item.targetId === tab.id && item.originalUrl === originalUrl);
    if (!entry) {
      let slug;
      do { slug = randomUUID().replaceAll('-', '').slice(0, 10); } while (this.entryForSlug(slug));
      entry = { slug, originalUrl, title: tab.title || originalUrl, screenshot, createdAt: Date.now(), updatedAt: Date.now(), targetId: tab.id, extensionTabId: tab.extensionTabId ?? null, extensionWindowId: tab.extensionWindowId ?? null, active: true };
      this.freezer.entries.push(entry);
    } else {
      entry.originalUrl = originalUrl;
      entry.title = tab.title || entry.title || originalUrl;
      entry.screenshot = screenshot || entry.screenshot || null;
      entry.updatedAt = Date.now();
      entry.targetId = tab.id;
      entry.extensionTabId = tab.extensionTabId ?? entry.extensionTabId ?? null;
      entry.extensionWindowId = tab.extensionWindowId ?? entry.extensionWindowId ?? null;
      entry.active = true;
    }
    this.persistFreezer();
    this.publish();
    return { tabId: tab.extensionTabId, targetId: tab.id, shortUrl: this.freezerUrl(entry.slug), slug: entry.slug, frozen: true };
  }

  async freezeTabById(id) {
    const result = await this.freezeTab({ targetId: id });
    if (result.shortUrl) await this.navigateTab(id, result.shortUrl);
    return result;
  }

  unfreezeSlug(slug) {
    const entry = this.entryForSlug(slug);
    if (!entry) throw new Error('This frozen page is no longer available.');
    entry.active = false;
    const tab = this.session?.tabs.find((item) => item.id === entry.targetId || item.frozenSlug === slug);
    if (tab) {
      tab.frozen = false;
      tab.frozenSlug = null;
      tab.originalUrl = null;
    }
    this.persistFreezer();
    this.publish();
    return { originalUrl: entry.originalUrl, slug: entry.slug };
  }

  unfreezeTab(tabInfo) {
    const tab = this.tabForExtensionInfo(tabInfo);
    const entry = this.entryForTab(tab) || this.entryForUrl(tab?.url);
    if (!entry) throw new Error('This tab is not frozen.');
    return this.unfreezeSlug(entry.slug);
  }

  async unfreezeTabById(id) {
    const result = this.unfreezeTab({ targetId: id });
    if (result.originalUrl) await this.navigateTab(id, result.originalUrl);
    return result;
  }

  async closeTabByInfo(info) {
    const tab = this.tabForExtensionInfo(info);
    if (!tab || tab.closedAt) throw new Error('This tab is no longer open.');
    return this.closeTab(tab.id);
  }

  freezerStatus(tabInfo) {
    const tab = this.tabForExtensionInfo(tabInfo);
    const entry = this.entryForTab(tab) || this.entryForUrl(tab?.url);
    const originalUrl = entry?.originalUrl || tab?.originalUrl || tab?.url || '';
    const currentUrl = tabInfo.url || tab?.url;
    return { frozen: !!entry?.active && (tab?.frozen || currentUrl === this.freezerUrl(entry.slug)), whitelisted: this.isWhitelisted(originalUrl), freezable: freezableUrl(originalUrl), slug: entry?.slug || null };
  }

  setWhitelist(tabInfo, enabled) {
    const tab = this.tabForExtensionInfo(tabInfo);
    const entry = this.entryForTab(tab) || this.entryForUrl(tab?.url);
    const url = entry?.originalUrl || tab?.originalUrl || tab?.url;
    if (!freezableUrl(url)) throw new Error('Only web pages can be whitelisted.');
    this.freezer.whitelist = this.freezer.whitelist.filter((item) => item !== url);
    if (enabled) this.freezer.whitelist.push(url);
    this.persistFreezer();
    return { whitelisted: enabled, url };
  }

  async freezeAllTabs(tabInfos = [], exclude = null) {
    const infos = tabInfos.length ? tabInfos : (this.session?.tabs || []).filter((tab) => !tab.closedAt).map((tab) => ({ targetId: tab.id, tabId: tab.extensionTabId, windowId: tab.extensionWindowId, url: tab.url, title: tab.title }));
    const excludedTargetId = exclude?.targetId;
    const excludedTabId = exclude?.tabId;
    const excludedWindowId = exclude?.windowId;
    const filteredInfos = infos.filter((info) => info.targetId !== excludedTargetId && !(Number.isInteger(excludedTabId) && info.tabId === excludedTabId && info.windowId === excludedWindowId));
    const items = [];
    const skipped = [];
    for (const info of filteredInfos) {
      try {
        const result = await this.freezeTab(info);
        if (result.shortUrl) items.push(result);
        else skipped.push({ tabId: result.tabId, reason: result.skipped || 'Skipped' });
      } catch (error) { skipped.push({ tabId: info.tabId, reason: error.message }); }
    }
    return { items, skipped, windows: new Set(filteredInfos.map((info) => info.windowId).filter((id) => id !== undefined)).size };
  }

  async navigateTab(id, url) {
    if (!this.client) throw new Error('Browser is not connected.');
    let sessionId;
    try {
      ({ sessionId } = await this.client.send('Target.attachToTarget', { targetId: id, flatten: true }));
      await this.client.send('Page.navigate', { url }, sessionId);
    } finally {
      if (sessionId) await this.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  async checkInactiveTabs() {
    if (this.inactivityBusy || this.status !== 'live' || !this.session) return;
    this.inactivityBusy = true;
    try {
      const now = Date.now();
      for (const tab of this.session.tabs.filter((item) => !item.closedAt && !item.frozen && item.active === false && Number.isInteger(item.extensionTabId) && item.lastActiveAt)) {
        try {
          const inactiveFor = now - tab.lastActiveAt;
          if (inactiveFor >= inactivityScreenshotAfter && !tab.inactiveScreenshotAt) {
            await this.capture(tab.id).catch(() => {});
            tab.inactiveScreenshotAt = now;
            this.publish();
          }
          if (tab.active) { tab.inactiveScreenshotAt = null; continue; }
          if (inactiveFor >= inactivityFreezeAfter && !tab.active && !tab.frozen) {
            const result = await this.freezeTab({ targetId: tab.id }, { capture: false });
            if (result.shortUrl) await this.navigateTab(tab.id, result.shortUrl);
          }
        } catch {}
      }
    } finally { this.inactivityBusy = false; }
  }

  async refreshTargetLocation(tab) {
    if (!this.client || !tab || this.status !== 'live') return;
    try {
      const location = await this.client.send('Browser.getWindowForTarget', { targetId: tab.id });
      const windowId = String(location.windowId);
      const moved = tab.windowId && tab.windowId !== windowId;
      tab.windowId = windowId;
      tab.windowBounds = location.bounds || null;
      tab.desktopId = await this.getDesktopId(tab.windowId, location.bounds);
      if (!tab.windowHistory) tab.windowHistory = [];
      const last = tab.windowHistory.at(-1);
      if (!last || last.windowId !== tab.windowId || last.desktopId !== tab.desktopId) {
        const at = Date.now();
        tab.windowHistory.push({ windowId: tab.windowId, desktopId: tab.desktopId, at });
        if (moved) this.emit('tab-moved', { tabId: tab.id, windowId: tab.windowId, at });
      }
    } catch {}
  }

  async refreshAllTargetLocations() {
    if (this.status !== 'live' || !this.session) return;
    await Promise.all(this.session.tabs.filter((tab) => !tab.closedAt).map((tab) => this.refreshTargetLocation(tab)));
    this.publish();
  }

  async getDesktopId(windowId, bounds) {
    if (process.platform === 'win32' && typeof this.desktopResolver === 'function') {
      try { return (await this.desktopResolver(windowId, bounds, this.process?.pid)) || 'unknown'; } catch {}
    }
    return 'unknown';
  }

  async capture(id) {
    const tab = this.session?.tabs.find((item) => item.id === id);
    const client = this.client;
    if (!tab || tab.closedAt || this.status !== 'live' || !client) return;
    if (tab.frozen) return tab.thumbnail;
    let sessionId;
    try {
      ({ sessionId } = await client.send('Target.attachToTarget', { targetId: id, flatten: true }));
      const metrics = await client.send('Page.getLayoutMetrics', {}, sessionId);
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      const { data } = await client.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 55, captureBeyondViewport: false,
        clip: { x: viewport.pageX || 0, y: viewport.pageY || 0, width, height, scale: Math.min(1, 560 / width) },
      }, sessionId);
      if (tab.closedAt || this.client !== client) return;
      tab.thumbnail = `data:image/jpeg;base64,${data}`;
      tab.thumbnailAt = Date.now();
      this.publish();
      return tab.thumbnail;
    } finally {
      if (sessionId) await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  async captureAll() {
    if (this.captureBusy || this.status !== 'live') return;
    this.captureBusy = true;
    try {
      for (const tab of this.session.tabs.filter((item) => !item.closedAt && !item.frozen && !item.inactiveScreenshotAt && item.active === false)) {
        if (this.status !== 'live') break;
        await this.capture(tab.id).catch(() => {});
      }
    } finally { this.captureBusy = false; }
  }

  async focusTab(id) {
    if (this.status !== 'live' || !this.session?.tabs.some((tab) => tab.id === id && !tab.closedAt)) throw new Error('This tab is no longer open.');
    await this.client.send('Target.activateTarget', { targetId: id });
  }

  async closeTab(id) {
    if (this.status !== 'live' || !this.session?.tabs.some((tab) => tab.id === id && !tab.closedAt)) throw new Error('This tab is no longer open.');
    await this.client.send('Target.closeTarget', { targetId: id });
  }

  async stop() {
    if (this.status !== 'live') return;
    await this.refreshAllTargetLocations().catch(() => {});
    this.status = 'stopping';
    this.closingBrowser = true;
    for (const tab of this.session.tabs) if (!tab.closedAt) tab.openAtEnd = true;
    this.publish();
    try { await this.client.send('Browser.close'); } catch {}
    this.finish();
  }

  finish() {
    clearInterval(this.interval);
    clearInterval(this.locationInterval);
    clearInterval(this.inactivityInterval);
    this.inactivityInterval = null;
    this.inactivityBusy = false;
    for (const timer of this.captureTimers.values()) clearTimeout(timer);
    this.captureTimers.clear();
    if (this.session && !this.session.endedAt) {
      this.session.endedAt = Date.now();
      this.session.tabs.forEach((tab) => { tab.closedAt ||= this.session.endedAt; });
      this.persist();
    }
    this.client?.removeAllListeners('disconnect');
    this.client?.close();
    this.client = null;
    this.groupBridge?.close();
    this.groupBridge = null;
    this.groupToken = null;
    this.pendingRestore = null;
    this.restoreResolve?.(null);
    this.restoreResolve = null;
    this.process = null;
    this.debugPort = null;
    if (this.status !== 'error') this.status = 'idle';
    this.publish();
  }

  async restoreSession(id, options = {}) {
    const saved = this.loadSession(id);
    const plan = buildRestorePlan(saved, options.at);
    if (!plan.windows.length) throw new Error('This session has no restorable web tabs.');
    let browser = options.browser === 'chrome' || options.browser === 'helium' ? options.browser : saved.browser;
    let executable = options.executable;
    let browserWarning = null;
    const detected = detectBrowsers();
    if (!executable || !fs.existsSync(executable)) executable = detected.find((item) => item.id === browser)?.path || null;
    if (!executable) {
      const fallback = detected.find((item) => item.path);
      if (fallback) {
        browserWarning = `Saved browser ${browser === 'helium' ? 'Helium' : 'Chrome'} was unavailable; restored with ${fallback.name}.`;
        browser = fallback.id;
        executable = fallback.path;
      }
    }
    this.pendingRestore = { plan, delivered: false };
    const resultPromise = new Promise((resolve) => { this.restoreResolve = resolve; });
    try {
      await this.launch({ browser, executable, name: `${saved.name} (restored)`, url: plan.windows[0].tabs[0].url });
      this.session.restoredFromSessionId = saved.id;
      let result = await Promise.race([resultPromise, delay(5000).then(() => null)]);
      if (!result && this.pendingRestore?.delivered) result = await Promise.race([resultPromise, delay(30000).then(() => null)]);
      this.restoreResolve = null;
      if (!result && this.pendingRestore?.delivered) {
        result = { opened: this.session.tabs.filter((tab) => !tab.closedAt).length, failed: 0, groupsRestored: false, warnings: ['The companion extension is still finishing the restore in the browser.'] };
      }
      if (!result) {
        let opened = 1;
        const failures = [];
        let anchorTargetId = this.session.tabs.find((tab) => !tab.closedAt)?.id;
        const restoredWindows = [{ sourceWindowId: plan.windows[0].sourceWindowId, targetId: anchorTargetId }];
        for (let windowIndex = 0; windowIndex < plan.windows.length; windowIndex++) {
          const window = plan.windows[windowIndex];
          for (let tabIndex = windowIndex === 0 ? 1 : 0; tabIndex < window.tabs.length; tabIndex++) {
            try {
              if (tabIndex > 0 && anchorTargetId) await this.client.send('Target.activateTarget', { targetId: anchorTargetId });
              const created = await this.client.send('Target.createTarget', { url: window.tabs[tabIndex].url, newWindow: tabIndex === 0 && windowIndex > 0 });
              if (tabIndex === 0) {
                anchorTargetId = created.targetId;
                restoredWindows.push({ sourceWindowId: window.sourceWindowId, targetId: anchorTargetId });
              }
              opened++;
            } catch (error) { failures.push(error.message); }
          }
        }
        result = { opened, failed: failures.length, groupsRestored: false, windows: restoredWindows, warnings: ['The companion extension was unavailable; tab pinning, exact order, groups, and opener links could not be restored.', ...failures] };
      }
      const desktopWarnings = await this.restoreVirtualDesktops(plan, result.windows || []);
      result.warnings = [...(browserWarning ? [browserWarning] : []), ...(result.warnings || []), ...desktopWarnings];
      result.desktopFailed = desktopWarnings.length;
      this.pendingRestore = null;
      this.publish();
      return { ...result, requested: plan.requested, skipped: plan.skipped, state: this.snapshot() };
    } catch (error) {
      this.pendingRestore = null;
      this.restoreResolve = null;
      throw error;
    }
  }

  async restoreVirtualDesktops(plan, restoredWindows) {
    if (typeof this.desktopMover !== 'function') return [];
    const warnings = [];
    for (const restored of restoredWindows) {
      const source = plan.windows.find((window) => window.sourceWindowId === String(restored.sourceWindowId));
      if (!source || source.desktopId === 'unknown') continue;
      let tab;
      for (let attempt = 0; attempt < 50; attempt++) {
        tab = restored.targetId
          ? this.session?.tabs.find((item) => item.id === restored.targetId)
          : this.session?.tabs.find((item) => item.extensionWindowId === restored.extensionWindowId);
        if (tab?.windowBounds) break;
        await delay(100);
      }
      if (tab) await this.refreshTargetLocation(tab);
      const moved = tab?.windowBounds && await this.desktopMover(tab.windowId, tab.windowBounds, this.process?.pid, source.desktopId);
      if (!moved) warnings.push(`Could not restore a browser window to virtual desktop ${source.desktopId}.`);
    }
    return warnings;
  }
}

module.exports = { BrowserController, browserCandidates, buildRestorePlan, detectBrowsers, validStartUrl, upsertTarget };
