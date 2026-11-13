// 设置 › 扩展 › 市场：添加 / 移除市场源，浏览、过滤并安装条目。

import { useCallback, useEffect, useState } from 'react';
import type { MarketEntry } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { BUTTON, SETTINGS_CARD, SettingsGroup, errorText } from '../ui/settings';
import { FIELD } from '../ui/recipes';

export function MarketSection({ api, onInstalled }: { api: Api; onInstalled: () => void }) {
  const [markets, setMarkets] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [entries, setEntries] = useState<MarketEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.markets().then((r) => setMarkets(r.markets), (err: unknown) => setError(errorText(err)));
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const browse = async (url: string): Promise<void> => {
    setActive(url);
    setError(null);
    try {
      setEntries((await api.marketPlugins(url)).plugins);
    } catch (err) {
      setError(errorText(err));
      setEntries([]);
    }
  };

  const add = async (): Promise<void> => {
    setError(null);
    try {
      await api.addMarket(newUrl.trim());
      setNewUrl('');
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (url: string): Promise<void> => {
    setError(null);
    try {
      await api.removeMarket(url);
      if (active === url) {
        setActive(null);
        setEntries([]);
      }
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const install = async (entry: MarketEntry): Promise<void> => {
    if (active === null) return;
    setBusy(entry.name);
    setError(null);
    try {
      const preview = await api.pluginPrepare({ kind: 'market', marketUrl: active, name: entry.name });
      await api.pluginConfirm(preview.token);
      onInstalled();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const shown = entries.filter((e) => filter === '' || e.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <SettingsGroup label={t('plugins.market')}>
      {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
      <div className={cn(SETTINGS_CARD, 'flex flex-col gap-2 px-4 py-3')}>
        <div className="flex gap-2">
          <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder={t('plugins.marketAddHint')} className={FIELD} />
          <button type="button" className={BUTTON} onClick={() => void add()}>{t('plugins.marketAdd')}</button>
        </div>
        {markets.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">{t('plugins.marketEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {markets.map((url) => (
              <div key={url} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void browse(url)}
                  className={cn('min-w-0 flex-1 truncate text-left font-mono text-[12px]', url === active ? 'text-ink' : 'text-ink-secondary hover:text-ink')}>
                  {url}
                </button>
                <button type="button" className={BUTTON} onClick={() => void browse(url)}>{t('plugins.marketBrowse')}</button>
                <button type="button" className={cn(BUTTON, 'text-danger')} onClick={() => void remove(url)}>{t('plugins.marketRemove')}</button>
              </div>
            ))}
          </div>
        )}
        {active !== null && (
          <div className="flex flex-col gap-2 border-t-[0.5px] border-hairline pt-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('plugins.marketFilter')} className={FIELD} />
            {shown.length === 0 ? (
              <p className="text-[13px] text-ink-secondary">{t('plugins.marketNoEntries')}</p>
            ) : (
              shown.map((entry) => (
                <div key={entry.name} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {entry.name} <span className="text-[12px] text-ink-secondary">v{entry.version}</span>
                  </span>
                  <button type="button" disabled={busy === entry.name} className={BUTTON} onClick={() => void install(entry)}>
                    {t('plugins.marketInstall')}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}
