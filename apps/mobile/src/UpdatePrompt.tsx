// 手机端发现新版本：显示版本与更新说明，确认后在原生层下载、校验并调起安装。

import { useEffect, useState } from 'react';
import { t } from '@renderer/i18n';
import { Dialog } from '@renderer/ui/Dialog';
import { PILL_PRIMARY, PILL_SECONDARY } from '@renderer/ui/recipes';
import { MinibotRemote } from './native';

function errorText(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'install_permission') return t('update.permission');
  return t('update.failed');
}

export function UpdatePrompt({
  version,
  notes,
  onClose,
}: {
  version: string;
  notes: string;
  onClose: () => void;
}) {
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const progress = MinibotRemote.addListener('updateProgress', ({ percent: value }) => setPercent(value));
    const failed = MinibotRemote.addListener('updateError', ({ message }) => {
      setPercent(null);
      setError(message);
    });
    return () => {
      void progress.then((h) => h.remove());
      void failed.then((h) => h.remove());
    };
  }, []);

  const install = (): void => {
    setError(null);
    setPercent(0);
    void MinibotRemote.downloadAndInstall().then(
      () => {
        setPercent(null);
        onClose();
      },
      (err: unknown) => {
        setPercent(null);
        setError(errorText(err));
      },
    );
  };

  const busy = percent !== null;
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={t('update.available', { version })}
      footer={
        <>
          <button type="button" className={PILL_SECONDARY} disabled={busy} onClick={onClose}>
            {t('update.later')}
          </button>
          <button type="button" className={PILL_PRIMARY} disabled={busy} onClick={install}>
            {t('update.install')}
          </button>
        </>
      }>
      <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
        {busy && <p className="text-[13px] text-ink-secondary">{t('update.downloading', { percent })}</p>}
        {error !== null && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <p className="text-[13px] leading-[19px] whitespace-pre-wrap text-ink-secondary">
          {notes.trim().length > 0 ? notes : t('update.notesEmpty')}
        </p>
      </div>
    </Dialog>
  );
}
