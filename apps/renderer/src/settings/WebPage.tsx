// 设置 › 联网：网页抓取开关 + 搜索引擎（无 / DeepSeek / Tavily，未连接的置灰并提示去插件页连接）。

import { useEffect, useState } from 'react';
import type { PluginView, SearchEngine } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { SettingRow, SettingsGroup, SettingsRows, Switch, errorText } from '../ui/settings';
import { cn } from '../lib/cn';

const ENGINE_LABEL: Record<Exclude<SearchEngine, 'none'>, string> = {
  deepseek: 'DeepSeek',
  tavily: 'Tavily',
};

export function WebPage({ api, onOpenPlugins }: { api: Api; onOpenPlugins: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [engine, setEngine] = useState<SearchEngine>('none');
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.webSettings().then((s) => {
      setEnabled(s.fetchEnabled);
      setEngine(s.searchEngine);
    }, (err: unknown) => setError(errorText(err)));
    api.plugins().then((r) => setPlugins(r.plugins), () => undefined);
  }, [api]);

  const toggle = async (): Promise<void> => {
    if (enabled === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateWebSettings({ fetchEnabled: !enabled });
      setEnabled(next.fetchEnabled);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const connected = (name: 'deepseek' | 'tavily'): boolean => {
    const plugin = plugins.find((p) => p.name === name);
    return plugin !== undefined && plugin.enabled && plugin.status === 'connected';
  };

  const choose = async (next: SearchEngine): Promise<void> => {
    setError(null);
    try {
      const result = await api.updateWebSettings({ searchEngine: next });
      setEngine(result.searchEngine);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const options: SearchEngine[] = ['none', 'deepseek', 'tavily'];

  return (
    <SettingsGroup label={t('settings.page.web')}>
      <SettingsRows>
        <SettingRow title={t('web.fetch')} subtitle={t('web.fetchHint')}>
          <Switch checked={enabled ?? false} disabled={enabled === null || saving} aria-label={t('web.fetch')} onClick={() => void toggle()} />
        </SettingRow>
        <SettingRow title={t('web.searchEngine')}>
          <div className="flex flex-col items-end gap-1">
            <div className="flex gap-1.5">
              {options.map((value) => {
                const isSearch = value === 'deepseek' || value === 'tavily';
                const enabledOption = !isSearch || connected(value);
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={!enabledOption}
                    aria-pressed={engine === value}
                    onClick={() => void choose(value)}
                    className={cn(
                      'rounded-full px-3 py-1 text-[13px] transition-colors disabled:opacity-40',
                      engine === value ? 'bg-ink text-on-ink' : 'bg-ink/[0.06] text-ink',
                    )}>
                    {value === 'none' ? t('web.searchEngineNone') : ENGINE_LABEL[value]}
                  </button>
                );
              })}
            </div>
            {options.some((v) => (v === 'deepseek' || v === 'tavily') && !connected(v)) && (
              <button type="button" onClick={onOpenPlugins} className="text-[12px] text-ink-tertiary underline-offset-2 hover:text-ink hover:underline">
                {t('web.searchNotConnected')}
              </button>
            )}
          </div>
        </SettingRow>
      </SettingsRows>
      {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
    </SettingsGroup>
  );
}
