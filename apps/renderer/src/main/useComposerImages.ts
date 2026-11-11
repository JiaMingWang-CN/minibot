// 输入框里待发送的图片：校验类型、大小、数量，管理预览地址（blob:）的释放。

import { useState } from 'react';
import { t } from '../i18n';
import { IMAGE_TYPES, type PendingImage } from './Composer';

export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function useComposerImages({ visionOk, model }: { visionOk: boolean; model: string }) {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = (files: File[]): void => {
    setError(null);
    if (!visionOk) {
      setError(t('main.imageUnsupported', { model }));
      return;
    }
    const accepted: PendingImage[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setError(t('main.imageType'));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(t('main.imageTooBig', { name: file.name }));
        continue;
      }
      accepted.push({ file, url: URL.createObjectURL(file) });
    }
    setImages((list) => {
      const room = MAX_IMAGES - list.length;
      if (accepted.length > room) setError(t('main.imageLimit'));
      for (const extra of accepted.slice(Math.max(room, 0))) URL.revokeObjectURL(extra.url);
      return [...list, ...accepted.slice(0, Math.max(room, 0))];
    });
  };

  const remove = (url: string): void => {
    URL.revokeObjectURL(url);
    setImages((list) => list.filter((i) => i.url !== url));
  };

  /** 发送成功后清空并释放预览地址 */
  const clear = (): void => {
    for (const i of images) URL.revokeObjectURL(i.url);
    setImages([]);
  };

  return { images, error, setError, add, remove, clear };
}
