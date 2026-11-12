// 关于：当前版本、诊断开关与反馈入口（收集点未配置时两者都不显示）。

import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { t } from '../i18n';
import { Toast } from '../ui/Toast';
import { BUTTON, SETTINGS_CARD, SettingRow, SettingsGroup, SettingsRows, Switch, errorText } from '../ui/settings';
import { cn } from '../lib/cn';
import { checkForUpdate, useUpdateState } from '../lib/updates';
import { DiagnosticsDetails } from './DiagnosticsNotice';
import { FeedbackDialog } from './FeedbackDialog';

type Info = Awaited<ReturnType<Api['diagnostics']>>;

export function AboutPage({ api }: { api: Api }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const update = useUpdateState();
  const [devNotice, setDevNotice] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.diagnostics().then(setInfo, (err: unknown) => setError(errorText(err)));
  }, [api]);

  const setConsent = (consent: 'on' | 'off'): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.setDiagnostics(consent).then(
      () => {
        setInfo((current) => (current === null ? current : { ...current, consent }));
        setBusy(false);
      },
      (err: unknown) => {
        setError(errorText(err));
        setBusy(false);
      },
    );
  };

  const runCheck = async (): Promise<void> => {
    setDevNotice(false);
    setChecking(true);
    try {
      const result = await checkForUpdate();
      if (result.phase === 'idle') setDevNotice(true);
    } catch {
      // 失败状态由主进程推送
    } finally {
      setChecking(false);
    }
  };

  const updateMessage = (): string | undefined => {
    if (devNotice) return t('about.updateDev');
    if (update.phase === 'checking') return t('about.updateChecking');
    if (update.phase === 'none') return t('about.updateNone');
    if (update.phase === 'downloading') return t('about.updateDownloading', { percent: update.percent ?? 0 });
    if (update.phase === 'ready') return t('about.updateReady', { version: update.version ?? '' });
    if (update.phase === 'error') return t('about.updateError');
    return undefined;
  };

  if (info === null) {
    return <p className="text-[13px] text-ink-secondary">{error ?? t('common.loading')}</p>;
  }

  return (
    <>
      <SettingsGroup label={t('settings.page.about')}>
        <SettingsRows>
          <SettingRow title={t('about.version', { version: info.appVersion })} />
          {info.available && (
            <SettingRow
              title={t('about.diagnostics')}
              subtitle={t('about.diagnosticsHint')}
              message={
                <button type="button" className="text-ink-secondary transition-colors hover:text-ink" onClick={() => setDetails(!details)}>
                  {t('diagnostics.details')}
                </button>
              }>
              <Switch
                checked={info.consent === 'on'}
                disabled={busy}
                aria-label={t('about.diagnostics')}
                onClick={() => setConsent(info.consent === 'on' ? 'off' : 'on')}
              />
            </SettingRow>
          )}
          {info.available && (
            <SettingRow title={t('about.feedback')} subtitle={t('about.feedbackHint')}>
              <button type="button" className={BUTTON} onClick={() => setFeedbackOpen(true)}>
                {t('about.feedback')}
              </button>
            </SettingRow>
          )}
          <SettingRow title={t('about.update')} subtitle={t('about.updateHint')} message={updateMessage()}>
            <button type="button" className={BUTTON} disabled={checking} onClick={() => void runCheck()}>
              {t('about.update')}
            </button>
          </SettingRow>
        </SettingsRows>
        {details && info.available && (
          <div className={cn(SETTINGS_CARD, 'mx-4 mb-3 p-3')}>
            <DiagnosticsDetails />
          </div>
        )}
        {error !== null && <p className="px-4 pb-3 text-[12px] text-danger">{error}</p>}
      </SettingsGroup>

      <FeedbackDialog
        api={api}
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        onSent={() => {
          setFeedbackOpen(false);
          setToast({ key: Date.now(), text: t('feedback.ok') });
        }}
      />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
