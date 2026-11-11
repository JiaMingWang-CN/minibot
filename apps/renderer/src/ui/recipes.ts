// 常用视觉配方：组件直接拼这些 class，保证同一类东西长得一样。

/** 浮在对话区上的表面（输入框、卡片）：composer 底色 + 0.5px 墨色细线 */
export const ELEVATED_CARD = 'bg-composer ring-[0.5px] ring-ink/10';
/** 同上，再加一层轻阴影 */
export const ELEVATED_FLOAT = `${ELEVATED_CARD} shadow-float`;

/** 圆形图标按钮 */
export const ICON_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08] aria-expanded:text-ink disabled:opacity-40 disabled:hover:bg-transparent';
export const ICON_BUTTON_SM = `${ICON_BUTTON} size-7`;

/** 胶囊按钮：主按钮是墨色填充，次按钮是浮起表面 */
const PILL = 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[14px] font-medium transition-[background-color,opacity] disabled:opacity-40';
export const PILL_PRIMARY = `${PILL} bg-ink text-on-ink hover:bg-ink/85`;
export const PILL_SECONDARY = `${PILL} ${ELEVATED_CARD} text-ink hover:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_6%)]`;
export const PILL_DANGER = `${PILL} bg-danger text-white hover:bg-danger/85`;
/** 小字链接式按钮（“跳过”“更多选项”） */
export const TEXT_BUTTON = 'rounded text-[13px] text-ink-secondary transition-colors hover:text-ink';

/** 浮层菜单面板与菜单行 */
export const MENU_SHEET = 'flex flex-col gap-0.5 rounded-xl border-[0.5px] border-hairline bg-menu p-1.5 shadow-menu animate-pop-in';
export const MENU_ROW =
  'flex h-[30px] w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-ink hover:bg-ink/[0.06] focus-visible:bg-ink/[0.06] focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent';
export const MENU_LABEL = 'flex h-6 shrink-0 items-end px-2 pb-0.5 text-[12px] font-medium text-ink-tertiary';
export const MENU_SEPARATOR = 'mx-2 my-1 h-[0.5px] shrink-0 bg-ink/10';

/** 表单输入框 */
export const FIELD =
  'w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-ink outline-none ring-[0.5px] ring-transparent transition-shadow placeholder:text-ink-tertiary focus:bg-composer focus:ring-hairline';
