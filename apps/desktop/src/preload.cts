const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('minibot', {
  connection: () => ipcRenderer.invoke('minibot:connection'),
});
