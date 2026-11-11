// 窗口外框的顶栏（28px）：窗口用 titleBarOverlay 隐藏了原生标题栏，这一条用来拖动窗口，
// 右侧由系统画窗口按钮。左边是标志，中间是当前位置。
// 底色同步给 Electron 的窗口按钮覆盖层，深浅色切换时跟着变。
// 高度与 apps/desktop/src/main.cts 的 TITLE_BAR_HEIGHT 一致。

import { useEffect, useRef } from 'react';
import { Logo } from './brand/Logo';

/** 计算样式里的 rgb()/rgba() → #rrggbb（Electron 覆盖层只收不透明颜色） */
function toHex(css: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (m === null) return null;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

export function FrameBar({ title }: { title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = (): void => {
      const el = ref.current;
      if (el === null) return;
      const style = getComputedStyle(el);
      const color = toHex(style.backgroundColor);
      const symbolColor = toHex(style.color);
      if (color !== null && symbolColor !== null) window.minibot.setTitleBar({ color, symbolColor });
    };
    sync();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => void requestAnimationFrame(sync);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  // 外层整行铺外框色；内层只占窗口按钮左边的区域，标题因此居中在可用区域里
  return (
    <div ref={ref} className="drag h-(--frame-bar) shrink-0 bg-frame text-ink">
      <div className="grid h-full w-[env(titlebar-area-width,100%)] grid-cols-[1fr_auto_1fr] items-center px-3">
        <div className="flex items-center gap-2">
          <Logo size={14} />
          <span className="text-[12px] font-semibold tracking-[-0.01em]">minibot</span>
        </div>
        <span className="max-w-[40vw] truncate text-[12px] text-ink-secondary">{title}</span>
        <span />
      </div>
    </div>
  );
}
