// 桌面端应用内更新的渲染端入口：读初始状态并订阅主进程推送。
// 手机网页层没有这个桥接，useUpdateState 返回 idle。

import { useEffect, useState } from 'react';

const IDLE: UpdateState = { phase: 'idle' };

function bridge(): Window['minibot']['update'] | undefined {
  if (typeof window === 'undefined' || typeof window.minibot === 'undefined') return undefined;
  return window.minibot.update;
}

export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(IDLE);
  useEffect(() => {
    const update = bridge();
    if (update === undefined) return;
    let alive = true;
    void update.state().then(
      (next) => {
        if (alive) setState(next);
      },
      () => {},
    );
    const unsubscribe = update.onState((next) => setState(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return state;
}

/** 触发一次手动检查；未打包运行时主进程直接返回 idle */
export async function checkForUpdate(): Promise<UpdateState> {
  const update = bridge();
  if (update === undefined) return IDLE;
  return await update.check();
}

/** 重启并安装已下载的更新 */
export async function installUpdate(): Promise<void> {
  await bridge()?.install();
}
