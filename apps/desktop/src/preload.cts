const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('minibot', {
  connection: () => ipcRenderer.invoke('minibot:connection'),
  setTitleBar: (colors: { color: string; symbolColor: string }) => ipcRenderer.send('minibot:title-bar', colors),
  openMemoryDir: (botId: string) => ipcRenderer.invoke('minibot:open-memory-dir', botId),
});
