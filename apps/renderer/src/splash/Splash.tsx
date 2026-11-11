// 开机动画的外壳：铺满窗口的画布，颜色从当前主题 token 取（头是墨色，眼和底是对话区底色）。

import { useEffect, useRef } from 'react';
import { playSplash, type Rgb } from './animation';

export const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 读一个颜色 token 的计算值（浏览器把它解析成 rgb()/rgba()） */
function tokenRgb(name: string): Rgb {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return m === null ? [0, 0, 0] : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function Splash({ onDone }: { onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current === null) return;
    const app = tokenRgb('--color-app');
    return playSplash(canvas.current, { background: app, head: tokenRgb('--color-ink'), eyes: app }, onDone);
  }, [onDone]);
  return <canvas ref={canvas} className="fixed inset-0 z-[100] size-full bg-app" aria-hidden="true" />;
}
