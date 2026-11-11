// 模型服务：每个供应商一张可展开的卡片（标题、地址、连接状态），展开后改名称、地址、Key，测试连接或删除。
// 布局照 OpenMausBot 的“连接”页。

import { useCallback, useId, useState } from 'react';
import type { Bot, KernelState, TestConnectionResult } from '@minibot/core';
import { ChevronRight, Eye, EyeOff, Plus } from 'lucide-react';
import type { Api, PresetWithModels } from '../api';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { ALL_LEVELS } from '../lib/models';
import { ModelsEditor, fromDrafts, initialDrafts, type ModelDraft } from './ModelsEditor';
import { Toast } from '../ui/Toast';
import { BUTTON, BUTTON_DANGER, BUTTON_PRIMARY, Field, INPUT, SETTINGS_CARD, SelectField, errorText } from '../ui/settings';

type ProviderInfo = KernelState['providers'][number];

const TEST_MESSAGE: Record<Exclude<TestConnectionResult, { ok: true }>['kind'], MessageKey> = {
  auth: 'onboarding.model.testAuth',
  url: 'onboarding.model.testUrl',
  network: 'onboarding.model.testNetwork',
  other: 'onboarding.model.testOther',
};

function StatusChip({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-[12px] leading-4', ok ? 'text-ink-secondary' : 'text-warning')}>
      <span className={cn('size-1.5 rounded-full', ok ? 'bg-success' : 'bg-warning')} aria-hidden />
      {text}
    </span>
  );
}

function KeyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative flex">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={t('onboarding.model.apiKey')}
        autoComplete="off"
        spellCheck={false}
        className={cn(INPUT, 'pr-9 font-mono')}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? t('settings.providers.hideKey') : t('settings.providers.showKey')}
        aria-pressed={shown}
        className="absolute top-1/2 right-0.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-tertiary hover:text-ink">
        {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
      </button>
    </span>
  );
}

