import { useEffect, useState } from 'react';
import { MinibotRemote, type PhoneStatus } from './native';

/** 原生层的连接与权限状态；连接变化时原生会推 status 事件，回到前台时再主动读一次 */
export function usePhoneStatus(): PhoneStatus | null {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const handle = MinibotRemote.addListener('status', (s) => alive && setStatus(s));
    const refresh = (): void => void MinibotRemote.getStatus().then((s) => alive && setStatus(s));
    refresh();
    // 从系统设置（通知权限、电池优化）回来时重新读一次，原生层不会为这些变化推事件
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void handle.then((h) => h.remove());
    };
  }, []);
  return status;
}
