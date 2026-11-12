// 手机端反馈问题：描述必填、联系方式可选、可附带最近日志并预览。

import { useState } from 'react';
import { t } from '@renderer/i18n';
import { Dialog } from '@renderer/ui/Dialog';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY, TEXT_BUTTON } from '@renderer/ui/recipes';
import { MinibotRemote } from '../native';

const DESCRIPTION_MAX = 5000;
const CONTACT_MAX = 200;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function FeedbackSheet({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: () => void }) {
  const [description, setDescription] = useState('');
  const [contact, setContact] = useState('');
  const [attachLogs, setAttachLogs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const openPreview = (): void => {
    setPreviewOpen(true);
    void MinibotRemote.logsPreview().then(
      (result) => setPreview(result.text),
      (err: unknown) => setPreview(errorText(err)),
    );
  };

  const submit = async (): Promise<void> => {
    if (busy || description.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await MinibotRemote.sendFeedback({
        description,
        ...(contact.trim().length > 0 ? { contact } : {}),
        attachLogs,
      });
      setDescription('');
      setContact('');
      onSent();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t('feedback.title')}
        wide
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={PILL_PRIMARY}
              disabled={busy || description.trim().length === 0}
              onClick={() => void submit()}>
              {busy ? t('feedback.sending') : t('feedback.submit')}
            </button>
          </>
        }>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-secondary">{t('feedback.description')}</span>
          <textarea
            className={`${FIELD} min-h-[120px] resize-y leading-relaxed`}
            value={description}
            maxLength={DESCRIPTION_MAX}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('feedback.descriptionPlaceholder')}
            aria-label={t('feedback.description')}
          />
          <span className="self-end text-[12px] text-ink-tertiary">{t('feedback.count', { count: description.length })}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-secondary">{t('feedback.contact')}</span>
          <input
            className={FIELD}
            value={contact}
            maxLength={CONTACT_MAX}
            disabled={busy}
            onChange={(e) => setContact(e.target.value)}
            placeholder={t('feedback.contactPlaceholder')}
            aria-label={t('feedback.contact')}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-ink"
              checked={attachLogs}
              disabled={busy}
              onChange={(e) => setAttachLogs(e.target.checked)}
            />
            <span>
              <span className="block">{t('feedback.attachLogs')}</span>
              <span className="block text-[12px] leading-[18px] text-ink-tertiary">{t('feedback.attachLogsHint')}</span>
            </span>
          </label>
          {attachLogs && (
            <button type="button" className={`${TEXT_BUTTON} self-start`} onClick={openPreview}>
              {t('feedback.preview')}
            </button>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="text-[13px] text-danger">
            {t('feedback.error', { message: error })}
          </p>
        )}
      </Dialog>
      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t('feedback.previewTitle')}
        wide
        footer={
          <button type="button" className={PILL_SECONDARY} onClick={() => setPreviewOpen(false)}>
            {t('common.cancel')}
          </button>
        }>
        <pre className="max-h-[45vh] overflow-auto rounded-lg bg-inset p-3 text-[12px] leading-[18px] whitespace-pre-wrap text-ink-secondary">
          {preview === null ? t('common.loading') : preview.length === 0 ? t('feedback.previewEmpty') : preview}
        </pre>
      </Dialog>
    </>
  );
}
