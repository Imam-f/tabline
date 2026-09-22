const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { detectBrowsers } = require('./browser.cjs');
const { SessionManager } = require('./session-manager.cjs');
const { VirtualDesktopResolver } = require('./virtual-desktop.cjs');

let window;
let manager;
let quitting = false;
let virtualDesktopResolver;
const isDev = process.env.TABLINE_DEV === '1';

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    const extensionPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'tabline-extension')
      : path.join(__dirname, 'tabline-extension');
    if (process.platform === 'win32') virtualDesktopResolver = new VirtualDesktopResolver();
    manager = new SessionManager(path.join(app.getPath('userData'), 'browser-data'), extensionPath, (controller) => {
      if (!virtualDesktopResolver) return;
      controller.desktopResolver = (windowId, bounds, processId) => virtualDesktopResolver.resolve(windowId, processId, bounds);
      controller.desktopMover = (windowId, bounds, processId, desktopId) => virtualDesktopResolver.move(windowId, processId, bounds, desktopId);
    });
    manager.on('change', (state) => { if (window && !window.isDestroyed()) window.webContents.send('state:changed', state); });
    ipcMain.handle('state:get', () => manager.snapshot());
    ipcMain.handle('browsers:list', () => detectBrowsers());
    ipcMain.handle('browser:choose', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Choose Helium or Chrome executable', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Browser executable', extensions: ['exe'] }] } : {}) });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('browser:launch', (_event, options) => manager.launch(options));
    ipcMain.handle('browser:stop', (_event, id) => manager.stop(id));
    ipcMain.handle('session:select', (_event, id) => manager.selectSession(id));
    ipcMain.handle('session:close', (_event, id) => manager.closeSession(id));
    ipcMain.handle('tab:focus', (_event, id) => manager.focusTab(id));
    ipcMain.handle('tab:close', (_event, id) => manager.closeTab(id));
    ipcMain.handle('tab:capture', (_event, id) => manager.capture(id));
    ipcMain.handle('tab:freeze', (_event, id) => manager.freezeTabById(id));
    ipcMain.handle('tab:unfreeze', (_event, id) => manager.unfreezeTabById(id));
    ipcMain.handle('tabs:freeze-all', () => manager.freezeAllTabs());
    ipcMain.handle('sessions:list', () => manager.listSessions());
    ipcMain.handle('sessions:load', (_event, id) => manager.loadSession(id));
    ipcMain.handle('sessions:restore', (_event, id, options) => manager.restoreSession(id, options));
    ipcMain.handle('folders:list', () => manager.listFolders());
    ipcMain.handle('folder:create', (_event, name, parentId) => manager.createFolder(name, parentId));
    ipcMain.handle('folder:rename', (_event, id, name) => manager.renameFolder(id, name));
    ipcMain.handle('folder:delete', (_event, id) => manager.deleteFolder(id));
    ipcMain.handle('folder:move', (_event, id, parentId) => manager.setFolderParent(id, parentId));
    ipcMain.handle('session:set-folder', (_event, sessionId, folderId) => manager.setSessionFolder(sessionId, folderId));
    ipcMain.handle('session:reorder', (_event, sessionId, targetSessionId, before) => manager.reorderSession(sessionId, targetSessionId, before));
    ipcMain.handle('session:rename', (_event, id, name) => manager.renameSession(id, name));
    ipcMain.handle('session:delete', (_event, id) => manager.deleteSession(id));
    ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
    ipcMain.handle('window:toggle-maximize', (event) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow) return;
      if (senderWindow.isMaximized()) senderWindow.unmaximize();
      else senderWindow.maximize();
    });
    ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
    ipcMain.handle('session:export', async (_event, session) => {
      const result = await dialog.showSaveDialog(window, { title: 'Export session', defaultPath: `tabline-${new Date(session.startedAt).toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON session', extensions: ['json'] }] });
      if (result.canceled) return false;
      await fs.writeFile(result.filePath, JSON.stringify(session, null, 2));
      return true;
    });
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]) : null);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('before-quit', (event) => {
    if (!quitting && manager?.hasRunningSessions()) {
      event.preventDefault();
      quitting = true;
      manager.stopAll().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => virtualDesktopResolver?.dispose());
}

function createWindow() {
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1000, minHeight: 700,
    title: 'Tabline', backgroundColor: '#f8f9fb', autoHideMenuBar: true, frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [isDev
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173 ws://localhost:5173"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'"] },
  }));
  if (isDev) window.loadURL('http://127.0.0.1:5173');
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
