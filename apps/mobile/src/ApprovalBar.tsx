import { ShieldAlert } from 'lucide-react';
import { t } from '@renderer/i18n';

/** 任意页面顶部：有待审批时显示数量，点击跳到最早一条所在的对话 */
export function ApprovalBar({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 bg-warning/10 px-4 py-2 text-left text-[13px] font-medium text-warning">
      <ShieldAlert size={14} className="shrink-0" aria-hidden />
      {t('mobile.approvalBar', { count })}
    </button>
  );
}
