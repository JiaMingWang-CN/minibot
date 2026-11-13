// 输入框：一个胶囊里放 ＋（添加图片）、自动长高的文本框、发送 / 停止按钮。
// Enter 发送，Shift+Enter 换行；输入法组字时不发送。图片可以点 ＋ 选、粘贴或拖进来。

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SkillInfo } from '@minibot/core';
import { ArrowUp, Plus, Square, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { t } from '../i18n';
import { ELEVATED_FLOAT, ICON_BUTTON_SM, MENU_ROW, MENU_SHEET } from '../ui/recipes';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface PendingImage {
  file: File;
  url: string;
}

const MAX_HEIGHT = 200;

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  disabled,
  placeholder,
  images,
  canAddImage,
  onAddImages,
  onRemoveImage,
  error,
  above,
  tools,
  skills,
  selectedSkills,
  onPickSkill,
  onRemoveSkill,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  placeholder: string;
  images: PendingImage[];
  canAddImage: boolean;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (url: string) => void;
  error: string | null;
  /** 胶囊上方的内容（审批卡片） */
  above?: ReactNode;
  /** ＋ 右边的工具按钮（审批方式） */
  tools?: ReactNode;
  /** `/` 点名菜单可用的 skill */
  skills?: SkillInfo[];
  selectedSkills?: string[];
  onPickSkill?: (name: string) => void;
  onRemoveSkill?: (name: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [multiline, setMultiline] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const hasContent = value.trim().length > 0 || images.length > 0 || (selectedSkills?.length ?? 0) > 0;
  const showStop = running && !hasContent;
  const slash = value.startsWith('/') && !/\s/.test(value);
  const query = slash ? value.slice(1).trim().toLowerCase() : '';
  const options = (skills ?? []).filter((s) => query === '' || s.name.toLowerCase().includes(query));
  const menuOpen = slash;

  // 文本框跟着内容长高，到上限后滚动
  useLayoutEffect(() => {
    const el = input.current;
    if (el === null) return;
    el.style.height = '0px';
    const height = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${height}px`;
    setMultiline(height > 28);
  }, [value]);

  const filesOf = (list: DataTransferItemList | FileList | null): File[] => {
    if (list === null) return [];
    const files = list instanceof FileList ? [...list] : [...list].map((i) => i.getAsFile());
    return files.filter((f): f is File => f !== null && f.type.startsWith('image/'));
  };

  return (
    <div className="flex flex-col gap-2">
      {above}
      {(selectedSkills?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {selectedSkills!.map((name) => (
            <span key={name} className="inline-flex items-center gap-1 rounded-full bg-ink/[0.08] px-2.5 py-1 text-[12px] text-ink">
              {name}
              <button type="button" aria-label={t('common.delete')} onClick={() => onRemoveSkill?.(name)} className="text-ink-tertiary hover:text-ink">
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {images.map((i) => (
            <span key={i.url} className="group relative">
              <img src={i.url} alt={i.file.name} className="size-16 rounded-xl object-cover ring-[0.5px] ring-ink/10" />
              <button
                type="button"
                aria-label={t('main.removeImage', { name: i.file.name })}
                onClick={() => onRemoveImage(i.url)}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-on-ink opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100">
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="px-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="relative">
        {menuOpen && (
          <div className={cn(MENU_SHEET, 'absolute bottom-full left-1 mb-2 max-h-60 w-[240px] overflow-y-auto')}>
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-[13px] text-ink-tertiary">{t('skills.menuEmpty')}</div>
            ) : (
              options.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPickSkill?.(s.name);
                    onChange('');
                  }}
                  className={cn(MENU_ROW, i === highlight && 'bg-ink/[0.08]')}>
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto min-w-0 truncate text-[12px] text-ink-tertiary">{s.description}</span>
                </button>
              ))
            )}
          </div>
        )}
      <div
        className={cn(
          'flex items-end gap-1.5 p-2 transition-[border-radius,box-shadow] focus-within:ring-ink/20',
          ELEVATED_FLOAT,
          multiline ? 'rounded-[18px]' : 'rounded-[22px]',
        )}
        onClick={(e) => e.target === e.currentTarget && input.current?.focus()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const files = filesOf(e.dataTransfer.files);
          if (files.length > 0) {
            e.preventDefault();
            onAddImages(files);
          }
        }}>
        <input
          ref={file}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={(e) => {
            onAddImages(filesOf(e.target.files));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          aria-label={t('main.attach')}
          title={t('main.attach')}
          disabled={!canAddImage || disabled}
          onClick={() => file.current?.click()}
          className={cn(ICON_BUTTON_SM, 'bg-ink/[0.04]')}>
          <Plus size={16} aria-hidden />
        </button>
        {tools}
        <textarea
          ref={input}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setHighlight(0);
            onChange(e.target.value);
          }}
          onPaste={(e) => {
            const files = filesOf(e.clipboardData.items);
            if (files.length > 0) {
              e.preventDefault();
              onAddImages(files);
            }
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => (options.length === 0 ? 0 : (h + 1) % options.length));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => (options.length === 0 ? 0 : (h - 1 + options.length) % options.length));
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onChange('');
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const picked = options[highlight] ?? options[0];
                if (picked !== undefined) {
                  onPickSkill?.(picked.name);
                  onChange('');
                }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (hasContent) onSubmit();
            }
          }}
          className="min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-tertiary"
        />
        {showStop ? (
          <button
            type="button"
            aria-label={t('main.stop')}
            title={t('main.stop')}
            onClick={onStop}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink transition-opacity hover:opacity-85">
            <Square size={10} className="fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t('main.send')}
            title={t('main.send')}
            disabled={!hasContent || disabled}
            onClick={onSubmit}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink transition-opacity hover:opacity-85 disabled:opacity-25">
            <ArrowUp size={15} strokeWidth={2.25} aria-hidden />
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
