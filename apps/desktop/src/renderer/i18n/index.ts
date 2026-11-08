import { zhCN } from './zh-CN.js';

export type MessageKey = keyof typeof zhCN;

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template: string = zhCN[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]),
  );
}
