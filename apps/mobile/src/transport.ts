import type { KernelEvent } from '@minibot/core';
import { ApiError, type ClientMessage, type EventConnection, type Transport } from '@renderer/api';
import { t } from '@renderer/i18n';
import { MinibotRemote } from './native';

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** 请求经原生桥接 → 加密连接 → 电脑端白名单 */
export function nativeTransport(): Transport {
  return {
    async request(method, path, body) {
      try {
        const res = await MinibotRemote.request({ method, path, ...(body !== undefined ? { body } : {}) });
        return {
          status: res.status,
          json: res.body,
          ...(res.bytes !== undefined ? { bytes: base64ToBytes(res.bytes) } : {}),
          ...(res.contentType !== undefined ? { contentType: res.contentType } : {}),
        };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === 'offline') throw new ApiError('offline', t('mobile.offline'));
        throw new ApiError(e.code ?? 'native_error', e.message ?? String(err));
      }
    },
  };
}

/** 事件来自原生层转发的内核事件；"ready" 对应桌面端 WebSocket 的每次（重新）连上 */
export function nativeEvents(onEvent: (event: KernelEvent) => void): EventConnection {
  const openListeners = new Set<() => void>();
  const handles = [
    MinibotRemote.addListener('kernelEvent', ({ event }) => onEvent(event as KernelEvent)),
    MinibotRemote.addListener('ready', () => {
      for (const listener of openListeners) listener();
    }),
  ];
  return {
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    send(message: ClientMessage) {
      void MinibotRemote.sendControl({ msg: message }).catch(() => {});
    },
    close() {
      for (const handle of handles) void handle.then((h) => h.remove());
    },
  };
}
