import { useState } from 'react';
import { Loader2, QrCode } from 'lucide-react';
import { Logo } from '@renderer/brand/Logo';
import { t } from '@renderer/i18n';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY, TEXT_BUTTON } from '@renderer/ui/recipes';
import { MinibotRemote } from '../native';

export function PairScreen({ deviceModel, revoked, onPaired }: { deviceModel: string; revoked: boolean; onPaired: () => void }) {
  const [deviceName, setDeviceName] = useState(deviceModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [code, setCode] = useState('');

  const run = async (action: () => Promise<{ cancelled: boolean } | void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!(result && result.cancelled)) onPaired();
    } catch (err) {
      const message = err instanceof Error ? err.message : String((err as { message?: string }).message ?? err);
      setError(t('mobile.pair.failed', { message }));
    } finally {
      setBusy(false);
    }
  };

  const name = deviceName.trim();
  return (
    <div className="safe-top safe-bottom flex h-full flex-col items-center justify-center gap-5 bg-app px-6">
      <Logo size={48} />
      <h1 className="text-[22px] tracking-[-0.01em]">{t('mobile.pair.title')}</h1>
      <p className="max-w-[320px] text-center text-[13px] leading-[18px] text-ink-secondary">{t('mobile.pair.body')}</p>
      {revoked && (
        <p role="alert" className="max-w-[320px] rounded-xl bg-danger/10 px-3.5 py-2.5 text-center text-[13px] text-danger">
          {t('mobile.pair.revoked')}
        </p>
      )}
      <label className="flex w-full max-w-[320px] flex-col gap-1.5 text-[13px] text-ink-secondary">
        {t('mobile.pair.deviceName')}
        <input className={FIELD} value={deviceName} maxLength={40} onChange={(e) => setDeviceName(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={busy || name.length === 0}
        className={`${PILL_PRIMARY} h-12 w-full max-w-[320px] text-[15px]`}
        onClick={() => void run(() => MinibotRemote.scanAndPair({ deviceName: name }))}>
        {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <QrCode size={16} aria-hidden />}
        {busy ? t('mobile.pair.pairing') : t('mobile.pair.scan')}
      </button>
      {error !== null && (
        <p role="alert" className="max-w-[320px] text-center text-[13px] text-danger">
          {error}
        </p>
      )}
      {pasting ? (
        <div className="flex w-full max-w-[320px] flex-col gap-2">
          <textarea
            className={`${FIELD} h-24 py-2 font-mono text-[12px]`}
            aria-label={t('mobile.pair.pasteLabel')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || code.trim().length === 0 || name.length === 0}
            className={`${PILL_SECONDARY} h-10`}
            onClick={() => void run(() => MinibotRemote.pair({ code: code.trim(), deviceName: name }))}>
            {t('mobile.pair.pasteSubmit')}
          </button>
        </div>
      ) : (
        <button type="button" className={TEXT_BUTTON} onClick={() => setPasting(true)}>
          {t('mobile.pair.paste')}
        </button>
      )}
    </div>
  );
}
