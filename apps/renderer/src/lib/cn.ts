import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 拼接 Tailwind class，后写的同类 class 覆盖先写的 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
