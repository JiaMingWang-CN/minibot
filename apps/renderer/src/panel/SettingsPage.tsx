// bot 设置页：人设；操作前要不要问（三档 + 总是允许的命令）；上下文窗口与输出上限。
// 布局照 OpenMausBot bot 面板的设置页。

import { useEffect, useState } from 'react';
import type { ApprovalMode, PluginView, SkillInfo } from '@minibot/core';
import { FileText, Gauge, Globe, ListChecks, Plug, ShieldCheck, Sparkles, Text } from 'lucide-react';
import type { McpServerView } from '../api';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { errorText } from '../ui/settings';
import type { PanelContext } from './BotPanel';
import { Card, ColRow, LinkRow, NoteRow, RowIcon, RowText, Segmented, SwitchRow, TrashButton, panelInputCls, primaryButtonCls, rowCls } from './rows';

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

export function SettingsPage({ api, bot, patch, isRunning, onOpenAllowlist }: PanelContext) {
  const [persona, setPersona] = useState(bot.persona);
  const [error, setError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    api.mcpServers().then((r) => setMcpServers(r.servers), () => undefined);
    api.plugins().then((r) => setPlugins(r.plugins), () => undefined);
    api.skills().then((r) => setSkills(r.skills), () => undefined);
  }, [api]);
  const run = (job: Promise<void>): void => {
    setError(null);
    job.catch((err: unknown) => setError(errorText(err)));
  };
  const toggleMcp = (id: string): void => {
    const current = bot.extensions.mcpServers;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    run(patch({ extensions: { ...bot.extensions, mcpServers: next } }));
  };
  const togglePlugin = (name: string): void => {
    const current = bot.extensions.plugins;
    const next = current.includes(name) ? current.filter((x) => x !== name) : [...current, name];
    run(patch({ extensions: { ...bot.extensions, plugins: next } }));
  };
  const toggleExclusion = (id: string): void => {
    const current = bot.pluginExclusions;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    run(patch({ pluginExclusions: next }));
  };
  const toggleSkill = (id: string): void => {
    const current = bot.extensions.skills;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    run(patch({ extensions: { ...bot.extensions, skills: next } }));
  };
  const SEARCH_PLUGINS = new Set(['deepseek', 'tavily']);
  const userSkills = skills.filter((s) => s.origin.kind === 'user');

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

      <Card label={t('panel.extensions')}>
        <SwitchRow
          icon={Globe}
          title={t('panel.extWeb')}
          hint={t('panel.extWebHint')}
          checked={bot.extensions.web}
          onChange={() =>
            run(patch({ extensions: { ...bot.extensions, web: !bot.extensions.web } }))
          }
        />
        {mcpServers.map((server) => (
          <SwitchRow
            key={server.id}
            icon={Plug}
            title={server.name}
            hint={t(`mcp.status.${server.status}` as MessageKey)}
            checked={bot.extensions.mcpServers.includes(server.id)}
            onChange={() => toggleMcp(server.id)}
          />
        ))}
        {plugins
          .filter((p) => !SEARCH_PLUGINS.has(p.name))
          .map((plugin) => (
            <div key={plugin.name} className="flex flex-col">
              <SwitchRow
                icon={Plug}
                title={plugin.name}
                hint={t(`plugins.status.${plugin.status}` as MessageKey)}
                checked={bot.extensions.plugins.includes(plugin.name)}
                onChange={() => togglePlugin(plugin.name)}
              />
              {bot.extensions.plugins.includes(plugin.name) &&
                plugin.serverIds.map((serverId) => (
                  <SwitchRow
                    key={serverId}
                    title={serverId}
                    hint={t('panel.pluginExclusions')}
                    checked={!bot.pluginExclusions.includes(serverId)}
                    onChange={() => toggleExclusion(serverId)}
                  />
                ))}
              {bot.extensions.plugins.includes(plugin.name) &&
                skills
                  .filter((s) => s.origin.kind === 'plugin' && s.origin.pluginName === plugin.name)
                  .map((skill) => (
                    <SwitchRow
                      key={skill.id}
                      icon={Sparkles}
                      title={skill.name}
                      hint={skill.shadowed ? t('skills.conflict') : skill.description}
                      checked={!bot.pluginExclusions.includes(skill.id)}
                      onChange={() => toggleExclusion(skill.id)}
                    />
                  ))}
            </div>
          ))}
        {userSkills.map((skill) => (
          <SwitchRow
            key={skill.id}
            icon={Sparkles}
            title={skill.name}
            hint={skill.shadowed ? t('skills.conflict') : skill.description}
            checked={bot.extensions.skills.includes(skill.id)}
            onChange={() => toggleSkill(skill.id)}
          />
        ))}
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
