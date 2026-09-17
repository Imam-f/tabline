const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabline', {
  getState: () => ipcRenderer.invoke('state:get'),
  getBrowsers: () => ipcRenderer.invoke('browsers:list'),
  chooseExecutable: () => ipcRenderer.invoke('browser:choose'),
  launch: (options) => ipcRenderer.invoke('browser:launch', options),
  stop: () => ipcRenderer.invoke('browser:stop'),
  focusTab: (id) => ipcRenderer.invoke('tab:focus', id),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  capture: (id) => ipcRenderer.invoke('tab:capture', id),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  restoreSession: (id, options) => ipcRenderer.invoke('sessions:restore', id, options),
  exportSession: (session) => ipcRenderer.invoke('session:export', session),
  listFolders: () => ipcRenderer.invoke('folders:list'),
  createFolder: (name, parentId) => ipcRenderer.invoke('folder:create', name, parentId),
  renameFolder: (id, name) => ipcRenderer.invoke('folder:rename', id, name),
  deleteFolder: (id) => ipcRenderer.invoke('folder:delete', id),
  setFolderParent: (id, parentId) => ipcRenderer.invoke('folder:move', id, parentId),
  setSessionFolder: (sessionId, folderId) => ipcRenderer.invoke('session:set-folder', sessionId, folderId),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', id, name),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
