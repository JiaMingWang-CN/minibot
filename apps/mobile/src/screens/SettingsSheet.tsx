import { useState } from 'react';
import { t } from '@renderer/i18n';
import { Dialog } from '@renderer/ui/Dialog';
import { PILL_DANGER, PILL_SECONDARY } from '@renderer/ui/recipes';
import { MinibotRemote, type PhoneStatus } from '../native';

function Row({ title, body, action }: { title: string; body: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{title}</div>
        <div className="text-[12px] leading-[17px] text-ink-secondary">{body}</div>
      </div>
      {action !== undefined && (
        <button type="button" className={`${PILL_SECONDARY} h-8 shrink-0 px-3 text-[13px]`} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

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

/** 顶部状态条点开：连接方式、通知权限、电池优化、后台连接、取消配对 */
export function SettingsSheet({ status, guide, onClose }: { status: PhoneStatus; guide: boolean; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <Dialog
        open
        onClose={() => setConfirming(false)}
        title={t('mobile.settings.unpairTitle')}
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_DANGER} onClick={() => void MinibotRemote.unpair().then(onClose)}>
              {t('mobile.settings.unpair')}
            </button>
          </>
        }>
        <p className="text-[14px] text-ink-secondary">{t('mobile.settings.unpairBody')}</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mobile.settings.title')}
      footer={
        <>
          <button type="button" className={PILL_SECONDARY} onClick={() => setConfirming(true)}>
            {t('mobile.settings.unpair')}
          </button>
          <button type="button" className={PILL_SECONDARY} onClick={onClose}>
            {t('mobile.settings.close')}
          </button>
        </>
      }>
      <div className="flex flex-col gap-4">
        {guide && <p className="rounded-xl bg-card px-3.5 py-2.5 text-[13px] leading-[18px] text-ink-secondary">{t('mobile.settings.guide')}</p>}
        <Row title={t('mobile.settings.pc')} body={status.pcName ?? ''} />
        <Row title={t('mobile.settings.via')} body={viaText(status)} />
        <Row
          title={t('mobile.settings.notifications')}
          body={status.notificationsAllowed ? t('mobile.settings.notificationsOn') : t('mobile.settings.notificationsOff')}
          action={status.notificationsAllowed ? undefined : { label: t('mobile.settings.allow'), onClick: () => void MinibotRemote.requestNotificationPermission() }}
        />
        <Row
          title={t('mobile.settings.battery')}
          body={status.batteryOptimized ? t('mobile.settings.batteryOn') : t('mobile.settings.batteryOff')}
          action={status.batteryOptimized ? { label: t('mobile.settings.toSettings'), onClick: () => void MinibotRemote.openBatterySettings() } : undefined}
        />
        <Row
          title={t('mobile.settings.background')}
          body={status.background ? t('mobile.settings.backgroundOn') : t('mobile.settings.backgroundOff')}
          action={{
            label: status.background ? t('mobile.settings.stopBackground') : t('mobile.settings.startBackground'),
            onClick: () => void (status.background ? MinibotRemote.stopBackground() : MinibotRemote.startBackground()),
          }}
        />
      </div>
    </Dialog>
  );
}
