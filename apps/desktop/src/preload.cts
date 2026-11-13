const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('minibot', {
  connection: () => ipcRenderer.invoke('minibot:connection'),
  setTitleBar: (colors: { color: string; symbolColor: string }) => ipcRenderer.send('minibot:title-bar', colors),
  openMemoryDir: (botId: string) => ipcRenderer.invoke('minibot:open-memory-dir', botId),
  pickFolder: () => ipcRenderer.invoke('minibot:pick-folder'),
  pickZip: () => ipcRenderer.invoke('minibot:pick-zip'),
  update: {
    state: () => ipcRenderer.invoke('minibot:update-state'),
    check: () => ipcRenderer.invoke('minibot:update-check'),
    install: () => ipcRenderer.invoke('minibot:update-install'),
    onState: (cb: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown): void => cb(state);
      ipcRenderer.on('minibot:update-state', listener);
      return () => ipcRenderer.removeListener('minibot:update-state', listener);
    },
  },
});
