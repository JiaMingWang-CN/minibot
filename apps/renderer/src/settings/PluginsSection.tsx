// 设置 › 扩展 › 插件：预装搜索插件置顶并标“搜索”；每行显示名称、版本、状态、来源与操作。

import { useCallback, useEffect, useState } from 'react';
import type { PluginView, UpdatePreview } from '@minibot/core';
import type { Api } from '../api';
import type { Subscribe } from '../App';
import { t, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { BUTTON, SETTINGS_CARD, SettingsGroup, errorText } from '../ui/settings';
import { Dialog } from '../ui/Dialog';
import { PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { PluginConnectDialog } from './PluginConnectDialog';
import { PluginInstallDialog } from './PluginInstallDialog';
import { MarketSection } from './MarketSection';

const SEARCH_PLUGINS = new Set(['deepseek', 'tavily']);

const STATUS_TEXT: Record<PluginView['status'], MessageKey> = {
  not_connected: 'plugins.status.not_connected',
  connected: 'plugins.status.connected',
  error: 'plugins.status.error',
};

const ORIGIN_TEXT: Record<string, MessageKey> = {
  local: 'plugins.origin.local',
  git: 'plugins.origin.git',
  market: 'plugins.origin.market',
  builtin: 'plugins.origin.builtin',
};

function statusCls(status: PluginView['status']): string {
  if (status === 'connected') return 'text-success';
  if (status === 'error') return 'text-danger';
  return 'text-ink-secondary';
}

export function PluginsSection({ api, subscribe }: { api: Api; subscribe: Subscribe }) {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [connecting, setConnecting] = useState<PluginView | null>(null);
  const [updates, setUpdates] = useState<Map<string, string>>(new Map());
  const [updating, setUpdating] = useState<UpdatePreview | null>(null);

  const refresh = useCallback(() => {
    api.plugins().then((r) => setPlugins(r.plugins), (err: unknown) => setError(errorText(err)));
  }, [api]);

  useEffect(() => {
    refresh();
    return subscribe((event) => {
      if (event.type === 'mcp_status') refresh();
    });
  }, [refresh, subscribe]);

  const run = async (name: string, job: () => Promise<unknown>): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      await job();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const checkUpdates = async (): Promise<void> => {
    setError(null);
    try {
      const { updates } = await api.pluginUpdates();
      setUpdates(new Map(updates.map((u) => [u.name, u.latest])));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const sorted = [...plugins].sort((a, b) => {
    const sa = SEARCH_PLUGINS.has(a.name) ? 0 : 1;
    const sb = SEARCH_PLUGINS.has(b.name) ? 0 : 1;
    return sa - sb || a.name.localeCompare(b.name);
  });

  return (
    <>
      <SettingsGroup
        label={t('plugins.title')}
        actions={
          <div className="flex gap-1.5">
            <button type="button" className={BUTTON} onClick={() => void checkUpdates()}>
              {t('plugins.checkUpdates')}
            </button>
            <button type="button" className={BUTTON} onClick={() => setInstalling(true)}>
              {t('plugins.install')}
            </button>
          </div>
        }>
        {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
        {sorted.length === 0 ? (
          <p className={cn(SETTINGS_CARD, 'px-4 py-6 text-[13px] text-ink-secondary')}>{t('plugins.empty')}</p>
        ) : (
          <div className={cn(SETTINGS_CARD, 'flex flex-col divide-y divide-hairline')}>
            {sorted.map((plugin) => {
              const update = updates.get(plugin.name);
              return (
                <div key={plugin.name} className="flex flex-col gap-1.5 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{plugin.name}</span>
                    {SEARCH_PLUGINS.has(plugin.name) && (
                      <span className="shrink-0 rounded-full bg-ink/[0.08] px-2 py-0.5 text-[11px] text-ink-secondary">
                        {t('plugins.tag.search')}
                      </span>
                    )}
                    <span className="shrink-0 text-[12px] text-ink-secondary">v{plugin.version}</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
                    <span className={statusCls(plugin.status)}>
                      {plugin.loginServerIds.length > 0 ? t('mcp.status.needs_login') : t(STATUS_TEXT[plugin.status])}
                    </span>
                    <span>{t(ORIGIN_TEXT[plugin.source.kind] ?? 'plugins.origin.local')}</span>
                    {update !== undefined && <span className="text-warning">{t('plugins.updateAvailable')}：{update}</span>}
                  </div>
                  {plugin.problems.length > 0 && (
                    <p className="min-w-0 break-words text-[12px] text-danger">{plugin.problems.join('；')}</p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" disabled={busy === plugin.name} className={BUTTON} onClick={() => setConnecting(plugin)}>
                      {t('plugins.connect')}
                    </button>
                    <button
                      type="button"
                      disabled={busy === plugin.name}
                      className={BUTTON}
                      onClick={() => void run(plugin.name, () => api.pluginSetEnabled(plugin.name, !plugin.enabled))}>
                      {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                    </button>
                    {plugin.loginServerIds.length > 0 && (
                      <button
                        type="button"
                        disabled={busy === plugin.name}
                        className={BUTTON}
                        onClick={() => void run(plugin.name, async () => {
                          for (const id of plugin.loginServerIds) await api.mcpLogin(id);
                        })}>
                        {t('extensions.mcp.login')}
                      </button>
                    )}
                    {update !== undefined && (
                      <button
                        type="button"
                        disabled={busy === plugin.name}
                        className={BUTTON}
                        onClick={() => void run(plugin.name, async () => {
                          setUpdating(await api.pluginPrepareUpdate(plugin.name));
                        })}>
                        {t('plugins.update')}
                      </button>
                    )}
                    {!plugin.builtin && (
                      <button
                        type="button"
                        disabled={busy === plugin.name}
                        className={cn(BUTTON, 'text-danger')}
                        onClick={() => void run(plugin.name, () => api.pluginDelete(plugin.name))}>
                        {t('plugins.delete')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      <MarketSection api={api} onInstalled={refresh} />

      {installing && (
        <PluginInstallDialog
          api={api}
          onClose={() => setInstalling(false)}
          onInstalled={() => {
            setInstalling(false);
            refresh();
          }}
        />
      )}
      {connecting !== null && (
        <PluginConnectDialog
          api={api}
          plugin={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            refresh();
          }}
        />
      )}
      {updating !== null && (
        <Dialog
          open
          onClose={() => setUpdating(null)}
          title={t('plugins.confirmTitle', { name: updating.manifest.name })}
          wide
          footer={
            <>
              <button type="button" className={PILL_SECONDARY} onClick={() => setUpdating(null)}>{t('common.cancel')}</button>
              <button
                type="button"
                className={PILL_PRIMARY}
                onClick={() => void run(updating.manifest.name, async () => {
                  await api.pluginConfirmUpdate(updating.token);
                  setUpdating(null);
                  setUpdates((m) => {
                    const next = new Map(m);
                    next.delete(updating.manifest.name);
                    return next;
                  });
                })}>
                {t('plugins.update')}
              </button>
            </>
          }>
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-secondary">
              {t('plugins.version')}：{updating.manifest.version}
            </p>
            {updating.commandChanges.length > 0 && (
              <div className="rounded-lg bg-warning/10 px-3 py-2">
                <p className="text-[12px] font-medium text-warning">{t('plugins.commandChanged')}</p>
                {updating.commandChanges.map((c) => (
                  <div key={c.server} className="mt-1 font-mono text-[12px] whitespace-pre-wrap break-words text-ink-secondary">
                    {c.server}：{t('plugins.before')} {c.before ?? '—'} → {t('plugins.after')} {c.after ?? '—'}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
