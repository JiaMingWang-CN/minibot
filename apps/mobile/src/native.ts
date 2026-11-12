import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type ConnectionKind = 'idle' | 'connecting' | 'lan' | 'relay' | 'pc_offline' | 'revoked' | 'error';

export interface PhoneStatus {
  paired: boolean;
  deviceModel: string;
  pcName: string | null;
  connection: ConnectionKind;
  error: string | null;
  background: boolean;
  notificationsAllowed: boolean;
  batteryOptimized: boolean;
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
  addListener(event: 'kernelEvent', cb: (e: { event: unknown }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'ready', cb: (e: { pcName: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'status', cb: (s: PhoneStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'openThread', cb: (e: { threadId: string }) => void): Promise<PluginListenerHandle>;
}

export const MinibotRemote = registerPlugin<MinibotRemotePlugin>('MinibotRemote');
