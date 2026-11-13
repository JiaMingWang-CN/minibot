// 设置 › 扩展：本期只有 MCP。列表显示状态、错误与工具数，可连接 / 刷新 / 登录 / 删除。

import { useCallback, useEffect, useState } from 'react';
import type { Subscribe } from '../App';
import type { Api, McpServerView } from '../api';
import { t, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { BUTTON, SETTINGS_CARD, SettingsGroup, errorText } from '../ui/settings';
import { McpServerDialog } from './McpServerDialog';
import { PluginsSection } from './PluginsSection';
import { SkillsSection } from './SkillsSection';

const STATUS_KEY: Record<string, MessageKey> = {
  connecting: 'mcp.status.connecting',
  connected: 'mcp.status.connected',
  failed: 'mcp.status.failed',
  needs_login: 'mcp.status.needs_login',
  stopped: 'mcp.status.stopped',
};

function Dot({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'connected' && 'bg-success',
        status === 'connecting' && 'bg-warning',
        status === 'failed' && 'bg-danger',
        status === 'needs_login' && 'bg-warning',
        status === 'stopped' && 'bg-ink-tertiary',
      )}
    />
  );
}

export function ExtensionsPage({ api, subscribe }: { api: Api; subscribe: Subscribe }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(() => {
    api
      .mcpServers()
      .then((r) => setServers(r.servers), (err: unknown) => setError(errorText(err)));
  }, [api]);

  useEffect(() => {
    refresh();
    return subscribe((event) => {
      if (event.type === 'mcp_status') refresh();
    });
  }, [refresh, subscribe]);

  const run = async (id: string, job: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
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

  return (
    <>
    <PluginsSection api={api} subscribe={subscribe} />
    <SkillsSection api={api} />
    <SettingsGroup
      label={t('extensions.mcp')}
      actions={
        <button type="button" className={BUTTON} onClick={() => setAdding(true)}>
          {t('extensions.mcp.add')}
        </button>
      }>
      {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
      {servers.length === 0 ? (
        <p className={cn(SETTINGS_CARD, 'px-4 py-6 text-[13px] text-ink-secondary')}>{t('extensions.mcp.empty')}</p>
      ) : (
        <div className={cn(SETTINGS_CARD, 'flex flex-col divide-y divide-hairline')}>
          {servers.map((server) => (
            <div key={server.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Dot status={server.status} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{server.name}</span>
                <span className="shrink-0 text-[12px] text-ink-secondary">
                  {server.transport.type === 'stdio' ? t('extensions.mcp.type.stdio') : t('extensions.mcp.type.http')}
                </span>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-[12px] text-ink-secondary">
                <span className={server.status === 'failed' ? 'text-danger' : server.status === 'needs_login' ? 'text-warning' : undefined}>
                  {t(STATUS_KEY[server.status] ?? 'mcp.status.stopped')}
                </span>
                <span>{t('extensions.mcp.toolCount', { count: server.tools.length })}</span>
                {server.error !== null && <span className="min-w-0 break-words text-danger">{server.error}</span>}
              </div>
              <div className="flex flex-wrap gap-1.5 pl-4">
                <button type="button" disabled={busy === server.id} className={BUTTON} onClick={() => void run(server.id, () => api.mcpConnect(server.id))}>
                  {t('extensions.mcp.connect')}
                </button>
                <button type="button" disabled={busy === server.id} className={BUTTON} onClick={() => void run(server.id, () => api.mcpRefresh(server.id))}>
                  {t('extensions.mcp.refresh')}
                </button>
                {server.transport.type === 'http' && server.transport.auth === 'oauth' && (
                  <>
                    <button type="button" disabled={busy === server.id} className={BUTTON} onClick={() => void run(server.id, () => api.mcpLogin(server.id))}>
                      {t('extensions.mcp.login')}
                    </button>
                    <button type="button" disabled={busy === server.id} className={BUTTON} onClick={() => void run(server.id, () => api.mcpLogout(server.id))}>
                      {t('extensions.mcp.logout')}
                    </button>
                  </>
                )}
                <button type="button" disabled={busy === server.id} className={cn(BUTTON, 'text-danger')} onClick={() => void run(server.id, () => api.deleteMcpServer(server.id))}>
                  {t('extensions.mcp.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <McpServerDialog api={api} onClose={() => setAdding(false)} onCreated={refresh} />}
    </SettingsGroup>
    </>
  );
}
