// 安装插件：选文件夹 / zip / 填 Git 地址 → prepare 预览 → 确认安装。

import { useState } from 'react';
import type { InstallPreview, InstallSource } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { Field, errorText } from '../ui/settings';

type Mode = 'folder' | 'zip' | 'git';

export function PluginInstallDialog({ api, onClose, onInstalled }: { api: Api; onClose: () => void; onInstalled: () => void }) {
  const [mode, setMode] = useState<Mode>('folder');
  const [pathValue, setPathValue] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (kind: Mode): Promise<void> => {
    setError(null);
    try {
      if (kind === 'folder') {
        const picked = await window.minibot?.pickFolder?.();
        if (picked !== null && picked !== undefined) setPathValue(picked);
      } else {
        const picked = await window.minibot?.pickZip?.();
        if (picked !== null && picked !== undefined) setPathValue(picked);
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const prepare = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const src: InstallSource =
        mode === 'git' ? { kind: 'git', url: gitUrl.trim() } : mode === 'zip' ? { kind: 'zip', path: pathValue.trim() } : { kind: 'folder', path: pathValue.trim() };
      setPreview(await api.pluginPrepare(src));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.pluginConfirm(preview.token);
      onInstalled();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (preview !== null) await api.pluginCancel(preview.token).catch(() => undefined);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={() => void cancel()}
      title={preview === null ? t('plugins.install') : t('plugins.confirmTitle', { name: preview.manifest.name })}
      wide
      footer={
        preview === null ? (
          <>
            <button type="button" className={PILL_SECONDARY} onClick={() => void cancel()}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_PRIMARY} disabled={busy} onClick={() => void prepare()}>
              {t('common.next')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={PILL_SECONDARY} onClick={() => setPreview(null)}>
              {t('common.back')}
            </button>
            <button type="button" className={PILL_PRIMARY} disabled={busy} onClick={() => void confirm()}>
              {t('plugins.confirm')}
            </button>
          </>
        )
      }>
      <div className="flex max-h-[65dvh] flex-col gap-3 overflow-y-auto">
        {error !== null && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        {preview === null ? (
          <>
            <div className="flex gap-1.5">
              {(['folder', 'zip', 'git'] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setPathValue('');
                  }}
                  className={m === mode ? PILL_PRIMARY : PILL_SECONDARY}>
                  {m === 'folder' ? t('plugins.installFolder') : m === 'zip' ? t('plugins.installZip') : t('plugins.installGit')}
                </button>
              ))}
            </div>
            {mode === 'git' ? (
              <Field label={t('plugins.installGit')}>
                <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder={t('plugins.gitPlaceholder')} className={`${FIELD} font-mono`} />
              </Field>
            ) : (
              <Field label={mode === 'zip' ? t('plugins.installZip') : t('plugins.installFolder')}>
                <div className="flex gap-2">
                  <input value={pathValue} onChange={(e) => setPathValue(e.target.value)} className={`${FIELD} font-mono`} />
                  <button type="button" className={PILL_SECONDARY} onClick={() => void pick(mode)}>
                    {t('plugins.marketBrowse')}
                  </button>
                </div>
              </Field>
            )}
          </>
        ) : (
          <>
            <p className="text-[13px] text-ink-secondary">
              {t('plugins.version')}：{preview.manifest.version}
            </p>
            <p className="text-[13px] text-ink">{preview.manifest.description}</p>
            {preview.servers.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[12px] font-medium text-ink-secondary">{t('plugins.servers')}</p>
                {preview.servers.map((s) => (
                  <pre key={s.name} className="break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">
                    {[
                      s.type === 'stdio' ? s.commandLine : s.url,
                      s.type === 'stdio' ? `${t('plugins.cwd')}：${s.cwd}` : null,
                      ...([[t('plugins.env'), s.env], [t('plugins.headers'), s.headers]] as const).map(([label, entries]) =>
                        entries !== undefined && entries.length > 0 ? `${label}：${entries.map((e) => `${e.name}=${e.value}`).join('，')}` : null,
                      ),
                    ]
                      .filter((line) => line !== null)
                      .join('\n')}
                  </pre>
                ))}
              </div>
            )}
            {preview.skills.length > 0 && (
              <p className="text-[12px] text-ink-secondary">
                {t('plugins.skills')}：{preview.skills.join('、')}
              </p>
            )}
            {preview.problems.length > 0 && (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">
                {t('plugins.problems')}：{preview.problems.join('；')}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
