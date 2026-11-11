// 初始化：全屏居中，一屏一步（模型接入 → 用户画像 → 主 bot → 工作目录）。
// 只有模型接入必填；之后每步都可以跳过。

import { useState, type ReactNode } from 'react';
import type { Bot, Provider, TestConnectionResult } from '@minibot/core';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import Markdown from 'react-markdown';
import type { Api, PresetWithModels } from '../api';
import { Logo } from '../brand/Logo';
import { cn } from '../lib/cn';
import { t, type MessageKey } from '../i18n';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY, TEXT_BUTTON } from '../ui/recipes';

const STEPS = ['model', 'profile', 'bot', 'workspace'] as const;
type Step = (typeof STEPS)[number];
const CUSTOM_MODEL = '__custom__';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-left">
      <span className="text-[13px] font-medium text-ink-secondary">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[12px] leading-4 text-ink-tertiary">{hint}</span>}
    </label>
  );
}

function SelectField({ value, onChange, options, label }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <span className="relative flex">
      <select aria-label={label} className={cn(FIELD, 'appearance-none pr-9')} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-tertiary" aria-hidden />
    </span>
  );
}

const TEST_MESSAGE: Record<Exclude<TestConnectionResult, { ok: true }>['kind'], MessageKey> = {
  auth: 'onboarding.model.testAuth',
  url: 'onboarding.model.testUrl',
  network: 'onboarding.model.testNetwork',
  other: 'onboarding.model.testOther',
};

