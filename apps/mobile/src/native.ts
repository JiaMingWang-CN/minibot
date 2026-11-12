import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type ConnectionKind = 'idle' | 'connecting' | 'lan' | 'relay' | 'pc_offline' | 'revoked' | 'error';

export interface PhoneStatus {
  paired: boolean;
  /** 与电脑的协议兼容状态；旧版电脑未报告版本时为 unknown */
  compat: 'ok' | 'phone_outdated' | 'pc_outdated' | 'unknown';
  deviceModel: string;
  pcName: string | null;
  connection: ConnectionKind;
  error: string | null;
  background: boolean;
  notificationsAllowed: boolean;
  batteryOptimized: boolean;
}

export interface DiagnosticsInfo {
  consent: 'unset' | 'on' | 'off';
  /** 构建时配置了收集点：反馈入口与开关可用 */
  available: boolean;
  appVersion: string;
}

export interface AvailableUpdate {
  available: boolean;
  version?: string;
  notes?: string;
}

export interface NativeResponse {
  status: number;
  body?: unknown;
  /** base64 */
  bytes?: string;
  contentType?: string;
}

/** 原生插件：私钥、psk、中继口令只在原生层，这里没有任何读取它们的方法 */
export interface MinibotRemotePlugin {
  getStatus(): Promise<PhoneStatus>;
  scanAndPair(o: { deviceName: string }): Promise<{ cancelled: boolean }>;
  pair(o: { code: string; deviceName: string }): Promise<void>;
  unpair(): Promise<void>;
  request(o: { method: string; path: string; body?: unknown }): Promise<NativeResponse>;
  sendControl(o: { msg: unknown }): Promise<void>;
  setActiveThread(o: { threadId: string | null }): Promise<void>;
  startBackground(): Promise<void>;
  stopBackground(): Promise<void>;
  requestNotificationPermission(): Promise<void>;
  openBatterySettings(): Promise<void>;
  takeLaunchThread(): Promise<{ threadId: string | null }>;
  // 诊断与反馈：本机功能，只在原生层处理，不经电脑端
  getDiagnostics(): Promise<DiagnosticsInfo>;
  setDiagnostics(o: { consent: 'on' | 'off' }): Promise<void>;
  logsPreview(): Promise<{ text: string }>;
  sendFeedback(o: { description: string; contact?: string; attachLogs: boolean }): Promise<void>;
  reportClientError(o: { message: string; stack?: string }): Promise<void>;
  // 应用内更新
  checkUpdate(o: { manual: boolean }): Promise<AvailableUpdate>;
  downloadAndInstall(): Promise<void>;
  addListener(event: 'kernelEvent', cb: (e: { event: unknown }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'ready', cb: (e: { pcName: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'status', cb: (s: PhoneStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'openThread', cb: (e: { threadId: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'updateProgress', cb: (e: { percent: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'updateError', cb: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

export const MinibotRemote = registerPlugin<MinibotRemotePlugin>('MinibotRemote');
