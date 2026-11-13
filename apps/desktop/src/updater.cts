// 桌面端应用内更新：electron-updater（GitHub Releases），未打包时不检查。
// 各步结果写日志与 update/* 事件，状态推给渲染端。

const { app } = require('electron') as typeof import('electron');
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
import type { DiagLog } from '@minibot/core';

type UpdatePhase = 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';

interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

interface UpdaterDeps {
  diag: DiagLog;
  /** 有回复正在运行时拒绝重启更新 */
  hasRunningReplies: () => boolean;
  onState: (state: UpdateState) => void;
}

interface Updater {
  state(): UpdateState;
  check(): Promise<UpdateState>;
  install(): Promise<void>;
  stop(): void;
}

/** 启动后多久检查一次、之后多久检查一次 */
const FIRST_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 3600_000;
const NEUTRAL: UpdateState = { phase: 'idle' };

/** 错误只报类别，不报原文（可能带地址等自由文本） */
function errorKindOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) return code.slice(0, 32);
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) return 'network';
  if (/404|403|401/i.test(message)) return 'http';
  return 'other';
}

function createUpdater(deps: UpdaterDeps): Updater {
  let current: UpdateState = NEUTRAL;
  let started = false;
  let firstTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  const publish = (state: UpdateState): void => {
    current = state;
    try {
      deps.onState(state);
    } catch {
      // 窗口已关闭等情况下推送失败不影响更新流程
    }
  };

  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>, event?: {
    kind: 'update';
    name: string;
    data: Record<string, string | number | boolean | null>;
  }): void => {
    try {
      deps.diag.write(level, 'update', msg, fields, event);
    } catch {
      // 日志失败不影响更新
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    autoUpdater.autoDownload = true;
    // 不在退出时偷偷安装：静默安装会刷新整个桌面图标，安装期间再打开应用也会卡住。
    // 只在用户点“重启更新”时安装，装完自动重新打开
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => {
      publish({ phase: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      const version = typeof info?.version === 'string' ? info.version : undefined;
      log('info', 'update.available', { version }, {
        kind: 'update',
        name: 'update/update.check',
        data: { result: 'available', ...(version !== undefined ? { version: version.slice(0, 64) } : {}) },
      });
      publish({ phase: 'downloading', ...(version !== undefined ? { version } : {}), percent: 0 });
    });
    autoUpdater.on('update-not-available', () => {
      log('info', 'update.none', {}, { kind: 'update', name: 'update/update.check', data: { result: 'none' } });
      publish({ phase: 'none', checkedAt: Date.now() });
    });
    autoUpdater.on('download-progress', (progress) => {
      const percent = typeof progress?.percent === 'number' ? Math.round(progress.percent) : 0;
      publish({
        phase: 'downloading',
        ...(current.version !== undefined ? { version: current.version } : {}),
        percent,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      const version = typeof info?.version === 'string' ? info.version : undefined;
      log('info', 'update.downloaded', { version }, {
        kind: 'update',
        name: 'update/update.download',
        data: { result: 'ok', ...(version !== undefined ? { version: version.slice(0, 64) } : {}) },
      });
      publish({ phase: 'ready', ...(version !== undefined ? { version } : {}), checkedAt: Date.now() });
    });
    autoUpdater.on('error', (err) => {
      const errorKind = errorKindOf(err);
      log('warn', 'update.failed', { errorKind, message: err instanceof Error ? err.message : String(err) }, {
        kind: 'update',
        name: 'update/update.check',
        data: { result: 'error', errorKind },
      });
      publish({ phase: 'error', error: errorKind, checkedAt: Date.now() });
    });

    firstTimer = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    firstTimer.unref();
    intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    intervalTimer.unref();
  };

  const check = async (): Promise<UpdateState> => {
    if (!app.isPackaged) return current;
    if (!started) start();
    // 正在下载或已下载好：不重新检查，否则提示条会先消失再出现
    if (current.phase === 'downloading' || current.phase === 'ready') return current;
    publish({ phase: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // error 事件通常已经设过状态；这里兜底（不会重复推 errorKind 原文）
      if (current.phase !== 'error') {
        publish({ phase: 'error', error: errorKindOf(err), checkedAt: Date.now() });
      }
    }
    return current;
  };

  const install = async (): Promise<void> => {
    if (!app.isPackaged) return;
    if (deps.hasRunningReplies()) {
      log('warn', 'update.install-blocked', {}, {
        kind: 'update',
        name: 'update/update.install',
        data: { result: 'blocked' },
      });
      throw new Error('还有回复正在进行，等结束后再重启');
    }
    log('info', 'update.install', {}, { kind: 'update', name: 'update/update.install', data: { result: 'ok' } });
    // 静默安装（不弹安装向导），装完自动重新打开
    autoUpdater.quitAndInstall(true, true);
  };

  start();

  return {
    state: () => current,
    check,
    install,
    stop: () => {
      if (firstTimer !== null) clearTimeout(firstTimer);
      if (intervalTimer !== null) clearInterval(intervalTimer);
      firstTimer = null;
      intervalTimer = null;
    },
  };
}

module.exports = { createUpdater };
export {};
