# CLAUDE

Project-specific guidance for AI coding agents.

## 桌面端界面（apps/renderer）

技术栈：React 19 + Tailwind v4（`@tailwindcss/vite`）+ lucide-react 图标 + `clsx`/`tailwind-merge`（`src/lib/cn.ts`）。不用组件库。

设计语言：黑白灰。全部定义在 `src/styles.css`：
- 颜色只用语义 token 生成的工具类（`bg-app`、`bg-panel`、`bg-frame`、`bg-composer`、`bg-menu`、`text-ink`、`text-ink-secondary`、`text-ink-tertiary`、`border-edge`、`ring-hairline` …），不写色值。浅色是默认值，深色在 `prefers-color-scheme: dark` 里整组覆盖。
- 强调色就是墨色（主按钮 `bg-ink text-on-ink`）；`danger` / `warning` / `success` 只用于状态。
- 层级靠 0.5px 细线和 `shadow-float`，不靠色块。
- 常用视觉配方在 `src/ui/recipes.ts`（`ELEVATED_*`、`PILL_*`、`ICON_BUTTON`、`MENU_*`、`FIELD`），同类控件先复用这些。
- 浮层用 `src/ui/` 里的 `Popover` / `Menu` / `Dialog` / `HoverCard`。

界面文字只有简体中文，集中在 `src/i18n.ts`，组件里不写死文案。

界面三块：`splash/`（开机动画）、`onboarding/`（初始化）、`main/`（主界面）。品牌符号在 `src/brand/Logo.tsx`，与 `docs/brand` 一致。

验证界面改动：`npm run build --workspace @minibot/renderer`，再启动桌面端截图。用 `MINIBOT_HOME` 指向临时目录可以看到初始化流程，不动真实数据。
