// 配对新手机：显示二维码与失效倒计时；手机扫码成功后显示“已配对”并自动关闭。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteStatus } from '@minibot/core';
import qrcode from 'qrcode-generator';
import type { Api } from '../api';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { errorText } from '../ui/settings';

const CLOSE_DELAY_MS = 1500;
const QUIET_ZONE = 4;

/** 二维码用 qr-paper / qr-ink 两个 token（深浅色都是黑码白底），四周留白由底板提供 */
function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'L');
    qr.addData(text, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (qr.isDark(row, col)) dark.push([col, row]);
    }
    return { count, dark };
  }, [text]);
  const size = cells.count + QUIET_ZONE * 2;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="size-[260px] rounded-xl bg-qr-paper">
      {cells.dark.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + QUIET_ZONE} y={y + QUIET_ZONE} width="1" height="1" className="fill-qr-ink" />
      ))}
    </svg>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function PairingDialog({
  api,
  status,
  onStatus,
  onClose,
}: {
  api: Api;
  status: RemoteStatus;
  onStatus: (status: RemoteStatus) => void;
  onClose: () => void;
}) {
  // 配对成功的判据：有设备的配对时间不早于对话框打开时（同一台手机重新配对时设备数不变）
  const openedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const start = (): void => {
    setError(null);
    api.startPairing().then((s) => onStatusRef.current(s), (err: unknown) => setError(errorText(err)));
  };

  // 打开即生成邀请，关闭时作废
  useEffect(() => {
    start();
    return () => {
      void api.cancelPairing().then((s) => onStatusRef.current(s), () => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 设备数增加：配对成功
  useEffect(() => {
    if (pairedName !== null) return;
    const paired = status.devices.filter((d) => d.pairedAt >= openedAt.current).sort((a, b) => b.pairedAt - a.pairedAt)[0];
    if (paired !== undefined) setPairedName(paired.name);
  }, [status.devices, pairedName]);

  // 显示“已配对”片刻后自动关闭
  useEffect(() => {
    if (pairedName === null) return;
    const timer = setTimeout(() => onCloseRef.current(), CLOSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pairedName]);

  const pairing = status.pairing;
  const expired = pairing === null || pairing.expiresAt <= now;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('phone.pair.title')}
      footer={
        <button type="button" className={PILL_SECONDARY} onClick={onClose}>
          {t('phone.pair.close')}
        </button>
      }>
      <div className="flex flex-col items-center gap-3">
        {pairedName !== null ? (
          <p className="py-16 text-[15px] font-medium text-success">{t('phone.pair.done', { name: pairedName })}</p>
        ) : expired ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <p className="text-[14px] text-ink-secondary">{t('phone.pair.expired')}</p>
            <button type="button" className={PILL_PRIMARY} onClick={start}>
              {t('phone.pair.regenerate')}
            </button>
          </div>
        ) : (
          <>
            <p className="self-start text-[14px] text-ink-secondary">{t('phone.pair.intro')}</p>
            <QrCode text={pairing.code} label={t('phone.pair.qrLabel')} />
            <p className="text-[13px] text-ink-secondary tabular-nums">{t('phone.pair.countdown', { time: formatCountdown(pairing.expiresAt - now) })}</p>
            {status.config.relayUrl === null && <p className="self-start text-[12px] leading-4 text-ink-tertiary">{t('phone.pair.noRelay')}</p>}
          </>
        )}
        {error !== null && <p className="self-start text-[12px] text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
