// 手机：中继与局域网设置、配对新手机、已配对设备列表。

import { useCallback, useEffect, useState } from 'react';
import type { Device, RemoteStatus } from '@minibot/core';
import type { Api } from '../api';
import type { Subscribe } from '../App';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { PILL_DANGER, PILL_SECONDARY } from '../ui/recipes';
import { BUTTON, BUTTON_DANGER, BUTTON_PRIMARY, INPUT, SettingRow, SettingsGroup, SettingsRows, Switch, errorText } from '../ui/settings';
import { cn } from '../lib/cn';
import { PairingDialog } from './PairingDialog';

function Dot({ tone }: { tone: 'ok' | 'busy' | 'error' | 'idle' }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', tone === 'ok' && 'bg-success', tone === 'busy' && 'bg-warning', tone === 'error' && 'bg-danger', tone === 'idle' && 'bg-ink-tertiary')}
    />
  );
}

function relativeTime(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return t('phone.time.now');
  if (minutes < 60) return t('phone.time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('phone.time.hours', { count: hours });
  return t('phone.time.days', { count: Math.floor(hours / 24) });
}

function lastSeenText(device: Device, now: number): string {
  if (device.lastSeenAt === null) return t('phone.devices.never');
  const via = device.lastVia === 'lan' ? t('phone.devices.viaLan') : t('phone.devices.viaRelay');
  return t('phone.devices.lastSeen', { time: relativeTime(device.lastSeenAt, now), via });
}

export function PhonePage({ api, subscribe }: { api: Api; subscribe: Subscribe }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [portDraft, setPortDraft] = useState('');
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((s: RemoteStatus): void => setStatus(s), []);
  const refresh = useCallback(() => {
    api.remoteStatus().then(apply, (err: unknown) => setError(errorText(err)));
  }, [api, apply]);

  useEffect(() => {
    refresh();
    return subscribe((event) => {
      if (event.type === 'remote_changed') refresh();
    });
  }, [refresh, subscribe]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // 服务端的配置变了（含别处修改），草稿跟着更新
  const savedUrl = status?.config.relayUrl ?? '';
  const savedPort = status?.config.lanPort;
  useEffect(() => setUrlDraft(savedUrl), [savedUrl]);
  useEffect(() => setPortDraft(savedPort === undefined ? '' : String(savedPort)), [savedPort]);

  const update = (patch: Parameters<Api['updateRemote']>[0]): void => {
    setError(null);
    api.updateRemote(patch).then(apply, (err: unknown) => {
      setError(errorText(err));
      refresh();
      setUrlDraft(savedUrl);
      setPortDraft(savedPort === undefined ? '' : String(savedPort));
    });
  };

  if (status === null) {
    return <p className="text-[13px] text-ink-secondary">{error ?? t('common.loading')}</p>;
  }
  if (!status.available) {
    return (
      <SettingsGroup>
        <SettingsRows>
          <SettingRow title={t('phone.unavailable')} subtitle={t('phone.unavailableHint')} />
        </SettingsRows>
      </SettingsGroup>
    );
  }

  const saveUrl = (): void => {
    const next = urlDraft.trim();
    if (next === savedUrl) return;
    update({ relayUrl: next === '' ? null : next });
  };
  const saveToken = (): void => {
    if (tokenDraft === '') return;
    update({ relayToken: tokenDraft });
    setTokenDraft('');
  };
  const savePort = (): void => {
    const next = Number(portDraft);
    if (portDraft.trim() === '' || next === savedPort) return;
    update({ lanPort: next });
  };
  const onEnter = (save: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save();
  };

  const relayTone = status.relay === 'connected' ? 'ok' : status.relay === 'connecting' ? 'busy' : status.relay === 'error' ? 'error' : 'idle';
  const relayText =
    status.relay === 'error'
      ? `${t('phone.relay.error')}：${status.relayError ?? ''}`
      : t(`phone.relay.${status.relay}` as 'phone.relay.off');
  const lanTone = status.lan === 'listening' ? 'ok' : status.lan === 'error' ? 'error' : 'idle';
  const lanText = status.lan === 'error' ? (status.lanError ?? '') : t(status.lan === 'listening' ? 'phone.lan.listening' : 'phone.lan.off');

  return (
    <>
      <SettingsGroup label={t('phone.connection')}>
        <SettingsRows>
          <SettingRow
            title={t('phone.relay.url')}
            subtitle={status.config.relayUrl === null ? t('phone.relay.urlMissing') : t('phone.relay.urlHint')}
            message={
              urlDraft.trim().startsWith('ws://') ? <span className="text-warning">{t('phone.relay.insecure')}</span> : undefined
            }>
            <input
              className={cn(INPUT, 'w-[280px]')}
              value={urlDraft}
              placeholder={t('phone.relay.urlPlaceholder')}
              aria-label={t('phone.relay.url')}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={saveUrl}
              onKeyDown={onEnter(saveUrl)}
              spellCheck={false}
            />
          </SettingRow>
          <SettingRow title={t('phone.relay.token')} subtitle={t('phone.relay.tokenHint')}>
            <input
              type="password"
              autoComplete="off"
              className={cn(INPUT, 'w-[200px]')}
              value={tokenDraft}
              placeholder={status.hasRelayToken ? t('phone.relay.tokenSet') : t('phone.relay.tokenPlaceholder')}
              aria-label={t('phone.relay.token')}
              onChange={(e) => setTokenDraft(e.target.value)}
              onBlur={saveToken}
              onKeyDown={onEnter(saveToken)}
            />
            {status.hasRelayToken && (
              <button type="button" className={BUTTON} onClick={() => update({ relayToken: null })}>
                {t('phone.relay.tokenClear')}
              </button>
            )}
          </SettingRow>
          <SettingRow title={t('phone.relay.status')} subtitle={status.relay === 'off' ? t('phone.relay.offHint') : undefined}>
            <span className="flex items-center gap-2 text-[13px] text-ink-secondary">
              <Dot tone={relayTone} />
              {relayText}
            </span>
          </SettingRow>
          <SettingRow title={t('phone.lan.title')} subtitle={t('phone.lan.hint')}>
            <label className="flex items-center gap-2 text-[13px] text-ink-secondary">
              {t('phone.lan.port')}
              <input
                inputMode="numeric"
                className={cn(INPUT, 'w-[84px]')}
                value={portDraft}
                aria-label={t('phone.lan.port')}
                onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, ''))}
                onBlur={savePort}
                onKeyDown={onEnter(savePort)}
              />
            </label>
            <Switch checked={status.config.lanEnabled} aria-label={t('phone.lan.title')} onClick={() => update({ lanEnabled: !status.config.lanEnabled })} />
          </SettingRow>
          {status.config.lanEnabled && (status.lan !== 'off' || status.devices.length > 0) && (
            <SettingRow title={t('phone.lan.title')}>
              <span className="flex items-center gap-2 text-[13px] text-ink-secondary">
                <Dot tone={lanTone} />
                {lanText}
              </span>
            </SettingRow>
          )}
        </SettingsRows>
        {error !== null && <p className="pl-4 text-[12px] text-danger">{error}</p>}
      </SettingsGroup>

      <SettingsGroup
        label={t('phone.devices')}
        actions={
          <button type="button" className={BUTTON_PRIMARY} onClick={() => setPairing(true)}>
            {t('phone.devices.pair')}
          </button>
        }>
        <SettingsRows>
          {status.devices.length === 0 && <SettingRow title={t('phone.devices.empty')} />}
          {status.devices.map((device) => (
            <SettingRow key={device.id} title={device.name} subtitle={lastSeenText(device, now)}>
              {device.online && (
                <span className="flex items-center gap-1.5 text-[12px] text-success">
                  <Dot tone="ok" />
                  {t('phone.devices.online')}
                </span>
              )}
              <button type="button" className={BUTTON_DANGER} onClick={() => setRevoking(device)}>
                {t('phone.devices.revoke')}
              </button>
            </SettingRow>
          ))}
        </SettingsRows>
      </SettingsGroup>

      {pairing && <PairingDialog api={api} status={status} onStatus={apply} onClose={() => setPairing(false)} />}

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t('phone.devices.revokeTitle', { name: revoking?.name ?? '' })}
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} onClick={() => setRevoking(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={PILL_DANGER}
              onClick={() => {
                const target = revoking;
                setRevoking(null);
                if (target !== null) api.revokeDevice(target.id).then(apply, (err: unknown) => setError(errorText(err)));
              }}>
              {t('phone.devices.revoke')}
            </button>
          </>
        }>
        <p className="text-[14px] text-ink-secondary">{t('phone.devices.revokeBody')}</p>
      </Dialog>
    </>
  );
}
