// 后台整理：记忆整理用哪个模型。默认跟 bot 用同一个，可以换成更便宜的。

import { useEffect, useState } from 'react';
import type { KernelState } from '@minibot/core';
import type { Api, PresetWithModels } from '../api';
import { t } from '../i18n';
import { BUTTON_PRIMARY, INPUT, SelectField, SettingRow, SettingsGroup, SettingsRows, errorText } from '../ui/settings';

const SAME_AS_BOT = '';

export function ConsolidationPage({ api, providers, presets }: { api: Api; providers: KernelState['providers']; presets: PresetWithModels[] }) {
  const [loaded, setLoaded] = useState(false);
  const [providerId, setProviderId] = useState(SAME_AS_BOT);
  const [model, setModel] = useState('');
  const [saved, setSaved] = useState({ providerId: SAME_AS_BOT, model: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        const value = { providerId: s.consolidationModel?.providerId ?? SAME_AS_BOT, model: s.consolidationModel?.model ?? '' };
        setProviderId(value.providerId);
        setModel(value.model);
        setSaved(value);
        setLoaded(true);
      })
      .catch((err: unknown) => setMessage({ ok: false, text: errorText(err) }));
  }, [api]);

  const provider = providers.find((p) => p.id === providerId);
  const models = presets.find((p) => p.id === provider?.presetId)?.models.map((m) => m.id) ?? [];
  const chooseProvider = (id: string): void => {
    setProviderId(id);
    const next = providers.find((p) => p.id === id);
    setModel(presets.find((p) => p.id === next?.presetId)?.models[0]?.id ?? '');
  };
  const dirty = providerId !== saved.providerId || (providerId !== SAME_AS_BOT && model !== saved.model);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (providerId !== SAME_AS_BOT && model.trim() === '') throw new Error(t('onboarding.error.model'));
      await api.updateSettings({ consolidationModel: providerId === SAME_AS_BOT ? null : { providerId, model: model.trim() } });
      setSaved({ providerId, model: model.trim() });
      setMessage({ ok: true, text: t('common.saved') });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup label={t('settings.consolidation.title')} footnote={t('settings.consolidation.hint')}>
      <SettingsRows>
        <SettingRow title={t('settings.consolidation.provider')}>
          <SelectField
            label={t('settings.consolidation.provider')}
            className="w-[220px]"
            value={providerId}
            onChange={chooseProvider}
            options={[
              { value: SAME_AS_BOT, label: t('settings.consolidation.sameAsBot') },
              ...providers.filter((p) => p.hasKey || p.id === providerId).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </SettingRow>
        {providerId !== SAME_AS_BOT && (
          <SettingRow title={t('settings.consolidation.model')}>
            {models.length > 0 ? (
              <SelectField
                label={t('settings.consolidation.model')}
                className="w-[220px]"
                value={model}
                onChange={setModel}
                options={(models.includes(model) || model === '' ? models : [model, ...models]).map((m) => ({ value: m, label: m }))}
              />
            ) : (
              <input value={model} onChange={(e) => setModel(e.target.value)} aria-label={t('settings.consolidation.model')} className={`${INPUT} w-[220px] font-mono`} />
            )}
          </SettingRow>
        )}
        <div className="flex items-center gap-3 px-4 py-2.5">
          <span className={`min-w-0 flex-1 text-[12px] ${message?.ok === true ? 'text-success' : 'text-danger'}`}>{message?.text}</span>
          <button type="button" className={BUTTON_PRIMARY} disabled={!loaded || !dirty || busy} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </SettingsRows>
    </SettingsGroup>
  );
}
