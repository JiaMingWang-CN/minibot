const { app, BrowserWindow, dialog, ipcMain } = require('electron') as typeof import('electron');
const path = require('node:path') as typeof import('node:path');
const { URL } = require('node:url') as typeof import('node:url');

const core = require('@minibot/core') as typeof import('@minibot/core');
const { Kernel, defaultDataRoot, startServer } = core;
const cryptoModule = require('./crypto.cjs') as {
  electronCrypto: () => import('@minibot/core').KeyCrypto;
};

// Title bar follows the page: dark while the startup animation plays, light afterwards.
const TITLE_BAR = {
  dark: { color: '#1c1917', symbolColor: '#e7e5e4', height: 32 },
  light: { color: '#f5f5f4', symbolColor: '#1c1917', height: 32 },
} as const;

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

const preloadPath = path.join(__dirname, 'preload.cjs');
const staticDir = path.join(__dirname, 'static');

let kernel: Awaited<ReturnType<typeof Kernel.open>> | undefined;
let server: ServerHandle | undefined;
let mainWindow: InstanceType<typeof BrowserWindow> | undefined;
let quitting = false;

async function bootstrap(): Promise<void> {
  const dataRoot = process.env['MINIBOT_HOME'] ?? defaultDataRoot();
  kernel = await Kernel.open({ dataRoot, crypto: cryptoModule.electronCrypto() });
  server = await startServer(kernel, { staticDir });

  ipcMain.handle('minibot:connection', (event) => {
    if (mainWindow === undefined || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('拒绝连接请求');
    }
    const frame = event.senderFrame;
    if (frame === null) throw new Error('拒绝连接请求');
    let origin = '';
    try {
      origin = new URL(frame.url).origin;
    } catch {
      throw new Error('拒绝连接请求');
    }
    if (server === undefined || origin !== server.origin) throw new Error('拒绝连接请求');
    return { port: server.port, token: server.token };
  });

  ipcMain.on('minibot:title-bar', (event, theme: unknown) => {
    if (mainWindow === undefined || event.sender.id !== mainWindow.webContents.id) return;
    if (theme !== 'dark' && theme !== 'light') return;
    mainWindow.setTitleBarOverlay(TITLE_BAR[theme]);
  });

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'minibot',
    icon: path.join(staticDir, 'assets', 'icon.png'),
    backgroundColor: TITLE_BAR.dark.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR.dark,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (server === undefined) {
      event.preventDefault();
      return;
    }
    try {
      if (new URL(navigationUrl).origin !== server.origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(`${server.origin}/`);
}

app
  .whenReady()
  .then(bootstrap)
  .catch((err: unknown) => {
    console.error(err);
    // 启动失败时给用户一个可见的说明，而不是窗口一闪而过
    dialog.showErrorBox('minibot 启动失败', err instanceof Error ? err.message : String(err));
    app.quit();
  });

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    try {
      await server?.close();
    } catch {
      // 关闭失败不阻止退出
    }
    try {
      await kernel?.close();
    } catch {
      // 同上
    }
    app.quit();
  })();
});
