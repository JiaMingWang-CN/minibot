import { useEffect, useState } from 'react';
import { MinibotRemote, type PhoneStatus } from './native';

/** 原生层的连接与权限状态；变化时原生会推 status 事件 */
export function usePhoneStatus(): PhoneStatus | null {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const handle = MinibotRemote.addListener('status', (s) => alive && setStatus(s));
    void MinibotRemote.getStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
      void handle.then((h) => h.remove());
    };
  }, []);
  return status;
}
