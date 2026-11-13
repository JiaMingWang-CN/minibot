// 连接插件：按清单 config 生成表单；DeepSeek / Tavily 显示二选一。

import { useEffect, useState } from 'react';
import type { KernelState, PluginView, Provider } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { Field, SelectField, errorText } from '../ui/settings';

type Choice = 'key' | 'service' | 'oauth';

export function PluginConnectDialog({
  api,
  plugin,
  onClose,
  onConnected,
}: {
  api: Api;
  plugin: PluginView;
  onClose: () => void;
  onConnected: () => void;
}) {
  const isDeepseek = plugin.builtin && plugin.name === 'deepseek';
  const isTavily = plugin.builtin && plugin.name === 'tavily';
  const fields = plugin.manifest.config;

  const [values, setValues] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Choice>('key');
  const [providerId, setProviderId] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDeepseek) return;
    api.state().then((s: KernelState) => {
      const deepseek = s.providers.filter((p) => p.presetId === 'deepseek');
      setProviders(deepseek);
      if (deepseek[0] !== undefined) setProviderId(deepseek[0].id);
    }, () => undefined);
  }, [api, isDeepseek]);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (isDeepseek) {
        await api.pluginConnect(plugin.name, choice === 'service' ? { providerId } : { api_key: values['api_key'] ?? '' });
      } else if (isTavily) {
        await api.pluginConnect(plugin.name, choice === 'oauth' ? { oauth: 'true' } : { api_key: values['api_key'] ?? '' });
        // 选账号登录：连接后立即在系统浏览器里走 OAuth 授权
        if (choice === 'oauth') for (const id of plugin.serverIds) await api.mcpLogin(id);
      } else {
        await api.pluginConnect(plugin.name, values);
      }
      onConnected();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const keyField = (
    <Field label="API Key" hint={t('plugins.secretHint')}>
      <input
        type="password"
        value={values['api_key'] ?? ''}
        onChange={(e) => setValues((v) => ({ ...v, api_key: e.target.value }))}
        className={FIELD}
      />
    </Field>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('plugins.connectTitle', { name: plugin.name })}
      wide
      footer={
        <>
          <button type="button" className={PILL_SECONDARY} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={PILL_PRIMARY} disabled={busy} onClick={() => void submit()}>
            {t('plugins.connect')}
          </button>
        </>
      }>
      <div className="flex flex-col gap-3">
        {error !== null && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

        {isDeepseek ? (
          <>
            <div className="flex gap-1.5">
              <button type="button" className={choice === 'service' ? PILL_PRIMARY : PILL_SECONDARY} onClick={() => setChoice('service')}>
                {t('plugins.useExistingService')}
              </button>
              <button type="button" className={choice === 'key' ? PILL_PRIMARY : PILL_SECONDARY} onClick={() => setChoice('key')}>
                {t('plugins.fillKey')}
              </button>
            </div>
            {choice === 'service' ? (
              providers.length === 0 ? (
                <p className="text-[12px] text-ink-secondary">{t('plugins.noService')}</p>
              ) : (
                <Field label={t('plugins.chooseService')}>
                  <SelectField
                    label={t('plugins.chooseService')}
                    value={providerId}
                    onChange={setProviderId}
                    options={providers.map((p) => ({ value: p.id, label: p.name }))}
                  />
                </Field>
              )
            ) : (
              keyField
            )}
          </>
        ) : isTavily ? (
          <>
            <div className="flex gap-1.5">
              <button type="button" className={choice === 'key' ? PILL_PRIMARY : PILL_SECONDARY} onClick={() => setChoice('key')}>
                {t('plugins.fillKey')}
              </button>
              <button type="button" className={choice === 'oauth' ? PILL_PRIMARY : PILL_SECONDARY} onClick={() => setChoice('oauth')}>
                {t('plugins.tavilyOauth')}
              </button>
            </div>
            {choice === 'key' && keyField}
          </>
        ) : (
          fields.map((field) => (
            <Field key={field.key} label={field.title} hint={field.description}>
              <input
                type={field.secret ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                className={FIELD}
              />
            </Field>
          ))
        )}
      </div>
    </Dialog>
  );
}
