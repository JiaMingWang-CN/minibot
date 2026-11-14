// 添加 MCP server：手填或从常见 JSON 粘贴；stdio 保存前单独确认要运行的命令行。

import { useState } from 'react';
import type { McpServerDraft } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { FIELD, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';
import { Field, SelectField, errorText } from '../ui/settings';

function looksSecret(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(name);
}

function shortNameOf(name: string): string {
  const mapped = Array.from(name).map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : '_')).join('').slice(0, 20);
  return mapped.length > 0 ? mapped : 'mcp';
}

function parseLines(text: string): Record<string, { value: string; secret: boolean }> {
  const out: Record<string, { value: string; secret: boolean }> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0) out[key] = { value, secret: looksSecret(key) };
  }
  return out;
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function McpServerDialog({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'oauth'>('none');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [timeout, setTimeoutText] = useState('60000');
  const [paste, setPaste] = useState('');
  const [ignored, setIgnored] = useState<string[]>([]);
  const [extraServers, setExtraServers] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildDraft = (): McpServerDraft | null => {
    if (name.trim().length === 0) {
      setError(t('extensions.mcp.error.name'));
      return null;
    }
    const timeoutMs = Number(timeout);
    const base = { name: name.trim(), shortName: shortNameOf(name), timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 60000 };
    if (type === 'stdio') {
      if (command.trim().length === 0) {
        setError(t('extensions.mcp.error.command'));
        return null;
      }
      return {
        ...base,
        transport: {
          type: 'stdio',
          command: command.trim(),
          args: args.split(/\r?\n/).map((a) => a.trim()).filter((a) => a.length > 0),
          cwd: cwd.trim().length > 0 ? cwd.trim() : null,
          env: parseLines(envText),
        },
      };
    }
    if (url.trim().length === 0) {
      setError(t('extensions.mcp.error.url'));
      return null;
    }
    return {
      ...base,
      transport: { type: 'http', url: url.trim(), headers: parseLines(headersText), auth },
    };
  };

  const parse = async (): Promise<void> => {
    setError(null);
    try {
      const result = await api.parseMcp(paste);
      setIgnored(result.ignored);
      setExtraServers(Math.max(0, result.servers.length - 1));
      const draft = result.servers[0];
      if (draft === undefined) {
        setError(t('extensions.mcp.empty'));
        return;
      }
      setName(draft.name);
      setTimeoutText(String(draft.timeoutMs));
      if (draft.transport.type === 'stdio') {
        setType('stdio');
        setCommand(draft.transport.command);
        setArgs(draft.transport.args.join('\n'));
        setCwd(draft.transport.cwd ?? '');
        setEnvText(
          Object.entries(draft.transport.env)
            .map(([key, value]) => `${key}=${value.value}`)
            .join('\n'),
        );
      } else {
        setType('http');
        setUrl(draft.transport.url);
        setAuth(draft.transport.auth);
        setHeadersText(
          Object.entries(draft.transport.headers)
            .map(([key, value]) => `${key}=${value.value}`)
            .join('\n'),
        );
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async (): Promise<void> => {
    const draft = buildDraft();
    if (draft === null) return;
    if (draft.transport.type === 'stdio' && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.addMcpServer(draft);
      onCreated();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  const commandLine = [command, ...args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean)].map(quoteArg).join(' ');

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('extensions.mcp.addTitle')}
      wide
      footer={
        confirming ? (
          <>
            <button type="button" className={PILL_SECONDARY} onClick={() => setConfirming(false)}>
              {t('common.back')}
            </button>
            <button type="button" className={PILL_PRIMARY} disabled={saving} onClick={() => void save()}>
              {t('extensions.mcp.confirmStart')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={PILL_SECONDARY} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_PRIMARY} disabled={saving} onClick={() => void save()}>
              {t('extensions.mcp.save')}
            </button>
          </>
        )
      }>
      <div className="flex max-h-[65dvh] flex-col gap-3 overflow-y-auto">
        {error !== null && (
          <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {confirming ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-ink">{t('extensions.mcp.confirmTitle')}</p>
            <pre className="break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{commandLine}</pre>
            {cwd.trim().length > 0 && (
              <p className="font-mono text-[12px] text-ink-secondary">{t('extensions.mcp.cwd')}: {cwd.trim()}</p>
            )}
          </div>
        ) : (
          <>
            <Field label={t('extensions.mcp.paste')} hint={t('extensions.mcp.pasteHint')}>
              <div className="flex flex-col gap-2">
                <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={3} spellCheck={false} className={`${FIELD} font-mono text-[12px]`} />
                <div className="flex justify-end">
                  <button type="button" className={PILL_SECONDARY} onClick={() => void parse()}>
                    {t('extensions.mcp.parse')}
                  </button>
                </div>
              </div>
            </Field>
            {ignored.length > 0 && (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">
                {t('extensions.mcp.ignored', { fields: ignored.join(', ') })}
              </p>
            )}
            {extraServers > 0 && (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t('extensions.mcp.extraServers', { count: extraServers })}</p>
            )}
            <Field label={t('extensions.mcp.name')}>
              <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
            </Field>
            <Field label={t('extensions.mcp.type')}>
              <SelectField
                label={t('extensions.mcp.type')}
                value={type}
                onChange={(v) => setType(v === 'http' ? 'http' : 'stdio')}
                options={[
                  { value: 'stdio', label: t('extensions.mcp.type.stdio') },
                  { value: 'http', label: t('extensions.mcp.type.http') },
                ]}
              />
            </Field>
            {type === 'stdio' ? (
              <>
                <Field label={t('extensions.mcp.command')}>
                  <input value={command} onChange={(e) => setCommand(e.target.value)} className={`${FIELD} font-mono`} />
                </Field>
                <Field label={t('extensions.mcp.args')}>
                  <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} className={`${FIELD} font-mono text-[12px]`} />
                </Field>
                <Field label={t('extensions.mcp.cwd')}>
                  <input value={cwd} onChange={(e) => setCwd(e.target.value)} className={`${FIELD} font-mono`} />
                </Field>
                <Field label={t('extensions.mcp.env')}>
                  <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={3} className={`${FIELD} font-mono text-[12px]`} />
                </Field>
              </>
            ) : (
              <>
                <Field label={t('extensions.mcp.url')}>
                  <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${FIELD} font-mono`} />
                </Field>
                <Field label={t('extensions.mcp.headers')}>
                  <textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} rows={3} className={`${FIELD} font-mono text-[12px]`} />
                </Field>
                <Field label={t('extensions.mcp.auth')}>
                  <SelectField
                    label={t('extensions.mcp.auth')}
                    value={auth}
                    onChange={(v) => setAuth(v === 'oauth' ? 'oauth' : 'none')}
                    options={[
                      { value: 'none', label: t('extensions.mcp.authNone') },
                      { value: 'oauth', label: t('extensions.mcp.authOauth') },
                    ]}
                  />
                </Field>
              </>
            )}
            <Field label={t('extensions.mcp.timeout')}>
              <input value={timeout} onChange={(e) => setTimeoutText(e.target.value)} inputMode="numeric" className={FIELD} />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
