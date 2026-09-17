const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { CDP } = require('./cdp.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  let tab = session.tabs.find((item) => item.id === info.targetId);
  if (!tab) {
    tab = { id: info.targetId, title: info.title || 'New tab', url: info.url || 'about:blank', openedAt: now, closedAt: null, openAtEnd: true, openerId: info.openerId || null, windowId: info.windowId || null, desktopId: info.desktopId || 'unknown', windowHistory: [], extensionTabId: null, extensionWindowId: null, tabIndex: null, pinned: false, active: false, orderHistory: [], groupId: null, groupTitle: null, groupColor: null, groupCollapsed: false, groupHistory: [], thumbnail: null, thumbnailAt: null, navigations: [] };
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

function buildRestorePlan(session) {
  const hasOpenSnapshot = session.tabs.some((tab) => typeof tab.openAtEnd === 'boolean');
  let candidates = hasOpenSnapshot
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

class BrowserController extends EventEmitter {
  constructor(dataDir, extensionPath = path.join(__dirname, 'tabline-extension')) {
    super();
    this.dataDir = dataDir;
    this.status = 'idle';
    this.session = null;
    this.client = null;
    this.process = null;
    this.captureBusy = false;
    this.captureTimers = new Map();
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

  listSessions() {
    return fs.readdirSync(path.join(this.dataDir, 'sessions')).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'sessions', name), 'utf8'));
        return [{ id: session.id, name: session.name, startedAt: session.startedAt, endedAt: session.endedAt, browser: session.browser, tabCount: session.tabs.length }];
      } catch { return []; }
    }).sort((a, b) => b.startedAt - a.startedAt);
  }

  loadSession(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
    const session = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'sessions', `${id}.json`), 'utf8'));
    session.tabs.forEach((tab) => { tab.windowHistory ||= []; tab.desktopId ||= 'unknown'; tab.windowId ||= null; tab.extensionTabId ??= null; tab.extensionWindowId ??= null; tab.tabIndex ??= null; tab.pinned ||= false; tab.active ||= false; tab.orderHistory ||= []; tab.groupId ??= null; tab.groupTitle ??= null; tab.groupColor ??= null; tab.groupCollapsed ||= false; tab.groupHistory ||= []; });
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
    const previous = this.session.tabs.find((tab) => tab.id === info.targetId);
    const shouldCapture = !previous || previous.url !== info.url || previous.title !== info.title;
    const tab = upsertTarget(this.session, info);
    if (!tab) return;
    this.refreshTargetLocation(tab).then(() => this.publish()).catch(() => {});
    this.publish();
    if (shouldCapture) {
      clearTimeout(this.captureTimers.get(tab.id));
      this.captureTimers.set(tab.id, setTimeout(() => {
        this.captureTimers.delete(tab.id);
        this.capture(tab.id).catch(() => {});
      }, 1600));
    }
  }

  async startGroupBridge() {
    this.groupToken = randomUUID();
    this.groupBridge = http.createServer((request, response) => {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/restore') {
        if (!this.pendingRestore || this.pendingRestore.delivered) { response.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); response.end(); return; }
        this.pendingRestore.delivered = true;
        response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        response.end(JSON.stringify(this.pendingRestore.plan));
        return;
      }
      if (request.method !== 'POST' || !['/tab-groups', '/restore-result'].includes(request.url)) {
        response.writeHead(404); response.end(); return;
      }
      let body = '';
      request.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
      request.on('end', () => {
        try {
          const message = JSON.parse(body);
          if (request.url === '/restore-result') {
            this.restoreResolve?.(message);
            this.restoreResolve = null;
          } else {
            for (const groupTab of Array.isArray(message.tabs) ? message.tabs : []) this.onGroupInfo(groupTab);
          }
          response.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); response.end();
        } catch { response.writeHead(400); response.end(); }
      });
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
    tab.extensionTabId = Number.isInteger(info.tabId) ? info.tabId : tab.extensionTabId ?? null;
    tab.extensionWindowId = Number.isInteger(info.windowId) ? info.windowId : tab.extensionWindowId ?? null;
    tab.tabIndex = Number.isInteger(info.index) ? info.index : tab.tabIndex ?? null;
    tab.pinned = typeof info.pinned === 'boolean' ? info.pinned : !!tab.pinned;
    tab.active = typeof info.active === 'boolean' ? info.active : !!tab.active;
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
      for (const tab of this.session.tabs.filter((item) => !item.closedAt)) {
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
    const plan = buildRestorePlan(saved);
    if (!plan.windows.length) throw new Error('This session has no restorable web tabs.');
    this.pendingRestore = { plan, delivered: false };
    const resultPromise = new Promise((resolve) => { this.restoreResolve = resolve; });
    try {
      await this.launch({ browser: saved.browser, executable: options.executable, name: `${saved.name} (restored)`, url: plan.windows[0].tabs[0].url });
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
      result.warnings = [...(result.warnings || []), ...desktopWarnings];
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
