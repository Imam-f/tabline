const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { BrowserController, detectBrowsers } = require('./browser.cjs');
const { VirtualDesktopResolver } = require('./virtual-desktop.cjs');

let window;
let controller;
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
    controller = new BrowserController(path.join(app.getPath('userData'), 'browser-data'), extensionPath);
    if (process.platform === 'win32') {
      virtualDesktopResolver = new VirtualDesktopResolver();
      controller.desktopResolver = (windowId, bounds, processId) => virtualDesktopResolver.resolve(windowId, processId, bounds);
      controller.desktopMover = (windowId, bounds, processId, desktopId) => virtualDesktopResolver.move(windowId, processId, bounds, desktopId);
    }
    controller.on('change', (state) => { if (window && !window.isDestroyed()) window.webContents.send('state:changed', state); });
    controller.on('storage-error', (message) => { if (window && !window.isDestroyed()) window.webContents.send('state:changed', { ...controller.snapshot(), error: `Could not save session: ${message}` }); });
    ipcMain.handle('state:get', () => controller.snapshot());
    ipcMain.handle('browsers:list', () => detectBrowsers());
    ipcMain.handle('browser:choose', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Choose Helium or Chrome executable', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Browser executable', extensions: ['exe'] }] } : {}) });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('browser:launch', (_event, options) => controller.launch(options));
    ipcMain.handle('browser:stop', () => controller.stop());
    ipcMain.handle('tab:focus', (_event, id) => controller.focusTab(id));
    ipcMain.handle('tab:close', (_event, id) => controller.closeTab(id));
    ipcMain.handle('tab:capture', (_event, id) => controller.capture(id));
    ipcMain.handle('sessions:list', () => controller.listSessions());
    ipcMain.handle('sessions:load', (_event, id) => controller.loadSession(id));
    ipcMain.handle('sessions:restore', (_event, id, options) => controller.restoreSession(id, options));
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
    if (!quitting && controller?.status === 'live') {
      event.preventDefault();
      quitting = true;
      controller.stop().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => virtualDesktopResolver?.dispose());
}

function createWindow() {
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1000, minHeight: 700,
    title: 'Tabline', backgroundColor: '#f8f9fb', autoHideMenuBar: true,
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
