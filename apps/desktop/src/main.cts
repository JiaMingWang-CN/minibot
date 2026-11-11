const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } = require('electron') as typeof import('electron');
const path = require('node:path') as typeof import('node:path');
const { URL } = require('node:url') as typeof import('node:url');

const core = require('@minibot/core') as typeof import('@minibot/core');
const { Kernel, RemoteService, defaultDataRoot, startServer } = core;
const cryptoModule = require('./crypto.cjs') as {
  electronCrypto: () => import('@minibot/core').KeyCrypto;
};

// 标题栏覆盖层的颜色由页面按主题 token 传入；页面加载前先用与主题背景一致的初始色，避免闪白或闪黑。
const TITLE_BAR_HEIGHT = 28;
const INITIAL_TITLE_BAR = {
  dark: { color: '#0b0b0b', symbolColor: '#f5f5f5' },
  light: { color: '#f5f5f5', symbolColor: '#1c1c1c' },
} as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

const preloadPath = path.join(__dirname, 'preload.cjs');
const staticDir = path.join(__dirname, 'static');

let kernel: Awaited<ReturnType<typeof Kernel.open>> | undefined;
let remote: Awaited<ReturnType<typeof RemoteService.start>> | undefined;
let tray: InstanceType<typeof Tray> | undefined;
let backgroundNoticeShown = false;
let server: ServerHandle | undefined;
let mainWindow: InstanceType<typeof BrowserWindow> | undefined;
let quitting = false;

async function bootstrap(): Promise<void> {
  const dataRoot = process.env['MINIBOT_HOME'] ?? defaultDataRoot();
  const crypto = cryptoModule.electronCrypto();
  kernel = await Kernel.open({ dataRoot, crypto });
  // 手机功能的任何问题（没有密钥库、端口被占用…）只体现在“手机”设置页，不影响内核与本机界面
  remote = await RemoteService.start(kernel, { dataRoot, crypto });
  server = await startServer(kernel, { staticDir, remote });

  // 只接受本应用主窗口、且页面来自本机服务的调用
  const assertTrusted = (event: import('electron').IpcMainInvokeEvent): void => {
    if (mainWindow === undefined || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('拒绝请求');
    }
    const frame = event.senderFrame;
    if (frame === null) throw new Error('拒绝请求');
    let origin = '';
    try {
      origin = new URL(frame.url).origin;
    } catch {
      throw new Error('拒绝请求');
    }
    if (server === undefined || origin !== server.origin) throw new Error('拒绝请求');
  };

  ipcMain.handle('minibot:connection', (event) => {
    assertTrusted(event);
    return { port: server!.port, token: server!.token };
  });

  // 只按 botId 打开该 bot 的记忆目录，不接受任意路径（openPath 打开可执行文件会直接运行它）
  ipcMain.handle('minibot:open-memory-dir', async (event, botId: unknown) => {
    assertTrusted(event);
    if (kernel === undefined || typeof botId !== 'string') throw new Error('拒绝请求');
    const error = await shell.openPath(kernel.memoryDir(botId));
    if (error.length > 0) throw new Error(error);
  });

  ipcMain.on('minibot:title-bar', (event, colors: unknown) => {
    if (mainWindow === undefined || event.sender.id !== mainWindow.webContents.id) return;
    const { color, symbolColor } = (colors ?? {}) as { color?: unknown; symbolColor?: unknown };
    if (typeof color !== 'string' || typeof symbolColor !== 'string') return;
    if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return;
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
    mainWindow.setBackgroundColor(color);
  });

  const initial = INITIAL_TITLE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'minibot',
    icon: path.join(staticDir, 'assets', 'icon.png'),
    backgroundColor: initial.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...initial, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 只把 http(s) 链接交给系统浏览器；其他协议（file:、自定义协议）一律不打开
  const openExternal = (target: string): void => {
    try {
      const { protocol } = new URL(target);
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(target);
    } catch {
      // 不是合法 URL，忽略
    }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (server === undefined) {
      event.preventDefault();
      return;
    }
    try {
      if (new URL(navigationUrl).origin === server.origin) return;
    } catch {
      // 落到下面一并拦截
    }
    event.preventDefault();
    openExternal(navigationUrl);
  });
  // 有已配对的手机时，关窗口只是隐藏到托盘，让手机继续连得上；没有设备时照旧直接退出
  mainWindow.on('close', (event) => {
    if (quitting || remote === undefined || !remote.hasDevices()) return;
    event.preventDefault();
    mainWindow?.hide();
    if (!backgroundNoticeShown && Notification.isSupported()) {
      backgroundNoticeShown = true;
      new Notification({
        title: 'minibot',
        body: 'minibot 仍在后台运行，手机可以继续连接。可从托盘图标退出。',
      }).show();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  createTray();
  await mainWindow.loadURL(`${server.origin}/`);
}

function showMainWindow(): void {
  if (mainWindow === undefined) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (tray !== undefined) return;
  const icon = nativeImage.createFromPath(path.join(staticDir, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('minibot');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 minibot', click: showMainWindow },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', showMainWindow);
}

// 同一数据目录只能有一个内核：第二个实例的启动修复会把第一个实例进行中的调用记成已取消。
// 用 MINIBOT_HOME 指向临时目录的调试实例用的是独立数据，不占用这把锁。
const gotLock = process.env['MINIBOT_HOME'] !== undefined || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app
    .whenReady()
    .then(bootstrap)
    .catch((err: unknown) => {
      console.error(err);
      // 启动失败时给用户一个可见的说明，而不是窗口一闪而过
      dialog.showErrorBox('minibot 启动失败', err instanceof Error ? err.message : String(err));
      app.quit();
    });
}

app.on('window-all-closed', () => {
  if (!quitting && remote?.hasDevices() === true) return;
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    tray?.destroy();
    tray = undefined;
    try {
      await remote?.close();
    } catch {
      // 关闭失败不阻止退出
    }
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
