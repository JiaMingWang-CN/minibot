const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } = require('electron') as typeof import('electron');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { URL } = require('node:url') as typeof import('node:url');

const core = require('@minibot/core') as typeof import('@minibot/core');
const { Kernel, RemoteService, defaultDataRoot, startServer } = core;
const cryptoModule = require('./crypto.cjs') as {
  electronCrypto: () => import('@minibot/core').KeyCrypto;
};
interface UpdateState {
  phase: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

const updaterModule = require('./updater.cjs') as {
  createUpdater: (deps: {
    diag: import('@minibot/core').DiagLog;
    hasRunningReplies: () => boolean;
    onState: (state: UpdateState) => void;
  }) => {
    state: () => UpdateState;
    check: () => Promise<UpdateState>;
    install: () => Promise<void>;
    stop: () => void;
  };
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
let updater: ReturnType<typeof updaterModule.createUpdater> | undefined;
let tray: InstanceType<typeof Tray> | undefined;
let backgroundNoticeShown = false;
let server: ServerHandle | undefined;
let mainWindow: InstanceType<typeof BrowserWindow> | undefined;
let quitting = false;

/** 收集点地址只在构建时写入 dist/build-info.json；缺文件或空串表示关闭 */
function collectUrl(): string | null {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8');
    const info = JSON.parse(raw) as { collectUrl?: unknown };
    const url = typeof info.collectUrl === 'string' ? info.collectUrl.trim() : '';
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** 崩溃与未捕获异常：写进本地日志并产生 crash 事件（事件只带脱敏堆栈与类别） */
function reportCrash(level: 'warn' | 'error', name: string, err: unknown, fields: Record<string, unknown> = {}): void {
  const error = err instanceof Error ? err : undefined;
  const message = error?.message ?? String(err);
  console.error(name, err);
  if (kernel === undefined) return;
  try {
    const stack = error?.stack !== undefined ? kernel.diag.scrubStack(error.stack) : undefined;
    kernel.diag.write(
      level,
      'app',
      name,
      { ...fields, message, ...(stack !== undefined ? { stack } : {}) },
      {
        kind: 'crash',
        name: `crash/${name.split('.').pop() ?? name}`,
        data: { source: 'main', ...(stack !== undefined ? { stack } : {}) },
      },
    );
    // 日志默认在 setImmediate 里批量写盘；崩溃后进程马上退出，这里同步落盘
    kernel.diag.flushSync();
  } catch {
    // 日志失败不能影响崩溃处理
  }
}

function onUncaught(err: unknown): void {
  reportCrash('error', 'app.uncaught_exception', err);
  // 记完交回 Node 的默认行为（打印并退出），不把崩溃吞掉
  process.removeListener('uncaughtException', onUncaught);
  throw err;
}

process.on('uncaughtException', onUncaught);
process.on('unhandledRejection', (reason) => {
  reportCrash('error', 'app.unhandled_rejection', reason);
});
app.on('render-process-gone', (_event, _contents, details) => {
  reportCrash('error', 'app.render_process_gone', details.reason, { reason: details.reason });
});
app.on('child-process-gone', (_event, details) => {
  reportCrash('error', 'app.child_process_gone', details.reason, { reason: details.reason, type: details.type });
});

async function bootstrap(): Promise<void> {
  const dataRoot = process.env['MINIBOT_HOME'] ?? defaultDataRoot();
  const crypto = cryptoModule.electronCrypto();
  const builtinPluginsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'builtin-plugins')
    : path.join(__dirname, '..', '..', '..', 'packages', 'builtin-plugins');
  kernel = await Kernel.open({
    dataRoot,
    crypto,
    appVersion: app.getVersion(),
    collectUrl: collectUrl(),
    openExternal: async (url) => openExternal(url),
    builtinPluginsDir,
  });
  // 手机功能的任何问题（没有密钥库、端口被占用…）只体现在“手机”设置页，不影响内核与本机界面
  try {
    remote = await RemoteService.start(kernel, { dataRoot, crypto });
  } catch (err) {
    console.error('手机功能启动失败', err);
    remote = undefined;
  }
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

  // 应用内更新：状态推给渲染端，检查与重启走 IPC（同样只接受主窗口）
  updater = updaterModule.createUpdater({
    diag: kernel.diag,
    hasRunningReplies: () => kernel !== undefined && kernel.runningThreads().length > 0,
    onState: (state) => {
      if (mainWindow !== undefined) mainWindow.webContents.send('minibot:update-state', state);
    },
  });
  ipcMain.handle('minibot:update-state', (event) => {
    assertTrusted(event);
    return updater?.state() ?? { phase: 'idle' };
  });
  ipcMain.handle('minibot:update-check', async (event) => {
    assertTrusted(event);
    return (await updater?.check()) ?? { phase: 'idle' };
  });
  ipcMain.handle('minibot:update-install', async (event) => {
    assertTrusted(event);
    await updater?.install();
  });

  // 只按 botId 打开该 bot 的记忆目录，不接受任意路径（openPath 打开可执行文件会直接运行它）
  ipcMain.handle('minibot:open-memory-dir', async (event, botId: unknown) => {
    assertTrusted(event);
    if (kernel === undefined || typeof botId !== 'string') throw new Error('拒绝请求');
    const error = await shell.openPath(kernel.memoryDir(botId));
    if (error.length > 0) throw new Error(error);
  });

  ipcMain.handle('minibot:pick-folder', async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle('minibot:pick-zip', async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'zip', extensions: ['zip'] }] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
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
  const win = mainWindow;
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  // 页面每次加载完都推送一次更新状态，重连后提示条不会丢
  win.webContents.on('did-finish-load', () => {
    if (updater !== undefined) win.webContents.send('minibot:update-state', updater.state());
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
      updater?.stop();
      updater = undefined;
    } catch {
      // 同上
    }
    try {
      await kernel?.close();
    } catch {
      // 同上
    }
    app.quit();
  })();
});
