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
  exportSession: (session) => ipcRenderer.invoke('session:export', session),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
