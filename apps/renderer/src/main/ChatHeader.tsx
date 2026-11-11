// 聊天头：半透明，浮在消息上；两侧等宽，中间的 bot 因此居中。
// 右边依次是上下文占用、模型选择和对话的更多操作。

import type { Bot, KernelState, Thread, ThreadUsage } from '@minibot/core';
import { MoreHorizontal } from 'lucide-react';
import type { BotPatch, PresetWithModels } from '../api';
import { Logo } from '../brand/Logo';
import { t } from '../i18n';
import { Menu } from '../ui/Menu';
import { ICON_BUTTON } from '../ui/recipes';
import { ContextRing } from './ContextRing';
import { ModelPicker } from './ModelPicker';

export function ChatHeader({
  bot,
  providers,
  presets,
  active,
  isRunning,
  context,
  usage,
  panelOpen,
  onTogglePanel,
  onOpenPanel,
  onChangeModel,
  onRename,
  onDelete,
  onCompact,
}: {
  bot: Bot;
  providers: KernelState['providers'];
  presets: PresetWithModels[];
  active: Thread | null;
  isRunning: boolean;
  context: { tokens: number; window: number } | null;
  usage: ThreadUsage | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenPanel: () => void;
  onChangeModel: (patch: BotPatch) => void;
  onRename: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
  onCompact: () => void;
}) {
  return (
  <header className="absolute inset-x-0 top-0 z-10 grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-app/80 px-4 backdrop-blur-md">
    <span />
    <button
      type="button"
      aria-expanded={panelOpen}
      title={t('panel.open')}
      onClick={onTogglePanel}
      className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-3 pl-2 transition-colors hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.08]">
      <Logo size={20} />
      <h1 className="truncate text-[14px] font-medium">{bot.name}</h1>
    </button>
    <div className="flex min-w-0 items-center justify-end gap-1">
      {context !== null && context.window > 0 && <ContextRing context={context} usage={usage} />}
      <ModelPicker bot={bot} providers={providers} presets={presets} isDisabled={isRunning} onChange={onChangeModel} />
      {active !== null && (
        <Menu
          align="end"
          items={[
            { label: t('main.rename'), onSelect: () => onRename(active) },
            { label: t('main.delete'), danger: true, onSelect: () => onDelete(active) },
            { type: 'separator' },
            { label: t('main.compact'), disabled: isRunning, onSelect: onCompact },
            { label: t('main.openMemory'), onSelect: () => void window.minibot.openMemoryDir(bot.id).catch(() => {}) },
            { type: 'separator' },
            { label: t('panel.open'), onSelect: onOpenPanel },
          ]}
          trigger={(props) => (
            <button {...props} type="button" aria-label={t('main.threadActions')} className={ICON_BUTTON}>
              <MoreHorizontal size={18} aria-hidden />
            </button>
          )}
        />
      )}
    </div>
  </header>
  );
}