function ProviderCard({
  api,
  bot,
  provider,
  presets,
  canPersistKeys,
  defaultOpen,
  onDone,
  onCancelNew,
}: {
  api: Api;
  bot: Bot;
  /** null 表示新增 */
  provider: ProviderInfo | null;
  presets: PresetWithModels[];
  canPersistKeys: boolean;
  defaultOpen: boolean;
  onDone: () => Promise<void>;
  onCancelNew?: () => void;
}) {
  const isNew = provider === null;
  const firstPreset = presets[0];
  const [open, setOpen] = useState(defaultOpen);
  const [presetId, setPresetId] = useState(provider?.presetId ?? firstPreset?.id ?? '');
  const preset = presets.find((p) => p.id === presetId);
  const [name, setName] = useState(provider?.name ?? firstPreset?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? firstPreset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [replacing, setReplacing] = useState(isNew || provider.hasKey !== true);
  const [useEnv, setUseEnv] = useState(provider?.apiKeyEnv !== undefined || !canPersistKeys);
  const [apiKeyEnv, setApiKeyEnv] = useState(provider?.apiKeyEnv ?? '');
  const [drafts, setDrafts] = useState<ModelDraft[]>(() => initialDrafts(provider, preset));
  const [busy, setBusy] = useState<'saving' | 'testing' | 'deleting' | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const bodyId = useId();

  const choosePreset = (id: string): void => {
    const next = presets.find((p) => p.id === id);
    setPresetId(id);
    if (next === undefined) return;
    setName(next.name);
    setBaseUrl(next.baseUrl);
    setDrafts(initialDrafts(null, next));
  };

  const run = async (kind: 'saving' | 'testing' | 'deleting', job: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setMessage(null);
    try {
      await job();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const keyFields = (): { apiKey?: string; apiKeyEnv?: string } =>
    useEnv ? (apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}) : apiKey.trim() ? { apiKey: apiKey.trim() } : {};

  const save = (): Promise<void> =>
    run('saving', async () => {
      if (baseUrl.trim() === '') throw new Error(t('onboarding.error.baseUrl'));
      const models = fromDrafts(drafts);
      if (isNew && preset === undefined) throw new Error(t('settings.providers.pickPreset'));
      try {
        if (isNew) {
          await api.addProvider({ name: name.trim() || preset!.name, format: preset!.format, baseUrl: baseUrl.trim(), presetId: preset!.id, models, ...keyFields() });
        } else {
          await api.updateProvider(provider.id, { name: name.trim() || provider.name, baseUrl: baseUrl.trim(), models, ...keyFields() });
        }
      } catch (err) {
        throw new Error(t('settings.providers.saveFailed', { message: errorText(err) }));
      }
      setApiKey('');
      if (!isNew) setReplacing(false);
      setMessage({ ok: true, text: t('common.saved') });
      await onDone();
    });

  const test = (model: string): Promise<void> =>
    run('testing', async () => {
      if (provider === null) return;
      setTestingId(model);
      try {
        const result = await api.testProvider(provider.id, model);
        if (result.ok) setToast({ key: Date.now(), text: t('onboarding.model.testOk') });
        else setMessage({ ok: false, text: t(TEST_MESSAGE[result.kind], { message: result.message }) });
      } finally {
        setTestingId(null);
      }
    });

  const remove = (): Promise<void> =>
    run('deleting', async () => {
      if (provider === null) return;
      await api.deleteProvider(provider.id);
      await onDone();
    });

  const header = isNew ? (
    <span className="text-[14px] leading-5 font-medium text-ink">{t('settings.providers.new')}</span>
  ) : (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-[14px] leading-5 font-medium text-ink">{provider.name}</span>
      <span className="truncate text-[13px] leading-[18px] text-ink-secondary">{provider.baseUrl}</span>
    </span>
  );

  return (
    <section className={SETTINGS_CARD}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-[inherit] px-4 py-2.5 text-left">
        {header}
        {!isNew && (
          <StatusChip
            ok={provider.hasKey}
            text={provider.hasKey ? t(provider.id === bot.providerId ? 'settings.providers.inUse' : 'settings.providers.connected') : t('settings.providers.noKey')}
          />
        )}
        <ChevronRight size={14} aria-hidden className={cn('ml-auto shrink-0 text-ink-secondary transition-transform', open && 'rotate-90')} />
      </button>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-3 border-t-[0.5px] border-edge px-4 py-4">
        {isNew && (
          <Field label={t('onboarding.model.preset')}>
            <SelectField label={t('onboarding.model.preset')} value={presetId} onChange={choosePreset} options={presets.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
        )}
        {isNew && preset !== undefined && preset.note !== '' && <p className="-mt-1 text-[12px] leading-4 text-ink-tertiary">{preset.note}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('onboarding.model.providerName')}>
            <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
          </Field>
          <Field label={t('onboarding.model.baseUrl')}>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} className={cn(INPUT, 'font-mono')} />
          </Field>
        </div>

        {useEnv ? (
          <Field label={t('onboarding.model.apiKeyEnv')} hint={t('onboarding.model.apiKeyEnvHint')}>
            <input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} spellCheck={false} className={cn(INPUT, 'font-mono')} />
          </Field>
        ) : replacing ? (
          <Field label={t('onboarding.model.apiKey')}>
            <KeyInput value={apiKey} onChange={setApiKey} placeholder={isNew ? 'sk-…' : t('settings.providers.newKey')} />
          </Field>
        ) : (
          <Field label={t('onboarding.model.apiKey')}>
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-1.5 font-mono text-[13px] text-ink-secondary">••••••••••••</span>
              <button type="button" className={BUTTON} onClick={() => setReplacing(true)}>
                {t('settings.providers.replaceKey')}
              </button>
            </span>
          </Field>
        )}
        {!canPersistKeys ? (
          <p className="text-[12px] text-warning">{t('onboarding.model.keyPersistHint')}</p>
        ) : (
          <button type="button" className="self-start text-[12px] text-ink-secondary hover:text-ink hover:underline" onClick={() => setUseEnv((u) => !u)}>
            {useEnv ? t('settings.providers.useKey') : t('settings.providers.useEnv')}
          </button>
        )}

        <ModelsEditor
          drafts={drafts}
          onChange={setDrafts}
          levels={(preset?.format ?? provider?.format) === 'anthropic_messages' ? ALL_LEVELS.filter((l) => l !== 'none' && l !== 'minimal') : ALL_LEVELS}
          defaultContextWindow={preset?.contextWindow ?? 128_000}
          {...(isNew ? {} : { onTest: (model: string) => void test(model) })}
          testingId={testingId}
          disabled={busy !== null}
        />

        {message !== null && (
          <p role={message.ok ? 'status' : 'alert'} className={cn('text-[12px] leading-4', message.ok ? 'text-success' : 'text-danger')}>
            {message.text}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          {isNew ? (
            <button type="button" className={BUTTON} onClick={onCancelNew}>
              {t('common.cancel')}
            </button>
          ) : (
            <button type="button" className={BUTTON_DANGER} disabled={busy !== null} onClick={() => void remove()}>
              {t('settings.providers.delete')}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className={BUTTON_PRIMARY} disabled={busy !== null} onClick={() => void save()}>
            {busy === 'saving' ? t('settings.saving') : isNew ? t('settings.providers.add') : t('common.save')}
          </button>
        </div>
      </div>
      <Toast toast={toast} onClose={closeToast} />
    </section>
  );
}

export function ProvidersPage({
  api,
  bot,
  providers,
  presets,
  canPersistKeys,
  onRefresh,
}: {
  api: Api;
  bot: Bot;
  providers: ProviderInfo[];
  presets: PresetWithModels[];
  canPersistKeys: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink-secondary">{t('settings.providers.intro')}</p>
        {!adding && (
          <button type="button" className={BUTTON} onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden />
            {t('settings.providers.add')}
          </button>
        )}
      </div>
      {adding && (
        <ProviderCard
          api={api}
          bot={bot}
          provider={null}
          presets={presets}
          canPersistKeys={canPersistKeys}
          defaultOpen
          onCancelNew={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await onRefresh();
          }}
        />
      )}
      {providers.map((p) => (
        <ProviderCard key={p.id} api={api} bot={bot} provider={p} presets={presets} canPersistKeys={canPersistKeys} defaultOpen={false} onDone={onRefresh} />
      ))}
    </div>
  );
}
