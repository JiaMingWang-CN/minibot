// bot 设置页：人设；操作前要不要问（三档 + 总是允许的命令）；上下文窗口与输出上限。
// 布局照 OpenMausBot bot 面板的设置页。

import { useState } from 'react';
import type { ApprovalMode } from '@minibot/core';
import { FileText, Gauge, ListChecks, ShieldCheck, Text } from 'lucide-react';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { errorText } from '../ui/settings';
import type { PanelContext } from './BotPanel';
import { Card, ColRow, LinkRow, NoteRow, RowIcon, RowText, Segmented, TrashButton, panelInputCls, primaryButtonCls, rowCls } from './rows';

const MODES: ApprovalMode[] = ['ask', 'edits', 'auto'];

function NumberRow({ icon, title, value, onCommit }: { icon: typeof Gauge; title: string; value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (Number.isFinite(n) && n > 0 && Math.floor(n) !== value) onCommit(Math.floor(n));
  };
  return (
    <label className={cn(rowCls, 'cursor-text')}>
      <RowIcon icon={icon} />
      <span className="min-w-0 flex-1 text-[14px] font-medium text-ink">{title}</span>
      <input
        inputMode="numeric"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape' && draft !== null) {
            e.preventDefault();
            setDraft(null);
          }
        }}
        aria-label={title}
        className="w-[110px] min-w-0 bg-transparent text-right text-[13px] text-ink-secondary tabular-nums outline-none focus:text-ink"
      />
    </label>
  );
}

export function SettingsPage({ bot, patch, isRunning, onOpenAllowlist }: PanelContext) {
  const [persona, setPersona] = useState(bot.persona);
  const [error, setError] = useState<string | null>(null);
  const run = (job: Promise<void>): void => {
    setError(null);
    job.catch((err: unknown) => setError(errorText(err)));
  };

  return (
    <div className="flex flex-col">
      <Card>
        <ColRow>
          <div className="flex items-center gap-2.5">
            <RowIcon icon={FileText} />
            <RowText title={t('panel.persona')} hint={t('panel.personaHint', { name: bot.name })} />
          </div>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder={t('panel.personaPlaceholder', { name: bot.name })}
            aria-label={t('panel.persona')}
            className={`${panelInputCls} min-h-[96px] resize-y leading-relaxed`}
          />
          {persona !== bot.persona && (
            <div className="flex justify-end">
              <button type="button" className={primaryButtonCls} onClick={() => run(patch({ persona }))}>
                {t('common.save')}
              </button>
            </div>
          )}
        </ColRow>
      </Card>

      <Card>
        <ColRow>
          <div className="flex items-center gap-2.5">
            <RowIcon icon={ShieldCheck} />
            <RowText title={t('panel.beforeActs', { name: bot.name })} hint={isRunning ? t('panel.whileRunning') : undefined} />
          </div>
          <div className="pl-[26px]">
            <Segmented
              label={t('panel.beforeActs', { name: bot.name })}
              value={bot.approvalMode}
              disabled={isRunning}
              onChange={(mode) => mode !== bot.approvalMode && run(patch({ approvalMode: mode }))}
              options={MODES.map((mode) => ({
                value: mode,
                label: t(`approvalMode.${mode}.label` as MessageKey),
                tooltip: t(`approvalMode.${mode}.desc` as MessageKey),
              }))}
            />
            <p className={cn('mt-2 text-[12px] leading-4', bot.approvalMode === 'auto' ? 'text-warning' : 'text-ink-tertiary')}>
              {t(`approvalMode.${bot.approvalMode}.desc` as MessageKey)}
            </p>
          </div>
          {(bot.allowedCommands.length > 0 || bot.allowWeb || bot.allowedMcpTools.length > 0) && (
            <div className="flex min-w-0 flex-col gap-1 pl-[26px]">
              <span className="text-[13px] text-ink-secondary">{t('allowlist.title')}</span>
              {bot.allowedCommands.map((command) => (
                <div key={`cmd:${command}`} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{command}</span>
                  <TrashButton
                    label={t('allowlist.removeAria', { command })}
                    onClick={() => run(patch({ allowedCommands: bot.allowedCommands.filter((c) => c !== command) }))}
                  />
                </div>
              ))}
              {bot.allowWeb && (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{t('allowlist.webAll')}</span>
                  <TrashButton
                    label={t('allowlist.removeAria', { command: t('allowlist.groupWeb') })}
                    onClick={() => run(patch({ allowWeb: false }))}
                  />
                </div>
              )}
              {bot.allowedMcpTools.map((key) => (
                <div key={`mcp:${key}`} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{key}</span>
                  <TrashButton
                    label={t('allowlist.removeAria', { command: key })}
                    onClick={() =>
                      run(patch({ allowedMcpTools: bot.allowedMcpTools.filter((k) => k !== key) }))
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </ColRow>
        <LinkRow icon={ListChecks} onClick={onOpenAllowlist}>
          {t('allowlist.manage')}
        </LinkRow>
      </Card>

      <Card label={t('panel.modelLimits')}>
        <NumberRow icon={Gauge} title={t('onboarding.model.contextWindow')} value={bot.contextWindow} onCommit={(n) => run(patch({ contextWindow: n }))} />
        <NumberRow icon={Text} title={t('panel.maxOutput')} value={bot.maxOutputTokens} onCommit={(n) => run(patch({ maxOutputTokens: n }))} />
      </Card>

      {error !== null && (
        <div className="mt-3.5">
          <NoteRow tone="warn">{error}</NoteRow>
        </div>
      )}
    </div>
  );
}
