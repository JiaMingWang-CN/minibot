// 设置 › 联网：本期只有网页抓取的全局开关。

import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { t } from '../i18n';
import { SettingRow, SettingsGroup, SettingsRows, Switch, errorText } from '../ui/settings';

export function WebPage({ api }: { api: Api }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .webSettings()
      .then((s) => setEnabled(s.fetchEnabled))
      .catch((err: unknown) => setError(errorText(err)));
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

  return (
    <SettingsGroup label={t('settings.page.web')}>
      <SettingsRows>
        <SettingRow title={t('web.fetch')} subtitle={t('web.fetchHint')}>
          <Switch
            checked={enabled ?? false}
            disabled={enabled === null || saving}
            aria-label={t('web.fetch')}
            onClick={() => void toggle()}
          />
        </SettingRow>
      </SettingsRows>
      {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
    </SettingsGroup>
  );
}
