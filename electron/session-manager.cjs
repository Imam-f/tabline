const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { BrowserController } = require('./browser.cjs');

class SessionManager extends EventEmitter {
  constructor(dataDir, extensionPath, configureController = () => {}) {
    super();
    this.dataDir = dataDir;
    this.extensionPath = extensionPath;
    this.configureController = configureController;
    this.storage = new BrowserController(dataDir, extensionPath);
    this.controllers = new Map();
    this.activeSessionId = null;
    this.pendingStatus = null;
    this.lastError = null;
  }

  createController() {
    const controller = new BrowserController(this.dataDir, this.extensionPath);
    this.configureController(controller);
    controller.on('change', () => this.publish());
    controller.on('storage-error', (message) => {
      this.lastError = `Could not save session: ${message}`;
      this.publish();
    });
    return controller;
  }

  runtimeStates() {
    return [...this.controllers.values()]
      .filter((controller) => controller.session)
      .map((controller) => controller.snapshot())
      .sort((a, b) => a.session.startedAt - b.session.startedAt);
  }

  activeController() {
    return this.controllers.get(this.activeSessionId) || null;
  }

  hasRunningSessions() {
    return [...this.controllers.values()].some((controller) => ['launching', 'live', 'stopping'].includes(controller.status));
  }

  snapshot() {
    const active = this.activeController()?.snapshot();
    return {
      status: active?.status || this.pendingStatus || 'idle',
      session: active?.session || null,
      debugPort: active?.debugPort || null,
      error: active?.error || this.lastError,
      activeSessionId: this.activeSessionId,
      sessions: this.runtimeStates(),
    };
  }

  publish() { this.emit('change', this.snapshot()); }

  latestProfileSession() {
    const runtime = this.runtimeStates().map((state) => state.session);
    const saved = this.storage.listSessions();
    return [...runtime, ...saved].sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  }

  async launch(options = {}) {
    const controller = this.createController();
    const sessionId = randomUUID();
    this.pendingStatus = 'launching';
    this.lastError = null;
    this.controllers.set(sessionId, controller);
    this.publish();
    try {
      const source = this.latestProfileSession();
      const profileSourceSessionId = options.profileSourceSessionId || source?.id || null;
      const sourceController = this.controllers.get(profileSourceSessionId);
      const liveCookies = sourceController?.client?.send('Storage.getCookies').then((result) => result.cookies || []).catch(() => []) || Promise.resolve([]);
      await controller.launch({ ...options, sessionId, profileSourceSessionId, profileSourceBrowser: source?.browser });
      const cookies = await liveCookies;
      if (cookies.length) {
        await controller.client.send('Storage.setCookies', { cookies }).catch(() => {});
        await Promise.all(controller.session.tabs.filter((tab) => !tab.closedAt).map((tab) => controller.navigateTab(tab.id, tab.url).catch(() => {})));
      }
      this.activeSessionId = sessionId;
      this.pendingStatus = null;
      this.publish();
      return this.snapshot();
    } catch (error) {
      this.controllers.delete(sessionId);
      this.pendingStatus = null;
      this.lastError = error.message;
      this.publish();
      throw error;
    }
  }

  async restoreSession(id, options = {}) {
    const controller = this.createController();
    const sessionId = randomUUID();
    this.pendingStatus = 'launching';
    this.lastError = null;
    this.controllers.set(sessionId, controller);
    this.publish();
    try {
      const result = await controller.restoreSession(id, { ...options, sessionId });
      this.activeSessionId = sessionId;
      this.pendingStatus = null;
      this.publish();
      return { ...result, state: this.snapshot() };
    } catch (error) {
      this.controllers.delete(sessionId);
      this.pendingStatus = null;
      this.lastError = error.message;
      this.publish();
      throw error;
    }
  }

  selectSession(id) {
    if (!this.controllers.has(id)) throw new Error('Session is not open.');
    this.activeSessionId = id;
    this.lastError = null;
    this.publish();
    return this.snapshot();
  }

  closeSession(id) {
    const controller = this.controllers.get(id);
    if (!controller) return this.snapshot();
    if (['live', 'launching', 'stopping'].includes(controller.status)) throw new Error('End this session before closing it.');
    this.controllers.delete(id);
    if (this.activeSessionId === id) this.activeSessionId = this.runtimeStates().at(-1)?.session.id || null;
    this.publish();
    return this.snapshot();
  }

  controllerForTab(id) {
    const active = this.activeController();
    if (active?.session?.tabs.some((tab) => tab.id === id)) return active;
    return [...this.controllers.values()].find((controller) => controller.session?.tabs.some((tab) => tab.id === id)) || null;
  }

  requireTabController(id) {
    const controller = this.controllerForTab(id);
    if (!controller) throw new Error('This tab is no longer available.');
    return controller;
  }

  async stop(id = this.activeSessionId) {
    await this.controllers.get(id)?.stop();
    this.publish();
  }

  async stopAll() {
    await Promise.all([...this.controllers.values()].map((controller) => controller.stop()));
  }

  focusTab(id) { return this.requireTabController(id).focusTab(id); }
  closeTab(id) { return this.requireTabController(id).closeTab(id); }
  capture(id) { return this.requireTabController(id).capture(id); }
  freezeTabById(id) { return this.requireTabController(id).freezeTabById(id); }
  unfreezeTabById(id) { return this.requireTabController(id).unfreezeTabById(id); }
  freezeAllTabs() {
    const controller = this.activeController();
    if (!controller) throw new Error('No session is selected.');
    return controller.freezeAllTabs();
  }

  listSessions() { return this.storage.listSessions(); }
  loadSession(id) { return this.storage.loadSession(id); }
  listFolders() { return this.storage.listFolders(); }
  createFolder(name, parentId) { return this.storage.createFolder(name, parentId); }
  renameFolder(id, name) { return this.storage.renameFolder(id, name); }
  deleteFolder(id) { return this.storage.deleteFolder(id); }
  setFolderParent(id, parentId) { return this.storage.setFolderParent(id, parentId); }
  setSessionFolder(sessionId, folderId) { return this.storage.setSessionFolder(sessionId, folderId); }
  reorderSession(sessionId, targetSessionId, before) { return this.storage.reorderSession(sessionId, targetSessionId, before); }

  renameSession(id, name) {
    this.storage.renameSession(id, name);
    const controller = this.controllers.get(id);
    if (controller?.session) controller.session.name = String(name).trim().slice(0, 80);
    this.publish();
  }

  deleteSession(id) {
    const controller = this.controllers.get(id);
    if (controller && ['live', 'launching', 'stopping'].includes(controller.status)) throw new Error('End this session before deleting it.');
    this.storage.deleteSession(id);
    if (controller) this.controllers.delete(id);
    if (this.activeSessionId === id) this.activeSessionId = this.runtimeStates().at(-1)?.session.id || null;
    this.publish();
  }
}

module.exports = { SessionManager };
