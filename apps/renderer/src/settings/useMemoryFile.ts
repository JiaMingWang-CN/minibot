// 读写一个记忆文件（用户画像或 bot 的某个记忆主题）：带着读到时的 hash 写回，
// 期间被别处改过就报冲突并重新读一次，不覆盖别人的修改。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Revision } from '@minibot/core';
import type { Api } from '../api';
import { ApiError } from '../api';
import { t } from '../i18n';
import { errorText } from '../ui/settings';

/** sha256('')，与内核的 hash 格式（十六进制）一致 */
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** version 每收到一次 memory_changed 就加一：没有未保存的修改时重新读取 */
export function useMemoryFile(api: Api, path: string | null, version = 0) {
  const [saved, setSaved] = useState<{ content: string; hash: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (keepDraft = false): Promise<void> => {
    if (path === null) return;
    // 文件还没建时按空内容编辑；内核写入时同样把不存在的文件当作空内容比对
    const read = api.readMemoryFile(path).catch((err: unknown) => {
      if (err instanceof ApiError && err.code === 'not_found') return { content: '', hash: EMPTY_HASH };
      throw err;
    });
    const [file, list] = await Promise.all([read, api.listRevisions(path)]);
    setSaved(file);
    if (!keepDraft) setDraft(file.content);
    setRevisions([...list].reverse());
  }, [api, path]);

  useEffect(() => {
    setSaved(null);
    setError(null);
    setNotice(null);
    load().catch((err: unknown) => setError(errorText(err)));
  }, [load]);

  // 别处改了记忆：草稿没动过就跟着刷新；改了一半的不覆盖，保存时会提示冲突
  const dirtyRef = useRef(false);
  dirtyRef.current = saved !== null && draft !== saved.content;
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version === firstVersion.current || dirtyRef.current) return;
    load().catch(() => {});
  }, [version, load]);

  const run = async (job: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await job();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        // 只更新基准版本，草稿原样保留；再保存一次就是确认覆盖对方的改动
        await load(true).catch(() => {});
        setError(t('memory.conflict'));
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      if (path === null || saved === null) return;
      await api.writeMemoryFile(path, draft, saved.hash);
      await load();
      setNotice(t('common.saved'));
    });

  const revert = (id: number): Promise<void> =>
    run(async () => {
      await api.revert(id);
      await load();
    });

  return {
    loaded: saved !== null,
    draft,
    setDraft,
    dirty: saved !== null && draft !== saved.content,
    revisions,
    busy,
    error,
    notice,
    save,
    revert,
  };
}
