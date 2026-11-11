// 重命名、删除对话的两个确认对话框。要改哪个对话由父组件持有，这里只管输入与提交。

import { useEffect, useState } from 'react';
import type { Thread } from '@minibot/core';
import type { Api } from '../api';
import { t } from '../i18n';
import { Dialog } from '../ui/Dialog';
import { FIELD, PILL_DANGER, PILL_PRIMARY, PILL_SECONDARY } from '../ui/recipes';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ThreadDialogs({
  api,
  renaming,
  deleting,
  onCloseRename,
  onCloseDelete,
  refreshThreads,
  onDeleted,
  onError,
}: {
  api: Api;
  renaming: Thread | null;
  deleting: Thread | null;
  onCloseRename: () => void;
  onCloseDelete: () => void;
  refreshThreads: () => Promise<Thread[]>;
  /** 删完后拿到最新的对话列表，父组件决定接着打开哪个 */
  onDeleted: (deletedId: string, remaining: Thread[]) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (renaming !== null) setValue(renaming.title);
  }, [renaming]);

  const confirmRename = async (): Promise<void> => {
    if (renaming === null || value.trim().length === 0) return;
    try {
      await api.renameThread(renaming.id, value.trim());
      await refreshThreads();
      onCloseRename();
    } catch (err) {
      onError(errorText(err));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return;
    const id = deleting.id;
    try {
      await api.deleteThread(id);
      onCloseDelete();
      onDeleted(id, await refreshThreads());
    } catch (err) {
      onError(errorText(err));
    }
  };

  return (
    <>
      <Dialog
        open={renaming !== null}
        onClose={onCloseRename}
        title={t('main.renameTitle')}
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} onClick={onCloseRename}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_PRIMARY} disabled={value.trim().length === 0} onClick={() => void confirmRename()}>
              {t('common.save')}
            </button>
          </>
        }>
        <input
          className={FIELD}
          aria-label={t('main.renameLabel')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void confirmRename()}
        />
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={onCloseDelete}
        title={t('main.deleteTitle', { title: deleting?.title ?? '' })}
        footer={
          <>
            <button type="button" className={PILL_SECONDARY} onClick={onCloseDelete}>
              {t('common.cancel')}
            </button>
            <button type="button" className={PILL_DANGER} onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </button>
          </>
        }>
        <p className="text-[14px] text-ink-secondary">{t('main.deleteBody')}</p>
      </Dialog>
    </>
  );
}