export function Onboarding({
  api,
  canPersistKeys,
  presets,
  onDone,
}: {
  api: Api;
  canPersistKeys: boolean;
  presets: PresetWithModels[];
  onDone: (bot: Bot) => void;
}) {
  const [step, setStep] = useState<Step>('model');
  const index = STEPS.indexOf(step);

  // 模型接入
  const first = presets[0];
  const [presetId, setPresetId] = useState(first?.id ?? '');
  const preset = presets.find((p) => p.id === presetId) ?? first;
  const [baseUrl, setBaseUrl] = useState(first?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [providerName, setProviderName] = useState(first?.name ?? '');
  const [modelChoice, setModelChoice] = useState(first?.models[0]?.id ?? CUSTOM_MODEL);
  const [customModel, setCustomModel] = useState('');
  const [contextWindow, setContextWindow] = useState(first?.models[0]?.contextWindow ?? first?.contextWindow ?? 128_000);
  const [contextTouched, setContextTouched] = useState(false);
  const [more, setMore] = useState(!canPersistKeys);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  // 其余步骤
  const [profile, setProfile] = useState('');
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [workspace, setWorkspace] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const model = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice;
  const useEnv = !canPersistKeys || apiKeyEnv.trim().length > 0;

  const choosePreset = (id: string): void => {
    const next = presets.find((p) => p.id === id);
    if (next === undefined) return;
    setPresetId(id);
    setBaseUrl(next.baseUrl);
    setProviderName(next.name);
    const known = next.models[0];
    setModelChoice(known?.id ?? CUSTOM_MODEL);
    if (!contextTouched) setContextWindow(known?.contextWindow ?? next.contextWindow);
    setTest(null);
  };

  const chooseModel = (id: string): void => {
    setModelChoice(id);
    const known = preset?.models.find((m) => m.id === id);
    if (!contextTouched) setContextWindow(known?.contextWindow ?? preset?.contextWindow ?? 128_000);
    setTest(null);
  };

  const validate = (): string | null => {
    if (baseUrl.trim().length === 0) return t('onboarding.error.baseUrl');
    if (!canPersistKeys && apiKeyEnv.trim().length === 0) return t('onboarding.error.apiKeyEnv');
    if (!useEnv && apiKey.trim().length === 0 && providerId === null) return t('onboarding.error.apiKey');
    if (model.length === 0) return t('onboarding.error.model');
    return null;
  };

  /** 新建或更新这一步对应的供应商，返回它的 id */
  const saveProvider = async (): Promise<string> => {
    if (preset === undefined) throw new Error(t('onboarding.error.model'));
    const key = useEnv ? { apiKeyEnv: apiKeyEnv.trim() } : apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {};
    const fields = {
      name: providerName.trim() || preset.name,
      format: preset.format,
      baseUrl: baseUrl.trim(),
      presetId: preset.id,
    };
    let saved: Provider;
    if (providerId === null) saved = await api.addProvider({ ...fields, ...key });
    else saved = await api.updateProvider(providerId, { ...fields, ...key });
    setProviderId(saved.id);
    return saved.id;
  };

  const runTest = async (): Promise<void> => {
    const invalid = validate();
    setError(invalid);
    if (invalid !== null) return;
    setTesting(true);
    setTest(null);
    try {
      const id = await saveProvider();
      const result = await api.testProvider(id, model);
      setTest(
        result.ok
          ? { ok: true, text: t('onboarding.model.testOk') }
          : { ok: false, text: t(TEST_MESSAGE[result.kind], { message: result.message }) },
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTesting(false);
    }
  };

  const finish = async (dir = workspace): Promise<void> => {
    if (providerId === null) return;
    setBusy(true);
    setError(null);
    try {
      const bot = await api.completeOnboarding({
        providerId,
        model,
        contextWindow,
        ...(profile.trim() ? { profile: profile.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(persona.trim() ? { persona: persona.trim() } : {}),
        ...(dir.trim() ? { workspace: dir.trim() } : {}),
      });
      onDone(bot);
    } catch (err) {
      setError(t('onboarding.error.finish', { message: errorText(err) }));
      setBusy(false);
    }
  };

  const next = async (): Promise<void> => {
    setError(null);
    if (step === 'model') {
      const invalid = validate();
      if (invalid !== null) return setError(invalid);
      setBusy(true);
      try {
        await saveProvider();
      } catch (err) {
        setError(errorText(err));
        return;
      } finally {
        setBusy(false);
      }
    }
    if (step === 'workspace') return finish();
    setStep(STEPS[index + 1]!);
  };

  const back = (): void => {
    setError(null);
    setStep(STEPS[index - 1]!);
  };

  const skip = (): void => {
    if (step === 'profile') setProfile('');
    if (step === 'bot') {
      setName('');
      setPersona('');
    }
    if (step === 'workspace') {
      setWorkspace('');
      void finish('');
      return;
    }
    setError(null);
    setStep(STEPS[index + 1]!);
  };

  let body: ReactNode;
  if (step === 'model') {
    const modelOptions = [
      ...(preset?.models ?? []).map((m) => ({ value: m.id, label: m.id })),
      { value: CUSTOM_MODEL, label: t('onboarding.model.customModel') },
    ];
    body = (
      <>
        <Field
          label={t('onboarding.model.preset')}
          hint={
            preset !== undefined && preset.note.length > 0 ? (
              <span className="[&_strong]:font-semibold [&_strong]:text-ink-secondary">
                <Markdown allowedElements={['p', 'strong', 'code']} unwrapDisallowed>
                  {preset.note}
                </Markdown>
              </span>
            ) : undefined
          }>
          <SelectField
            label={t('onboarding.model.preset')}
            value={presetId}
            onChange={choosePreset}
            options={presets.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Field>
        <Field label={t('onboarding.model.baseUrl')}>
          <input className={FIELD} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" spellCheck={false} />
        </Field>
        {canPersistKeys && (
          <Field label={t('onboarding.model.apiKey')}>
            <input
              className={FIELD}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={providerId !== null ? t('onboarding.model.apiKeyKept') : 'sk-…'}
              disabled={apiKeyEnv.trim().length > 0}
              autoComplete="off"
            />
          </Field>
        )}
        <Field label={t('onboarding.model.knownModel')}>
          {(preset?.models.length ?? 0) > 0 && (
            <SelectField label={t('onboarding.model.knownModel')} value={modelChoice} onChange={chooseModel} options={modelOptions} />
          )}
          {modelChoice === CUSTOM_MODEL && (
            <input
              className={FIELD}
              value={customModel}
              onChange={(e) => {
                setCustomModel(e.target.value);
                setTest(null);
              }}
              placeholder={t('onboarding.model.modelName')}
              aria-label={t('onboarding.model.modelName')}
              spellCheck={false}
            />
          )}
        </Field>
        {!canPersistKeys && <p className="text-left text-[12px] text-warning">{t('onboarding.model.keyPersistHint')}</p>}
        {more ? (
          <>
            <Field label={t('onboarding.model.apiKeyEnv')} hint={t('onboarding.model.apiKeyEnvHint')}>
              <input className={FIELD} value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="DEEPSEEK_API_KEY" spellCheck={false} />
            </Field>
            <Field label={t('onboarding.model.providerName')}>
              <input className={FIELD} value={providerName} onChange={(e) => setProviderName(e.target.value)} />
            </Field>
            <Field label={t('onboarding.model.contextWindow')} hint={t('onboarding.model.contextUnit')}>
              <input
                className={FIELD}
                type="number"
                min={1}
                value={contextWindow}
                onChange={(e) => {
                  setContextWindow(Number(e.target.value));
                  setContextTouched(true);
                }}
              />
            </Field>
          </>
        ) : (
          <button type="button" className={cn(TEXT_BUTTON, 'self-start')} onClick={() => setMore(true)}>
            {t('onboarding.model.more')}
          </button>
        )}
        <div className="flex items-center gap-3">
          <button type="button" className={PILL_SECONDARY} disabled={testing} onClick={() => void runTest()}>
            {testing && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t('onboarding.model.test')}
          </button>
          {test !== null && (
            <span role="status" className={cn('flex min-w-0 items-center gap-1 text-left text-[13px]', test.ok ? 'text-success' : 'text-danger')}>
              {test.ok && <Check size={14} aria-hidden />}
              {test.text}
            </span>
          )}
        </div>
      </>
    );
  } else if (step === 'profile') {
    body = (
      <textarea
        className={cn(FIELD, 'min-h-32 resize-none')}
        aria-label={t('onboarding.profile.label')}
        value={profile}
        onChange={(e) => setProfile(e.target.value)}
        placeholder={t('onboarding.profile.placeholder')}
        autoFocus
      />
    );
  } else if (step === 'bot') {
    body = (
      <>
        <Field label={t('onboarding.bot.name')}>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('onboarding.bot.namePlaceholder')} autoFocus />
        </Field>
        <Field label={t('onboarding.bot.persona')}>
          <textarea
            className={cn(FIELD, 'min-h-24 resize-none')}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder={t('onboarding.bot.personaPlaceholder')}
          />
        </Field>
      </>
    );
  } else {
    body = (
      <input
        className={FIELD}
        aria-label={t('onboarding.workspace.label')}
        value={workspace}
        onChange={(e) => setWorkspace(e.target.value)}
        placeholder={t('onboarding.workspace.placeholder')}
        spellCheck={false}
        autoFocus
      />
    );
  }

  return (
    <main className="flex min-h-0 flex-1 overflow-y-auto">
      <div key={step} className="m-auto flex w-[400px] max-w-[calc(100%-32px)] animate-rise flex-col items-center py-10 text-center">
        <Logo size={56} />
        <ol aria-label={t('onboarding.progress')} className="mt-6 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === index ? 'step' : undefined}
              aria-label={t(`onboarding.step.${s}`)}
              className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-5 bg-ink' : i < index ? 'w-1.5 bg-ink/50' : 'w-1.5 bg-ink/15')}
            />
          ))}
        </ol>
        <h1 className="mt-5 text-[28px] leading-[34px] font-normal tracking-[-0.02em]">{t(`onboarding.${step}.title`)}</h1>
        <p className="mt-2 text-[13px] leading-[18px] text-ink-secondary">{t(`onboarding.${step}.intro`)}</p>
        <div className="mt-8 flex w-full flex-col gap-4">{body}</div>
        {error !== null && (
          <p role="alert" className="mt-4 w-full text-left text-[13px] text-danger">
            {error}
          </p>
        )}
        <button type="button" className={cn(PILL_PRIMARY, 'mt-8 w-full max-w-[320px]')} disabled={busy} onClick={() => void next()}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {step === 'workspace' ? t('onboarding.finish') : t('common.next')}
        </button>
        <p className="mt-3 flex items-center gap-3">
          {index > 0 && (
            <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={back}>
              {t('common.back')}
            </button>
          )}
          {step !== 'model' && (
            <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={skip}>
              {t('common.skip')}
            </button>
          )}
        </p>
      </div>
    </main>
  );
}
