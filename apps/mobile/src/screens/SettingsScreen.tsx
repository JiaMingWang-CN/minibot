import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { t } from '@renderer/i18n';
import { Dialog } from '@renderer/ui/Dialog';
import { ICON_BUTTON, PILL_DANGER, PILL_SECONDARY } from '@renderer/ui/recipes';
import { BUTTON, BUTTON_DANGER, BUTTON_PRIMARY, SettingRow, SettingsGroup, SettingsRows, Switch } from '@renderer/ui/settings';
import { MinibotRemote, type DiagnosticsInfo, type PhoneStatus } from '../native';
import { FeedbackSheet } from './FeedbackSheet';

export function viaText(status: PhoneStatus): string {
  switch (status.connection) {
    case 'lan':
      return t('mobile.status.lan');
    case 'relay':
      return t('mobile.status.relay');
    case 'pc_offline':
      return t('mobile.status.pcOffline');
    case 'error':
      return t('mobile.status.error');
    case 'idle':
      return t('mobile.status.idle');
    default:
      return t('mobile.status.connecting');
  }
}

/** 设置页（整页）：连接方式、后台连接、通知权限、电池优化、版本与更新、诊断与反馈、取消配对 */
export function SettingsScreen({
  status,
  guide,
  availableVersion,
  updateNotice,
  onCheckUpdate,
  onInstallUpdate,
  onBack,
}: {
  status: PhoneStatus;
  guide: boolean;
  /** 已发现但还没安装的新版本 */
  availableVersion: string | null;
  /** 手动检查更新的结果提示（已是最新 / 失败），没有则为 null */
  updateNotice: string | null;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onBack: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [diag, setDiag] = useState<DiagnosticsInfo | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

  useEffect(() => {
    void MinibotRemote.getDiagnostics().then(setDiag, () => setDiag(null));
  }, []);

  const toggleDiagnostics = (): void => {
    if (diag === null) return;
    const consent = diag.consent === 'on' ? 'off' : 'on';
    void MinibotRemote.setDiagnostics({ consent }).then(
      () => setDiag({ ...diag, consent }),
      () => {},
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2">
        <button type="button" aria-label={t('mobile.chat.back')} className={ICON_BUTTON} onClick={onBack}>
          <ChevronLeft size={20} aria-hidden />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">{t('mobile.settings.title')}</h1>
      </header>

      <div className="safe-bottom min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <div className="flex flex-col gap-6 pt-2">
          {guide && (
            <p className="rounded-xl bg-card px-3.5 py-2.5 text-[13px] leading-[18px] text-ink-secondary">{t('mobile.settings.guide')}</p>
          )}

          <SettingsGroup label={t('mobile.settings.groupConnection')}>
            <SettingsRows>
              <SettingRow title={t('mobile.settings.pc')} subtitle={status.pcName ?? ''} />
              <SettingRow title={t('mobile.settings.via')} subtitle={viaText(status)} />
              <SettingRow
                title={t('mobile.settings.background')}
                subtitle={status.background ? t('mobile.settings.backgroundOn') : t('mobile.settings.backgroundOff')}>
                <Switch
                  checked={status.background}
                  aria-label={t('mobile.settings.background')}
                  onClick={() => void (status.background ? MinibotRemote.stopBackground() : MinibotRemote.startBackground())}
                />
              </SettingRow>
              <SettingRow
                title={t('mobile.settings.notifications')}
                subtitle={status.notificationsAllowed ? t('mobile.settings.notificationsOn') : t('mobile.settings.notificationsOff')}>
                {!status.notificationsAllowed && (
                  <button type="button" className={BUTTON} onClick={() => void MinibotRemote.requestNotificationPermission()}>
                    {t('mobile.settings.allow')}
                  </button>
                )}
              </SettingRow>
              <SettingRow
                title={t('mobile.settings.battery')}
                subtitle={status.batteryOptimized ? t('mobile.settings.batteryOn') : t('mobile.settings.batteryOff')}>
                {status.batteryOptimized && (
                  <button type="button" className={BUTTON} onClick={() => void MinibotRemote.openBatterySettings()}>
                    {t('mobile.settings.toSettings')}
                  </button>
                )}
              </SettingRow>
            </SettingsRows>
          </SettingsGroup>

          <SettingsGroup label={t('mobile.settings.groupAbout')}>
            <SettingsRows>
              <SettingRow
                title={t('mobile.settings.version', { version: diag?.appVersion ?? '' })}
                subtitle={
                  availableVersion !== null
                    ? t('update.available', { version: availableVersion })
                    : (updateNotice ?? t('mobile.settings.updateHint'))
                }>
                {availableVersion !== null ? (
                  <button type="button" className={BUTTON_PRIMARY} onClick={onInstallUpdate}>
                    {t('update.install')}
                  </button>
                ) : (
                  <button type="button" className={BUTTON} onClick={onCheckUpdate}>
                    {t('about.update')}
                  </button>
                )}
              </SettingRow>
              {diag?.available === true && (
                <SettingRow
                  title={t('about.diagnostics')}
                  subtitle={diag.consent === 'on' ? t('mobile.settings.diagOn') : t('mobile.settings.diagOff')}>
                  <Switch checked={diag.consent === 'on'} aria-label={t('about.diagnostics')} onClick={toggleDiagnostics} />
                </SettingRow>
              )}
              {diag?.available === true && (
                <SettingRow title={t('about.feedback')} subtitle={feedbackSent ? t('feedback.ok') : t('about.feedbackHint')}>
                  <button type="button" className={BUTTON} onClick={() => setFeedbackOpen(true)}>
                    {t('about.feedback')}
                  </button>
                </SettingRow>
              )}
            </SettingsRows>
          </SettingsGroup>

          <SettingsGroup>
            <SettingsRows>
              <SettingRow title={t('mobile.settings.unpair')} subtitle={t('mobile.settings.unpairBody')}>
                <button type="button" className={BUTTON_DANGER} onClick={() => setConfirming(true)}>
                  {t('mobile.settings.unpair')}
                </button>
              </SettingRow>
            </SettingsRows>
          </SettingsGroup>
        </div>
      </div>

      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title={t('mobile.settings.unpairTitle')}
          footer={
            <>
              <button type="button" className={PILL_SECONDARY} onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className={PILL_DANGER} onClick={() => void MinibotRemote.unpair().then(() => setConfirming(false))}>
                {t('mobile.settings.unpair')}
              </button>
            </>
          }>
          <p className="text-[14px] text-ink-secondary">{t('mobile.settings.unpairBody')}</p>
        </Dialog>
      )}
      {feedbackOpen && (
        <FeedbackSheet
          open
          onClose={() => setFeedbackOpen(false)}
          onSent={() => {
            setFeedbackOpen(false);
            setFeedbackSent(true);
          }}
        />
      )}
    </div>
  );
}
